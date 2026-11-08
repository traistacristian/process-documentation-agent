// German + English documents and guided-mode targets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { translateDoc, otherLanguages } from '../../server/engine/translate.js';
import { renderMarkdown, renderDocx } from '../../server/engine/render.js';
import { attachTargets } from '../../server/engine/targets.js';
import { emptyDoc, emptyStep, normalizeDoc } from '../../server/engine/schema.js';
import { LocalRepository } from '../../server/repo/local.js';
import { loadConfig } from '../../server/config.js';

const sample = () => {
  const d = emptyDoc({ processId: 'PRC-2026-AB12CD', title: 'Reset a password', language: 'en', category: 'Service Desk' });
  d.purpose = 'Lets users sign in again.';
  d.steps = [{ ...emptyStep(1), title: 'Open the user', instructions: ['Open "Active users".', 'Select the user.'], application: 'Microsoft 365 admin center', screenshotIds: ['shot_aa'] }];
  return normalizeDoc(d);
};
const fakeStream = (fn) => ({ messages: { stream: (req) => ({ finalMessage: async () => { const texts = JSON.parse(req.messages[0].content.split('\n\n')[1]); return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ translations: fn(texts, req) }) }] }; } }) } });

test('a document is translated text by text; structure, ids and application names stay', async () => {
  let seen;
  const out = await translateDoc({ cfg: loadConfig(), doc: sample(), to: 'de', client: fakeStream((t, req) => { seen = req; return t.map((x) => `DE:${x}`); }) });
  assert.equal(out.info.language, 'de');
  assert.equal(out.info.title, 'DE:Reset a password');
  assert.deepEqual(out.steps[0].instructions, ['DE:Open "Active users".', 'DE:Select the user.']);
  assert.equal(out.steps[0].application, 'Microsoft 365 admin center', 'application names are not translated');
  assert.deepEqual(out.steps[0].screenshotIds, ['shot_aa']);
  assert.equal(seen.model, 'claude-haiku-5-5');
  assert.match(seen.system, /to German/);
  await assert.rejects(translateDoc({ cfg: loadConfig(), doc: sample(), to: 'de', client: fakeStream((t) => t.slice(1)) }), /instead of/);
  assert.deepEqual(otherLanguages(loadConfig(), 'en'), ['de']);
  assert.deepEqual(otherLanguages(loadConfig(), 'de'), ['en']);
});

test('German documents get German headings and labels', async () => {
  const de = { ...sample(), info: { ...sample().info, language: 'de' } };
  const md = renderMarkdown(de);
  assert.match(md, /## 6\. Prozessablauf – Schritt für Schritt/);
  assert.match(md, /### Schritt 1 – Open the user/);
  assert.match(md, /\*\*Anwendung \/ System:\*\*/);
  assert.match(renderMarkdown(sample()), /## 6\. Process Execution – Step by Step/);
  assert.equal((await renderDocx(de)).subarray(0, 2).toString(), 'PK');
});

test('the local repository keeps the translation next to the original and serves it by language', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-lang-'));
  const cfg = loadConfig(); cfg.repository.local.path = dir;
  const repo = new LocalRepository(cfg);
  const doc = sample(); const de = await translateDoc({ cfg, doc, to: 'de', client: fakeStream((t) => t.map((x) => `DE:${x}`)) });
  const r = await repo.publish({ doc, docx: Buffer.from('PK'), markdown: '#', screenshots: [], expectedEtag: null, translations: [{ language: 'de', doc: de, docx: Buffer.from('PK-de'), markdown: '# de' }] });
  assert.equal(r.translations[0].language, 'de');
  assert.equal((await repo.list()).length, 1, 'the translation is not a second process');
  assert.equal((await repo.get(doc.info.processId, { language: 'de' })).doc.info.title, 'DE:Reset a password');
  assert.equal((await repo.get(doc.info.processId)).translations[0].language, 'de');
  assert.equal(await repo.get(doc.info.processId, { language: 'fr' }), null);
  assert.equal((await repo.file(doc.info.processId, 'document.de.docx')).toString(), 'PK-de');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('guided mode targets come from the recorded clicks behind each step, never from values', () => {
  const d = sample(); d.steps[0].evidenceEventSeqs = [1, 2, 3, 4, 5];
  const ev = [
    { seq: 1, type: 'navigate', url: 'https://admin.microsoft.com/#/users?token=abc' },
    { seq: 2, type: 'click', url: 'https://admin.microsoft.com/Adminportal/Home?x=1#/users', element: { role: 'link', name: 'Active users' } },
    { seq: 3, type: 'click', url: 'https://admin.microsoft.com/Adminportal/Home', element: { role: 'link', name: 'Active users' } },
    { seq: 4, type: 'input', url: 'https://admin.microsoft.com/Adminportal/Home', element: { role: 'textbox', label: 'Password', isPassword: true } },
    { seq: 5, type: 'click', url: 'https://admin.microsoft.com/Adminportal/Home', element: { role: 'button', name: 'Reset password' } },
  ];
  attachTargets(d, ev);
  assert.deepEqual(d.steps[0].targets, [
    { role: 'link', name: 'Active users', url: 'https://admin.microsoft.com/Adminportal/Home' },
    { role: 'button', name: 'Reset password', url: 'https://admin.microsoft.com/Adminportal/Home' },
  ]);
});
