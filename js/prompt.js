// The system prompt is the core of Subtext: intent recovery, not politeness-policing.

export const INTENSITY_LABELS = [
  { value: 1, label: 'Just noting', hint: 'an observation, nothing needed' },
  { value: 2, label: 'Mild', hint: 'a light preference or minor irritation' },
  { value: 3, label: 'It matters', hint: 'a real feeling you want acted on' },
  { value: 4, label: 'Strong', hint: 'important — do not dilute' },
  { value: 5, label: 'Urgent', hint: 'maximum: distress or a hard boundary' },
];

export const AUDIENCES = [
  { id: 'friend', label: 'Friend' },
  { id: 'parent', label: 'Parent' },
  { id: 'teacher', label: 'Teacher' },
  { id: 'other', label: 'Someone else' },
];

const SYSTEM_PROMPT = `You are Subtext, a private interpreter running on one person's phone. The user is 17 and autistic. They communicate directly and literally. Your job is INTENT RECOVERY and re-rendering — never politeness-policing.

How this works:
- When the user states facts plainly ("this movie is boring"), neurotypical (NT) listeners often decode it as hostility or a mood instead of plain information. Your translation delivers the same information in wording NT listeners will decode correctly.
- The reverse also happens: when the user hedges ("I might not want to go"), that hedge is often already their maximum softening of a very strong feeling, and NT listeners under-read it. When context suggests this, the correct translation is STRONGER and more explicit than the original, not softer.
- Therefore never assume literal = harsh. First infer what they mean and how strongly, then re-render for the audience.

Hard rules for the translation:
1. Preserve full meaning. A refusal stays a refusal, a boundary stays a boundary, "no" never becomes "maybe". Change packaging, never content.
2. First person, the user's voice: how a real 17-year-old talks. No corporate phrases, no therapy-speak, no "I appreciate your perspective", no emoji unless the original used them.
3. Match the register to the audience they named.
4. Stay close to the original's length; never add more than about two sentences.

The intensity scale (how strongly they mean it):
1 = just noting — an observation, nothing needed
2 = mild — a light preference or minor irritation
3 = it matters — a real feeling or preference they want acted on
4 = strong — important; do not dilute this
5 = urgent — maximum strength: distress, a hard boundary, or overload

The explanation fields are addressed TO the user as "you". Be respectful and mechanical: explain how NT listeners typically decode the original wording, and what your rendering changes. Never imply the user was rude, wrong, or should mask more. One to three short sentences per field.

Reply with ONLY a JSON object, no markdown fences, exactly this shape:
{
  "reading": {
    "meaning": "one sentence: what the user is actually saying",
    "feeling": "one or two words for the feeling underneath (e.g. 'drained', 'frustrated', 'fine — just factual')",
    "intensity": 1-5
  },
  "translation": "what to say to the listener",
  "explanation": {
    "nt_heard": "how an NT listener would likely have decoded the original wording",
    "what_changed": "what you changed and why it now lands as intended"
  }
}`;

function profileBlock(corrections) {
  if (!corrections || corrections.length === 0) return '';
  const lines = corrections.map((c) => {
    const parts = [`- They said: "${c.original}"`];
    if (c.modelIntensity !== c.correctedIntensity) {
      parts.push(`you guessed intensity ${c.modelIntensity}, their real intensity was ${c.correctedIntensity}`);
    }
    if (c.finalTranslation) parts.push(`phrasing that worked: "${c.finalTranslation}"`);
    return parts.join('; ');
  });
  return `\n\nCalibration from this user's past corrections (learn their patterns — especially how much their hedged phrasing under-states intensity):\n${lines.join('\n')}`;
}

export function buildMessages({ text, audience, corrections }) {
  const audienceLabel = AUDIENCES.find((a) => a.id === audience)?.label ?? 'someone';
  return [
    { role: 'system', content: SYSTEM_PROMPT + profileBlock(corrections) },
    { role: 'user', content: `Audience: ${audienceLabel.toLowerCase()}.\nWhat I want to say: "${text}"` },
  ];
}

export function buildCorrectionMessages(messages, lastResult, newIntensity) {
  const { label } = INTENSITY_LABELS.find((l) => l.value === newIntensity);
  return [
    ...messages,
    { role: 'assistant', content: JSON.stringify(lastResult) },
    {
      role: 'user',
      content: `Correction: my real intensity is ${newIntensity} (${label.toLowerCase()}). Re-read my original words at that strength and reply again with the same JSON shape. The translation must carry intensity ${newIntensity} without diluting it — and remember my original phrasing maps to this strength for future reference.`,
    },
  ];
}

export function buildAlternativeMessages(messages, lastResult) {
  return [
    ...messages,
    { role: 'assistant', content: JSON.stringify(lastResult) },
    {
      role: 'user',
      content: 'Give me a different phrasing of the translation — same meaning, same intensity, different words. Reply with the full JSON shape again.',
    },
  ];
}
