// End-to-end: in real Chromium, a Word document and a video are uploaded through the web app and
// become drafts on the review page. The video is read in the browser (screens + sound track);
// Azure AI Speech is replaced by a stub that reports what it received.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../server/config.js';
import { createApp } from '../../server/app.js';
import { docx } from '../unit/files.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(import.meta.url)('playwright');
const SHOTS = process.env.E2E_SCREENSHOTS ? path.resolve(process.env.E2E_SCREENSHOTS) : null;
const snap = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }); } };

let dataDir; let server; let browser; let appUrl; let heard = null;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-e2e-upl-'));
  const cfg = loadConfig({ dataDir, ai: { provider: 'rules' } });
  cfg.repository.local.path = path.join(dataDir, 'repository');
  const api = createApp(cfg, {
    protectScreenshot: async () => ({ count: 0, kinds: [] }),
    transcribeAudio: async ({ path: p }) => {
      const wav = fs.readFileSync(p);
      heard = { riff: wav.subarray(0, 4).toString(), rate: wav.readUInt32LE(24), seconds: (wav.length - 44) / 32000 };
      return [{ ms: 500, durationMs: 2000, speaker: 1, text: 'First open the user list.' }, { ms: 3500, durationMs: 2000, speaker: 1, text: 'Then select the user and click Edit.' }, { ms: 6500, durationMs: 2000, speaker: 1, text: 'Finally save the changes.' }];
    },
  });
  server = http.createServer(api);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  appUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('upload a Word document and a video from the home page', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 })).newPage();
  await page.goto(appUrl);
  await page.getByTestId('choice-upload').click();

  const file = path.join(dataDir, 'Unlock an account.docx');
  fs.writeFileSync(file, await docx(['title:Unlock an account', 'h1:Steps', 'h2:Find the user', 'li:Open Users > Active users.', 'li:Search for the user.', 'h2:Unlock the account', 'img', 'li:Click "Unblock sign-in".'], { title: 'Unlock an account' }));
  await page.getByTestId('upload-file').setInputFiles(file);
  await page.getByTestId('upload-consent').check();
  await snap(page, 'upload-01-document');
  await page.getByTestId('upload-start').click();
  await page.waitForURL(/#\/review\//);
  await page.getByTestId('uploaded-from').filter({ hasText: 'Unlock an account.docx' }).waitFor({ timeout: 20000 });
  const draftOf = async () => (await fetch(`${appUrl}/api/drafts/${page.url().split('/review/')[1]}`, { headers: { 'x-dev-user': 'admin' } })).json();
  const first = await draftOf();
  assert.deepEqual(first.doc.steps.map((s) => s.title), ['Find the user', 'Unlock the account']);
  assert.equal(first.doc.steps[1].screenshotIds.length, 1);
  await snap(page, 'upload-02-review-document');

  await page.goto(`${appUrl}/#/upload`);
  await page.getByTestId('upload-file').setInputFiles(path.join(ROOT, 'test/fixtures/upload-screens.webm'));
  await page.getByTestId('video-note').waitFor();
  await page.getByTestId('upload-title').fill('Edit a user');
  await page.getByTestId('upload-consent').check();
  await page.getByTestId('upload-start').click();
  await page.waitForURL(/#\/review\//, { timeout: 60000 });
  await page.getByTestId('uploaded-from').filter({ hasText: 'upload-screens.webm' }).waitFor({ timeout: 20000 });
  await snap(page, 'upload-03-review-video');
  assert.equal(heard.riff, 'RIFF');
  assert.equal(heard.rate, 16000);
  assert.ok(heard.seconds > 8 && heard.seconds < 10, `the whole sound track is sent (${heard.seconds} s)`);
  const draft = await draftOf();
  assert.equal(draft.doc.info.title, 'Edit a user');
  assert.equal(draft.doc.steps.length, 3, 'one step per screen of the video');
  assert.ok(draft.doc.steps.every((s) => s.screenshotIds.length === 1));
});
