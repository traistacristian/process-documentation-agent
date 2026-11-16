// Click markers on step screenshots. While recording, the browser add-in reports where each clicked
// element and each filled-in field was on the screen. For every step the clicks are numbered in the
// order they were made and placed on the step's screenshot: a numbered circle where the user clicked,
// a frame with a number around each field that was filled in or chosen. The markers are stored with
// the step (as fractions of the image, so they survive resizing) and drawn onto the image when it is
// shown in the app and when the Word document is rendered. The stored screenshot stays untouched.
import sharp from 'sharp';
import { DIGITS, DIGIT_HEIGHT } from './digits.js';

const MARKED = new Set(['click', 'input', 'change']);
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton', 'slider']);
export const MAX_MARKS_PER_STEP = 20;

const kindOf = (e) => (FIELD_ROLES.has(e.element?.role) ? 'field' : 'click');
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const r4 = (v) => Math.round(v * 10000) / 10000;

// Where box `b` (recorded with event e) lies on the screenshot taken with viewport `view`.
// Returns fractions of the image, or null when the element was not visible on that screenshot.
function place(b, view) {
  if (Math.abs(b.vw - view.vw) > 4 || Math.abs(b.vh - view.vh) > 4) return null; // window was resized
  const dx = b.sx - view.sx; const dy = b.sy - view.sy; // page scrolled between screenshot and click
  const x = b.x + dx; const y = b.y + dy;
  const cx = Number.isFinite(b.px) ? b.px + dx : x + b.w / 2;
  const cy = Number.isFinite(b.py) ? b.py + dy : y + b.h / 2;
  if (cx < 0 || cy < 0 || cx > view.vw || cy > view.vh) return null;
  const x0 = clamp01(x / view.vw); const y0 = clamp01(y / view.vh);
  const x1 = clamp01((x + b.w) / view.vw); const y1 = clamp01((y + b.h) / view.vh);
  return { x: r4(x0), y: r4(y0), w: r4(x1 - x0), h: r4(y1 - y0), cx: r4(cx / view.vw), cy: r4(cy / view.vh) };
}

// Adds `marks` to every step of the document from the recorded events behind it.
export function attachMarks(doc, events) {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const origin = new Map(); // screenshot id -> the event it was taken with
  for (const e of events) if (e.screenshotId && !origin.has(e.screenshotId)) origin.set(e.screenshotId, e);
  for (const step of doc.steps) {
    const shots = (step.screenshotIds || []).map((id) => ({ id, ev: origin.get(id) })).filter((s) => s.ev);
    const marks = []; let n = 0; let prev = null;
    for (const seq of step.evidenceEventSeqs || []) {
      const e = bySeq.get(seq);
      if (!e || !MARKED.has(e.type) || !e.box) continue;
      const kind = kindOf(e);
      // Clicking into a field and then typing / choosing in it is one action: one number.
      const key = `${e.url}|${e.box.x + e.box.sx},${e.box.y + e.box.sy},${e.box.w},${e.box.h}`;
      if (prev && prev.key === key) { if (kind === 'field') prev.mark.kind = 'field'; continue; }
      // The screenshot that shows this page: the latest one taken at or before the action, else the next one.
      const same = shots.filter((s) => s.ev.url === e.url);
      const shot = [...same].reverse().find((s) => s.ev.seq <= e.seq) || same[0];
      if (!shot) { prev = null; continue; }
      const view = shot.ev.box || { vw: e.box.vw, vh: e.box.vh, sx: e.box.sx, sy: e.box.sy };
      const pos = place(e.box, view);
      if (!pos) { prev = null; continue; }
      const mark = { shotId: shot.id, n: ++n, kind, ...pos };
      marks.push(mark); prev = { key, mark };
      if (marks.length >= MAX_MARKS_PER_STEP) break;
    }
    step.marks = marks;
  }
  return doc;
}

// Automatic crop: the part of the screenshot a reader needs for the step, around the elements that are
// clicked or filled in (and the area the AI named as relevant), with enough margin to show the
// surrounding labels and headings. Fractions of the image; null when cropping would hardly help.
export function autoCrop(boxes, { width = 1600, height = 900 } = {}) {
  const items = (boxes || []).filter((b) => b && [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w >= 0 && b.h >= 0);
  if (!items.length) return null;
  let x0 = Math.min(...items.map((b) => Math.min(b.x, b.cx ?? b.x)));
  let y0 = Math.min(...items.map((b) => Math.min(b.y, b.cy ?? b.y)));
  let x1 = Math.max(...items.map((b) => Math.max(b.x + b.w, b.cx ?? 0)));
  let y1 = Math.max(...items.map((b) => Math.max(b.y + b.h, b.cy ?? 0)));
  // Margin for context (labels, the panel's heading), then a sensible minimum size.
  const mx = 0.08 + (x1 - x0) * 0.1; const my = 0.1 + (y1 - y0) * 0.1;
  // More room above than below: the heading and labels that say where on the page this is sit above.
  x0 -= mx; x1 += mx; y0 -= my * 1.5; y1 += my * 0.6;
  const grow = (a0, a1, min, up = 0.5) => { const d = Math.max(0, min - (a1 - a0)); return [a0 - d * up, a1 + d * (1 - up)]; };
  [x0, x1] = grow(x0, x1, 0.42); [y0, y1] = grow(y0, y1, 0.32, 0.65);
  // Keep a document-friendly shape (between 4:3 and 2.4:1 in pixels).
  const ratio = ((x1 - x0) * width) / ((y1 - y0) * height);
  if (ratio < 4 / 3) [x0, x1] = grow(x0, x1, ((y1 - y0) * height * (4 / 3)) / width);
  if (ratio > 2.4) [y0, y1] = grow(y0, y1, ((x1 - x0) * width) / 2.4 / height, 0.65);
  // Slide the window back inside the image.
  const fit = (a0, a1) => { const len = Math.min(1, a1 - a0); let s0 = Math.max(0, Math.min(a0, 1 - len)); return [s0, s0 + len]; };
  [x0, x1] = fit(x0, x1); [y0, y1] = fit(y0, y1);
  const w = x1 - x0; const h = y1 - y0;
  if (w * h > 0.8) return null; // almost the whole screen anyway
  const r = (v) => Math.round(v * 10000) / 10000;
  return { x: r(x0), y: r(y0), w: r(w), h: r(h), auto: true };
}

// Adds an automatic crop to every step screenshot that has none yet (a reviewer's own crop is kept).
// focus: optional { [shotId]: box } of areas the AI named as relevant. sizes: { [shotId]: {width,height} }.
export function applyAutoCrops(doc, { focus = {}, sizes = {}, replace = false } = {}) {
  let n = 0;
  for (const st of doc.steps) {
    st.crops = (st.crops || []).filter((c) => !replace || !c.auto);
    for (const id of st.screenshotIds || []) {
      if (st.crops.some((c) => c.shotId === id)) continue;
      const boxes = [...(st.marks || []).filter((m) => m.shotId === id), ...(focus[id] ? [focus[id]] : [])];
      const crop = autoCrop(boxes, sizes[id]);
      if (crop) { st.crops.push({ shotId: id, ...crop }); n++; }
    }
  }
  return n;
}

// Pixel sizes of screenshots, so automatic crops keep a good shape. { [shotId]: {width,height} }
export async function imageSizes(entries) {
  const out = {};
  for (const [id, p] of entries) { try { const m = await sharp(p).metadata(); out[id] = { width: m.width, height: m.height }; } catch { /* unknown size: default shape */ } }
  return out;
}

export const cropFor = (doc, shotId) => (doc?.steps || []).flatMap((s) => ((s.screenshotIds || []).includes(shotId) ? (s.crops || []).filter((c) => c.shotId === shotId) : []))[0] || null;
export const marksFor = (doc, shotId) => (doc?.steps || []).flatMap((s) => (s.screenshotIds || []).includes(shotId) ? (s.marks || []).filter((m) => m.shotId === shotId) : []);

const GREEN = '#2FA84F'; const GREEN_DARK = '#1E6E34';

function numberPath(n, cx, cy, size) {
  const chars = String(n).split('');
  const width = chars.reduce((w, c) => w + DIGITS[c].adv, 0);
  const s = size / DIGIT_HEIGHT;
  let x = cx - (width * s) / 2; const y = cy + size / 2;
  return chars.map((c) => { const p = `<path transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${s.toFixed(4)})" d="${DIGITS[c].d}" fill="#fff"/>`; x += DIGITS[c].adv * s; return p; }).join('');
}

function badge(n, cx, cy, r) {
  return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(r + r * 0.12).toFixed(1)}" fill="#fff"/>`
    + `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${GREEN}" stroke="${GREEN_DARK}" stroke-width="${(r * 0.08).toFixed(1)}"/>`
    + numberPath(n, cx, cy, r * (n > 9 ? 0.8 : 0.95));
}

// Fields and clicked buttons, links, tabs… get a green frame with the number on its top-right corner, so
// the number never hides the element's text (labels are usually on the left or above). A click into a
// large area (a table row, a panel) gets a numbered circle where the pointer was instead.
export function marksSvg(marks, W, H) {
  const k = Math.max(0.6, W / 1280); // marker size follows the screenshot resolution
  const r = 15 * k;
  const frames = []; const badges = [];
  const f1 = (v) => v.toFixed(1);
  for (const m of marks) {
    const framed = m.w > 0 && m.h > 0 && (m.kind === 'field' || (m.w < 0.4 && m.h < 0.2));
    if (framed) {
      const stroke = (m.kind === 'field' ? 3 : 2.5) * k;
      const x = m.x * W - stroke; const y = m.y * H - stroke; const w = m.w * W + 2 * stroke; const h = m.h * H + 2 * stroke;
      const rect = (color, sw, extra = '') => `<rect x="${f1(x)}" y="${f1(y)}" width="${f1(w)}" height="${f1(h)}" rx="${f1(3 * k)}" fill="none" stroke="${color}" stroke-width="${f1(sw)}"${extra}/>`;
      frames.push(rect('#fff', stroke + 2 * k, ' opacity=".8"') + rect(GREEN, stroke));
      badges.push(badge(m.n, Math.min(W - r, Math.max(r, x + w)), Math.min(H - r, Math.max(r, y)), r));
    } else {
      badges.push(badge(m.n, Math.min(W - r, Math.max(r, m.cx * W)), Math.min(H - r, Math.max(r, m.cy * H)), r));
    }
  }
  // Frames first, numbered circles on top of them.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${frames.join('')}${badges.join('')}</svg>`;
}

// The screenshot as shown in documents: markers drawn, then cut to the chosen part (crop, as fractions).
export async function renderShot(buffer, marks, crop) {
  const drawn = await annotateImage(buffer, marks);
  if (!crop || !(crop.w > 0 && crop.h > 0) || (crop.x <= 0 && crop.y <= 0 && crop.w >= 1 && crop.h >= 1)) return drawn;
  const meta = await sharp(drawn).metadata();
  const left = Math.max(0, Math.round(crop.x * meta.width)); const top = Math.max(0, Math.round(crop.y * meta.height));
  const width = Math.min(meta.width - left, Math.round(crop.w * meta.width)); const height = Math.min(meta.height - top, Math.round(crop.h * meta.height));
  if (width < 8 || height < 8) return drawn;
  const out = sharp(drawn).extract({ left, top, width, height });
  return meta.format === 'png' ? out.png().toBuffer() : out.jpeg({ quality: 88 }).toBuffer();
}

// Draws the markers onto the image. Returns the original buffer when there is nothing to draw.
export async function annotateImage(buffer, marks) {
  if (!marks?.length) return buffer;
  const img = sharp(buffer); const meta = await img.metadata();
  if (!meta.width || !meta.height) return buffer;
  const svg = Buffer.from(marksSvg(marks, meta.width, meta.height));
  const out = img.composite([{ input: svg, left: 0, top: 0 }]);
  return meta.format === 'png' ? out.png().toBuffer() : out.jpeg({ quality: 85 }).toBuffer();
}
