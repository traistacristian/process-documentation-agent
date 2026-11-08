// Personal data in screenshots: Claude (fake client here) finds the areas, sharp pixelates them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { blurRegions, findPersonalData, protectScreenshot } from '../../server/engine/privacy.js';
import { loadConfig } from '../../server/config.js';

// 2000 x 400 test image: left half black/white stripes (stands in for text), right half plain grey.
async function stripes() {
  const w = 2000; const h = 400; const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = x < 1000 ? ((x >> 2) % 2 ? 255 : 0) : 128; raw.fill(v, (y * w + x) * 3, (y * w + x) * 3 + 3); }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}
const pixel = async (buf, x, y) => { const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true }); return data[(y * info.width + x) * info.channels]; };
const variance = async (buf, box) => { const { data, info } = await sharp(buf).extract(box).greyscale().raw().toBuffer({ resolveWithObject: true }); const m = data.reduce((a, v) => a + v, 0) / data.length; return data.reduce((a, v) => a + (v - m) ** 2, 0) / data.length; void info; };

test('areas are pixelated so the text in them is unreadable; the rest of the image is untouched', async () => {
  const img = await stripes();
  const before = await variance(img, { left: 100, top: 100, width: 200, height: 100 });
  const { buffer, count } = await blurRegions(img, [{ x: 100, y: 100, width: 200, height: 100 }]);
  assert.equal(count, 1);
  const after = await variance(buffer, { left: 110, top: 110, width: 180, height: 80 });
  assert.ok(after < before / 10, `stripes are gone (variance ${before} -> ${after})`);
  assert.equal(await pixel(buffer, 1500, 200), 128, 'outside the area nothing changes');
  assert.equal((await blurRegions(img, [])).count, 0);
});

test('the model gets a downscaled image and its coordinates are mapped back to the original', async () => {
  const img = await stripes();
  let req;
  const client = { messages: { create: async (r) => { req = r; return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ regions: [{ kind: 'email', x: 64, y: 64, width: 128, height: 32 }] }) }] }; } } };
  const regions = await findPersonalData({ cfg: loadConfig(), buffer: img, client });
  assert.match(req.messages[0].content[1].text, /1280 x 256/);
  assert.equal(req.model, 'claude-haiku-5-5');
  assert.equal(req.output_config.effort, 'low');
  assert.deepEqual(regions[0], { kind: 'email', x: 100, y: 100, width: 200, height: 50 });
  const refused = { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } };
  await assert.rejects(findPersonalData({ cfg: loadConfig(), buffer: img, client: refused }));
});

test('a stored screenshot is overwritten with the protected version', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-priv-'));
  const p = path.join(dir, 'shot_ab.png'); const img = await stripes(); fs.writeFileSync(p, img);
  const client = { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"regions":[{"kind":"name","x":64,"y":64,"width":128,"height":32}]}' }] }) } };
  const r = await protectScreenshot({ cfg: loadConfig(), path: p, client });
  assert.deepEqual(r, { count: 1, kinds: ['name'] });
  assert.notDeepEqual(fs.readFileSync(p), img);
  fs.rmSync(dir, { recursive: true, force: true });
});
