import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { attachMarks, annotateImage, marksFor, marksSvg } from '../../server/engine/annotate.js';
import { sanitizeEvent } from '../../server/engine/redact.js';
import { normalizeDoc } from '../../server/engine/schema.js';

const view = { vw: 1000, vh: 500, sx: 0, sy: 0 };
const url = 'https://admin.example.com/users';
const events = [
  { seq: 1, type: 'click', url, screenshotId: 'shot_a', element: { role: 'button', name: 'Add user' }, box: { ...view, x: 100, y: 50, w: 80, h: 30, px: 120, py: 60 } },
  { seq: 2, type: 'input', url, element: { role: 'textbox', name: 'Display name' }, box: { ...view, x: 300, y: 200, w: 200, h: 30 } },
  { seq: 3, type: 'key', url, text: 'Enter', element: { role: 'textbox', name: 'Display name' }, box: { ...view, x: 300, y: 200, w: 200, h: 30 } },
  // Page scrolled down by 100px: the button is drawn 100px lower on the screenshot taken before.
  { seq: 4, type: 'click', url, element: { role: 'button', name: 'Save' }, box: { ...view, sy: 100, x: 400, y: 300, w: 60, h: 30 } },
  // Scrolled out of the screenshot: no marker.
  { seq: 5, type: 'click', url, element: { role: 'button', name: 'Far below' }, box: { ...view, sy: 900, x: 10, y: 10, w: 60, h: 30 } },
  // Another page without a screenshot of it: no marker.
  { seq: 6, type: 'click', url: 'https://admin.example.com/other', element: { role: 'link', name: 'Other' }, box: { ...view, x: 10, y: 10, w: 60, h: 30 } },
];

test('clicks of a step are numbered in order on the step screenshot', () => {
  const doc = { steps: [{ screenshotIds: ['shot_a'], evidenceEventSeqs: [1, 2, 3, 4, 5, 6] }] };
  attachMarks(doc, events);
  const m = doc.steps[0].marks;
  assert.deepEqual(m.map((x) => [x.n, x.kind]), [[1, 'click'], [2, 'field'], [3, 'click']]);
  assert.equal(m[0].cx, 0.12); assert.equal(m[0].cy, 0.12); // the pointer position
  assert.equal(m[1].x, 0.3); assert.equal(m[1].w, 0.2); // the field frame
  assert.equal(m[2].cy, (300 + 100 + 15) / 500); // corrected for scrolling
  assert.equal(marksFor(doc, 'shot_a').length, 3);
  assert.equal(marksFor(doc, 'shot_b').length, 0);
  // Survives the schema (marks are kept, not stripped).
  const n = normalizeDoc({ steps: [{ title: 'x', marks: m }] });
  assert.equal(n.steps[0].marks.length, 3);
  assert.deepEqual(normalizeDoc({ steps: [{ title: 'y' }] }).steps[0].marks, []);
});

test('markers are drawn onto the screenshot', async () => {
  const blank = await sharp({ create: { width: 1000, height: 500, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
  const doc = { steps: [{ screenshotIds: ['shot_a'], evidenceEventSeqs: [1, 2] }] };
  attachMarks(doc, events);
  const out = await annotateImage(blank, doc.steps[0].marks);
  const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
  const [r, g, b] = px(174, 48); // inside the green number on the top-right corner of the clicked button, beside the digit
  assert.ok(g > 120 && r < 120 && b < 140, `expected green, got ${r},${g},${b}`);
  assert.deepEqual(px(900, 450).map((v) => v > 240), [true, true, true]); // untouched elsewhere
  assert.equal(await annotateImage(blank, []), blank);
  assert.match(marksSvg([{ n: 12, kind: 'click', cx: 0.5, cy: 0.5 }], 100, 100), /<path/);
});

test('the recorded element position is sanitised to numbers', () => {
  const ev = sanitizeEvent({ type: 'click', box: { x: 1.4, y: 2, w: 3, h: 4, vw: 800, vh: 600, sx: 0, sy: 10, px: 'evil', py: 5, extra: '<script>' } }, { sensitiveFieldPatterns: [], excludedApps: [], excludedUrls: [] });
  assert.deepEqual(ev.box, { x: 1, y: 2, w: 3, h: 4, vw: 800, vh: 600, sx: 0, sy: 10 });
  assert.equal(sanitizeEvent({ type: 'click', box: { x: 'a' } }, { sensitiveFieldPatterns: [], excludedApps: [], excludedUrls: [] }).box, undefined);
});

test('a crop cuts the shown screenshot after the markers are drawn', async () => {
  const { renderShot } = await import('../../server/engine/annotate.js');
  const img = await sharp({ create: { width: 1000, height: 500, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
  const out = await renderShot(img, [{ n: 1, kind: 'click', x: 0, y: 0, w: 0, h: 0, cx: 0.1, cy: 0.1 }], { x: 0, y: 0, w: 0.5, h: 0.4 });
  const m = await sharp(out).metadata();
  assert.deepEqual([m.width, m.height], [500, 200]);
  assert.equal(await renderShot(img, [], null), img, 'nothing to do: the original');
});

test('AI marker placement: pixels become ordered fractions, unknown and oversized boxes are dropped', async () => {
  const { locateMarks } = await import('../../server/engine/locate.js');
  const { loadConfig } = await import('../../server/config.js');
  const img = await sharp({ create: { width: 2560, height: 1440, channels: 3, background: '#ffffff' } }).png().toBuffer();
  let req;
  const client = { messages: { create: async (r) => { req = r; return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ elements: [
    { instruction: 2, kind: 'click', x: 640, y: 360, width: 64, height: 36 },
    { instruction: 1, kind: 'field', x: 128, y: 72, width: 256, height: 36 },
    { instruction: 9, kind: 'click', x: 1, y: 1, width: 5, height: 5 },
    { instruction: 1, kind: 'click', x: 0, y: 0, width: 1280, height: 720 },
  ], focus: { x: 64, y: 36, width: 640, height: 360 } }) }] }; } } };
  const marks = await locateMarks({ cfg: loadConfig(), buffer: img, instructions: ['Enter the name in "Display name".', 'Click "Save".'], client });
  assert.match(req.messages[0].content[1].text, /1280 x 720 pixels[\s\S]*2\. Click "Save"/);
  assert.deepEqual(marks.map((m) => [m.n, m.kind, m.x, m.y]), [[1, 'field', 0.1, 0.1], [2, 'click', 0.5, 0.5]]);
  assert.deepEqual(await locateMarks({ cfg: loadConfig(), buffer: img, instructions: [], client }), []);
  const { locateStep } = await import('../../server/engine/locate.js');
  const r = await locateStep({ cfg: loadConfig(), buffer: img, instructions: ['Click "Save".'], client });
  assert.deepEqual(r.focus, { x: 0.05, y: 0.05, w: 0.5, h: 0.5 });
});

test('automatic crop: around the markers with context, a document-friendly shape, never cutting a marker off', async () => {
  const { autoCrop, applyAutoCrops } = await import('../../server/engine/annotate.js');
  const marks = [{ x: 0.7, y: 0.6, w: 0.08, h: 0.04, cx: 0.74, cy: 0.62 }, { x: 0.82, y: 0.85, w: 0.06, h: 0.04, cx: 0.85, cy: 0.87 }];
  const c = autoCrop(marks, { width: 1600, height: 900 });
  assert.ok(c.auto);
  for (const m of marks) { assert.ok(m.x >= c.x && m.x + m.w <= c.x + c.w + 1e-9, 'x inside'); assert.ok(m.y >= c.y && m.y + m.h <= c.y + c.h + 1e-9, 'y inside'); }
  assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001, 'inside the image');
  assert.ok(c.w * c.h < 0.8 && c.w >= 0.42 && c.h >= 0.32);
  const ratio = (c.w * 1600) / (c.h * 900); assert.ok(ratio >= 4 / 3 - 0.01 && ratio <= 2.41, `shape ${ratio}`);
  assert.equal(autoCrop([]), null);
  assert.equal(autoCrop([{ x: 0.02, y: 0.02, w: 0.01, h: 0.01 }, { x: 0.95, y: 0.95, w: 0.02, h: 0.02 }]), null, 'markers all over the screen: no crop');
  const doc = { steps: [
    { screenshotIds: ['a', 'b'], marks: [{ shotId: 'a', ...marks[0] }], crops: [] },
    { screenshotIds: ['c'], marks: [{ shotId: 'c', ...marks[0] }], crops: [{ shotId: 'c', x: 0, y: 0, w: 0.5, h: 0.5 }] },
    { screenshotIds: ['d'], marks: [], crops: [] },
  ] };
  assert.equal(applyAutoCrops(doc, { focus: { d: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 } } }), 2);
  assert.equal(doc.steps[0].crops.length, 1, 'no markers on b: not cropped');
  assert.deepEqual(doc.steps[1].crops, [{ shotId: 'c', x: 0, y: 0, w: 0.5, h: 0.5 }], "the reviewer's own crop is kept");
  assert.equal(doc.steps[2].crops[0].shotId, 'd', 'the AI area is used without markers');
});
