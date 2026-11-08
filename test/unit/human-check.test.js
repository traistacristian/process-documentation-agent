// Human check after sign-in: puzzle generation, server-side verification, one answer per puzzle,
// lock-out after repeated wrong answers, and the API gate (428 until the puzzle is solved).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadConfig } from '../../server/config.js';
import { createApp } from '../../server/app.js';
import { createHumanCheck, PUZZLES } from '../../server/human-check.js';

// Solves a question the way a person would (the test only knows the question text).
function solve(q) {
  let m;
  if ((m = /^What is (\d+) \+ (\d+)\?$/.exec(q))) return +m[1] + +m[2];
  if ((m = /^What is (\d+) − (\d+)\?$/.exec(q))) return m[1] - m[2];
  if ((m = /^What is (\d+) × (\d+)\?$/.exec(q))) return m[1] * m[2];
  if ((m = /^What is (\d+) × (\d+) \+ (\d+)\?$/.exec(q))) return m[1] * m[2] + +m[3];
  if ((m = /^Fill the gap: (\d+) \+ \? = (\d+)$/.exec(q))) return m[2] - m[1];
  if ((m = /^Which number comes next: ([\d, ]+), …\?$/.exec(q))) {
    const n = m[1].split(', ').map(Number);
    return n[1] - n[0] === n[2] - n[1] ? n[3] + (n[1] - n[0]) : n[3] * (n[1] / n[0]);
  }
  throw new Error(`Unknown question: ${q}`);
}

test('every puzzle kind has a whole-number answer that matches its question', () => {
  for (const [kind, make] of Object.entries(PUZZLES)) for (let i = 0; i < 50; i++) {
    const p = make();
    assert.ok(Number.isInteger(p.answer) && p.answer >= 0, kind);
    assert.equal(solve(p.question), p.answer, `${kind}: ${p.question}`);
  }
});

test('a correct answer gives a pass bound to the user; the challenge does not reveal the answer', () => {
  const hc = createHumanCheck();
  const c = hc.newChallenge('alex');
  const answer = solve(c.question);
  assert.ok(!Buffer.from(c.challengeId.split('.')[0], 'base64url').toString().includes(`"${answer}"`));
  const r = hc.verify('alex', c.challengeId, ` ${answer} `);
  assert.equal(r.ok, true);
  assert.equal(hc.hasPass('alex', r.pass), true);
  assert.equal(hc.hasPass('sam', r.pass), false, 'a pass only works for the user who solved the puzzle');
  assert.equal(hc.hasPass('alex', `${r.pass}x`), false, 'a tampered pass is rejected');
  assert.equal(hc.verify('alex', c.challengeId, answer).ok, false, 'a challenge can be answered only once');
  assert.equal(hc.verify('sam', hc.newChallenge('alex').challengeId, answer).reason, 'invalid', 'a challenge belongs to one user');
});

test('passes and challenges expire; repeated wrong answers lock the user out', () => {
  let t = 1_000_000;
  const hc = createHumanCheck({ now: () => t, passHours: 1, challengeMinutes: 5, maxFailures: 3, lockMinutes: 5 });
  const c = hc.newChallenge('u');
  t += 6 * 60_000;
  assert.equal(hc.verify('u', c.challengeId, solve(c.question)).reason, 'expired');
  const fresh = hc.newChallenge('u');
  const ok = hc.verify('u', fresh.challengeId, solve(fresh.question));
  assert.equal(ok.ok, true);
  t += 61 * 60_000;
  assert.equal(hc.hasPass('u', ok.pass), false, 'the pass expires');
  assert.equal(hc.verify('u', hc.newChallenge('u').challengeId, 'abc').reason, 'wrong');
  assert.equal(hc.verify('u', hc.newChallenge('u').challengeId, '-1').reason, 'wrong');
  assert.equal(hc.verify('u', hc.newChallenge('u').challengeId, '-1').reason, 'locked');
  const c2 = hc.newChallenge('u');
  assert.equal(hc.verify('u', c2.challengeId, solve(c2.question)).reason, 'locked', 'even a right answer is refused while locked');
  t += 6 * 60_000;
  const c3 = hc.newChallenge('u');
  assert.equal(hc.verify('u', c3.challengeId, solve(c3.question)).ok, true, 'the lock ends');
});

let srv; let base; let dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-hc-'));
  const cfg = loadConfig({ dataDir: dir, ai: { provider: 'rules' }, auth: { humanCheck: { enabled: true } } });
  cfg.repository.local.path = path.join(dir, 'repository');
  srv = http.createServer(createApp(cfg));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const call = async (method, p, body, headers = {}) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-dev-user': 'alex', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

test('the API stays locked until the signed-in user solves the puzzle', async () => {
  assert.equal((await call('GET', '/api/config')).body.humanCheck, true);
  assert.equal((await call('GET', '/api/me')).status, 200, 'who am I works before the check');
  const locked = await call('GET', '/api/dashboard');
  assert.equal(locked.status, 428);
  assert.equal(locked.body.code, 'HUMAN_CHECK_REQUIRED');

  const c1 = (await call('GET', '/api/human-check')).body;
  const wrong = await call('POST', '/api/human-check', { challengeId: c1.challengeId, answer: solve(c1.question) + 1 });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, 'HUMAN_CHECK_WRONG');

  const c2 = (await call('GET', '/api/human-check')).body;
  const ok = await call('POST', '/api/human-check', { challengeId: c2.challengeId, answer: solve(c2.question) });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/dashboard', null, { 'x-human-pass': ok.body.pass })).status, 200);
  assert.equal((await call('GET', '/api/dashboard', null, { 'x-human-pass': ok.body.pass, 'x-dev-user': 'sam' })).status, 428, 'another user needs their own pass');
});
