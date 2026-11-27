// Uploaded documents and videos become drafts through the normal generation and review.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadConfig } from '../../server/config.js';
import { createApp } from '../../server/app.js';
import { docx } from './files.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const servers = [];
async function start(deps = {}, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-upl-'));
  const cfg = loadConfig({ dataDir: dir, ai: { provider: 'rules' } });
  cfg.repository.local.path = path.join(dir, 'repository');
  Object.assign(cfg, extra);
  const srv = http.createServer(createApp(cfg, { protectScreenshot: async () => ({ count: 0, kinds: [] }), ...deps }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  servers.push({ srv, dir });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, body, user = 'alex') => {
    const raw = Buffer.isBuffer(body);
    const r = await fetch(base + p, { method, headers: { 'content-type': raw ? 'application/octet-stream' : 'application/json', 'x-dev-user': user }, body: raw ? body : body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
  };
  const waitDraft = async (id) => { for (let i = 0; i < 100; i++) { const d = (await call('GET', `/api/drafts/${id}`)).body; if (d.status !== 'generating') return d; await new Promise((r) => setTimeout(r, 30)); } throw new Error('timeout'); };
  const waitUpload = async (id) => { for (let i = 0; i < 100; i++) { const s = (await call('GET', `/api/uploads/${id}`)).body; if (s.draftId || s.status === 'failed') return s; await new Promise((r) => setTimeout(r, 30)); } throw new Error('timeout'); };
  return { dir, cfg, call, waitDraft, waitUpload };
}
after(() => { for (const { srv, dir } of servers) { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); } });

let A;
before(async () => { A = await start(); });

test('a Word document becomes a draft; secrets are removed and the file is not kept', async () => {
  const { call, waitDraft, dir } = A;
  assert.equal((await call('POST', '/api/uploads', { kind: 'document', fileName: 'mfa.docx' })).status, 400, 'consent is required');
  assert.equal((await call('POST', '/api/uploads', { kind: 'document', consent: true })).status, 400, 'a file name is required');
  const up = (await call('POST', '/api/uploads', { kind: 'document', fileName: 'mfa.docx', consent: true, category: 'Identity & Access Management' })).body;
  assert.equal(up.status, 'uploading');
  assert.equal(up.meta.title, 'mfa', 'without a name the file name is used until the document is read');
  assert.equal((await call('GET', `/api/uploads/${up.id}`, null, 'sam')).status, 404, 'only the person uploading sees the upload');

  const buf = await docx(['title:Reset an MFA method', 'h1:Steps', 'h2:Verify the caller', 'p:Call back on the number in the HR system. Ask max.mustermann@contoso.example, password=Sommer2026!', 'h2:Require re-registration', 'img', 'p:Click "Require re-register multifactor authentication".'], { title: 'Reset an MFA method' });
  const r = await call('POST', `/api/uploads/${up.id}/document`, buf);
  assert.equal(r.status, 202);
  const d = await waitDraft(r.body.id);
  assert.equal(d.status, 'draft');
  assert.equal(d.doc.info.title, 'Reset an MFA method', 'the title comes from the document');
  assert.equal(d.doc.info.category, 'Identity & Access Management');
  assert.deepEqual(d.doc.steps.map((s) => s.title), ['Verify the caller', 'Require re-registration']);
  assert.equal(d.doc.steps[1].screenshotIds.length, 1, 'the picture of step 2 is its screenshot');
  const text = JSON.stringify(d.doc);
  assert.ok(!text.includes('Sommer2026') && !text.includes('max.mustermann@'), 'password and e-mail address are removed');
  assert.match(d.history[0].action, /drafted from the uploaded file "mfa\.docx"/);
  assert.ok(!fs.readdirSync(path.join(dir, 'uploads')).length, 'the uploaded file is not stored');
  assert.equal((await call('POST', `/api/uploads/${up.id}/document`, buf)).status, 409, 'an upload is read once');
  const shot = d.doc.steps[1].screenshotIds[0];
  assert.ok(fs.existsSync(path.join(dir, 'screenshots', d.sessionId, `${shot}.png`)));
});

test('documents that cannot be read are refused with a reason', async () => {
  const { call } = A;
  const up = (await call('POST', '/api/uploads', { kind: 'document', fileName: 'old.doc', consent: true })).body;
  const r = await call('POST', `/api/uploads/${up.id}/document`, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]));
  assert.equal(r.status, 422);
  assert.match(r.body.error, /not supported/);
  assert.equal((await call('GET', `/api/uploads/${up.id}`)).body.status, 'uploading', 'another file can still be sent');
});

test('a video: frames and the transcribed sound track become the steps; the sound is deleted', async () => {
  let heard = null;
  const B = await start({ transcribeAudio: async ({ path: p, mime, language }) => { heard = { bytes: fs.statSync(p).size, mime, language }; return [{ ms: 1000, durationMs: 2000, speaker: 1, text: 'First open the Entra admin center.' }, { ms: 31000, durationMs: 2000, speaker: 1, text: 'Then click Reset password. The password is Summer2026!' }]; } });
  const { call, waitUpload, waitDraft, dir } = B;
  assert.equal((await call('GET', '/api/config')).body.uploads.transcription, true);
  const up = (await call('POST', '/api/uploads', { kind: 'video', fileName: 'reset.mp4', title: 'Reset a password', consent: true, language: 'de' })).body;
  assert.equal((await call('POST', `/api/uploads/${up.id}/document`, Buffer.from('x'))).status, 409, 'a video is not read as a document');
  assert.equal((await call('POST', `/api/uploads/${up.id}/finish`)).status, 422, 'nothing sent yet');
  await call('POST', `/api/uploads/${up.id}/frames`, { data: PNG, atMs: 0 });
  await call('POST', `/api/uploads/${up.id}/frames`, { data: PNG, atMs: 30000 });
  await call('POST', `/api/uploads/${up.id}/audio`, Buffer.from('RIFF-part-1'));
  await call('POST', `/api/uploads/${up.id}/audio`, Buffer.from('-part-2'));
  assert.equal((await call('POST', `/api/uploads/${up.id}/finish`)).status, 202);
  const s = await waitUpload(up.id);
  assert.ok(s.draftId, s.error);
  const d = await waitDraft(s.draftId);
  assert.deepEqual(heard, { bytes: 18, mime: 'audio/wav', language: 'de' });
  assert.ok(!fs.existsSync(path.join(dir, 'uploads', `${up.id}.wav`)), 'the sound track is deleted after transcription');
  assert.equal(d.doc.steps.length, 2);
  assert.deepEqual(d.doc.steps.map((x) => x.title), ['First open the Entra admin center', 'Then click Reset password']);
  assert.equal(d.doc.steps.filter((x) => x.screenshotIds.length).length, 2);
  assert.ok(!JSON.stringify(d.doc).includes('Summer2026'), 'spoken secrets are masked');
  assert.match(d.suggestions.join(' '), /uploaded video "reset\.mp4"/);
  assert.equal((await call('POST', `/api/uploads/${up.id}/frames`, { data: PNG, atMs: 1 })).status, 409, 'finished');
});

test('a video without transcription, or in a category with AI off, uses subtitles or only the screens', async () => {
  let calls = 0;
  const C = await start({ transcribeAudio: async () => { calls++; return []; } }, { aiPolicy: { offCategories: ['Service Desk'] } });
  const { call, waitUpload, waitDraft } = C;
  const up = (await call('POST', '/api/uploads', { kind: 'video', fileName: 'unlock.webm', consent: true, category: 'Service Desk' })).body;
  await call('POST', `/api/uploads/${up.id}/frames`, { data: PNG, atMs: 0 });
  await call('POST', `/api/uploads/${up.id}/audio`, Buffer.from('sound'));
  await call('POST', `/api/uploads/${up.id}/finish`);
  const d = await waitDraft((await waitUpload(up.id)).draftId);
  assert.equal(calls, 0, 'AI off: the sound is not sent to Azure AI Speech');
  assert.match(d.suggestions[0], /not transcribed: The AI is switched off for the category "Service Desk"/);
  assert.equal(d.engine, 'rules');

  const up2 = (await call('POST', '/api/uploads', { kind: 'video', fileName: 'unlock.webm', consent: true, category: 'Service Desk' })).body;
  assert.equal((await call('POST', `/api/uploads/${up2.id}/subtitles?fileName=x.txt`, Buffer.from('just text'))).status, 422);
  const sub = await call('POST', `/api/uploads/${up2.id}/subtitles?fileName=unlock.vtt`, Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Anna>Open the user and click Unlock.</v>\n'));
  assert.equal(sub.body.subtitleLines, 1);
  await call('POST', `/api/uploads/${up2.id}/audio`, Buffer.from('sound'));
  await call('POST', `/api/uploads/${up2.id}/finish`);
  const d2 = await waitDraft((await waitUpload(up2.id)).draftId);
  assert.equal(calls, 0, 'subtitles are used instead of transcribing');
  assert.deepEqual(d2.doc.steps[0].instructions, ['Open the user and click Unlock.']);
});
