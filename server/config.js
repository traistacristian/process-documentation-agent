// Configuration loader.
// Order of precedence (later wins): config/default.json -> config/local.json -> PDA_CONFIG file
// -> environment variables -> admin settings saved at runtime (<dataDir>/settings.json, only for
// the admin-editable keys listed in ADMIN_KEYS).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ADMIN_KEYS = ['categories', 'capture', 'retention', 'notifications', 'invitations'];

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
  if (env.PDA_REPOSITORY_MODE) cfg.repository.mode = env.PDA_REPOSITORY_MODE;
  if (env.PDA_AI_PROVIDER) cfg.ai.provider = env.PDA_AI_PROVIDER;
  if (env.ENTRA_TENANT_ID) cfg.auth.entra.tenantId = env.ENTRA_TENANT_ID;
  if (env.ENTRA_API_CLIENT_ID) cfg.auth.entra.apiClientId = env.ENTRA_API_CLIENT_ID;
  if (env.ENTRA_SPA_CLIENT_ID) cfg.auth.entra.spaClientId = env.ENTRA_SPA_CLIENT_ID;
  if (env.ENTRA_API_SCOPE) cfg.auth.entra.apiScope = env.ENTRA_API_SCOPE;
  if (env.PDA_REQUIRE_SEPARATE_APPROVER) cfg.auth.requireSeparateApprover = env.PDA_REQUIRE_SEPARATE_APPROVER === 'true';
  if (env.PDA_HUMAN_CHECK) cfg.auth.humanCheck = { ...(cfg.auth.humanCheck || {}), enabled: env.PDA_HUMAN_CHECK !== 'false' };
  if (env.PDA_HUMAN_CHECK_SECRET) cfg.auth.humanCheck = { ...(cfg.auth.humanCheck || {}), secret: env.PDA_HUMAN_CHECK_SECRET };
  if (env.ANTHROPIC_MODEL) cfg.ai.model = env.ANTHROPIC_MODEL;
  if (env.ANTHROPIC_EFFORT) cfg.ai.effort = env.ANTHROPIC_EFFORT;
  if (env.PDA_AI_DESCRIBE_STEPS) cfg.ai.describeSteps = env.PDA_AI_DESCRIBE_STEPS !== 'false';
  if (env.ANTHROPIC_FOUNDRY_RESOURCE) cfg.ai.foundry = { ...(cfg.ai.foundry || {}), resource: env.ANTHROPIC_FOUNDRY_RESOURCE };
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

  const settingsFile = path.join(cfg.dataDir, 'settings.json');
  const saved = readJson(settingsFile) || {};
  for (const k of ADMIN_KEYS) if (saved[k] !== undefined) cfg[k] = isObj(saved[k]) ? deepMerge(cfg[k], saved[k]) : saved[k];
  cfg._settingsFile = settingsFile;
  cfg._root = ROOT;
  return cfg;
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
