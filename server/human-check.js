// Human check ("are you a person?") shown after sign-in, before the app can be used.
//
// The user solves a small calculation or number puzzle. Everything is checked on the server:
//  - GET  /api/human-check            -> a new challenge: { challengeId, question, hint }
//  - POST /api/human-check  { challengeId, answer } -> { pass, expiresAt } on a correct answer
// The challengeId is signed (HMAC) and carries only a hash of the answer, so the client cannot read
// the answer from it or invent its own challenge. Each challenge can be answered once, expires after
// a few minutes, and repeated wrong answers lock the user out for a while.
// The pass is a signed token bound to the signed-in user. The web app sends it as X-Human-Pass on
// every API call; without a valid pass the API answers 428 with code HUMAN_CHECK_REQUIRED.
//
// Capture clients (browser extension, desktop agent) use their own per-session capture token and
// are not affected. The secret is random per process unless PDA_HUMAN_CHECK_SECRET is set (needed
// when more than one server instance runs, otherwise a restart only means solving one more puzzle).
import crypto from 'node:crypto';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unb64 = (s) => { try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); } catch { return null; } };
const rnd = (min, max) => crypto.randomInt(min, max + 1);
const pick = (arr) => arr[crypto.randomInt(arr.length)];

// Puzzle kinds. Each returns { question, answer, hint }; answers are whole numbers.
export const PUZZLES = {
  add() { const a = rnd(11, 49); const b = rnd(5, 39); return { question: `What is ${a} + ${b}?`, answer: a + b, hint: 'Calculation' }; },
  subtract() { const a = rnd(30, 90); const b = rnd(5, a - 10); return { question: `What is ${a} − ${b}?`, answer: a - b, hint: 'Calculation' }; },
  multiply() { const a = rnd(3, 12); const b = rnd(3, 9); return { question: `What is ${a} × ${b}?`, answer: a * b, hint: 'Calculation' }; },
  mixed() { const a = rnd(2, 9); const b = rnd(2, 9); const c = rnd(1, 20); return { question: `What is ${a} × ${b} + ${c}?`, answer: a * b + c, hint: 'Calculation' }; },
  sequence() {
    const start = rnd(1, 20); const step = rnd(2, 9);
    const seq = Array.from({ length: 4 }, (_, i) => start + i * step);
    return { question: `Which number comes next: ${seq.join(', ')}, …?`, answer: start + 4 * step, hint: 'Number puzzle' };
  },
  missing() {
    const a = rnd(4, 30); const total = a + rnd(5, 40);
    return { question: `Fill the gap: ${a} + ? = ${total}`, answer: total - a, hint: 'Number puzzle' };
  },
  doubling() {
    const start = rnd(2, 6); const seq = [start, start * 2, start * 4, start * 8];
    return { question: `Which number comes next: ${seq.join(', ')}, …?`, answer: start * 16, hint: 'Number puzzle' };
  },
};

export function createHumanCheck(opts = {}) {
  const enabled = opts.enabled !== false;
  const secret = opts.secret ? Buffer.from(String(opts.secret)) : crypto.randomBytes(32);
  const challengeTtlMs = (opts.challengeMinutes ?? 5) * 60_000;
  const passTtlMs = (opts.passHours ?? 12) * 3_600_000;
  const maxFailures = opts.maxFailures ?? 5;
  const lockMs = (opts.lockMinutes ?? 5) * 60_000;
  const now = opts.now || Date.now;
  const kinds = opts.kinds?.length ? opts.kinds.filter((k) => PUZZLES[k]) : Object.keys(PUZZLES);
  const used = new Map(); // challenge nonce -> expiry (one answer per challenge)
  const failures = new Map(); // user id -> { count, lockedUntil }

  const sign = (data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');
  const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const seal = (payload) => { const body = b64(payload); return `${body}.${sign(body)}`; };
  const open = (token) => {
    const [body, sig, extra] = String(token || '').split('.');
    if (!body || !sig || extra !== undefined || !safeEq(sig, sign(body))) return null;
    return unb64(body);
  };
  const answerHash = (nonce, answer) => sign(`answer:${nonce}:${answer}`);
  const sweep = () => { const t = now(); for (const [k, exp] of used) if (exp < t) used.delete(k); };

  function newChallenge(userId) {
    const p = PUZZLES[pick(kinds)]();
    const nonce = crypto.randomBytes(12).toString('base64url');
    const expiresAt = now() + challengeTtlMs;
    const challengeId = seal({ t: 'c', n: nonce, u: userId, h: answerHash(nonce, p.answer), exp: expiresAt });
    return { challengeId, question: p.question, hint: p.hint, expiresAt };
  }

  function lockedUntil(userId) {
    const f = failures.get(userId);
    return f?.lockedUntil && f.lockedUntil > now() ? f.lockedUntil : 0;
  }

  // -> { ok: true, pass, expiresAt } | { ok: false, reason: 'locked'|'expired'|'invalid'|'wrong', retryAfterMs? }
  function verify(userId, challengeId, rawAnswer) {
    const locked = lockedUntil(userId);
    if (locked) return { ok: false, reason: 'locked', retryAfterMs: locked - now() };
    const c = open(challengeId);
    if (!c || c.t !== 'c' || c.u !== userId) return { ok: false, reason: 'invalid' };
    if (c.exp < now()) return { ok: false, reason: 'expired' };
    sweep();
    if (used.has(c.n)) return { ok: false, reason: 'invalid' };
    used.set(c.n, c.exp);
    const answer = String(rawAnswer ?? '').trim().replace(/^\+/, '');
    if (!/^-?\d{1,6}$/.test(answer) || !safeEq(answerHash(c.n, Number(answer)), c.h)) {
      const f = failures.get(userId) || { count: 0, lockedUntil: 0 };
      f.count += 1;
      if (f.count >= maxFailures) { f.count = 0; f.lockedUntil = now() + lockMs; }
      failures.set(userId, f);
      return { ok: false, reason: f.lockedUntil > now() ? 'locked' : 'wrong', retryAfterMs: f.lockedUntil > now() ? f.lockedUntil - now() : undefined };
    }
    failures.delete(userId);
    const expiresAt = now() + passTtlMs;
    return { ok: true, pass: seal({ t: 'p', u: userId, exp: expiresAt }), expiresAt };
  }

  function hasPass(userId, token) {
    const p = open(token);
    return !!p && p.t === 'p' && p.u === userId && p.exp > now();
  }

  return { enabled, newChallenge, verify, hasPass, lockedUntil };
}
