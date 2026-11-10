// Renders the standard document model to Word (.docx, the format published to SharePoint) and to
// Markdown (used for previews and the plain-text copy kept next to the Word file).
// Fixed texts follow the document language (English or German).
import fs from 'node:fs';
import { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType, ImageRun, AlignmentType, BorderStyle, Header, Footer, PageNumber, ShadingType } from 'docx';
import { renderShot } from './annotate.js';

const LABELS = {
  en: {
    sections: ['Process Information', 'Purpose', 'Scope', 'Prerequisites', 'Roles and Responsibilities', 'Process Execution – Step by Step', 'Decision Points and Exceptions', 'Expected Outcome', 'Troubleshooting', 'Related Documentation', 'Change History'],
    tbd: 'To be confirmed.', field: 'Field', value: 'Value', included: 'Included', excluded: 'Excluded',
    prereq: { permissions: 'Required permissions', access: 'Required access', systems: 'Applications and systems', information: 'Required information', dependencies: 'Dependencies' },
    info: ['Process title', 'Process ID', 'Version', 'Creation date', 'Last updated', 'Process owner', 'Responsible department', 'Category', 'Author', 'Reviewer / approver', 'Status'],
    step: 'Step', app: 'Application / system', input: 'Required input', result: 'Expected result', screenshot: 'Screenshot', note: 'Note', warning: 'Warning',
    figure: 'Figure', notAvailable: 'not available', important: 'IMPORTANT STEP', importantHint: 'Take extra care: this step is critical for the process.', marksHint: 'The numbers show the order of the clicks; frames show the fields to fill in.', noDecisions: 'No decision points recorded.', ifThen: (c, a) => `If ${c}, then ${a}`, stepRef: (n) => `step ${n}`,
    exc: ['Problem', 'Handling / recovery', 'Escalation'], noIssues: 'No known issues recorded.', issue: ['Issue', 'Resolution'], none: 'None.',
    role: ['Role', 'Responsibilities'], history: ['Version', 'Date', 'Author', 'Approver', 'Summary'], keywords: 'Keywords', subtitle: 'IT Process Documentation', eyebrow: 'IT WORK INSTRUCTION', page: 'Page', of: 'of', steps: 'Steps',
  },
  de: {
    sections: ['Prozessinformationen', 'Zweck', 'Geltungsbereich', 'Voraussetzungen', 'Rollen und Verantwortlichkeiten', 'Prozessablauf – Schritt für Schritt', 'Entscheidungspunkte und Ausnahmen', 'Erwartetes Ergebnis', 'Fehlerbehebung', 'Zugehörige Dokumentation', 'Änderungshistorie'],
    tbd: 'Noch zu bestätigen.', field: 'Feld', value: 'Wert', included: 'Enthalten', excluded: 'Nicht enthalten',
    prereq: { permissions: 'Erforderliche Berechtigungen', access: 'Erforderliche Zugänge', systems: 'Anwendungen und Systeme', information: 'Erforderliche Informationen', dependencies: 'Abhängigkeiten' },
    info: ['Prozesstitel', 'Prozess-ID', 'Version', 'Erstellt am', 'Zuletzt aktualisiert', 'Prozessverantwortlich', 'Zuständige Abteilung', 'Kategorie', 'Autor', 'Prüfer / Freigabe', 'Status'],
    step: 'Schritt', app: 'Anwendung / System', input: 'Erforderliche Eingabe', result: 'Erwartetes Ergebnis', screenshot: 'Screenshot', note: 'Hinweis', warning: 'Warnung',
    figure: 'Abbildung', notAvailable: 'nicht verfügbar', important: 'WICHTIGER SCHRITT', importantHint: 'Bitte besonders sorgfältig ausführen: Dieser Schritt ist entscheidend für den Prozess.', marksHint: 'Die Zahlen zeigen die Reihenfolge der Klicks, Rahmen die auszufüllenden Felder.', noDecisions: 'Keine Entscheidungspunkte erfasst.', ifThen: (c, a) => `Wenn ${c}, dann ${a}`, stepRef: (n) => `Schritt ${n}`,
    exc: ['Problem', 'Behandlung / Wiederherstellung', 'Eskalation'], noIssues: 'Keine bekannten Probleme erfasst.', issue: ['Problem', 'Lösung'], none: 'Keine.',
    role: ['Rolle', 'Verantwortlichkeiten'], history: ['Version', 'Datum', 'Autor', 'Freigabe', 'Zusammenfassung'], keywords: 'Schlüsselwörter', subtitle: 'IT-Prozessdokumentation', eyebrow: 'IT-ARBEITSANWEISUNG', page: 'Seite', of: 'von', steps: 'Schritte',
  },
};
export const labelsFor = (d) => LABELS[d?.info?.language] || LABELS.en;

const infoRows = (d, L) => [
  d.info.title, d.info.processId, d.info.version, d.info.createdAt?.slice(0, 10), d.info.updatedAt?.slice(0, 10),
  d.info.owner, d.info.department, d.info.category, d.info.author, d.info.approver, d.info.status,
].map((v, i) => [L.info[i], v]).concat([[L.keywords, (d.keywords || []).join(', ')]]);

export function renderMarkdown(d) {
  const T = labelsFor(d); const SECTIONS = T.sections; const TBD = T.tbd;
  const L = [];
  const list = (arr) => (arr?.length ? arr.map((x) => `- ${x}`).join('\n') : `_${TBD}_`);
  L.push(`# ${d.info.title}`, '');
  L.push(`## 1. ${SECTIONS[0]}`, '', `| ${T.field} | ${T.value} |`, '|---|---|', ...infoRows(d, T).map(([k, v]) => `| ${k} | ${v || '–'} |`), '');
  L.push(`## 2. ${SECTIONS[1]}`, '', d.purpose || `_${TBD}_`, '');
  L.push(`## 3. ${SECTIONS[2]}`, '', `**${T.included}**`, '', list(d.scope.included), '', `**${T.excluded}**`, '', list(d.scope.excluded), '');
  L.push(`## 4. ${SECTIONS[3]}`, '');
  for (const [k, label] of Object.entries(T.prereq)) L.push(`**${label}**`, '', list(d.prerequisites[k]), '');
  L.push(`## 5. ${SECTIONS[4]}`, '', d.roles.length ? d.roles.map((r) => `- **${r.role}**: ${r.responsibilities}`).join('\n') : `_${TBD}_`, '');
  L.push(`## 6. ${SECTIONS[5]}`, '');
  for (const s of d.steps) {
    L.push(`### ${s.important ? '★ ' : ''}${T.step} ${s.number} – ${s.title}`, '');
    if (s.important) L.push(`> **${T.important}** – ${T.importantHint}`, '');
    if (s.description) L.push(s.description, '');
    s.instructions.forEach((x, i) => L.push(`${i + 1}. ${x}`));
    L.push('', `- **${T.app}:** ${s.application || '–'}`, `- **${T.input}:** ${s.input || '–'}`, `- **${T.result}:** ${s.expectedResult || TBD}`);
    for (const id of s.screenshotIds) L.push(`- **${T.screenshot}:** ![${T.step} ${s.number}](screenshots/${id}.jpg)`);
    for (const n of s.notes) L.push(`- **${T.note}:** ${n}`);
    for (const w of s.warnings) L.push(`- **${T.warning}:** ${w}`);
    L.push('');
  }
  L.push(`## 7. ${SECTIONS[6]}`, '');
  L.push(d.decisions.length ? d.decisions.map((x) => `- ${T.ifThen(x.condition, x.action)}${x.stepNumber ? ` (${T.stepRef(x.stepNumber)})` : ''}`).join('\n') : `_${T.noDecisions}_`, '');
  if (d.exceptions.length) L.push(`| ${T.exc.join(' | ')} |`, '|---|---|---|', ...d.exceptions.map((e) => `| ${e.problem} | ${e.handling || TBD} | ${e.escalation || TBD} |`), '');
  L.push(`## 8. ${SECTIONS[7]}`, '', d.expectedOutcome || `_${TBD}_`, '', list(d.verification), '');
  L.push(`## 9. ${SECTIONS[8]}`, '', d.troubleshooting.length ? d.troubleshooting.map((t) => `- **${t.issue}**: ${t.resolution}`).join('\n') : `_${T.noIssues}_`, '');
  L.push(`## 10. ${SECTIONS[9]}`, '', d.related.length ? d.related.map((r) => `- [${r.title}](${r.url})`).join('\n') : `_${T.none}_`, '');
  L.push(`## 11. ${SECTIONS[10]}`, '', `| ${T.history.join(' | ')} |`, '|---|---|---|---|---|', ...d.changeHistory.map((c) => `| ${c.version} | ${c.date?.slice(0, 10)} | ${c.author} | ${c.approver} | ${c.summary} |`), '');
  return L.join('\n');
}

let TBD = LABELS.en.tbd;
const H = (text, level = HeadingLevel.HEADING_1) => new Paragraph({ text, heading: level, spacing: { before: 240, after: 120 } });
const P = (text, opts = {}) => new Paragraph({ children: [new TextRun({ text: text || '', italics: !text || opts.italics, bold: opts.bold })], spacing: { after: 80 } });
const bullets = (arr) => (arr?.length ? arr.map((x) => new Paragraph({ text: x, bullet: { level: 0 } })) : [P(TBD, { italics: true })]);
const cell = (text, bold = false, shade) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(text ?? ''), bold })] })], shading: shade ? { fill: shade } : undefined });
const table = (rows, header) => new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  rows: [...(header ? [new TableRow({ tableHeader: true, children: header.map((h) => cell(h, true, 'E2F2EF')) })] : []), ...rows.map((r) => new TableRow({ children: r.map((c, i) => cell(c, !header && i === 0)) }))],
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
const BRAND = '0B6E66';

export async function renderDocx(d, resolveShot = () => null) {
  const T = labelsFor(d); const SECTIONS = T.sections; TBD = T.tbd;
  // Cover page: title, purpose and key facts, then the ten sections from page 2.
  const cover = [
    new Paragraph({ children: [], spacing: { before: 2400 } }),
    new Paragraph({ children: [new TextRun({ text: T.eyebrow, bold: true, size: 20, color: BRAND, characterSpacing: 40 })], spacing: { after: 160 } }),
    new Paragraph({ children: [new TextRun({ text: d.info.title, bold: true, size: 60, color: '14212B' })], spacing: { after: 240 } }),
    ...(d.purpose ? [new Paragraph({ children: [new TextRun({ text: d.purpose, size: 24, color: '5A6B76' })], spacing: { after: 240 } })] : []),
    new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 24, color: BRAND, space: 1 } }, spacing: { after: 360 } }),
    table([
      [T.info[1], d.info.processId], [T.info[2], `${d.info.version} · ${d.info.status}`], [T.info[5], d.info.owner || '–'],
      [T.info[6], d.info.department || '–'], [T.info[9], d.info.approver || '–'], [T.info[4], d.info.updatedAt?.slice(0, 10) || '–'], [T.steps, String(d.steps.length)],
    ]),
  ];
  const children = [
    H(`1. ${SECTIONS[0]}`), table(infoRows(d, T).map(([k, v]) => [k, v || '–'])),
    H(`2. ${SECTIONS[1]}`), P(d.purpose || TBD, { italics: !d.purpose }),
    H(`3. ${SECTIONS[2]}`), P(T.included, { bold: true }), ...bullets(d.scope.included), P(T.excluded, { bold: true }), ...bullets(d.scope.excluded),
    H(`4. ${SECTIONS[3]}`),
  ];
  for (const [k, label] of Object.entries(T.prereq)) children.push(P(label, { bold: true }), ...bullets(d.prerequisites[k]));
  children.push(H(`5. ${SECTIONS[4]}`), d.roles.length ? table(d.roles.map((r) => [r.role, r.responsibilities]), T.role) : P(TBD, { italics: true }));
  children.push(H(`6. ${SECTIONS[5]}`));
  for (const s of d.steps) {
    children.push(H(`${s.important ? '★ ' : ''}${T.step} ${s.number} – ${s.title}`, HeadingLevel.HEADING_2));
    if (s.important) {
      children.push(new Paragraph({
        children: [new TextRun({ text: `${T.important}  `, bold: true, color: 'B54708', size: 18 }), new TextRun({ text: T.importantHint, color: '7A2E0E', size: 18 })],
        shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'FFF4E5' },
        border: { left: { style: BorderStyle.SINGLE, size: 24, color: 'E8590C', space: 6 } },
        spacing: { before: 60, after: 120 },
      }));
    }
    if (s.description) children.push(P(s.description));
    s.instructions.forEach((x, i) => children.push(new Paragraph({ children: [new TextRun({ text: `${i + 1}. `, bold: true }), new TextRun(x)], indent: { left: 360 }, spacing: { after: 60 } })));
    children.push(table([[T.app, s.application || '–'], [T.input, s.input || '–'], [T.result, s.expectedResult || TBD]]));
    for (const id of s.screenshotIds) {
      const p = resolveShot(id);
      if (!p || !fs.existsSync(p)) { children.push(P(`[${T.screenshot} ${id} ${T.notAvailable}]`, { italics: true })); continue; }
      const marks = (s.marks || []).filter((m) => m.shotId === id);
      const crop = (s.crops || []).find((c) => c.shotId === id) || null;
      const buf = await renderShot(fs.readFileSync(p), marks, crop).catch(() => fs.readFileSync(p)); const { w, h, type } = imageSize(buf);
      const width = Math.min(600, w); const height = Math.round((h / w) * width);
      children.push(new Paragraph({ children: [new ImageRun({ data: buf, type, transformation: { width, height } })], alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60 } }));
      children.push(new Paragraph({ children: [new TextRun({ text: `${T.figure}: ${T.step} ${s.number} – ${s.title}${marks.length ? ` · ${T.marksHint}` : ''}`, italics: true, size: 18, color: '5B6B80' })], alignment: AlignmentType.CENTER }));
    }
    for (const n of s.notes) children.push(P(`${T.note}: ${n}`));
    for (const w of s.warnings) children.push(new Paragraph({ children: [new TextRun({ text: `⚠ ${w}`, color: '9A5B00' })] }));
  }
  children.push(H(`7. ${SECTIONS[6]}`));
  children.push(...(d.decisions.length ? d.decisions.map((x) => new Paragraph({ text: `${T.ifThen(x.condition, x.action)}${x.stepNumber ? ` (${T.stepRef(x.stepNumber)})` : ''}.`, bullet: { level: 0 } })) : [P(T.noDecisions, { italics: true })]));
  if (d.exceptions.length) children.push(table(d.exceptions.map((e) => [e.problem, e.handling || TBD, e.escalation || TBD]), T.exc));
  children.push(H(`8. ${SECTIONS[7]}`), P(d.expectedOutcome || TBD, { italics: !d.expectedOutcome }), ...(d.verification.length ? bullets(d.verification) : []));
  children.push(H(`9. ${SECTIONS[8]}`), ...(d.troubleshooting.length ? [table(d.troubleshooting.map((t) => [t.issue, t.resolution]), T.issue)] : [P(T.noIssues, { italics: true })]));
  children.push(H(`10. ${SECTIONS[9]}`), ...(d.related.length ? d.related.map((r) => new Paragraph({ text: `${r.title}: ${r.url}`, bullet: { level: 0 } })) : [P(T.none, { italics: true })]));
  children.push(H(`11. ${SECTIONS[10]}`), table(d.changeHistory.map((c) => [c.version, c.date?.slice(0, 10), c.author, c.approver, c.summary]), T.history));

  const doc = new Document({
    creator: 'Process Documentation Agent', title: d.info.title, description: `${d.info.processId} v${d.info.version}`, keywords: (d.keywords || []).join(', '), subject: d.info.category || undefined,
    styles: { default: { document: { run: { font: 'Segoe UI', size: 21 } }, heading1: { run: { font: 'Segoe UI', size: 30, bold: true, color: '08534D' }, paragraph: { spacing: { before: 360, after: 120 } } }, heading2: { run: { font: 'Segoe UI', size: 24, bold: true, color: '14212B' } } } },
    sections: [
      { children: cover },
      {
        headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun({ text: `${d.info.title} · ${d.info.processId} · v${d.info.version}`, size: 16, color: '8A99A3' })], alignment: AlignmentType.RIGHT })] }) },
        footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun({ text: `${T.subtitle} · ${T.page} `, size: 16, color: '8A99A3' }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '8A99A3' }), new TextRun({ text: ` ${T.of} `, size: 16, color: '8A99A3' }), new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: '8A99A3' })], alignment: AlignmentType.CENTER })] }) },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}
