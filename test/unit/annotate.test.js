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
