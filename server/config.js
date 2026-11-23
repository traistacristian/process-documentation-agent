// Configuration loader.
// Order of precedence (later wins): config/default.json -> config/local.json -> PDA_CONFIG file
// -> environment variables -> admin settings saved at runtime (<dataDir>/settings.json, only for
// the admin-editable keys listed in ADMIN_KEYS).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ADMIN_KEYS = ['categories', 'capture', 'retention', 'notifications', 'invitations', 'aiPolicy'];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

export function deepMerge(base, over) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function loadConfig(overrides = {}) {
  let cfg = readJson(path.join(ROOT, 'config/default.json'));
  cfg = deepMerge(cfg, readJson(path.join(ROOT, 'config/local.json')) || {});
  if (process.env.PDA_CONFIG) cfg = deepMerge(cfg, readJson(process.env.PDA_CONFIG) || {});

  const env = process.env;
  if (env.PORT) cfg.port = Number(env.PORT);
  if (env.PDA_DATA_DIR) cfg.dataDir = env.PDA_DATA_DIR;
  if (env.PDA_AUTH_MODE) cfg.auth.mode = env.PDA_AUTH_MODE;
  if (env.PDA_MULTI_TENANT) cfg.multiTenant = env.PDA_MULTI_TENANT === 'true';
  if (env.PDA_SELF_SIGNUP) cfg.saas = { ...(cfg.saas || {}), selfSignup: env.PDA_SELF_SIGNUP !== 'false' };
  if (env.PDA_TRIAL_DAYS) cfg.saas = { ...(cfg.saas || {}), trialDays: Number(env.PDA_TRIAL_DAYS) };
  if (env.PDA_PUBLISHER_TENANT_ID) cfg.saas = { ...(cfg.saas || {}), marketplace: { ...(cfg.saas?.marketplace || {}), publisherTenantId: env.PDA_PUBLISHER_TENANT_ID } };
  if (env.PDA_MARKETPLACE_APP_ID) cfg.saas = { ...(cfg.saas || {}), marketplace: { ...(cfg.saas?.marketplace || {}), appId: env.PDA_MARKETPLACE_APP_ID } };
  if (env.PDA_MI_CLIENT_ID) cfg.saas = { ...(cfg.saas || {}), miClientId: env.PDA_MI_CLIENT_ID };
  if (env.PDA_REPOSITORY_MODE) cfg.repository.mode = env.PDA_REPOSITORY_MODE;
  if (env.PDA_AI_PROVIDER) cfg.ai.provider = env.PDA_AI_PROVIDER;
  if (env.ENTRA_TENANT_ID) cfg.auth.entra.tenantId = env.ENTRA_TENANT_ID;
  if (env.ENTRA_API_CLIENT_ID) cfg.auth.entra.apiClientId = env.ENTRA_API_CLIENT_ID;
  if (env.ENTRA_SPA_CLIENT_ID) cfg.auth.entra.spaClientId = env.ENTRA_SPA_CLIENT_ID;
  if (env.ENTRA_API_SCOPE) cfg.auth.entra.apiScope = env.ENTRA_API_SCOPE;
  if (env.PDA_REQUIRE_SEPARATE_APPROVER) cfg.auth.requireSeparateApprover = env.PDA_REQUIRE_SEPARATE_APPROVER === 'true';
  if (env.ANTHROPIC_MODEL) cfg.ai.model = env.ANTHROPIC_MODEL;
  if (env.ANTHROPIC_EFFORT) cfg.ai.effort = env.ANTHROPIC_EFFORT;
  if (env.PDA_AI_DESCRIBE_STEPS) cfg.ai.describeSteps = env.PDA_AI_DESCRIBE_STEPS !== 'false';
  if (env.ANTHROPIC_FOUNDRY_RESOURCE) cfg.ai.foundry = { ...(cfg.ai.foundry || {}), resource: env.ANTHROPIC_FOUNDRY_RESOURCE };
  if (env.TEAMS_MI_CLIENT_ID) cfg.teams = { ...(cfg.teams || {}), miClientId: env.TEAMS_MI_CLIENT_ID };
  if (env.PDA_PUBLIC_URL) cfg.publicUrl = env.PDA_PUBLIC_URL;
  if (env.AZURE_SPEECH_ENDPOINT) cfg.speech = { ...(cfg.speech || {}), endpoint: env.AZURE_SPEECH_ENDPOINT };
  if (env.AZURE_SPEECH_KEY) cfg.speech = { ...(cfg.speech || {}), key: env.AZURE_SPEECH_KEY };
  if (env.SP_TENANT_ID) cfg.repository.sharepoint.tenantId = env.SP_TENANT_ID;
  if (env.SP_CLIENT_ID) cfg.repository.sharepoint.clientId = env.SP_CLIENT_ID;
  if (env.SP_SITE_URL) cfg.repository.sharepoint.siteUrl = env.SP_SITE_URL;
  if (env.SP_AUTH) cfg.repository.sharepoint.auth = env.SP_AUTH;
  if (env.SP_ROOT_FOLDER) cfg.repository.sharepoint.rootFolder = env.SP_ROOT_FOLDER;
  if (env.SP_LIBRARY) cfg.repository.sharepoint.libraryName = env.SP_LIBRARY;

  cfg = deepMerge(cfg, overrides);
  if (cfg.auth.entra.apiClientId && !cfg.auth.entra.apiScope) cfg.auth.entra.apiScope = `api://${cfg.auth.entra.apiClientId}/access_as_user`;
  cfg.dataDir = path.resolve(ROOT, cfg.dataDir);
  if (cfg.repository.local?.path) cfg.repository.local.path = path.resolve(ROOT, cfg.repository.local.path.replace('./data', cfg.dataDir));

  cfg._root = ROOT;
  return applySavedSettings(cfg);
}

// Admin settings saved at runtime (<dataDir>/settings.json), for the keys in ADMIN_KEYS.
function applySavedSettings(cfg) {
  const settingsFile = path.join(cfg.dataDir, 'settings.json');
  const saved = readJson(settingsFile) || {};
  for (const k of ADMIN_KEYS) if (saved[k] !== undefined) cfg[k] = isObj(saved[k]) ? deepMerge(cfg[k], saved[k]) : saved[k];
  cfg._settingsFile = settingsFile;
  return cfg;
}

// Multi-tenant: the configuration of one customer organisation (tenant). It starts from the platform
// configuration (config/default.json + environment, without the platform's own saved settings) and
// differs in:
//   - data:      <platform dataDir>/tenants/<tenant id>/ holds this tenant's recordings, drafts,
//                screenshots, audit log, search index, local repository and settings.json
//   - sign-in:   tokens of this tenant only; the user comes from the SaaS front (auth.upstream)
//   - repository: the tenant's own (its SharePoint site, set during onboarding), else a local folder
//   - settings:  the tenant's own categories, capture policy, retention, AI policy
export function tenantConfig(platform, tenant) {
  if (!TENANT_ID.test(tenant?.id || '')) throw new Error('Invalid tenant id');
  const base = JSON.parse(JSON.stringify(platform));
  const cfg = { ...base, multiTenant: false, tenant: { id: tenant.id, name: tenant.name || '', status: tenant.status, trialEndsAt: tenant.trialEndsAt || null }, _root: platform._root };
  cfg.dataDir = path.join(platform.dataDir, 'tenants', tenant.id.toLowerCase());
  cfg.auth = { ...cfg.auth, mode: 'entra', upstream: true, devUsers: [], entra: { ...cfg.auth.entra, tenantId: tenant.id } };
  cfg.invitations = { groups: {} };
  cfg.repository = deepMerge({ ...cfg.repository, mode: 'local', local: { path: path.join(cfg.dataDir, 'repository') } }, tenant.repository || {});
  return applySavedSettings(cfg);
}

export function saveAdminSettings(cfg, patch) {
  const current = readJson(cfg._settingsFile) || {};
  for (const k of ADMIN_KEYS) {
    if (patch[k] === undefined) continue;
    current[k] = patch[k];
    cfg[k] = isObj(patch[k]) ? deepMerge(cfg[k], patch[k]) : patch[k];
  }
  fs.mkdirSync(path.dirname(cfg._settingsFile), { recursive: true });
  fs.writeFileSync(cfg._settingsFile, JSON.stringify(current, null, 2));
  return cfg;
}
