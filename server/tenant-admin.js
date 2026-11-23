// Platform owner's tool for the multi-tenant deployment: add, list and change customer tenants.
// Until self-service onboarding and Marketplace billing exist, this is how a pilot customer is
// switched on or off. On Azure App Service run it from the SSH console (data folder = PDA_DATA_DIR).
//
//   npm run tenant -- list
//   npm run tenant -- add <tenant id> --name "Contoso" [--status trial|active] [--plan pilot]
//   npm run tenant -- set <tenant id> [--status suspended] [--name ...] [--plan pilot|team|business]
//                        [--seats 25] [--ai 300] [--trial-ends 2026-12-31]   (seats/ai: "plan" = the plan's default)
//   npm run tenant -- usage <tenant id>
//   npm run tenant -- remove <tenant id>        (registry entry only; data folder is kept)
import { loadConfig } from './config.js';
import { TenantRegistry } from './tenants.js';
import { subscriptionView } from './subscription.js';

const [cmd, id, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i += 2) if (rest[i]?.startsWith('--')) opts[rest[i].slice(2)] = rest[i + 1];

const cfg = loadConfig();
const registry = new TenantRegistry(cfg.dataDir);
const show = (t) => console.log(`${t.id}  ${t.status.padEnd(9)} ${String(t.plan || '-').padEnd(8)} ${t.trialEndsAt && t.status === 'trial' ? `until ${new Date(t.trialEndsAt).toISOString().slice(0, 10)} ` : ''}${t.name}`);

try {
  if (cmd === 'list') {
    const all = registry.list();
    if (!all.length) console.log('No tenants registered.');
    all.forEach(show);
  } else if (cmd === 'add' || cmd === 'set') {
    if (cmd === 'add' && registry.get(id)) throw new Error(`Tenant ${id} is already registered; use "set".`);
    if (cmd === 'set' && !registry.get(id)) throw new Error(`Tenant ${id} is not registered; use "add".`);
    const patch = {};
    for (const k of ['name', 'status', 'plan']) if (opts[k] !== undefined) patch[k] = opts[k];
    const num = (v, what) => { if (v === 'plan') return null; const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new Error(`${what} must be a whole number or "plan"`); return n; };
    if (opts.seats !== undefined) patch.seats = num(opts.seats, '--seats');
    if (opts.ai !== undefined) patch.aiGenerations = num(opts.ai, '--ai');
    if (opts['trial-ends'] !== undefined) { const d = Date.parse(`${opts['trial-ends']}T23:59:59Z`); if (Number.isNaN(d)) throw new Error('--trial-ends must be a date, e.g. 2026-12-31'); patch.trialEndsAt = d; }
    show(registry.upsert(id, patch));
  } else if (cmd === 'usage') {
    const t = registry.get(id);
    if (!t) throw new Error(`Tenant ${id} is not registered.`);
    console.log(JSON.stringify(subscriptionView(cfg, registry, t), null, 2));
  } else if (cmd === 'remove') {
    registry.remove(id);
    console.log(`Removed ${id} from the registry. Its data folder was not deleted.`);
  } else {
    console.log('Usage: npm run tenant -- list | add <tenant id> --name <name> [--status trial|active] [--plan <plan>] | set <tenant id> [--status ...] [--plan ...] [--seats n] [--ai n] [--trial-ends YYYY-MM-DD] | usage <tenant id> | remove <tenant id>');
    process.exitCode = cmd ? 1 : 0;
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
