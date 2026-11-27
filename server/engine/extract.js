// Reads the process described in an uploaded file: a written work instruction, a slide deck, a
// PDF guide, plain text or a subtitle file. The text is returned as ordered blocks (headings,
// paragraphs, list items, images) that become note, mark and screenshot events, so the uploaded
// content goes through the same generation, guardrails and review as a recording.
//
// Everything runs locally on the server: no file is sent anywhere to be read. The original file
// is not kept; only the extracted text (redacted) and the images (checked for personal data) are.
import zlib from 'node:zlib';
import sharp from 'sharp';
import { parseVtt } from '../teams.js';

export const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'pptx', 'txt', 'md', 'markdown', 'csv', 'html', 'htm', 'vtt', 'srt'];
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv'];
const LEGACY = { doc: 'Word 97-2003 (.doc)', ppt: 'PowerPoint 97-2003 (.ppt)', xls: 'Excel', xlsx: 'Excel', rtf: 'RTF', odt: 'OpenDocument', odp: 'OpenDocument' };

const MAX_ENTRY = 60 * 1024 * 1024; // largest file inside a .docx/.pptx we unpack (zip bomb guard)
const MAX_TEXT = 300_000; // characters of text taken from one file
const MIN_IMAGE = { w: 160, h: 100 }; // smaller images are icons, logos or bullets
const bad = (message) => Object.assign(new Error(message), { status: 422 });

const ext = (name) => (/\.([a-z0-9]+)$/i.exec(String(name || '')) || [])[1]?.toLowerCase() || '';

// Decides how to read the file, by its content first (the name can be wrong) and its name second.
export function detectType(fileName, buf) {
  const e = ext(fileName);
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
    const names = zipEntries(buf).map((x) => x.name);
    if (names.includes('word/document.xml')) return 'docx';
    if (names.includes('ppt/presentation.xml')) return 'pptx';
    throw bad(LEGACY[e] ? `${LEGACY[e]} files are not supported. Save the file as PDF or Word (.docx) and upload it again.` : 'This archive is not a Word (.docx) or PowerPoint (.pptx) file.');
  }
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0) throw bad(`${LEGACY[e] || 'Office 97-2003'} files are not supported. Save the file as .docx, .pptx or PDF and upload it again.`);
  if (LEGACY[e]) throw bad(`${LEGACY[e]} files are not supported. Save the file as PDF, Word (.docx) or PowerPoint (.pptx) and upload it again.`);
  if (VIDEO_EXTENSIONS.includes(e)) throw bad('Videos are read in the browser: choose "Video" to upload a screen recording.');
  if (buf.subarray(0, 4096).includes(0)) throw bad('This file type is not supported. Upload a PDF, Word (.docx), PowerPoint (.pptx), text, Markdown, HTML or subtitle (.vtt/.srt) file.');
  const head = buf.subarray(0, 200).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (e === 'vtt' || head.startsWith('WEBVTT')) return 'vtt';
  if (e === 'srt' || /^\d+\r?\n\d\d:\d\d:\d\d[,.]\d{3}\s*-->/.test(head)) return 'srt';
  if (['html', 'htm'].includes(e) || /^<(!doctype html|html)/i.test(head)) return 'html';
  if (e === 'md' || e === 'markdown') return 'markdown';
  return 'text';
}

// Returns { type, title, blocks: [{ type: 'heading'|'text'|'item'|'image', text, level, image, ms }], warnings }.
export async function extractDocument({ buf, fileName, maxImages = 40 }) {
  if (!buf?.length) throw bad('The file is empty.');
  const type = detectType(fileName, buf);
  const out = type === 'pdf' ? await readPdf(buf, maxImages)
    : type === 'docx' ? readDocx(buf, maxImages)
      : type === 'pptx' ? readPptx(buf, maxImages)
        : type === 'vtt' || type === 'srt' ? readSubtitles(buf, type)
          : type === 'html' ? readHtml(buf.toString('utf8'))
            : readText(buf.toString('utf8'), type === 'markdown');
  const blocks = await keepUsefulImages(limitText(out.blocks));
  if (!blocks.some((b) => b.type !== 'image' && b.text?.trim())) {
    throw bad(type === 'pdf' ? 'No text was found in this PDF. It is probably a scan: upload the original document, or a PDF with selectable text.' : 'No text was found in this file.');
  }
  return { type, title: cleanTitle(out.title) || firstHeading(blocks) || '', blocks, warnings: out.warnings || [] };
}

const firstHeading = (blocks) => cleanTitle(blocks.find((b) => b.type === 'heading')?.text);
const cleanTitle = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 200);

function limitText(blocks) {
  let total = 0; const out = [];
  for (const b of blocks) {
    if (b.type !== 'image') {
      const text = String(b.text || '').replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
      if (!text) continue;
      total += text.length;
      if (total > MAX_TEXT) break;
      out.push({ ...b, text });
    } else out.push(b);
  }
  return out;
}

// Normalises images to PNG/JPEG and drops icons and tiny pictures.
async function keepUsefulImages(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type !== 'image') { out.push(b); continue; }
    try {
      const img = sharp(b.image.buf, { failOn: 'none', limitInputPixels: 80_000_000 });
      const m = await img.metadata();
      if (!m.width || !m.height || m.width < MIN_IMAGE.w || m.height < MIN_IMAGE.h) continue;
      const jpeg = m.format === 'jpeg';
      const buf = jpeg || m.format === 'png' ? b.image.buf : await img.png().toBuffer();
      out.push({ ...b, image: { buf, mime: jpeg ? 'image/jpeg' : 'image/png', width: m.width, height: m.height } });
    } catch { /* an image format sharp cannot read (EMF/WMF): skipped */ }
  }
  return out;
}

// ------------------------------------------------------------------ zip (docx, pptx)
export function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw bad('The file is damaged (it is not a complete Office file).');
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10); const size = buf.readUInt32LE(p + 20); const raw = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28); const extra = buf.readUInt16LE(p + 30); const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    out.push({ name: buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'), method, size, raw, local });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

function openZip(buf) {
  const entries = new Map(zipEntries(buf).map((e) => [e.name, e]));
  const read = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    if (e.raw > MAX_ENTRY) throw bad('The file contains a part that is too large to read.');
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const data = buf.subarray(start, start + e.size);
    if (e.method === 0) return Buffer.from(data);
    if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY });
    return null;
  };
  return { names: [...entries.keys()], read, text: (name) => read(name)?.toString('utf8') ?? null };
}

// ------------------------------------------------------------------ xml helpers
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decodeXml = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
  return ENTITIES[e.toLowerCase()] ?? m;
});
const attr = (xml, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(xml); return m ? decodeXml(m[1]) : null; };
function relationships(xml) {
  const out = new Map();
  for (const m of String(xml || '').matchAll(/<Relationship\b[^>]*>/g)) out.set(attr(m[0], 'Id'), { target: attr(m[0], 'Target'), type: attr(m[0], 'Type') || '', external: attr(m[0], 'TargetMode') === 'External' });
  return out;
}
const resolvePath = (baseDir, target) => {
  const parts = (target.startsWith('/') ? target.slice(1) : `${baseDir}/${target}`).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
};

// ------------------------------------------------------------------ Word
const HEADING_STYLE = /^(heading|überschrift|berschrift|titre|título|titolo|kop)\s*(\d)/i;
const TITLE_STYLE = /^(title|titel|titre|título|titolo)$/i;

function readDocx(buf, maxImages) {
  const z = openZip(buf);
  const xml = z.text('word/document.xml');
  const rels = relationships(z.text('word/_rels/document.xml.rels'));
  const styles = new Map();
  for (const m of String(z.text('word/styles.xml') || '').matchAll(/<w:style\b[^>]*>[\s\S]*?<\/w:style>/g)) {
    const id = attr(m[0], 'w:styleId'); const name = attr(/<w:name\b[^>]*>/.exec(m[0])?.[0] || '', 'w:val');
    if (id) styles.set(id, name || id);
  }
  const title = decodeXml(/<dc:title>([\s\S]*?)<\/dc:title>/.exec(z.text('docProps/core.xml') || '')?.[1] || '');
  const blocks = []; let images = 0;
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] || '';
  const PARA = /<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g;
  const paraText = (p) => decodeXml(p.replace(/<w:tab\/>/g, ' ').replace(/<w:(br|cr)\b[^>]*\/>/g, '\n').replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<[^>]+>/g, (x, t) => t ?? '')).trim();
  // Pictures in a paragraph or table, in order.
  const pictures = (xml) => {
    for (const b of xml.matchAll(/<a:blip\b[^>]*r:embed="([^"]+)"/g)) {
      const r = rels.get(b[1]);
      if (!r || r.external || images >= maxImages * 2) continue;
      const data = z.read(resolvePath('word', r.target));
      if (data) { blocks.push({ type: 'image', image: { buf: data } }); images++; }
    }
  };
  for (const m of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    // Tables: one line per row, "label: value" for two columns.
    if (m[0].startsWith('<w:tbl>')) {
      for (const row of m[0].matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)) {
        const raw = [...row[1].matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((c) => [...c[1].matchAll(PARA)].map((x) => paraText(x[1] || '')).filter(Boolean).join(' '));
        const cells = raw.filter((c) => c && c !== '–' && c !== '-');
        pictures(row[1]);
        if (cells.length && !(raw.length > 1 && cells.length === 1)) blocks.push({ type: 'text', text: cells.length === 2 ? `${cells[0]}: ${cells[1]}` : cells.join(' | '), table: true });
      }
      continue;
    }
    const p = m[1] || '';
    const pPr = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(p)?.[1] || '';
    const styleId = attr(/<w:pStyle\b[^>]*>/.exec(pPr)?.[0] || '', 'w:val') || '';
    const styleName = styles.get(styleId) || styleId;
    const outline = attr(/<w:outlineLvl\b[^>]*>/.exec(pPr)?.[0] || '', 'w:val');
    const text = paraText(p);
    pictures(p);
    if (!text) continue;
    const hs = HEADING_STYLE.exec(styleName);
    const runs = [...p.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)].filter((r) => /<w:t\b/.test(r[1]));
    const allBold = runs.length > 0 && runs.every((r) => /<w:b\/>|<w:b w:val="(1|true|on)"\/>/.test(r[1]));
    if (TITLE_STYLE.test(styleName)) blocks.push({ type: 'heading', level: 0, text });
    else if (hs) blocks.push({ type: 'heading', level: Number(hs[2]), text });
    else if (outline != null && Number(outline) < 6) blocks.push({ type: 'heading', level: Number(outline) + 1, text });
    else if (/<w:numPr>/.test(pPr) || /list/i.test(styleName)) blocks.push({ type: 'item', text });
    // Documents formatted by hand: a short, bold line on its own is a heading.
    else if (allBold && text.length <= 90 && !/[.:;,]$/.test(text) && !text.includes('\n')) blocks.push({ type: 'heading', level: 2, text, guessed: true });
    else blocks.push({ type: 'text', text });
  }
  // Bold lines only count as headings in documents without real heading styles.
  const styled = blocks.some((b) => b.type === 'heading' && !b.guessed);
  return { title, blocks: styled ? blocks.map((b) => (b.guessed ? { type: 'text', text: b.text } : b)) : blocks };
}

// ------------------------------------------------------------------ PowerPoint
function readPptx(buf, maxImages) {
  const z = openZip(buf);
  const pres = z.text('ppt/presentation.xml') || '';
  const presRels = relationships(z.text('ppt/_rels/presentation.xml.rels'));
  let slides = [...pres.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => presRels.get(m[1])?.target).filter(Boolean).map((t) => resolvePath('ppt', t));
  if (!slides.length) slides = z.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(/(\d+)\.xml/.exec(a)[1]) - Number(/(\d+)\.xml/.exec(b)[1]));
  const title = decodeXml(/<dc:title>([\s\S]*?)<\/dc:title>/.exec(z.text('docProps/core.xml') || '')?.[1] || '');
  const paragraphs = (xml) => [...String(xml).matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((m) => decodeXml(m[1].replace(/<a:br\b[^>]*\/>/g, '\n').replace(/<a:t>([\s\S]*?)<\/a:t>|<[^>]+>/g, (x, t) => t ?? '')).trim()).filter(Boolean);
  const blocks = []; let images = 0;
  slides.forEach((path, i) => {
    const xml = z.text(path); if (!xml) return;
    const dir = path.split('/').slice(0, -1).join('/');
    const rels = relationships(z.text(`${dir}/_rels/${path.split('/').pop()}.rels`));
    if (/<p:sld\b[^>]*\bshow="0"/.test(xml)) return; // hidden slide
    let heading = ''; const body = [];
    for (const sp of xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
      const ph = attr(/<p:ph\b[^>]*>/.exec(sp[1])?.[0] || '', 'type');
      const paras = paragraphs(sp[1]);
      if (!paras.length || ['sldNum', 'dt', 'ftr'].includes(ph)) continue;
      if (!heading && (ph === 'title' || ph === 'ctrTitle')) heading = paras.join(' ');
      else body.push(...paras);
    }
    for (const t of xml.matchAll(/<a:tbl>([\s\S]*?)<\/a:tbl>/g)) body.push(...paragraphs(t[1]));
    blocks.push({ type: 'heading', level: 2, text: heading || `Slide ${i + 1}`, slide: i + 1 });
    for (const t of body) blocks.push({ type: /^\s*(\d+[.)]|[-•*])\s/.test(t) ? 'item' : 'text', text: t });
    for (const b of xml.matchAll(/<a:blip\b[^>]*r:embed="([^"]+)"/g)) {
      const r = rels.get(b[1]);
      if (!r || r.external || images >= maxImages * 2) continue;
      const data = z.read(resolvePath(dir, r.target));
      if (data) { blocks.push({ type: 'image', image: { buf: data } }); images++; }
    }
    // Speaker notes often hold the actual explanation.
    const notesRel = [...rels.values()].find((r) => r.type.endsWith('/notesSlide'));
    if (notesRel) {
      const nx = z.text(resolvePath(dir, notesRel.target)) || '';
      const notes = [...nx.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)].filter((sp) => !['sldNum', 'sldImg', 'hdr', 'ftr', 'dt'].includes(attr(/<p:ph\b[^>]*>/.exec(sp[1])?.[0] || '', 'type'))).flatMap((sp) => paragraphs(sp[1]));
      for (const t of notes) blocks.push({ type: 'text', text: t, speakerNotes: true });
    }
  });
  return { title, blocks };
}

// ------------------------------------------------------------------ PDF
async function readPdf(buf, maxImages) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let doc; let task;
  try {
    task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false });
    doc = await task.promise;
  } catch (e) {
    if (e?.name === 'PasswordException') throw bad('This PDF is password-protected. Remove the password and upload it again.');
    throw bad(`The PDF could not be read (${e.message}).`);
  }
  const meta = await doc.getMetadata().catch(() => null);
  const pages = [];
  for (let n = 1; n <= Math.min(doc.numPages, 300); n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    const lines = []; let cur = null;
    for (const it of tc.items) {
      if (typeof it.str !== 'string') continue;
      const y = it.transform[5]; const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 0;
      if (!cur || Math.abs(cur.y - y) > Math.max(2, size * 0.5)) { cur = { y, size, text: '' }; lines.push(cur); }
      cur.text += it.str; cur.size = Math.max(cur.size, size);
      if (it.hasEOL) cur = null;
    }
    const images = [];
    if (maxImages > 0) {
      const ops = await page.getOperatorList();
      let last = null;
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        if (fn === pdfjs.OPS.transform) last = ops.argsArray[i];
        if (fn !== pdfjs.OPS.paintImageXObject) continue;
        const name = ops.argsArray[i][0];
        const objs = String(name).startsWith('g_') ? page.commonObjs : page.objs;
        const img = await new Promise((r) => { try { objs.get(name, r); } catch { r(null); } setTimeout(() => r(null), 5000).unref?.(); });
        const png = await pdfImage(img);
        if (png) images.push({ y: last ? last[5] + last[3] : null, buf: png });
      }
    }
    pages.push({ lines: lines.filter((l) => l.text.trim()), images });
    page.cleanup();
  }
  await task.destroy();
  // Headings: lines clearly larger than the body text of the document.
  const sizes = pages.flatMap((p) => p.lines.map((l) => Math.round(l.size * 10) / 10)).sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)] || 10;
  // Lines that repeat on most pages are headers and footers.
  const repeats = new Map();
  for (const p of pages) for (const l of new Set(p.lines.map((x) => x.text.trim().replace(/\d+/g, '#')))) repeats.set(l, (repeats.get(l) || 0) + 1);
  const furniture = (t) => pages.length >= 3 && repeats.get(t.trim().replace(/\d+/g, '#')) >= Math.ceil(pages.length * 0.6);
  const blocks = []; let imageCount = 0;
  for (const p of pages) {
    const items = [...p.lines.map((l) => ({ kind: 'line', y: l.y, l })), ...p.images.map((im) => ({ kind: 'image', y: im.y ?? -Infinity, im }))].sort((a, b) => b.y - a.y);
    let para = null;
    const flush = () => { if (para) blocks.push(para); para = null; };
    for (const it of items) {
      if (it.kind === 'image') { flush(); if (imageCount++ < maxImages * 2) blocks.push({ type: 'image', image: { buf: it.im.buf } }); continue; }
      const { l } = it; const t = l.text.trim();
      if (furniture(t)) continue;
      const heading = l.size >= body * 1.2 && t.length <= 120;
      const item = /^(\d+[.)]|step \d+|schritt \d+|[-•▪●◦*])\s*/i.test(t);
      if (heading) {
        flush();
        const level = l.size >= body * 1.6 ? 1 : 2; const prev = blocks.at(-1);
        // A heading that wraps onto a second line.
        if (prev?.type === 'heading' && prev.level === level && prev.lastY - l.y < l.size * 1.6) { prev.text += ` ${t}`; prev.lastY = l.y; continue; }
        blocks.push({ type: 'heading', level, text: t, lastY: l.y }); continue;
      }
      // A new paragraph after a list item, a gap, or a line that ends a sentence.
      const gap = para && para.lastY - l.y > l.size * 1.8;
      if (!para || item || gap || para.type === 'item' && /[.:!?]$/.test(para.text)) { flush(); para = { type: item ? 'item' : 'text', text: t, lastY: l.y }; continue; }
      para.text = para.text.endsWith('-') ? para.text.slice(0, -1) + t : `${para.text} ${t}`; para.lastY = l.y;
    }
    flush();
  }
  const title = cleanTitle(meta?.info?.Title);
  return { title: /^(untitled|microsoft word|document\d*)/i.test(title) ? '' : title, blocks: blocks.map(({ lastY, ...b }) => b) };
}

async function pdfImage(img) {
  if (!img?.width || !img?.height || img.width < MIN_IMAGE.w || img.height < MIN_IMAGE.h || !img.data) return null;
  const channels = img.kind === 3 ? 4 : img.kind === 2 ? 3 : 0;
  if (!channels || img.data.length < img.width * img.height * channels) return null;
  return sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.width * img.height * channels), { raw: { width: img.width, height: img.height, channels } }).png().toBuffer();
}

// ------------------------------------------------------------------ text, Markdown, HTML, subtitles
function readText(text, markdown) {
  const blocks = [];
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  for (const para of src.split(/\n\s*\n/)) {
    const lines = para.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
    let buf = [];
    const flush = () => { if (buf.length) blocks.push({ type: 'text', text: buf.join(' ') }); buf = []; };
    for (const line of lines) {
      const h = markdown || /^#{1,6}\s/.test(line) ? /^(#{1,6})\s+(.+?)\s*#*$/.exec(line) : null;
      if (h) { flush(); blocks.push({ type: 'heading', level: h[1].length, text: h[2] }); continue; }
      if (/^\s*(\d+[.)]|[-*•]|step \d+:?|schritt \d+:?)\s+/i.test(line)) { flush(); blocks.push({ type: 'item', text: line.trim() }); continue; }
      if (/^\s{2,}\S/.test(line) && blocks.at(-1)?.type === 'item' && !buf.length) { blocks.at(-1).text += ` ${line.trim()}`; continue; }
      buf.push(line.trim());
    }
    flush();
    // Plain text: a short line on its own, followed by more text, works like a heading ("Step 2 - Assign the licence").
  }
  if (!markdown) {
    for (let i = 0; i < blocks.length - 1; i++) {
      const b = blocks[i];
      if (b.type === 'text' && b.text.length <= 80 && !/[.,;]$/.test(b.text) && blocks[i + 1].type !== 'heading') blocks[i] = { type: 'heading', level: 2, text: b.text.replace(/:$/, ''), guessed: true };
    }
  }
  return { title: '', blocks: blocks.map((b) => ({ ...b, text: markdown ? stripMarkdown(b.text) : b.text })) };
}
const stripMarkdown = (t) => t.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/`([^`]+)`/g, '"$1"');

function readHtml(html) {
  const clean = html.replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const title = decodeXml(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').trim();
  const blocks = [];
  for (const m of clean.matchAll(/<(h[1-6]|p|li|td|th|pre|blockquote|dt|dd|div)\b[^>]*>([\s\S]*?)(?=<\/?(?:h[1-6]|p|li|td|th|pre|blockquote|dt|dd|div|ul|ol|table|tr)\b)/gi)) {
    const text = decodeXml(m[2].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').trim();
    if (!text) continue;
    const tag = m[1].toLowerCase();
    blocks.push(tag[0] === 'h' && tag.length === 2 ? { type: 'heading', level: Number(tag[1]), text } : { type: tag === 'li' ? 'item' : 'text', text });
  }
  return { title, blocks: blocks };
}

function readSubtitles(buf, type) {
  let src = buf.toString('utf8').replace(/^\uFEFF/, '').replace(/\r/g, '');
  if (type === 'srt') src = src.replace(/(\d\d:\d\d:\d\d),(\d{3})/g, '$1.$2');
  const lines = parseVtt(src);
  if (!lines.length) throw bad('No subtitles were found in this file.');
  return { title: '', blocks: lines.map((l) => ({ type: 'text', text: `${l.speaker ? `${l.speaker}: ` : ''}${l.text}`, ms: l.ms, speaker: l.speaker, said: l.text })), transcript: true };
}

// ------------------------------------------------------------------ blocks -> capture events
const LABEL_MAX = 90;
const STEP_WORD = /^\s*(step|schritt)\s*\d+\b/i;
const STEPS_SECTION = /^(steps|procedure|process steps|process execution|instructions|step[- ]by[- ]step|how to|schritte|vorgehen|vorgehensweise|durchführung|ablauf|anleitung|prozessschritte|arbeitsschritte)\b/i;
// A short step title from a list item or a paragraph: the first sentence, without its number.
export function stepLabel(text) {
  const t = String(text).replace(/^\s*((\d+(\.\d+)*[.)]?|step \d+|schritt \d+)\s*[:.)–—-]?|[-–—•*▪●◦])\s*/i, '').trim();
  const first = t.split(/(?<=[.!?])\s|\n/)[0].replace(/[.:]$/, '');
  return first.length <= LABEL_MAX ? first : `${first.slice(0, LABEL_MAX - 1).replace(/\s+\S*$/, '')}…`;
}

// Long paragraphs are split at sentence boundaries into notes of at most 1000 characters.
export function chunkText(text, max = 1000) {
  const out = []; let cur = '';
  for (const s of String(text).split(/(?<=[.!?])\s+/)) {
    if (cur && cur.length + s.length + 1 > max) { out.push(cur); cur = ''; }
    cur = cur ? `${cur} ${s}` : s;
    while (cur.length > max) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur) out.push(cur);
  return out;
}

// Turns the blocks of a document into the events the engines understand. Headings start steps
// ("mark" events with the heading as the step title); when a document has no headings, every
// list item (or, failing that, every paragraph) starts a step. Text becomes notes. The first
// picture of a step becomes its screenshot: saveImage(block) stores it and returns its id.
export function documentEvents(blocks, { t0, source = 'upload', saveImage = () => null, title = '' }) {
  const events = []; let ts = t0;
  const push = (e) => { const x = { ts: (ts += 1000), source, ...e }; events.push(x); return x; };
  const headings = blocks.filter((b) => b.type === 'heading');
  // The document's own title is not a step.
  const titleIdx = blocks.findIndex((b) => b.type === 'heading');
  const lowest = Math.min(...headings.slice(1).map((h) => h.level ?? 9));
  const skipTitle = titleIdx >= 0 && (blocks[titleIdx].level === 0 || (headings.length > 1 && (blocks[titleIdx].level ?? 9) < lowest)
    || cleanTitle(blocks[titleIdx].text).toLowerCase() === cleanTitle(title).toLowerCase());
  // A section called "Steps", "Procedure", "Vorgehen"…: only the headings inside it are steps; the
  // other sections (purpose, prerequisites…) are context, kept as notes.
  const si = blocks.findIndex((b) => b.type === 'heading' && STEPS_SECTION.test(stepLabel(b.text)));
  let sectionEnd = blocks.length;
  if (si >= 0) for (let i = si + 1; i < blocks.length; i++) if (blocks[i].type === 'heading' && (blocks[i].level ?? 9) <= (blocks[si].level ?? 9)) { sectionEnd = i; break; }
  const inSection = (i) => si >= 0 && i > si && i < sectionEnd;
  const stepSection = new Set(blocks.map((b, i) => (b.type === 'heading' && inSection(i) ? i : -1)).filter((i) => i >= 0));
  // "Step 1 …" / "Schritt 1 …" lines are the clearest signal of where a step starts.
  const numbered = blocks.map((b, i) => (b.type !== 'image' && STEP_WORD.test(b.text) && (si < 0 || inSection(i)) ? i : -1)).filter((i) => i >= 0);
  const isStepHeading = (i) => (stepSection.size ? stepSection.has(i) : !(i === titleIdx && skipTitle));
  const stepHeadings = blocks.filter((b, i) => b.type === 'heading' && isStepHeading(i) && (si < 0 || stepSection.has(i))).length;
  const items = blocks.filter((b, i) => b.type === 'item' && (si < 0 || inSection(i))).length;
  const by = numbered.length >= 2 ? 'numbered' : stepHeadings > 0 ? 'heading' : items > 0 ? 'item' : 'paragraph';
  const startsStep = (b, i) => (by === 'numbered' ? numbered.includes(i)
    : by === 'heading' ? b.type === 'heading' && isStepHeading(i) && (si < 0 || stepSection.has(i))
      : by === 'item' ? b.type === 'item' && (si < 0 || inSection(i))
        : b.type === 'text' && !b.speakerNotes && (si < 0 || inSection(i)));
  let step = null; // the mark event of the current step
  blocks.forEach((b, i) => {
    if (b.type === 'image') {
      if (step && !step.screenshotId) { const id = saveImage(b, i); if (id) step.screenshotId = id; }
      return;
    }
    if (i === titleIdx && skipTitle) return;
    if (startsStep(b, i)) {
      step = push({ type: 'mark', text: stepLabel(b.text) });
      // "Step 2 - Add the user. Open Users…": the rest of the line is the first instruction.
      const rest = b.type === 'heading' ? '' : b.text.replace(/^\s*(step|schritt)\s*\d+\s*[:.)–—-]?\s*/i, '').slice(stepLabel(b.text).length).replace(/^[.:]\s*/, '').trim();
      if (b.type !== 'heading' && by !== 'numbered') for (const c of chunkText(b.text)) push({ type: 'note', text: c });
      else if (rest) for (const c of chunkText(rest)) push({ type: 'note', text: c });
      return;
    }
    if (b.type === 'heading') {
      if (by === 'heading' || by === 'numbered') step = null; // a context section: its pictures are not step screenshots
      if (i === si) return;
      push({ type: 'note', text: `${stepLabel(b.text)}:` });
      return;
    }
    for (const c of chunkText(b.text)) push({ type: 'note', text: c });
  });
  return events;
}

const mmss = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

// A video: transcript lines become notes at the moment they were said, frames become screenshots
// at the moment they were shown. The screens split the video into steps.
export function videoEvents({ transcript = [], frames = [], t0, source = 'upload' }) {
  const several = new Set(transcript.map((l) => l.speaker).filter((x) => x != null && x !== '')).size > 1;
  const who = (l) => (several && l.speaker != null && l.speaker !== '' ? `${typeof l.speaker === 'number' ? `Speaker ${l.speaker}` : l.speaker}: ` : '');
  const ev = [
    ...frames.map((f) => ({ ts: t0 + f.atMs, source, type: 'screenshot', screenshotId: f.id })),
    ...transcript.flatMap((l) => chunkText(`[${mmss(l.ms)}] ${who(l)}${l.text}`).map((text) => ({ ts: t0 + l.ms + 1, source, type: 'note', text }))),
  ];
  return ev.sort((a, b) => a.ts - b.ts);
}
