// Personal data in screenshots (GDPR). Every screenshot is checked by Claude for names, e-mail
// addresses, phone numbers and similar, and those areas are pixelated in the stored file before
// anyone views it or it is sent anywhere else. The browser add-in additionally hides e-mail
// addresses and phone numbers on the page itself before the screenshot is taken.
import fs from 'node:fs';
import sharp from 'sharp';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { createClient } from './generate-llm.js';

const Regions = z.object({
  regions: z.array(z.object({ kind: z.string(), x: z.number(), y: z.number(), width: z.number(), height: z.number() })),
});

const SYSTEM = `You protect personal data in screenshots of IT administration tools. Before a screenshot is stored, every area that shows personal data must be found so it can be blurred.

Mark every area that shows:
- names of people (user and contact display names, first and last names, names inside lists, tables, cards, breadcrumbs, page titles and avatars with initials)
- e-mail addresses and user principal names (user@domain)
- phone and mobile numbers, postal addresses, dates of birth
- personal identifiers (employee or personnel numbers, ID card numbers)
- profile photos of people
- passwords, recovery codes or secrets shown in clear text

Do not mark: menus, buttons, tabs, field labels, column headers, product, company and tenant names, role, licence and group names (unless they contain a person's name), settings and their values.

Give each area as a rectangle in pixels of the image you were given (x and y = top-left corner). Cover the whole text (the full cell or line) rather than cutting it off. Return an empty list when there is no personal data.`;

const MAX_W = 1280; // the model sees exactly this image, so its coordinates need no guessing

export async function findPersonalData({ cfg, buffer, client }) {
  const meta = await sharp(buffer).metadata();
  const scale = meta.width > MAX_W ? MAX_W / meta.width : 1;
  const w = Math.round(meta.width * scale); const h = Math.round(meta.height * scale);
  const small = scale === 1 ? buffer : await sharp(buffer).resize(w, h).jpeg({ quality: 80 }).toBuffer();
  const mime = scale === 1 && meta.format === 'png' ? 'image/png' : 'image/jpeg';
  const anthropic = client || (await createClient(cfg));
  const format = zodOutputFormat(Regions);
  const msg = await anthropic.messages.create({
    model: cfg.ai.model,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    output_config: { effort: cfg.ai.effort, format: { type: format.type, schema: format.schema } },
    system: SYSTEM,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mime, data: small.toString('base64') } },
      { type: 'text', text: `The image is ${w} x ${h} pixels. List the areas with personal data.` },
    ] }],
  });
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('The AI model declined to check this screenshot.'), { code: 'AI_REFUSAL' });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const { regions } = format.parse(text);
  // Back to the original resolution, with a margin so text edges are covered too.
  return regions.map((r) => ({ kind: r.kind, x: r.x / scale, y: r.y / scale, width: r.width / scale, height: r.height / scale }));
}

// Pixelates the given rectangles (in pixels of the original image). Returns the new image.
export async function blurRegions(buffer, regions, { pad = 6 } = {}) {
  const meta = await sharp(buffer).metadata();
  const boxes = regions.map((r) => {
    const left = Math.max(0, Math.floor(r.x - pad)); const top = Math.max(0, Math.floor(r.y - pad));
    const right = Math.min(meta.width, Math.ceil(r.x + r.width + pad)); const bottom = Math.min(meta.height, Math.ceil(r.y + r.height + pad));
    return { left, top, width: right - left, height: bottom - top };
  }).filter((b) => b.width > 1 && b.height > 1);
  if (!boxes.length) return { buffer, count: 0 };
  const overlays = await Promise.all(boxes.map(async (b) => {
    const tw = Math.max(1, Math.round(b.width / 12)); const th = Math.max(1, Math.round(b.height / 12));
    const tiny = await sharp(buffer).extract(b).resize(tw, th, { fit: 'fill' }).toBuffer();
    return { input: await sharp(tiny).resize(b.width, b.height, { fit: 'fill', kernel: 'nearest' }).blur(2).toBuffer(), left: b.left, top: b.top };
  }));
  const img = sharp(buffer).composite(overlays);
  const out = meta.format === 'png' ? await img.png().toBuffer() : await img.jpeg({ quality: 75 }).toBuffer();
  return { buffer: out, count: boxes.length };
}

// Checks one stored screenshot and overwrites it with the protected version.
export async function protectScreenshot({ cfg, path, client }) {
  const buffer = fs.readFileSync(path);
  const regions = await findPersonalData({ cfg, buffer, client });
  const { buffer: out, count } = await blurRegions(buffer, regions);
  if (count) fs.writeFileSync(path, out);
  return { count, kinds: [...new Set(regions.map((r) => r.kind))] };
}
