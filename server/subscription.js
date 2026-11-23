// GET /api/subscription: the organisation's plan and this month's usage, for its Admins
// (multi-tenant deployment). Works while the subscription is read-only.
import { ROLES } from './auth.js';
import { evaluate } from './licence.js';
import { effectiveUser } from './onboarding.js';

const err = (status, message, code) => Object.assign(new Error(message), { status, code });

export function subscriptionView(cfg, registry, t) {
  const lic = evaluate(cfg, t);
  const u = registry.usage(t.id);
  return { plan: lic.plan, status: t.status, trialEndsAt: lic.trialEndsAt, readOnly: lic.readOnly, reason: lic.reason, seats: lic.seats, seatsUsed: u.seatsUsed, aiGenerations: lic.aiGenerations, aiUsed: u.aiUsed, month: u.month };
}

export function mountSubscription(app, { cfg, registry, userOf, wrap }) {
  app.get('/api/subscription', wrap(async (req, res) => {
    let user;
    try { user = await userOf(req); } catch { throw err(401, 'Invalid or expired token'); }
    if (!user) throw err(401, 'Not signed in');
    const t = registry.get(user.tenantId);
    if (!t || !registry.canUse(t.id)) throw err(403, 'Your organisation has not set up the app.', 'TENANT_NOT_ONBOARDED');
    if (!effectiveUser(user, t).roles.includes(ROLES.ADMIN)) throw err(403, 'This action requires the Admin role');
    res.json(subscriptionView(cfg, registry, t));
  }));
}
