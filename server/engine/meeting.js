// Meeting recordings that fill the gaps of a draft. While someone explains a process in a meeting,
// the app records the shared screen (screenshots when it changes) and the audio. Afterwards:
//   1. Azure AI Speech (fast transcription) turns the audio into a timestamped transcript
//      (Claude does not take audio). Keyless: the App Service managed identity has the
//      "Cognitive Services Speech User" role on the Speech resource.
//   2. Claude reads the draft, its open questions and the transcript, and proposes answers, notes and
//      missing steps, each with the moment in the meeting it comes from. The server attaches the
//      screenshot taken closest to that moment.
// Nothing is applied automatically: the reviewer accepts or rejects every suggestion.
import fs from 'node:fs';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { createClient } from './generate-llm.js';

const LOCALES = { en: 'en-US', de: 'de-DE' };

export const speechConfigured = (cfg) => !!cfg.speech?.endpoint;

// Returns [{ ms, durationMs, speaker, text }].
export async function transcribeAudio({ cfg, path, mime = 'audio/webm', language = 'en', credential, fetchImpl = globalThis.fetch }) {
  const endpoint = cfg.speech.endpoint.replace(/\/+$/, '');
  const headers = {};
  if (cfg.speech.key) headers['Ocp-Apim-Subscription-Key'] = cfg.speech.key;
  else {
    let cred = credential;
    if (!cred) { const { ManagedIdentityCredential } = await import('@azure/identity'); cred = new ManagedIdentityCredential(); }
    const t = await cred.getToken('https://cognitiveservices.azure.com/.default');
    headers.authorization = `Bearer ${t.token}`;
  }
  const form = new FormData();
  form.append('audio', new Blob([fs.readFileSync(path)], { type: mime }), 'meeting.webm');
  const primary = LOCALES[language] || 'en-US';
  form.append('definition', JSON.stringify({ locales: [primary, ...Object.values(LOCALES).filter((l) => l !== primary)], diarization: { enabled: true, maxSpeakers: 8 }, profanityFilterMode: 'None' }));
  const res = await fetchImpl(`${endpoint}/speechtotext/transcriptions:transcribe?api-version=2024-11-15`, { method: 'POST', headers, body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Speech transcription failed (${res.status}): ${body?.error?.message || body?.message || 'no details'}`), { status: 502 });
  return (body.phrases || []).map((p) => ({ ms: p.offsetMilliseconds ?? 0, durationMs: p.durationMilliseconds ?? 0, speaker: p.speaker ?? null, text: p.text || '' })).filter((p) => p.text.trim());
}

const Out = z.object({
  suggestions: z.array(z.object({
    kind: z.enum(['answer', 'note', 'step', 'topic']),
    clarificationId: z.string().nullable(),
    stepNumber: z.number().int().nullable(),
    title: z.string().nullable(),
    text: z.string(),
    instructions: z.array(z.string()),
    quote: z.string(),
    atSeconds: z.number(),
  })),
});

const SYSTEM = `You help complete an IT work instruction from a meeting in which colleagues explained the process. You get the current draft (steps and open questions) and a timestamped transcript of the meeting.

Find information in the transcript that fills a gap in the draft:
- kind "answer": the meeting answers one of the open questions. Set clarificationId; text is the answer, written as it should go into the document.
- kind "note": an important detail for an existing step (a value, a condition, a warning, a reason). Set stepNumber; text is the note.
- kind "step": the meeting describes a step that is missing from the draft. Set stepNumber to the step it comes after (0 = at the start), title, and instructions (short imperative sentences).
- kind "topic": a subject that came up in the meeting but seems unclear, disputed, only known by one person, or not documented anywhere, and should be documented as its own work instruction (for example "Nobody was sure how the licence is removed for leavers"). title is a short process name to record (verb first, e.g. "Remove licences from leavers"); text explains in one or two sentences why it should be documented. Only propose topics that are really IT procedures.
For every suggestion give quote (the words from the transcript it is based on, shortened if long) and atSeconds (when in the meeting it was said or shown).

Rules: only use what was actually said; never invent names, values or settings. Ignore small talk and anything already in the draft. Never include passwords or secrets. Write text and instructions in the language of the document, in the style of a work instruction. Return an empty list when the meeting adds nothing.`;

const mmss = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

export async function findMeetingSuggestions({ cfg, doc, clarifications, transcript, client }) {
  const draft = {
    title: doc.info.title, language: doc.info.language || 'en', purpose: doc.purpose,
    steps: doc.steps.map((s) => ({ number: s.number, title: s.title, instructions: s.instructions, input: s.input, expectedResult: s.expectedResult, notes: s.notes })),
    openQuestions: clarifications.filter((c) => c.status === 'open').map((c) => ({ clarificationId: c.id, section: c.section, question: c.question })),
  };
  const lines = transcript.map((p) => `[${mmss(p.ms)}]${p.speaker != null ? ` Speaker ${p.speaker}:` : ''} ${p.text}`).join('\n').slice(0, 400_000);
  const anthropic = client || (await createClient(cfg));
  const format = zodOutputFormat(Out);
  const stream = anthropic.messages.stream({
    model: cfg.ai.model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: cfg.ai.effort, format: { type: format.type, schema: format.schema } },
    system: SYSTEM,
    messages: [{ role: 'user', content: `<draft>\n${JSON.stringify(draft, null, 2)}\n</draft>\n<transcript>\n${lines}\n</transcript>\nList what the meeting adds to the draft.` }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('The AI model declined to analyse this meeting.'), { code: 'AI_REFUSAL' });
  if (msg.stop_reason === 'max_tokens') throw Object.assign(new Error('The meeting analysis was cut off.'), { code: 'AI_TRUNCATED' });
  const { suggestions } = format.parse(msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  const openIds = new Set(draft.openQuestions.map((q) => q.clarificationId));
  return suggestions.filter((s) => s.text.trim() || s.instructions.length).filter((s) => s.kind !== 'topic' || s.title?.trim())
    .filter((s) => s.kind !== 'answer' || openIds.has(s.clarificationId))
    .filter((s) => s.kind !== 'note' || doc.steps.some((x) => x.number === s.stepNumber));
}

// The screenshot taken closest to a moment, preferring one shown shortly after it (people talk, then show).
export function nearestFrame(frames, ms) {
  let best = null; let bestScore = Infinity;
  for (const f of frames) {
    const d = f.atMs - ms;
    const score = d >= 0 ? d : -d * 2;
    if (score < bestScore && Math.abs(d) <= 90_000) { best = f; bestScore = score; }
  }
  return best;
}
