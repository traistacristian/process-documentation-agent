// Tenant registry for the multi-tenant (SaaS) deployment.
//
// One record per customer organisation, keyed by its Microsoft Entra tenant id:
//   { id, name, status, plan, createdAt, updatedAt, repository? }
//   status: trial | active | suspended | cancelled
// A tenant that is not in the registry cannot use the app, even if its admin consented to the
// Entra app: the registry, not Entra, decides who is a customer.
//
// The registry also keeps the routing index for capture clients (browser extension, desktop agent).
// They hold no user token, only a pairing code and then a capture token for one session, so the
// front needs to know which tenant a pairing code or a session id belongs to. The index stores
// nothing else: the capture token itself is checked by that tenant's app against its own session.
//
// Storage: <platform dataDir>/platform/*.json, written atomically. Kept in memory, so the app runs
// as one instance (as today on Azure Files); Table Storage replaces this file before scaling out.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TENANT_ID } from './auth.js';

export const STATUSES = ['trial', 'active', 'suspended', 'cancelled'];
const err = (status, message, code) => Object.assign(new Error(message), { status, code });
const DAY = 86400_000;

export class TenantRegistry {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'platform');
    fs.mkdirSync(this.dir, { recursive: true });
    this.tenantsFile = path.join(this.dir, 'tenants.json');
    this.indexFile = path.join(this.dir, 'capture-index.json');
    this.tenants = this.#read(this.tenantsFile, {});
    this.index = { codes: {}, sessions: {}, ...this.#read(this.indexFile, {}) };
  }

  #read(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
  #write(file, data) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  ping() { fs.writeFileSync(path.join(this.dir, '.health'), String(Date.now())); }

  static normalizeId(id) {
    const tid = String(id || '').trim().toLowerCase();
    if (!TENANT_ID.test(tid)) throw err(400, 'A tenant id is a GUID (Microsoft Entra ID → Overview → Tenant ID).', 'INVALID_TENANT');
    return tid;
  }

  get(id) {
    try { return this.tenants[TenantRegistry.normalizeId(id)] || null; } catch { return null; }
  }

  list() { return Object.values(this.tenants).sort((a, b) => a.createdAt - b.createdAt); }

  upsert(id, patch = {}) {
    const tid = TenantRegistry.normalizeId(id);
    if (patch.status !== undefined && !STATUSES.includes(patch.status)) throw err(400, `Status must be one of: ${STATUSES.join(', ')}`, 'INVALID_STATUS');
    const now = Date.now();
    const cur = this.tenants[tid] || { id: tid, name: '', status: 'trial', plan: '', createdAt: now };
    const { id: _ignored, createdAt: _c, ...rest } = patch;
    this.tenants[tid] = { ...cur, ...rest, updatedAt: now };
    this.#write(this.tenantsFile, this.tenants);
    return this.tenants[tid];
  }

  remove(id) {
    const tid = TenantRegistry.normalizeId(id);
    delete this.tenants[tid];
    this.#write(this.tenantsFile, this.tenants);
  }

  // Whether the tenant may use the app at all. Plan, seat and read-only rules for a suspended
  // subscription are checked by the licence layer on top of this.
  canUse(id) {
    const t = this.get(id);
    return !!t && t.status !== 'cancelled';
  }

  // ---- capture routing ----
  // A pairing code that is unique across all tenants (codes are typed by people, so they stay short).
  issuePairingCode(tenantId, sessionId, expiresAt) {
    const tid = TenantRegistry.normalizeId(tenantId);
    const now = Date.now();
    for (const [c, v] of Object.entries(this.index.codes)) if (v.expiresAt <= now) delete this.index.codes[c];
    let code;
    for (let i = 0; i < 50 && (!code || this.index.codes[code]); i++) code = String(crypto.randomInt(100000, 999999));
    if (this.index.codes[code]) throw err(503, 'No free pairing code, try again', 'PAIRING_BUSY');
    this.index.codes[code] = { tid, sessionId, expiresAt };
    this.index.sessions[sessionId] = { tid, at: now };
    this.#write(this.indexFile, this.index);
    return code;
  }

  tenantForCode(code) {
    const v = this.index.codes[String(code || '')];
    return v && v.expiresAt > Date.now() ? v.tid : null;
  }

  tenantForSession(sessionId) {
    return this.index.sessions[String(sessionId || '')]?.tid || null;
  }

  // Drops index entries of sessions older than maxDays (their capture tokens expired long ago).
  prune(now = Date.now(), maxDays = 60) {
    let n = 0;
    for (const [c, v] of Object.entries(this.index.codes)) if (v.expiresAt <= now) { delete this.index.codes[c]; n++; }
    for (const [s, v] of Object.entries(this.index.sessions)) if (now - v.at > maxDays * DAY) { delete this.index.sessions[s]; n++; }
    if (n) this.#write(this.indexFile, this.index);
    return n;
  }
}
