// End-to-end test: real Chromium with the capture extension loaded, the real web app and API, and a
// test web portal (test/fixtures/admin-portal.html) on a different origin where the process is
// actually performed. Covers: new process recording -> generation -> clarifications -> approval ->
// publishing, then update recording -> comparison -> per-change decisions -> publishing v1.1.
// Publishing goes to the LOCAL repository adapter (no SharePoint tenant is available in CI).
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(import.meta.url)('playwright');
const SHOTS = process.env.E2E_SCREENSHOTS ? path.resolve(process.env.E2E_SCREENSHOTS) : null;
const SECRET = 'S3cret-Pass!42';

let dataDir; let appServer; let portalServer; let ctx; let appUrl; let portalUrl;
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apiGet = async (p) => (await fetch(`${appUrl}${p}`, { headers: { 'x-dev-user': 'admin' } })).json();
const snap = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }); } };

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-e2e-'));
  const cfg = loadConfig({ dataDir, repository: { mode: 'local', local: { path: path.join(dataDir, 'repository') } }, ai: { provider: 'rules' } });
  cfg.repository.local.path = path.join(dataDir, 'repository');
  appServer = http.createServer(createApp(cfg));
  appUrl = `http://127.0.0.1:${await listen(appServer)}`;
  const fixture = fs.readFileSync(path.join(ROOT, 'test/fixtures/admin-portal.html'));
  portalServer = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(fixture); });
  // "localhost" instead of 127.0.0.1 gives the portal a different origin from the app.
  portalUrl = `http://localhost:${await listen(portalServer)}/portal`;
  ctx = await chromium.launchPersistentContext('', {
    headless: true, channel: 'chromium', viewport: { width: 1360, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1,
    args: [`--disable-extensions-except=${path.join(ROOT, 'extension')}`, `--load-extension=${path.join(ROOT, 'extension')}`],
  });
  if (!ctx.serviceWorkers().length) await ctx.waitForEvent('serviceworker');
});

after(async () => {
  await ctx?.close(); appServer?.close(); portalServer?.close();
  if (!process.env.KEEP_E2E_DATA) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function startRecording(app) {
  await app.getByTestId('consent').check();
  await app.getByTestId('start').click();
  await app.getByTestId('recbar').waitFor();
  await app.getByTestId('ext-status').filter({ hasText: 'connected' }).waitFor({ timeout: 15000 });
}

async function stopAndGenerate(app) {
  await app.bringToFront();
  await app.getByTestId('stop').click();
  await app.getByTestId('generate').click();
  await app.waitForURL(/#\/review\//);
  await app.getByTestId('tab-clar').waitFor({ timeout: 20000 });
  return app.url().split('/review/')[1];
}

async function resolveClarifications(app) {
  await app.getByTestId('tab-clar').click();
  const answers = { purpose: 'Gives service desk staff the minimum admin rights they need to support users.', scope: 'Included: assigning helpdesk roles to internal staff\nExcluded: global administrator assignments', prerequisites: 'User administrator role in the admin portal', roles: 'Service desk lead: performs the change\nIT security: approves privileged roles' };
  for (let guard = 0; guard < 30; guard++) {
    const card = app.locator('[data-testid=clarification]:has([data-testid=clar-answer])').first();
    if (!(await card.count())) break;
    const section = (await card.locator('.badge').innerText()).trim();
    if (answers[section]) { await card.getByTestId('clar-answer').fill(answers[section]); await card.getByTestId('clar-apply').click(); }
    else await card.getByTestId('clar-dismiss').click();
    await sleep(300);
  }
}

async function approveAndPublish(app) {
  await app.getByTestId('approve').click();
  await app.getByTestId('publish').click();
  await app.getByTestId('published').waitFor({ timeout: 15000 });
}

test('new process: capture real browser activity, generate, review, approve and publish', async () => {
  const app = await ctx.newPage();
  await app.goto(`${appUrl}/#/`);
  await snap(app, '01-landing');
  await app.getByTestId('choice-new').click();
  await app.getByTestId('title').fill('Grant helpdesk permissions to a user');
  await startRecording(app);

  const portal = await ctx.newPage();
  await portal.goto(`${portalUrl}#/users`);
  await sleep(1200);
  await portal.getByLabel('Search users').click();
  await portal.getByLabel('Search users').fill('jdoe');
  await portal.keyboard.press('Enter');
  await sleep(500);
  await portal.getByRole('gridcell', { name: 'John Doe' }).click();
  await sleep(1200);
  await portal.getByLabel('Permission level').selectOption('Helpdesk administrator');
  await sleep(300);
  await portal.getByRole('button', { name: 'Save' }).click();
  await sleep(2500); // toast + upload

  await app.bringToFront();
  await app.getByTestId('note-input').fill('Only assign helpdesk roles to staff accounts, never to guests.');
  await app.getByTestId('add-note').click();
  await sleep(2000);
  await snap(app, '02-recording');
  const draftId = await stopAndGenerate(app);

  const d = await apiGet(`/api/drafts/${draftId}`);
  const text = d.doc.steps.flatMap((s) => [s.title, ...s.instructions, s.expectedResult]).join('\n');
  assert.ok(d.doc.steps.length >= 2, `expected at least 2 steps, got ${d.doc.steps.length}`);
  assert.match(text, /Select "Helpdesk administrator" in "Permission level"/);
  assert.match(text, /Click "Save"/);
  assert.match(text, /Changes saved successfully/);
  assert.ok(d.doc.steps.some((s) => s.screenshotIds.length), 'screenshots are attached to steps');
  const marks = d.doc.steps.flatMap((s) => s.marks || []);
  assert.ok(marks.length > 0, 'clicks are numbered on the step screenshots');
  assert.ok(d.doc.steps.every((s) => (s.marks || []).every((m, i) => m.n === i + 1 && s.screenshotIds.includes(m.shotId))), 'markers are numbered in order on the step\'s own screenshots');
  assert.ok(d.clarifications.some((c) => c.section === 'purpose'), 'missing purpose is asked, not invented');
  assert.ok(d.blockers.length > 0, 'cannot approve with open clarifications');
  await app.getByTestId('tab-doc').click();
  await snap(app, '03-review-generated');

  // Screenshot editor: add a click marker by hand and crop to the upper-left part, then save.
  await app.getByTestId('edit-shot').first().click();
  const canvas = app.getByTestId('shot-canvas');
  await canvas.locator('img').waitFor();
  const cb = await canvas.boundingBox();
  await app.getByTestId('tool-click').click();
  await app.mouse.click(cb.x + cb.width * 0.3, cb.y + cb.height * 0.3);
  await app.getByTestId('tool-crop').click();
  await app.mouse.move(cb.x + 2, cb.y + 2); await app.mouse.down();
  await app.mouse.move(cb.x + cb.width * 0.6, cb.y + cb.height * 0.6, { steps: 5 }); await app.mouse.up();
  if (SHOTS) await app.screenshot({ path: path.join(SHOTS, '03b-shot-editor.png') });
  await app.getByTestId('shot-save').click();
  await app.getByTestId('save').click();
  await app.getByTestId('save').filter({ hasText: 'Saved' }).waitFor();
  await app.locator('.marked-shot').first().scrollIntoViewIfNeeded();
  if (SHOTS) await app.screenshot({ path: path.join(SHOTS, '03c-cropped.png') });
  const edited = (await apiGet(`/api/drafts/${draftId}`)).doc.steps.find((s) => s.crops?.length);
  assert.ok(edited, 'the crop is saved with the step');
  assert.ok(edited.marks.length >= 2 && edited.marks.at(-1).kind === 'click', 'the hand-placed marker is saved');
  const shotId = edited.crops[0].shotId;
  const sizeOf = async (q) => { const r = await fetch(`${appUrl}/api/drafts/${draftId}/screenshots/${shotId}${q}`, { headers: { 'x-dev-user': 'admin' } }); const b = Buffer.from(await r.arrayBuffer()); return (await import('sharp')).default(b).metadata(); };
  const full = await sizeOf('?raw=1'); const cut = await sizeOf('');
  assert.ok(cut.width < full.width * 0.7 && cut.height < full.height * 0.7, `the shown screenshot is cropped (${cut.width}x${cut.height} of ${full.width}x${full.height})`);

  await resolveClarifications(app);
  await snap(app, '04-clarifications');
  await approveAndPublish(app);
  await snap(app, '05-published');
  const pub = await apiGet(`/api/drafts/${draftId}`);
  assert.equal(pub.status, 'published');
  assert.equal(pub.published.version, '1.0');
  const proc = await apiGet(`/api/processes/${pub.published.processId}`);
  assert.equal(proc.doc.info.version, '1.0');
  assert.match(proc.doc.purpose, /minimum admin rights/);
  const docx = fs.readFileSync(path.join(pub.published.location, 'document.docx'));
  assert.equal(docx.subarray(0, 2).toString(), 'PK', 'a valid .docx (zip) was published');
  assert.ok(fs.readdirSync(path.join(pub.published.location, 'screenshots')).length > 0);
  assert.ok(proc.doc.keywords.length >= 3, 'the published document has search keywords');
  // Search: by keyword, by a word inside a step, with a typo; the library shows the result and its keywords.
  const found = await apiGet(`/api/processes?q=${encodeURIComponent('helpdesk permision')}`);
  assert.equal(found[0]?.processId, pub.published.processId, 'found with a typo');
  assert.ok((await apiGet(`/api/processes?q=${encodeURIComponent(proc.doc.keywords[0])}`)).some((x) => x.processId === pub.published.processId), 'found by keyword');
  await app.goto(`${appUrl}/#/library`);
  await app.getByTestId('library-search').fill('permission level');
  await app.getByTestId('search-count').filter({ hasText: 'for “permission level”' }).waitFor();
  assert.match(await app.getByTestId('search-result').first().innerText(), /Found in step/);
  await snap(app, '05b-library-search');
  await portal.close(); await app.close();
});

test('update process: record changed procedure, compare, decide per change, publish v1.1', async () => {
  const app = await ctx.newPage();
  await app.goto(`${appUrl}/#/update`);
  await app.getByTestId('search').fill('helpdesk');
  await app.getByRole('link', { name: 'Select' }).first().click();
  await startRecording(app);

  const portal = await ctx.newPage();
  await portal.goto(`${portalUrl}?v=2#/users`);
  await sleep(1200);
  await portal.getByLabel('Search users').click();
  await portal.getByLabel('Search users').fill('jdoe');
  await portal.keyboard.press('Enter');
  await sleep(500);
  await portal.getByRole('gridcell', { name: 'John Doe' }).click();
  await sleep(1200);
  await portal.getByRole('tab', { name: 'Security' }).click();
  await sleep(800);
  await portal.getByLabel('Permission level').selectOption('Helpdesk administrator');
  await portal.getByLabel('Require phishing-resistant MFA').check();
  await sleep(800);
  await portal.getByLabel('Temporary password').click();
  await portal.getByLabel('Temporary password').fill(SECRET);
  await sleep(800);
  await portal.getByRole('button', { name: 'Save' }).click();
  await sleep(1500);
  await portal.getByRole('link', { name: 'View permission summary' }).click();
  await sleep(2500);

  const draftId = await stopAndGenerate(app);
  const d = await apiGet(`/api/drafts/${draftId}`);
  assert.equal(d.mode, 'update');
  assert.ok(d.comparison.summary.added + d.comparison.summary.modified >= 1, `expected changes, got ${JSON.stringify(d.comparison.summary)}`);
  await app.getByTestId('tab-changes').click();
  await snap(app, '06-comparison');
  await app.getByTestId('accept-all').click();
  await sleep(800);
  await resolveClarifications(app);
  await app.getByTestId('tab-changes').click();
  await approveAndPublish(app);
  await snap(app, '07-update-published');

  const pub = await apiGet(`/api/drafts/${draftId}`);
  assert.equal(pub.published.version, '1.1');
  const proc = await apiGet(`/api/processes/${pub.published.processId}`);
  assert.equal(proc.versions.length, 2, 'previous approved version kept in history');
  assert.match(JSON.stringify(proc.doc.steps), /Security/);
  assert.match(proc.doc.changeHistory.at(-1).summary, /added|modified/);
  assert.ok(fs.existsSync(path.join(pub.published.location, '_versions', '1.0', 'document.docx')), 'v1.0 preserved');
  await portal.close(); await app.close();
});

test('guided mode: the add-in walks a colleague through the published procedure', async () => {
  const pid = (await apiGet('/api/processes'))[0].processId;
  const proc = await apiGet(`/api/processes/${pid}`);
  const steps = proc.doc.steps.filter((s) => s.targets.length);
  assert.ok(steps.length >= 2, `published steps carry what to click (got ${JSON.stringify(proc.doc.steps.map((s) => s.targets))})`);
  const app = await ctx.newPage();
  await app.goto(`${appUrl}/#/library/${pid}`);
  await app.getByTestId('guide-start').click();
  await app.getByText('Started.').waitFor();
  const portal = await ctx.newPage();
  await portal.goto(`${portalUrl}#/users`);
  const panel = portal.locator('div[role=dialog][aria-label="Guided procedure"]');
  await panel.waitFor({ timeout: 10000 });
  const first = proc.doc.steps[0].targets[0];
  assert.match(await panel.innerText(), /Step 1 of/);
  assert.match(await panel.innerText(), new RegExp(`(Click|Fill in|Choose in)\\s+${first.name}`));
  await snap(portal, '08-guided-mode');
  const before = await panel.innerText();
  const el = ['textbox', 'searchbox', 'combobox', 'checkbox'].includes(first.role) ? portal.getByLabel(first.name).first() : portal.getByRole(first.role, { name: first.name }).first();
  await el.click();
  for (let i = 0; i < 30 && (await panel.innerText()) === before; i++) await sleep(100);
  assert.notEqual(await panel.innerText(), before, 'clicking the highlighted element moves the guide on');
  await panel.getByRole('button', { name: 'End guide' }).click();
  await panel.waitFor({ state: 'detached', timeout: 5000 });
  await portal.close(); await app.close();
});

test('the password typed during recording never reached storage', () => {
  const hits = [];
  const walk = (dir) => { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isDirectory()) walk(p); else if (fs.readFileSync(p).includes(SECRET)) hits.push(p); } };
  walk(dataDir);
  assert.deepEqual(hits, []);
});
