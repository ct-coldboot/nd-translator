# Subtext

*Say it your way. Send it their way.*

A private, installable web app (PWA) that translates between direct/literal communication and
the indirect register neurotypical listeners expect — in both directions of intensity. Built
for one specific 17-year-old, owned by them, running against their family's own LLM server.

## What it does

- **Translate** — type what you want to say, pick who it's for (friend / parent / teacher),
  and get: how the app read your intent and its strength, a rendering that will land as
  intended, and an explanation of what changed and why.
- **The intensity dial** — the app shows how strongly it thinks you meant it (1 *just noting*
  → 5 *urgent*). If it guessed wrong, drag the dial and retranslate. Crucially, translation is
  **intent recovery, not softening**: hedged phrasing that under-signals ("I'm a little
  tired" meaning *shutdown incoming*) gets translated *stronger*, not softer.
- **Personal profile** — every correction is stored on the phone (localStorage only) and fed
  back into future translations, so the app learns this person's patterns.
- **The second read** — when the *wording* of a thought carries a classic unhelpful thought
  pattern (CBT / Burns taxonomy: all-or-nothing, worst-case jump, mind-reading…), a private
  "For you" card offers a validation-first alternative reading of the same facts. It is
  detection-gated and deliberately conservative: sensory overload, real mistreatment, grief,
  and plain factual reports are accurate data, never "distortions", and get no reframe. It
  never changes what gets sent. Grounded in Maddela et al. 2023 (PATTERNREFRAME), Ziems et
  al. 2022 (Positive Reframing), and Sharma et al. 2023 (specific + actionable beats sunny;
  toxic-positivity phrasing is banned outright).
- **Phrasebook** — 30 curated situations (school / family / friends / big feelings) that work
  fully offline, including the reverse-masking cases.

## Privacy

No accounts, no analytics, no third-party calls. The only network traffic is to the family's
own LLM server over their private Tailscale network. Corrections never leave the phone except
inside translation requests to that server.

## Stack

Vanilla HTML/CSS/JS, no build step, no dependencies. Service worker + manifest for offline
install. Talks to any OpenAI-compatible `/chat/completions` endpoint (tested against
[Lemonade Server](https://lemonade-server.ai/) on an AMD Strix Halo, fronted by
`tailscale serve` for HTTPS).

- `js/prompt.js` — the system prompt: the actual product
- `js/app.js` — UI controller
- `js/api.js`, `js/storage.js` — OpenAI-compatible client, localStorage persistence
- `data/phrasebook.js` — offline phrasebook content
- `sw.js`, `manifest.webmanifest` — PWA plumbing
- `tools/test-harness.py` — model smoke tests; run when switching models
  (`--dataset` also samples the local `references/dev.csv`, which is gitignored)
- `tools/cors-proxy.py` — optional CORS shim for the server (see SETUP.md)

## Develop locally

```
python -m http.server 8080
# open http://localhost:8080
```

## Deploy

Hosted on GitHub Pages from the `main` branch root. Any push to `main` redeploys.
Bump `VERSION` in `sw.js` when shipping changes so installed phones pick them up.

## Server & phone setup

See [SETUP.md](SETUP.md) for the full Tailscale walkthrough (two users, one tailnet),
Lemonade fronting, CORS check, and phone install steps.
