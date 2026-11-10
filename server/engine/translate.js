// Publishes every document in each configured language (English and German): the approved
// document is translated by Claude, string by string, so the structure, screenshots, ids and
// evidence stay identical and only the wording changes.
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { createClient } from './generate-llm.js';

export const LANGUAGE_NAMES = { en: 'English', de: 'German' };

export function otherLanguages(cfg, lang) {
  return (cfg.ai?.languages || cfg.languages || ['en', 'de']).filter((l) => l !== lang && LANGUAGE_NAMES[l]);
}

// Every human-readable text of the document, as [get, set] pairs. Application names, ids, dates,
// people and URLs are not translated.
function textSlots(d) {
  const slots = [];
  const field = (obj, key) => { if (obj && typeof obj[key] === 'string' && obj[key].trim()) slots.push([() => obj[key], (v) => { obj[key] = v; }]); };
  const list = (arr) => arr?.forEach((_, i) => field(arr, i));
  field(d.info, 'title'); field(d, 'purpose'); list(d.keywords || []); field(d, 'expectedOutcome');
  list(d.scope.included); list(d.scope.excluded);
  for (const k of ['permissions', 'access', 'information', 'dependencies']) list(d.prerequisites[k]);
  d.roles.forEach((r) => { field(r, 'role'); field(r, 'responsibilities'); });
  d.steps.forEach((s) => { field(s, 'title'); field(s, 'description'); list(s.instructions); field(s, 'input'); field(s, 'expectedResult'); list(s.notes); list(s.warnings); });
  d.decisions.forEach((x) => { field(x, 'condition'); field(x, 'action'); });
  d.exceptions.forEach((x) => { field(x, 'problem'); field(x, 'handling'); field(x, 'escalation'); });
  list(d.verification);
  d.troubleshooting.forEach((x) => { field(x, 'issue'); field(x, 'resolution'); });
  d.related.forEach((x) => field(x, 'title'));
  d.changeHistory.forEach((x) => field(x, 'summary'));
  return slots;
}

const Out = z.object({ translations: z.array(z.string()) });

export async function translateDoc({ cfg, doc, to, client }) {
  const out = structuredClone(doc);
  const slots = textSlots(out);
  out.info.language = to;
  if (!slots.length) return out;
  const texts = slots.map(([get]) => get());
  const anthropic = client || (await createClient(cfg));
  const format = zodOutputFormat(Out);
  const stream = anthropic.messages.stream({
    model: cfg.ai.model,
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    output_config: { effort: cfg.ai.effort, format: { type: format.type, schema: format.schema } },
    system: `You translate IT work instructions from ${LANGUAGE_NAMES[doc.info.language] || 'English'} to ${LANGUAGE_NAMES[to]} for colleagues in the IT department. Use the formal, concise style of work instructions (in German the polite imperative: "Öffnen Sie ...", "Klicken Sie auf ..."). Keep names of menus, buttons, fields, products and applications exactly as written (they match the user interface), as well as anything in quotes, placeholders in square brackets, URLs, ids and numbers. Return exactly one translation per input string, in the same order.`,
    messages: [{ role: 'user', content: `Translate these ${texts.length} strings. Answer with {"translations": [...]} containing exactly ${texts.length} strings.\n\n${JSON.stringify(texts)}` }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('The AI model declined to translate this document.'), { code: 'AI_REFUSAL' });
  if (msg.stop_reason === 'max_tokens') throw Object.assign(new Error('The translation was truncated.'), { code: 'AI_TRUNCATED' });
  const { translations } = format.parse(msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  if (translations.length !== texts.length) throw new Error(`The translation returned ${translations.length} texts instead of ${texts.length}.`);
  slots.forEach(([, set], i) => set(translations[i]));
  return out;
}
