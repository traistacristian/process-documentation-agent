// Append-only audit log (JSONL). Production: forward to Azure Monitor / Log Analytics or Microsoft
// Sentinel via the Application Insights SDK or a diagnostic setting; keep this local log as a buffer.
import fs from 'node:fs';
import path from 'node:path';

export class AuditLog {
  constructor(dataDir) { this.file = path.join(dataDir, 'audit.jsonl'); this.sinks = []; }

  // Extra destinations (e.g. Application Insights custom events). A failing sink never blocks the log.
  addSink(fn) { this.sinks.push(fn); }

  write(user, action, details = {}) {
    const entry = { ts: new Date().toISOString(), user: user ? { id: user.id, name: user.name } : null, action, ...details };
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
    for (const sink of this.sinks) { try { sink(entry); } catch { /* monitoring must not break the workflow */ } }
    return entry;
  }

  read({ limit = 200 } = {}) {
    if (!fs.existsSync(this.file)) return [];
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  }
}
