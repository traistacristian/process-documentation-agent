// Click markers for screenshots whose click positions were not recorded (screen sharing, the desktop
// agent, or an older browser add-in). Claude looks at the step's screenshot and its instructions and
// points out, in order, the element each instruction acts on. The result is a proposal shown on the
// screenshot; the reviewer can move, delete or add markers in the screenshot editor.
import sharp from 'sharp';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { createClient } from './generate-llm.js';

const Found = z.object({
  elements: z.array(z.object({
    instruction: z.number().int(),
    kind: z.enum(['click', 'field']),
    x: z.number(), y: z.number(), width: z.number(), height: z.number(),
  })),
});

const SYSTEM = `You mark where a user acts on a screenshot of an IT administration tool, for a work instruction.
You get the screenshot and the step's numbered instructions. For each instruction that clicks, selects, ticks, or types into something VISIBLE on this screenshot, give the rectangle of that element (the button, link, tab, menu entry, checkbox, list row or input field) in pixels of the image you were given (x and y = top-left corner).
kind is "field" for an input box or drop-down that is filled in, otherwise "click".
Leave out instructions whose element is not visible on this screenshot (for example it appears only after a click, or the instruction is about another screen). Never guess: an element you cannot clearly identify is left out. Keep the order of the instructions.`;

const MAX_W = 1280;

export async function locateMarks({ cfg, buffer, instructions, client }) {
  const lines = (instructions || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 15);
  if (!lines.length) return [];
  const meta = await sharp(buffer).metadata();
  const scale = meta.width > MAX_W ? MAX_W / meta.width : 1;
  const w = Math.round(meta.width * scale); const h = Math.round(meta.height * scale);
  const img = scale === 1 && meta.format === 'jpeg' ? buffer : await sharp(buffer).resize(w, h).jpeg({ quality: 80 }).toBuffer();
  const anthropic = client || (await createClient(cfg));
  const format = zodOutputFormat(Found);
  const msg = await anthropic.messages.create({
    model: cfg.ai.model,
    max_tokens: 3000,
    thinking: { type: 'adaptive' },
    output_config: { effort: cfg.ai.effort, format: { type: format.type, schema: format.schema } },
    system: SYSTEM,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.toString('base64') } },
      { type: 'text', text: `The image is ${w} x ${h} pixels.\nInstructions:\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}` },
    ] }],
  });
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('The AI model declined to look at this screenshot.'), { code: 'AI_REFUSAL' });
  const { elements } = format.parse(msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  const c = (v) => Math.min(1, Math.max(0, v));
  const r4 = (v) => Math.round(v * 10000) / 10000;
  return elements
    .filter((e) => e.width > 0 && e.height > 0 && e.instruction >= 1 && e.instruction <= lines.length)
    .sort((a, b) => a.instruction - b.instruction)
    .map((e) => {
      const x = c(e.x / w); const y = c(e.y / h); const x2 = c((e.x + e.width) / w); const y2 = c((e.y + e.height) / h);
      return { kind: e.kind, x: r4(x), y: r4(y), w: r4(x2 - x), h: r4(y2 - y), cx: r4((x + x2) / 2), cy: r4((y + y2) / 2) };
    })
    .filter((m) => m.w > 0 && m.h > 0 && m.w < 0.9 && m.h < 0.9) // a box around (almost) everything points at nothing
    .slice(0, 20)
    .map((m, i) => ({ n: i + 1, ...m }));
}
