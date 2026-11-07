// Renders the standard document model to Word (.docx, the format published to SharePoint) and to
// Markdown (used for previews and the plain-text copy kept next to the Word file).
import fs from 'node:fs';
import { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType, ImageRun, AlignmentType, BorderStyle } from 'docx';

const SECTIONS = ['Process Information', 'Purpose', 'Scope', 'Prerequisites', 'Roles and Responsibilities', 'Process Execution – Step by Step', 'Decision Points and Exceptions', 'Expected Outcome', 'Troubleshooting', 'Related Documentation', 'Change History'];
const TBD = 'To be confirmed.';

const infoRows = (d) => [
  ['Process title', d.info.title], ['Process ID', d.info.processId], ['Version', d.info.version],
  ['Creation date', d.info.createdAt?.slice(0, 10)], ['Last updated', d.info.updatedAt?.slice(0, 10)],
  ['Process owner', d.info.owner], ['Responsible department', d.info.department], ['Category', d.info.category],
  ['Author', d.info.author], ['Reviewer / approver', d.info.approver], ['Status', d.info.status],
];

export function renderMarkdown(d) {
  const L = [];
  const list = (arr) => (arr?.length ? arr.map((x) => `- ${x}`).join('\n') : `_${TBD}_`);
  L.push(`# ${d.info.title}`, '');
  L.push(`## 1. ${SECTIONS[0]}`, '', '| Field | Value |', '|---|---|', ...infoRows(d).map(([k, v]) => `| ${k} | ${v || '–'} |`), '');
  L.push(`## 2. ${SECTIONS[1]}`, '', d.purpose || `_${TBD}_`, '');
  L.push(`## 3. ${SECTIONS[2]}`, '', '**Included**', '', list(d.scope.included), '', '**Excluded**', '', list(d.scope.excluded), '');
  L.push(`## 4. ${SECTIONS[3]}`, '');
  for (const [k, label] of [['permissions', 'Required permissions'], ['access', 'Required access'], ['systems', 'Applications and systems'], ['information', 'Required information'], ['dependencies', 'Dependencies']]) L.push(`**${label}**`, '', list(d.prerequisites[k]), '');
  L.push(`## 5. ${SECTIONS[4]}`, '', d.roles.length ? d.roles.map((r) => `- **${r.role}**: ${r.responsibilities}`).join('\n') : `_${TBD}_`, '');
  L.push(`## 6. ${SECTIONS[5]}`, '');
  for (const s of d.steps) {
    L.push(`### Step ${s.number} – ${s.title}`, '');
    if (s.description) L.push(s.description, '');
    s.instructions.forEach((x, i) => L.push(`${i + 1}. ${x}`));
    L.push('', `- **Application / system:** ${s.application || '–'}`, `- **Required input:** ${s.input || '–'}`, `- **Expected result:** ${s.expectedResult || TBD}`);
    for (const id of s.screenshotIds) L.push(`- **Screenshot:** ![Step ${s.number}](screenshots/${id}.jpg)`);
    for (const n of s.notes) L.push(`- **Note:** ${n}`);
    for (const w of s.warnings) L.push(`- **Warning:** ${w}`);
    L.push('');
  }
  L.push(`## 7. ${SECTIONS[6]}`, '');
  L.push(d.decisions.length ? d.decisions.map((x) => `- **If** ${x.condition} **then** ${x.action}${x.stepNumber ? ` (step ${x.stepNumber})` : ''}`).join('\n') : `_No decision points recorded._`, '');
  if (d.exceptions.length) L.push('| Problem | Handling | Escalation |', '|---|---|---|', ...d.exceptions.map((e) => `| ${e.problem} | ${e.handling || TBD} | ${e.escalation || TBD} |`), '');
  L.push(`## 8. ${SECTIONS[7]}`, '', d.expectedOutcome || `_${TBD}_`, '', list(d.verification), '');
  L.push(`## 9. ${SECTIONS[8]}`, '', d.troubleshooting.length ? d.troubleshooting.map((t) => `- **${t.issue}**: ${t.resolution}`).join('\n') : '_No known issues recorded._', '');
  L.push(`## 10. ${SECTIONS[9]}`, '', d.related.length ? d.related.map((r) => `- [${r.title}](${r.url})`).join('\n') : '_None._', '');
  L.push(`## 11. ${SECTIONS[10]}`, '', '| Version | Date | Author | Approver | Summary |', '|---|---|---|---|---|', ...d.changeHistory.map((c) => `| ${c.version} | ${c.date?.slice(0, 10)} | ${c.author} | ${c.approver} | ${c.summary} |`), '');
  return L.join('\n');
}

const H = (text, level = HeadingLevel.HEADING_1) => new Paragraph({ text, heading: level, spacing: { before: 240, after: 120 } });
const P = (text, opts = {}) => new Paragraph({ children: [new TextRun({ text: text || '', italics: !text || opts.italics, bold: opts.bold })], spacing: { after: 80 } });
const bullets = (arr) => (arr?.length ? arr.map((x) => new Paragraph({ text: x, bullet: { level: 0 } })) : [P(TBD, { italics: true })]);
const cell = (text, bold = false, shade) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(text ?? ''), bold })] })], shading: shade ? { fill: shade } : undefined });
const table = (rows, header) => new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  rows: [...(header ? [new TableRow({ tableHeader: true, children: header.map((h) => cell(h, true, 'E7EEF7')) })] : []), ...rows.map((r) => new TableRow({ children: r.map((c, i) => cell(c, !header && i === 0)) }))],
  borders: { top: { style: BorderStyle.SINGLE, size: 2, color: 'BFC8D6' }, bottom: { style: BorderStyle.SINGLE, size: 2, color: 'BFC8D6' }, left: { style: BorderStyle.SINGLE, size: 2, color: 'BFC8D6' }, right: { style: BorderStyle.SINGLE, size: 2, color: 'BFC8D6' }, insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'D9DFE8' }, insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'D9DFE8' } },
});

function imageSize(buf) {
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), type: 'png' };
  // JPEG: scan for SOF0/SOF2 marker
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1]; const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), type: 'jpg' };
    i += 2 + len;
  }
  return { w: 1280, h: 720, type: 'jpg' };
}

// resolveShot(id) -> absolute path of the screenshot file or null
export async function renderDocx(d, resolveShot = () => null) {
  const children = [
    new Paragraph({ children: [new TextRun({ text: d.info.title, bold: true, size: 40, color: '1F3A5F' })], spacing: { after: 120 } }),
    new Paragraph({ children: [new TextRun({ text: `IT Process Documentation · ${d.info.processId} · Version ${d.info.version} · ${d.info.status}`, color: '5B6B80', size: 20 })], spacing: { after: 240 } }),
    H(`1. ${SECTIONS[0]}`), table(infoRows(d).map(([k, v]) => [k, v || '–'])),
    H(`2. ${SECTIONS[1]}`), P(d.purpose || TBD, { italics: !d.purpose }),
    H(`3. ${SECTIONS[2]}`), P('Included', { bold: true }), ...bullets(d.scope.included), P('Excluded', { bold: true }), ...bullets(d.scope.excluded),
    H(`4. ${SECTIONS[3]}`),
  ];
  for (const [k, label] of [['permissions', 'Required permissions'], ['access', 'Required access'], ['systems', 'Applications and systems'], ['information', 'Required information'], ['dependencies', 'Dependencies']]) children.push(P(label, { bold: true }), ...bullets(d.prerequisites[k]));
  children.push(H(`5. ${SECTIONS[4]}`), d.roles.length ? table(d.roles.map((r) => [r.role, r.responsibilities]), ['Role', 'Responsibilities']) : P(TBD, { italics: true }));
  children.push(H(`6. ${SECTIONS[5]}`));
  for (const s of d.steps) {
    children.push(H(`Step ${s.number} – ${s.title}`, HeadingLevel.HEADING_2));
    if (s.description) children.push(P(s.description));
    s.instructions.forEach((x, i) => children.push(new Paragraph({ children: [new TextRun({ text: `${i + 1}. `, bold: true }), new TextRun(x)], indent: { left: 360 }, spacing: { after: 60 } })));
    children.push(table([['Application / system', s.application || '–'], ['Required input', s.input || '–'], ['Expected result', s.expectedResult || TBD]]));
    for (const id of s.screenshotIds) {
      const p = resolveShot(id);
      if (!p || !fs.existsSync(p)) { children.push(P(`[Screenshot ${id} not available]`, { italics: true })); continue; }
      const buf = fs.readFileSync(p); const { w, h, type } = imageSize(buf);
      const width = Math.min(600, w); const height = Math.round((h / w) * width);
      children.push(new Paragraph({ children: [new ImageRun({ data: buf, type, transformation: { width, height } })], alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60 } }));
      children.push(new Paragraph({ children: [new TextRun({ text: `Figure: Step ${s.number} – ${s.title}`, italics: true, size: 18, color: '5B6B80' })], alignment: AlignmentType.CENTER }));
    }
    for (const n of s.notes) children.push(P(`Note: ${n}`));
    for (const w of s.warnings) children.push(new Paragraph({ children: [new TextRun({ text: `⚠ ${w}`, color: '9A5B00' })] }));
  }
  children.push(H(`7. ${SECTIONS[6]}`));
  children.push(...(d.decisions.length ? d.decisions.map((x) => new Paragraph({ text: `If ${x.condition}, then ${x.action}${x.stepNumber ? ` (step ${x.stepNumber})` : ''}.`, bullet: { level: 0 } })) : [P('No decision points recorded.', { italics: true })]));
  if (d.exceptions.length) children.push(table(d.exceptions.map((e) => [e.problem, e.handling || TBD, e.escalation || TBD]), ['Problem', 'Handling / recovery', 'Escalation']));
  children.push(H(`8. ${SECTIONS[7]}`), P(d.expectedOutcome || TBD, { italics: !d.expectedOutcome }), ...(d.verification.length ? bullets(d.verification) : []));
  children.push(H(`9. ${SECTIONS[8]}`), ...(d.troubleshooting.length ? [table(d.troubleshooting.map((t) => [t.issue, t.resolution]), ['Issue', 'Resolution'])] : [P('No known issues recorded.', { italics: true })]));
  children.push(H(`10. ${SECTIONS[9]}`), ...(d.related.length ? d.related.map((r) => new Paragraph({ text: `${r.title}: ${r.url}`, bullet: { level: 0 } })) : [P('None.', { italics: true })]));
  children.push(H(`11. ${SECTIONS[10]}`), table(d.changeHistory.map((c) => [c.version, c.date?.slice(0, 10), c.author, c.approver, c.summary]), ['Version', 'Date', 'Author', 'Approver', 'Summary']));

  const doc = new Document({
    creator: 'Process Documentation Agent', title: d.info.title, description: `${d.info.processId} v${d.info.version}`,
    styles: { default: { document: { run: { font: 'Segoe UI', size: 21 } } } },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}
