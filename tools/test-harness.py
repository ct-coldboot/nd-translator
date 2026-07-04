#!/usr/bin/env python3
"""Subtext model smoke-test harness.

Run this against the Lemonade server before/after switching the loaded model to
confirm the translator pipeline still works end to end: the model returns clean,
parseable, correctly-shaped JSON within the token budget for a spread of real inputs.

It deliberately shares the app's sources of truth:
  - the system prompt is read straight out of ../js/prompt.js (not copy-pasted), so a
    prompt edit is reflected here automatically;
  - the response parsing mirrors js/api.js chatJSON exactly (fence strip -> first '{'
    to last '}' -> typographic-quote repair), so a PASS here means the real client
    would have parsed it too.

Two tiers of check:
  - STRUCTURAL (hard fail): HTTP ok, not truncated (finish_reason != "length"),
    non-empty content, parses as JSON, has the shape app.js requires. These are
    model-independent — a failure means the app is broken on this model.
  - QUALITY (warn by default, hard with --strict): intent-recovery heuristics such as
    "a hedged under-signal should not read as trivial intensity 1". These vary by model.

Phase 2 (CBT second read) coverage:
  - the shape check now includes the "reframe" field (null, or an object with
    pattern/validation/second_read);
  - cases carry expect_reframe: distortion-style wording should get a reframe, and
    sensory reports / real mistreatment / plain facts must NOT (a false positive
    reads as invalidation — flagged loudly, but still a quality warn since
    detection is model-dependent);
  - reframe text is screened for toxic-positivity markers ("at least", silver
    linings...) which the prompt bans outright;
  - --dataset samples rows from references/dev.csv (Ziems et al. 2022 positive
    reframing) through the full app pipeline. Rows mentioning substances/self-harm
    are filtered out first — the raw dataset contains some (e.g. it positively
    reframes "self medication"), and they are not usable test inputs here.

Usage:
  python3 tools/test-harness.py                       # auto-detect loaded model
  python3 tools/test-harness.py --model NAME
  python3 tools/test-harness.py --dataset --sample 8  # include dev.csv rows
  python3 tools/test-harness.py --base-url http://localhost:13305/api/v1 --strict -v

Exit code: 0 if all structural checks pass (and quality too under --strict), else 1.
"""
import argparse
import csv
import json
import os
import random
import re
import sys
import time
import urllib.request
import urllib.error

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_BASE = os.environ.get("SUBTEXT_BASE_URL", "http://localhost:13305/api/v1")


# ---- shared with the app -----------------------------------------------------

def load_system_prompt():
    """Extract SYSTEM_PROMPT from js/prompt.js so tests use the real product prompt."""
    src = open(os.path.join(REPO_ROOT, "js", "prompt.js"), encoding="utf-8").read()
    marker = "const SYSTEM_PROMPT = `"
    start = src.index(marker) + len(marker)
    end = src.index("`;", start)
    return src[start:end]


AUDIENCE_LABELS = {"friend": "friend", "parent": "parent", "teacher": "teacher", "other": "someone else"}


def build_messages(system_prompt, text, audience):
    # mirrors js/prompt.js buildMessages (no profile corrections in the harness)
    label = AUDIENCE_LABELS.get(audience, "someone")
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f'Audience: {label}.\nWhat I want to say: "{text}"'},
    ]


def build_correction(prev_messages, last_result, new_intensity):
    # mirrors js/prompt.js buildCorrectionMessages
    labels = {1: "just noting", 2: "mild", 3: "it matters", 4: "strong", 5: "urgent"}
    return prev_messages + [
        {"role": "assistant", "content": json.dumps(last_result)},
        {"role": "user", "content": (
            f"Correction: my real intensity is {new_intensity} ({labels[new_intensity]}). "
            "Re-read my original words at that strength and reply again with the same JSON "
            f"shape. The translation must carry intensity {new_intensity} without diluting it "
            "— and remember my original phrasing maps to this strength for future reference.")},
    ]


def parse_content(content):
    """Mirror of js/api.js chatJSON parsing. Returns dict, or raises ValueError."""
    content = re.sub(r"^```[^\n]*\n", "", content)
    content = re.sub(r"\n```\s*$", "", content)
    start = content.find("{")
    end = content.rfind("}")
    if start == -1 or end == -1 or start > end:
        raise ValueError("no JSON object found in content")
    js = content[start:end + 1]
    try:
        return json.loads(js)
    except json.JSONDecodeError:
        repaired = (js.replace("“", '"').replace("”", '"')
                      .replace("‘", "'").replace("’", "'"))
        return json.loads(repaired)  # let it raise if still bad


# ---- server ------------------------------------------------------------------

def http_json(url, payload=None, timeout=180):
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.status, json.load(res)


def detect_model(base):
    # Use the *loaded* model from /health, not /models[0] — /models lists every
    # downloaded model, and requesting the wrong name makes Lemonade swap the loaded
    # model out from under us (max_loaded_models=1). We test what's actually running.
    root = base.rstrip("/").rsplit("/api/", 1)[0] + "/api/v1"
    try:
        _, h = http_json(root + "/health", timeout=10)
        if h.get("model_loaded"):
            return h["model_loaded"]
    except Exception:
        pass
    _, d = http_json(base.rstrip("/") + "/models", timeout=10)
    ids = [m["id"] for m in d.get("data", [])]
    if not ids:
        raise SystemExit("No models available on the server — load one first.")
    return ids[0]


def chat(base, model, messages, max_tokens, thinking=False):
    body = {"model": model, "messages": messages, "temperature": 0.5,
            "max_tokens": max_tokens, "stream": False}
    if not thinking:
        # Match the app: js/api.js sends this to disable hybrid-model reasoning.
        body["chat_template_kwargs"] = {"enable_thinking": False}
    t0 = time.time()
    status, d = http_json(base.rstrip("/") + "/chat/completions", body)
    dt = time.time() - t0
    choice = d["choices"][0]
    msg = choice["message"]
    usage = d.get("usage", {})
    timings = d.get("timings", {})
    return {
        "status": status,
        "finish_reason": choice.get("finish_reason"),
        "content": msg.get("content") or "",
        "reasoning_chars": len(msg.get("reasoning_content") or ""),
        "completion_tokens": usage.get("completion_tokens"),
        "tok_s": round(timings.get("predicted_per_second", 0), 1),
        "wall_s": round(dt, 1),
    }


# ---- validation --------------------------------------------------------------

def validate_shape(obj):
    """Return list of structural errors ([] == valid). Matches what app.js consumes."""
    errs = []
    if not isinstance(obj, dict):
        return ["top level is not an object"]
    reading = obj.get("reading")
    if not isinstance(reading, dict):
        errs.append("missing/invalid 'reading' object")
    else:
        for k in ("meaning", "feeling", "intensity"):
            if k not in reading:
                errs.append(f"reading.{k} missing")
        inten = reading.get("intensity")
        try:
            iv = int(inten)
            if not (1 <= iv <= 5):
                errs.append(f"reading.intensity {inten} out of 1..5")
        except (TypeError, ValueError):
            errs.append(f"reading.intensity not a number: {inten!r}")
    if not (isinstance(obj.get("translation"), str) and obj["translation"].strip()):
        errs.append("translation missing or empty")
    expl = obj.get("explanation")
    if not isinstance(expl, dict):
        errs.append("missing/invalid 'explanation' object")
    else:
        for k in ("nt_heard", "what_changed"):
            if k not in expl:
                errs.append(f"explanation.{k} missing")
    return errs


def intensity_of(obj):
    try:
        return int(obj["reading"]["intensity"])
    except Exception:
        return None


# ---- second read (CBT reframe) -------------------------------------------------

# The plain-language pattern names the prompt instructs the model to use.
REFRAME_PATTERNS = [
    "all-or-nothing", "one bad time becomes every time", "worst-case jump",
    "predicting the future", "mind-reading", "only the bad gets through",
    "discounting the good", "taking all the blame", "should rules",
    "name-calling yourself",
]

# Toxic-positivity markers the prompt bans (Sharma et al. 2023: high-positivity
# reframes are *less* adoptable; Ziems constraint: never contradict the original).
BANNED_POSITIVITY = [
    "at least", "look on the bright side", "bright side", "silver lining",
    "everything happens for a reason", "could be worse", "cheer up",
]


def validate_reframe_shape(obj):
    """Structural errors for the reframe field. null is always valid."""
    errs = []
    if "reframe" not in obj:
        return errs  # tolerated by the app; flagged as a quality warn in run_case
    r = obj["reframe"]
    if r is None:
        return errs
    if not isinstance(r, dict):
        return ["reframe is neither null nor an object"]
    for k in ("pattern", "validation", "second_read"):
        if not (isinstance(r.get(k), str) and r[k].strip()):
            errs.append(f"reframe.{k} missing or empty")
    return errs


def reframe_quality_warns(obj, expect_reframe):
    """Quality warnings for the second read. expect_reframe: True/False/None."""
    warns = []
    if "reframe" not in obj:
        warns.append("'reframe' key missing entirely (prompt requires it, null or object)")
        return warns
    r = obj["reframe"]
    if expect_reframe is True and r is None:
        warns.append("expected a reframe (clear distortion wording) but got null")
    if expect_reframe is False and r is not None:
        warns.append("FALSE-POSITIVE reframe on a non-distortion (invalidation risk): "
                     f"pattern={r.get('pattern')!r}")
    if isinstance(r, dict):
        text = " ".join(str(r.get(k, "")) for k in ("validation", "second_read")).lower()
        for phrase in BANNED_POSITIVITY:
            if phrase in text:
                warns.append(f"banned toxic-positivity phrase in reframe: {phrase!r}")
        pat = (r.get("pattern") or "").lower().strip()
        if pat and not any(p in pat or pat in p for p in REFRAME_PATTERNS):
            warns.append(f"pattern name not from the plain-language list: {pat!r}")
        if len((r.get("second_read") or "").split()) > 60:
            warns.append("second_read is long (>60 words) — should be one or two sentences")
    return warns


# ---- test cases --------------------------------------------------------------
# quality checks are heuristics: min/max intensity, translation must differ from input,
# and expect_reframe (True: distortion wording should get a second read; False: a
# reframe here would be invalidating — sensory reports, real mistreatment, plain facts).
CASES = [
    {"id": "direct-factual", "text": "This movie is boring.", "audience": "friend",
     "expect_reframe": False},
    {"id": "hedge-undersignal",
     "text": "I'm a little tired, I might not come to dinner.", "audience": "parent",
     "min_intensity": 3,  # reverse-masking: a hedge that must not read as trivial
     "expect_reframe": False},
    {"id": "refusal-boundary",
     "text": "No, I'm not doing the group project with them.", "audience": "teacher",
     "expect_reframe": False},
    {"id": "urgent-overload",
     "text": "I need everyone to stop talking right now, I can't handle it.",
     "audience": "parent", "min_intensity": 4,
     "expect_reframe": False},  # sensory overload is accurate data, never a "distortion"
    {"id": "short-neutral", "text": "Can we leave in five minutes?", "audience": "friend",
     "expect_reframe": False},
    # -- Phase 2: distortion wording that SHOULD earn a private second read --
    {"id": "cbt-catastrophize",
     "text": "I failed one math quiz so I'm obviously going to fail the whole semester.",
     "audience": "parent", "expect_reframe": True},
    {"id": "cbt-mindread",
     "text": "Nobody replied to my message in the group chat. They all hate me.",
     "audience": "friend", "expect_reframe": True},
    {"id": "cbt-selflabel",
     "text": "I dropped my tray in the cafeteria. I'm such a useless idiot.",
     "audience": "friend", "expect_reframe": True},
    # -- Phase 2: real mistreatment — reframing this would be invalidation --
    {"id": "real-injustice",
     "text": "Kids at school keep imitating the way I talk and laughing. It's not fair.",
     "audience": "teacher", "min_intensity": 3, "expect_reframe": False},
]


def run_case(base, model, system_prompt, case, max_tokens, verbose, thinking):
    """Returns (struct_ok, quality_warnings, info_line, obj_or_None)."""
    msgs = build_messages(system_prompt, case["text"], case["audience"])
    r = chat(base, model, msgs, max_tokens, thinking)

    struct_errs = []
    if r["status"] != 200:
        struct_errs.append(f"HTTP {r['status']}")
    if r["finish_reason"] == "length":
        struct_errs.append("truncated (finish_reason=length; budget too small for thinking+answer)")
    if not r["content"].strip():
        struct_errs.append("empty content")
    obj = None
    if not struct_errs:
        try:
            obj = parse_content(r["content"])
        except (ValueError, json.JSONDecodeError) as e:
            struct_errs.append(f"unparseable JSON: {e}")
    if obj is not None:
        struct_errs += validate_shape(obj)
        struct_errs += validate_reframe_shape(obj)

    warns = []
    if obj is not None and not struct_errs:
        inten = intensity_of(obj)
        if "min_intensity" in case and inten is not None and inten < case["min_intensity"]:
            warns.append(f"intensity {inten} < expected >= {case['min_intensity']} (under-read)")
        if "max_intensity" in case and inten is not None and inten > case["max_intensity"]:
            warns.append(f"intensity {inten} > expected <= {case['max_intensity']}")
        if obj.get("translation", "").strip().lower() == case["text"].strip().lower():
            warns.append("translation identical to input (no re-rendering)")
        warns += reframe_quality_warns(obj, case.get("expect_reframe"))

    meta = f"{r['wall_s']}s  {r['completion_tokens']}tok  {r['tok_s']}tok/s  think={r['reasoning_chars']}ch"
    detail = ""
    if obj is not None:
        rf = obj.get("reframe")
        rf_note = f"  reframe={rf.get('pattern')!r}" if isinstance(rf, dict) else "  reframe=None"
        detail = f"\n      intensity={intensity_of(obj)}{rf_note} :: {obj.get('translation','')!r}"
        if isinstance(rf, dict):
            detail += f"\n      second_read: {rf.get('second_read','')!r}"
    if verbose and obj is not None:
        detail += f"\n      reading={obj.get('reading')}"
    return (len(struct_errs) == 0, warns, struct_errs, meta + detail, obj, msgs)


# ---- dataset mode (references/dev.csv, Ziems et al. 2022) ---------------------

DATASET_DEFAULT = os.path.join(REPO_ROOT, "references", "dev.csv")

# Rows about substances or self-harm are excluded up front: the raw Ziems data
# contains some (it even positively reframes "self medication"), and they are not
# usable inputs for this app's harness.
DATASET_BLOCKLIST = re.compile(
    r"\b(self.?medicat\w*|drunk|drink\w*|alcohol|beer|wine|vodka|hangover|weed|"
    r"smok\w*|cigarette\w*|drug\w*|suicid\w*|kill\w*|die|died|dying|dead|cutting|"
    r"hospital\w*|funeral)\b",
    re.IGNORECASE)


def sample_dataset(path, n, seed):
    rows = []
    with open(path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            text = (row.get("original_text") or "").strip()
            if not text or DATASET_BLOCKLIST.search(text):
                continue
            rows.append(text)
    random.Random(seed).shuffle(rows)
    return rows[:n]


def main():
    ap = argparse.ArgumentParser(description="Subtext model smoke-test harness")
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    ap.add_argument("--model", default=None, help="default: auto-detect the loaded model")
    ap.add_argument("--max-tokens", type=int, default=4096)
    ap.add_argument("--strict", action="store_true", help="treat quality warnings as failures")
    ap.add_argument("--thinking", action="store_true",
                    help="test with model thinking ON (default: off, matching the app)")
    ap.add_argument("--dataset", nargs="?", const=DATASET_DEFAULT, default=None,
                    metavar="CSV", help="also run sampled rows from the Ziems dev.csv "
                    f"(default path: {DATASET_DEFAULT})")
    ap.add_argument("--sample", type=int, default=6, help="dataset rows to sample (default 6)")
    ap.add_argument("--seed", type=int, default=7, help="dataset sampling seed (default 7)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    base = args.base_url
    model = args.model or detect_model(base)
    system_prompt = load_system_prompt()
    ds_rows = sample_dataset(args.dataset, args.sample, args.seed) if args.dataset else []

    print(f"Subtext harness  model={model}  base={base}  max_tokens={args.max_tokens}  "
          f"thinking={'on' if args.thinking else 'off'}")
    print(f"  {time.strftime('%Y-%m-%d %H:%M:%S')}\n")

    struct_fail = 0
    quality_warn = 0
    last = None  # (obj, msgs) for the correction-flow test
    total = len(CASES) + 1 + len(ds_rows)  # + correction flow

    for i, case in enumerate(CASES, 1):
        ok, warns, errs, info, obj, msgs = run_case(
            base, model, system_prompt, case, args.max_tokens, args.verbose, args.thinking)
        status = "PASS" if ok else "FAIL"
        if not ok:
            struct_fail += 1
        print(f"[{i}/{total}] {case['id']:<20} {status}  {info}")
        for e in errs:
            print(f"      ! {e}")
        for w in warns:
            quality_warn += 1
            print(f"      ~ WARN: {w}")
        if case["id"] == "hedge-undersignal" and obj is not None:
            last = (obj, msgs)

    # correction flow: take the hedge case, correct it to intensity 5, expect valid + escalated
    i = len(CASES) + 1
    if last is not None:
        obj0, msgs0 = last
        cmsgs = build_correction(msgs0, obj0, 5)
        r = chat(base, model, cmsgs, args.max_tokens, args.thinking)
        errs, warns = [], []
        obj = None
        if r["finish_reason"] == "length":
            errs.append("truncated (finish_reason=length)")
        elif not r["content"].strip():
            errs.append("empty content")
        else:
            try:
                obj = parse_content(r["content"])
                errs += validate_shape(obj)
            except Exception as e:
                errs.append(f"unparseable JSON: {e}")
        if obj is not None and not errs:
            if intensity_of(obj) != 5:
                warns.append(f"intensity {intensity_of(obj)} != requested 5 after correction")
        ok = not errs
        if not ok:
            struct_fail += 1
        info = f"{r['wall_s']}s  {r['completion_tokens']}tok  {r['tok_s']}tok/s"
        print(f"[{i}/{total}] {'correction-flow':<20} {'PASS' if ok else 'FAIL'}  {info}")
        if obj is not None:
            print(f"      intensity={intensity_of(obj)} :: {obj.get('translation','')!r}")
        for e in errs:
            print(f"      ! {e}")
        for w in warns:
            quality_warn += 1
            print(f"      ~ WARN: {w}")
    else:
        print(f"[{i}/{total}] correction-flow      SKIP  (hedge case did not produce a base result)")
        struct_fail += 1

    # dataset rows: full app pipeline over sampled real stress posts. Detection rate is
    # informational — experts chose to reframe every row, but some describe real
    # hardships where the app's null (validation-only) is the correct call.
    if ds_rows:
        detected = 0
        print()
        for j, text in enumerate(ds_rows, 1):
            case = {"id": f"dev.csv-{j}", "text": text, "audience": "friend"}
            ok, warns, errs, info, obj, _ = run_case(
                base, model, system_prompt, case, args.max_tokens, args.verbose, args.thinking)
            if not ok:
                struct_fail += 1
            if obj is not None and isinstance(obj.get("reframe"), dict):
                detected += 1
            print(f"[{len(CASES) + 1 + j}/{total}] {case['id']:<20} {'PASS' if ok else 'FAIL'}  {info}")
            if args.verbose or not ok:
                print(f"      input: {text!r}")
            for e in errs:
                print(f"      ! {e}")
            for w in warns:
                quality_warn += 1
                print(f"      ~ WARN: {w}")
        print(f"\n      dataset second-read rate: {detected}/{len(ds_rows)} (informational)")

    print()
    print(f"Structural: {total - struct_fail}/{total} passed   Quality warnings: {quality_warn}")
    failed = struct_fail > 0 or (args.strict and quality_warn > 0)
    print("RESULT:", "FAIL" if failed else "PASS")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    try:
        main()
    except urllib.error.URLError as e:
        raise SystemExit(f"Could not reach the server at the base URL: {e}")
