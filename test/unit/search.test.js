import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SearchIndex, tokenize } from '../../server/search.js';
import { sampleDocs } from '../../server/engine/samples.js';
import { extractKeywords, normalizeKeywords } from '../../server/engine/keywords.js';

let n = 0;
const docs = sampleDocs({ user: { name: 'Tester' }, newProcessId: () => `PRC-2026-00000${++n}` });
docs[0].keywords = ['password', 'reset', 'MFA', 'Kennwort zurücksetzen'];

function fakeRepo(list) {
  const state = { docs: new Map(list.map((d) => [d.info.processId, d])), gets: 0 };
  return {
    state,
    async list() { return [...state.docs.values()].map((d) => ({ processId: d.info.processId, title: d.info.title, version: d.info.version, category: d.info.category, owner: d.info.owner, updatedAt: d.info.updatedAt, etag: `"${d.info.version}"` })); },
    async get(pid) { state.gets++; const doc = state.docs.get(pid); return doc ? { doc } : null; },
  };
}

test('tokenize folds case and accents and drops stop words and plural s', () => {
  assert.deepEqual(tokenize('Löschen the USERS of Größe'), ['loschen', 'user', 'grosse']);
});

test('keywords are suggested from the document and normalised', () => {
  const k = extractKeywords(docs[2]);
  assert.ok(k.includes('Microsoft 365 admin center'));
  assert.ok(k.some((x) => /mailbox/i.test(x)));
  assert.deepEqual(normalizeKeywords(' MFA, mfa ;Reset\n\nreset password '), ['MFA', 'Reset', 'reset password']);
});

test('search ranks by title and keywords, matches prefixes, typos, accents and finds the step', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-search-'));
  const repo = fakeRepo(docs);
  const idx = new SearchIndex({ repo, dataDir: dir });
  await idx.refresh();
  assert.equal(idx.list().length, docs.length);

  const top = (q) => idx.search(q).map((r) => r.title);
  assert.equal(top('password')[0], "Reset a user's password");
  assert.equal(top('pasword')[0], "Reset a user's password", 'one typo is forgiven');
  assert.equal(top('passw')[0], "Reset a user's password", 'word beginnings match');
  assert.equal(top('kennwort zurucksetzen')[0], "Reset a user's password", 'accents are ignored');
  assert.equal(top('mfa')[0], "Reset a user's password", 'keywords are searchable');
  assert.deepEqual(top('shared mailbox convert'), ['Offboard a leaving employee'], 'every word must match');
  assert.deepEqual(top('nothing-like-this'), []);

  const r = idx.search('licence')[0];
  assert.equal(r.title, 'Create a new employee account');
  assert.ok(r.matched.steps.length > 0, 'the matching step is named');
  assert.ok(r.keywords.length > 0, 'results carry their keywords');
  assert.ok(idx.keywords().some((k) => k.keyword === 'Microsoft 365 admin center' && k.count === docs.length - 1));

  // The index is kept on disk: a new instance answers without reading the documents again.
  const again = new SearchIndex({ repo, dataDir: dir });
  const before = repo.state.gets;
  await again.refresh();
  assert.equal(repo.state.gets, before, 'unchanged documents are not re-read');
  assert.equal(again.search('password')[0].title, "Reset a user's password");

  // A new version is re-indexed, a removed process disappears.
  const d = structuredClone(docs[1]); d.info.version = '1.1'; d.keywords = ['onboarding', 'joiner']; repo.state.docs.set(d.info.processId, d);
  repo.state.docs.delete(docs[3].info.processId);
  await again.refresh({ force: true });
  assert.equal(again.search('joiner')[0].title, 'Create a new employee account');
  assert.equal(again.list().length, docs.length - 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
