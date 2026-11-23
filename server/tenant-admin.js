// Platform owner's tool for the multi-tenant deployment: add, list and change customer tenants.
// Until self-service onboarding and Marketplace billing exist, this is how a pilot customer is
// switched on or off. On Azure App Service run it from the SSH console (data folder = PDA_DATA_DIR).
//
//   npm run tenant -- list
//   npm run tenant -- add <tenant id> --name "Contoso" [--status trial|active] [--plan pilot]
//   npm run tenant -- set <tenant id> [--status suspended] [--name ...] [--plan ...]
//   npm run tenant -- remove <tenant id>        (registry entry only; data folder is kept)
import { loadConfig } from './config.js';
import { TenantRegistry } from './tenants.js';

const [cmd, id, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i += 2) if (rest[i]?.startsWith('--')) opts[rest[i].slice(2)] = rest[i + 1];

const cfg = loadConfig();
const registry = new TenantRegistry(cfg.dataDir);
const show = (t) => console.log(`${t.id}  ${t.status.padEnd(9)} ${String(t.plan || '-').padEnd(8)} ${t.name}`);

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
    show(registry.upsert(id, patch));
  } else if (cmd === 'remove') {
    registry.remove(id);
    console.log(`Removed ${id} from the registry. Its data folder was not deleted.`);
  } else {
    console.log('Usage: npm run tenant -- list | add <tenant id> --name <name> [--status trial|active] [--plan <plan>] | set <tenant id> [--status ...] | remove <tenant id>');
    process.exitCode = cmd ? 1 : 0;
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
