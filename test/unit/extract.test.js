// Reading processes from uploaded files: Word, PowerPoint, PDF, text and subtitles, and turning
// what was read into the events the engines draft from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractDocument, documentEvents, videoEvents, detectType, stepLabel, chunkText } from '../../server/engine/extract.js';
import { generateWithRules } from '../../server/engine/generate-rules.js';
import { docx, pptx } from './files.js';

const marks = (events) => events.filter((e) => e.type === 'mark').map((e) => e.text);
const withSeq = (events) => [{ type: 'start', ts: 0, source: 'upload' }, ...events].map((e, i) => ({ ...e, seq: i + 1 }));
const meta = (fileName, kind = 'document') => ({ title: 'T', language: 'en', source: { kind, fileName, type: 'docx' } });

test('Word: headings inside the "Steps" section become steps, other sections are context, tables become label: value', async () => {
  const buf = await docx([
    'title:Create a new employee account',
    'h1:Purpose', 'p:Every new employee gets a working account on the first day.',
    'h1:Steps',
    'h2:Check the onboarding request', 'li:Open the onboarding request.', 'li:Check that it is approved.', ['Expected result', 'All details are present.'],
    'h2:Add the user', 'img', 'icon', 'li:Open Users > Active users and click "Add a user".', ['Application / system', 'Microsoft 365 admin center'], ['Required input', '–'],
    'h1:Troubleshooting', 'p:If no licence is free, ask the licence owner.',
  ], { title: 'Create a new employee account' });
  const x = await extractDocument({ buf, fileName: 'account.docx' });
  assert.equal(x.type, 'docx');
  assert.equal(x.title, 'Create a new employee account');
  assert.equal(x.blocks.filter((b) => b.type === 'image').length, 1, 'the 24 px icon is dropped');
  assert.ok(x.blocks.some((b) => b.text === 'Expected result: All details are present.'));
  assert.ok(!x.blocks.some((b) => b.text === 'Required input'), 'a row whose value is empty is left out');

  const saved = [];
  const ev = documentEvents(x.blocks, { t0: 0, title: x.title, saveImage: (b) => { saved.push(b.image.mime); return 'shot_1'; } });
  assert.deepEqual(marks(ev), ['Check the onboarding request', 'Add the user']);
  assert.deepEqual(saved, ['image/png']);
  assert.equal(ev.find((e) => e.text === 'Add the user').screenshotId, 'shot_1');
  assert.ok(ev.some((e) => e.type === 'note' && e.text === 'Purpose:'), 'context sections stay as notes');

  const { doc, suggestions } = generateWithRules({ meta: meta('account.docx'), events: withSeq(ev), screenshotsAvailable: new Set(['shot_1']) });
  assert.deepEqual(doc.steps.map((s) => s.title), ['Check the onboarding request', 'Add the user']);
  assert.deepEqual(doc.steps[0].instructions, ['Open the onboarding request.', 'Check that it is approved.']);
  assert.equal(doc.steps[0].expectedResult, 'All details are present.');
  assert.equal(doc.steps[1].application, 'Microsoft 365 admin center');
  assert.deepEqual(doc.steps[1].screenshotIds, ['shot_1']);
  assert.ok(doc.prerequisites.systems.includes('Microsoft 365 admin center'));
  assert.ok(!doc.prerequisites.systems.includes('Unknown application'));
  assert.match(suggestions[0], /uploaded file "account\.docx"/);
  assert.match(suggestions[1], /starts with an introduction: "Purpose: Every new employee gets a working account on the first day\."/);
});

test('Word without heading styles: bold lines are headings, otherwise the numbered list is the steps', async () => {
  const bold = await extractDocument({ buf: await docx(['b:Reset the password', 'p:Open the user and click Reset password.', 'b:Tell the user', 'p:Call the user.']), fileName: 'x.docx' });
  assert.deepEqual(marks(documentEvents(bold.blocks, { t0: 0 })), ['Reset the password', 'Tell the user']);
  const list = await extractDocument({ buf: await docx(['p:How to unlock an account.', 'li:Open the Entra admin center.', 'li:Search for the user. Open the profile.', 'p:Done.']), fileName: 'x.docx' });
  assert.deepEqual(marks(documentEvents(list.blocks, { t0: 0 })), ['Open the Entra admin center', 'Search for the user']);
});

test('PowerPoint: one step per slide, with its pictures and speaker notes', async () => {
  const buf = await pptx([
    { title: 'Open the admin center', body: ['Go to admin.microsoft.com'], notes: ['Sign in with your admin account.'], img: true },
    { title: 'Assign the licence', body: ['1. Select the user', '2. Choose Licences and apps'] },
  ]);
  const x = await extractDocument({ buf, fileName: 'deck.pptx' });
  assert.equal(x.type, 'pptx');
  assert.ok(!x.blocks.some((b) => b.text === '1' || b.text === '2'), 'slide numbers are left out');
  const ev = documentEvents(x.blocks, { t0: 0, saveImage: () => 'shot_p' });
  assert.deepEqual(marks(ev), ['Open the admin center', 'Assign the licence']);
  assert.equal(ev[0].screenshotId, 'shot_p');
  assert.ok(ev.some((e) => e.text === 'Sign in with your admin account.'));
});

test('PDF: headings by font size, "Step N" lines, pictures where they are on the page', async () => {
  const x = await extractDocument({ buf: fs.readFileSync(new URL('../fixtures/upload-guide.pdf', import.meta.url)), fileName: 'guide.pdf' });
  assert.equal(x.type, 'pdf');
  assert.equal(x.title, 'Reset an MFA method');
  assert.ok(x.blocks.some((b) => b.type === 'heading' && b.text === 'Purpose'));
  const ev = documentEvents(x.blocks, { t0: 0, title: x.title, saveImage: () => 'shot_pdf' });
  assert.deepEqual(marks(ev), ['Verify the caller', 'Open the user in the Entra admin center', 'Click "Require re-register multifactor authentication"']);
  assert.equal(ev.find((e) => e.type === 'mark' && e.text.startsWith('Open the user')).screenshotId, 'shot_pdf', 'the picture below step 2 belongs to step 2');
  assert.ok(ev.some((e) => e.type === 'note' && /^Ask for the employee number and call back on the number stored in the HR system\.$/.test(e.text)), 'a step line that wraps is one instruction');
});

test('text, Markdown, HTML and subtitles', async () => {
  const md = await extractDocument({ buf: Buffer.from('# Offboard a user\n\nWhy we do it.\n\n## Block sign-in\n\n1. Open the user.\n2. Click **Block sign-in**.\n\n## Remove licences\n\nOpen [Licences](https://x) and remove all.'), fileName: 'off.md' });
  assert.equal(md.title, 'Offboard a user');
  assert.deepEqual(marks(documentEvents(md.blocks, { t0: 0, title: md.title })), ['Block sign-in', 'Remove licences']);
  assert.ok(md.blocks.some((b) => b.text === '2. Click Block sign-in.'));
  const txt = await extractDocument({ buf: Buffer.from('Step 1: Open the portal.\nStep 2: Click Users.\nThe list opens.\n'), fileName: 'notes.txt' });
  assert.deepEqual(marks(documentEvents(txt.blocks, { t0: 0 })), ['Open the portal', 'Click Users']);
  const html = await extractDocument({ buf: Buffer.from('<html><head><title>VPN</title><style>p{}</style></head><body><h2>Install the client</h2><p>Download it.</p><script>x()</script><h2>Connect</h2><ul><li>Start it</li></ul></body></html>'), fileName: 'vpn.html' });
  assert.equal(html.title, 'VPN');
  assert.deepEqual(marks(documentEvents(html.blocks, { t0: 0 })), ['Install the client', 'Connect']);
  const srt = await extractDocument({ buf: Buffer.from('1\n00:00:01,000 --> 00:00:03,000\nOpen the portal.\n\n2\n00:01:05,500 --> 00:01:08,000\nThen click Users.\n'), fileName: 'v.srt' });
  assert.deepEqual(srt.blocks.map((b) => [b.ms, b.text]), [[1000, 'Open the portal.'], [65500, 'Then click Users.']]);
});

test('unsupported and unreadable files get a clear message', async () => {
  await assert.rejects(extractDocument({ buf: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0]), fileName: 'old.doc' }), /Word 97-2003.*not supported/);
  await assert.rejects(extractDocument({ buf: Buffer.from('x'), fileName: 'clip.mp4' }), /Videos are read in the browser/);
  await assert.rejects(extractDocument({ buf: Buffer.alloc(0), fileName: 'a.txt' }), /empty/);
  await assert.rejects(extractDocument({ buf: Buffer.from('%PDF-1.4 garbage'), fileName: 'a.pdf' }), /PDF could not be read|No text/);
  assert.equal(detectType('notes', Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nHi')), 'vtt');
});

test('step labels, long paragraphs and video events', () => {
  assert.equal(stepLabel('Step 3 – Assign the licence. Then wait.'), 'Assign the licence');
  assert.equal(stepLabel('2) Open the user'), 'Open the user');
  const parts = chunkText(`${'A sentence. '.repeat(200)}`);
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 1000));
  const ev = videoEvents({ t0: 1000, frames: [{ id: 'f2', atMs: 60_000 }, { id: 'f1', atMs: 0 }], transcript: [{ ms: 2000, speaker: 1, text: 'Open the portal.' }, { ms: 61_000, speaker: 2, text: 'Now click Users.' }] });
  assert.deepEqual(ev.map((e) => e.screenshotId || e.text), ['f1', '[00:02] Speaker 1: Open the portal.', 'f2', '[01:01] Speaker 2: Now click Users.']);
  const one = videoEvents({ t0: 0, frames: [], transcript: [{ ms: 0, speaker: 1, text: 'Hi.' }] });
  assert.equal(one[0].text, '[00:00] Hi.', 'one speaker: no speaker label');
  const { doc } = generateWithRules({ meta: meta('demo.mp4', 'video'), events: withSeq(ev), screenshotsAvailable: new Set(['f1', 'f2']) });
  assert.deepEqual(doc.steps.map((s) => s.title), ['Open the portal', 'Now click Users']);
  assert.deepEqual(doc.steps.map((s) => s.screenshotIds[0]), ['f1', 'f2']);
});

test('the AI is told that the evidence comes from an uploaded file', async () => {
  const { buildUserPrompt, SYSTEM_PROMPT } = await import('../../server/engine/prompts.js');
  const p = buildUserPrompt({ meta: { title: 'T', source: { kind: 'video', fileName: 'demo.mp4' } }, candidateSteps: [], events: [], screenshots: [], base: null });
  assert.match(p, /<evidence_source>Not a live recording: the events were extracted from a video \("demo\.mp4"\)/);
  assert.doesNotMatch(buildUserPrompt({ meta: { title: 'T' }, candidateSteps: [], events: [], screenshots: [], base: null }), /evidence_source/);
  assert.match(SYSTEM_PROMPT, /13\. When <evidence_source>/);
});
