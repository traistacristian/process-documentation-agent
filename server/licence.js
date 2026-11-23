// Licence rules of the multi-tenant deployment, checked by server/saas.js on every request of a
// registered tenant.
//
//   status trial       full use until trialEndsAt, then read-only. Self-service trials last at most
//                      MAX_TRIAL_DAYS days and have 1 seat (only the administrator who signed up).
//   status active      full use within the plan's seats and AI quota.
//   status suspended   read-only (payment problem): people can still read, download and delete.
//   status cancelled   no access (handled by the registry).
//
// Seats: distinct people who use the app in a calendar month (UTC). Once all seats are taken, a
// further person is refused until the next month or until the subscription has more seats.
// AI quota: AI-drafted documents per calendar month. Over the quota, documents are still drafted,
// by the rule-based engine.
const DAY = 86400_000;
export const MAX_TRIAL_DAYS = 5;
export const DEFAULT_PLANS = {
  trial: { seats: 1, aiGenerations: 20 },
  pilot: { seats: 25, aiGenerations: 300 },
  team: { seats: 10, aiGenerations: 200 },
  business: { seats: 50, aiGenerations: 1000 },
};
const READ = new Set(['GET', 'HEAD', 'OPTIONS']);

export const trialDays = (cfg) => Math.min(MAX_TRIAL_DAYS, Math.max(1, Number(cfg.saas?.trialDays) || MAX_TRIAL_DAYS));
export const month = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);

export function limits(cfg, t) {
  const plan = { ...DEFAULT_PLANS, ...(cfg.saas?.plans || {}) }[t.plan || t.status] || {};
  const pick = (k) => (t[k] !== undefined && t[k] !== null ? t[k] : plan[k] ?? null);
  return { seats: pick('seats'), aiGenerations: pick('aiGenerations') };
}

// What the tenant may do right now: { readOnly, reason, seats, aiGenerations, trialEndsAt }.
export function evaluate(cfg, t, now = Date.now()) {
  const l = limits(cfg, t);
  let reason = null;
  if (t.status === 'suspended') reason = 'suspended';
  else if (t.status === 'trial' && t.trialEndsAt && now > t.trialEndsAt) reason = 'trial_ended';
  return { readOnly: !!reason, reason, plan: t.plan || t.status, status: t.status, trialEndsAt: t.trialEndsAt || null, ...l };
}

const MESSAGES = {
  trial_ended: ['TRIAL_ENDED', 'Your trial has ended. You can still read and download your documents; to record and publish again, your administrator buys a subscription.'],
  suspended: ['SUBSCRIPTION_SUSPENDED', 'Your subscription is suspended (payment). You can still read and download your documents; ask your administrator to renew it.'],
};

// Throws an HTTP 402 error when the request is not allowed under the licence.
// Reading, downloading and deleting stay allowed while read-only.
export function checkRequest(lic, method) {
  if (!lic.readOnly || READ.has(method) || method === 'DELETE') return;
  const [code, message] = MESSAGES[lic.reason];
  throw Object.assign(new Error(message), { status: 402, code });
}

export const seatError = (seats) => Object.assign(new Error(`All ${seats} seat${seats === 1 ? '' : 's'} of your organisation's subscription ${seats === 1 ? 'is' : 'are'} in use this month. Ask your administrator to add seats.`), { status: 402, code: 'SEAT_LIMIT' });

export { DAY };
