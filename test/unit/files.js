// Small Office files built in memory for the upload tests (same structure Word and PowerPoint write).
import sharp from 'sharp';
import { zipStore } from '../../server/teams.js';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const screenshotPng = (w = 640, h = 360) => (w < 100 ? sharp({ create: { width: w, height: h, channels: 3, background: { r: 0, g: 120, b: 212 } } }).png().toBuffer()
  : sharp({ create: { width: w, height: h, channels: 3, background: { r: 230, g: 236, b: 242 } } })
    .composite([{ input: { create: { width: Math.round(w / 2), height: 40, channels: 3, background: { r: 0, g: 120, b: 212 } } }, left: 20, top: 20 }]).png().toBuffer());

// parts: ['h1:Title', 'h2:Heading', 'p:Text', 'b:Bold line', 'li:List item', 'img', ['cell', 'cell']]
export async function docx(parts, { title = '' } = {}) {
  const png = await screenshotPng();
  const icon = await screenshotPng(24, 24);
  let rid = 10; const rels = []; const media = [];
  const run = (t, bold) => `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
  const body = parts.map((p) => {
    if (Array.isArray(p)) return `<w:tbl><w:tr>${p.map((c) => `<w:tc><w:p>${run(c)}</w:p></w:tc>`).join('')}</w:tr></w:tbl>`;
    if (p === 'img' || p === 'icon') {
      const id = `rId${++rid}`; const name = `media/image${rid}.png`;
      rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${name}"/>`);
      media.push([`word/${name}`, p === 'img' ? png : icon]);
      return `<w:p><w:r><w:drawing><a:graphic><a:graphicData><a:blip r:embed="${id}"/></a:graphicData></a:graphic></w:drawing></w:r></w:p>`;
    }
    const [k, ...rest] = p.split(':'); const t = rest.join(':');
    if (k === 'h1' || k === 'h2') return `<w:p><w:pPr><w:pStyle w:val="Heading${k[1]}"/></w:pPr>${run(t)}</w:p>`;
    if (k === 'title') return `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${run(t)}</w:p>`;
    if (k === 'li') return `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run(t)}</w:p>`;
    if (k === 'b') return `<w:p>${run(t, true)}</w:p>`;
    return `<w:p>${run(t)}</w:p>`;
  }).join('');
  const styles = `<w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style></w:styles>`;
  return zipStore([
    ['[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')],
    ['word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`)],
    ['word/styles.xml', Buffer.from(styles)],
    ['word/_rels/document.xml.rels', Buffer.from(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`)],
    ['docProps/core.xml', Buffer.from(`<cp:coreProperties xmlns:cp="x" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title)}</dc:title></cp:coreProperties>`)],
    ...media,
  ]);
}

// slides: [{ title, body: [...], notes: [...], img: true }]
export async function pptx(slides) {
  const png = await screenshotPng();
  const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const sp = (ph, paras) => `<p:sp><p:nvSpPr><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:txBody>${paras.map((t) => `<a:p><a:r><a:t>${esc(t)}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
  const files = [['ppt/presentation.xml', Buffer.from(`<p:presentation ${P}><p:sldIdLst>${slides.map((s, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`)],
    ['ppt/_rels/presentation.xml.rels', Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`)]];
  slides.forEach((s, i) => {
    const n = i + 1; const rels = [];
    if (s.img) { rels.push(`<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${n}.png"/>`); files.push([`ppt/media/image${n}.png`, png]); }
    if (s.notes) {
      rels.push(`<Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>`);
      files.push([`ppt/notesSlides/notesSlide${n}.xml`, Buffer.from(`<p:notes ${P}><p:cSld><p:spTree>${sp('sldImg', [])}${sp('body', s.notes)}${sp('sldNum', [String(n)])}</p:spTree></p:cSld></p:notes>`)]);
    }
    files.push([`ppt/slides/slide${n}.xml`, Buffer.from(`<p:sld ${P}><p:cSld><p:spTree>${sp('title', [s.title])}${sp(null, s.body || [])}${s.img ? '<p:pic><p:blipFill><a:blip r:embed="rId7"/></p:blipFill></p:pic>' : ''}${sp('sldNum', [String(n)])}</p:spTree></p:cSld></p:sld>`)]);
    files.push([`ppt/slides/_rels/slide${n}.xml.rels`, Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`)]);
  });
  return zipStore(files);
}
