// AI documentation engine (Claude, via the official Anthropic SDK).
// The model receives redacted events, the deterministic candidate steps and the screenshots, and
// returns a document in the standard schema (structured outputs). The server then enforces the
// "never invent" rule: steps without valid evidence, unknown screenshot ids and empty mandatory
// sections are flagged as clarifications before anyone can approve the document.
import fs from 'node:fs';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { DocSchema, normalizeDoc } from './schema.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompts.js';
import { generateWithRules } from './generate-rules.js';

const LlmStep = DocSchema.shape.steps.element.omit({ id: true, number: true });
const LlmOutput = z.object({
  doc: DocSchema.omit({ info: true, changeHistory: true, steps: true }).extend({ steps: z.array(LlmStep) }),
  clarifications: z.array(z.object({ section: z.string(), stepNumber: z.number().int().nullable(), question: z.string() })),
  suggestions: z.array(z.string()),
});

export function aiAvailable(cfg) {
  if (cfg.ai.provider === 'rules') return false;
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || cfg.ai.provider === 'claude');
}

export async function generateWithClaude({ cfg, meta, events, screenshots, base, user, client }) {
  const skeleton = generateWithRules({ meta, events, screenshotsAvailable: new Set(screenshots.map((s) => s.id)), base, user });
  const shots = screenshots.slice(0, cfg.ai.maxScreenshotsToModel);
  const content = [];
  for (const s of shots) {
    content.push({ type: 'text', text: `Screenshot id: ${s.id}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: s.mime, data: fs.readFileSync(s.path).toString('base64') } });
  }
  content.push({ type: 'text', text: buildUserPrompt({ meta, candidateSteps: skeleton.doc.steps, events: compactEvents(events), screenshots: shots, base }) });

  const anthropic = client || new Anthropic();
  const format = zodOutputFormat(LlmOutput);
  const stream = anthropic.beta.messages.stream({
    model: cfg.ai.model,
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    output_config: { effort: cfg.ai.effort, format: { type: format.type, schema: format.schema } },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('The AI model declined to process this recording.'), { code: 'AI_REFUSAL' });
  if (msg.stop_reason === 'max_tokens') throw Object.assign(new Error('The AI response was truncated.'), { code: 'AI_TRUNCATED' });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const out = format.parse(text);
  return finalize({ out, skeleton, events, screenshots, base, meta, user, model: msg.model });
}

function compactEvents(events) {
  return events.filter((e) => !['heartbeat'].includes(e.type)).map((e) => {
    const { seq, type, app, windowTitle, url, pageTitle, element, value, text, level, screenshotId, source } = e;
    return Object.fromEntries(Object.entries({ seq, type, source, app, windowTitle, url, pageTitle, element, value, text, level, screenshotId }).filter(([, v]) => v !== undefined));
  });
}

// Server-side guardrails applied to whatever the model returned.
export function finalize({ out, skeleton, events, screenshots, base, meta, user, model }) {
  const validSeqs = new Set(events.map((e) => e.seq));
  const validShots = new Set(screenshots.map((s) => s.id));
  const clarifications = [];
  const ask = (section, question, stepId = null) => clarifications.push({ id: `clr_${crypto.randomBytes(4).toString('hex')}`, section, stepId, question, answer: '', status: 'open' });

  const doc = { ...skeleton.doc, ...out.doc, info: skeleton.doc.info, changeHistory: skeleton.doc.changeHistory };
  doc.steps = out.doc.steps.map((s, i) => {
    const step = { ...s, id: `stp_${crypto.randomBytes(4).toString('hex')}`, number: i + 1 };
    step.evidenceEventSeqs = (s.evidenceEventSeqs || []).filter((n) => validSeqs.has(n));
    step.screenshotIds = (s.screenshotIds || []).filter((id) => validShots.has(id));
    if (!step.evidenceEventSeqs.length) {
      step.warnings = [...(step.warnings || []), 'Not supported by captured evidence - confirm or remove before approval.'];
      ask('steps', `Step ${i + 1} ("${step.title}") could not be linked to any recorded action. Is it part of the process?`, step.id);
    }
    return step;
  });
  for (const c of out.clarifications) {
    const step = c.stepNumber ? doc.steps[c.stepNumber - 1] : null;
    ask(c.section, c.question, step?.id ?? null);
  }
  if (!doc.purpose && !clarifications.some((c) => c.section === 'purpose')) ask('purpose', 'Why does this process exist and what does it achieve?');
  if (!doc.prerequisites.permissions.length && !clarifications.some((c) => c.section === 'prerequisites')) ask('prerequisites', 'Which permissions or admin roles are required to perform this process?');
  return { doc: normalizeDoc(doc), clarifications, suggestions: out.suggestions, engine: `claude:${model}` };
}
