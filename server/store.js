// Durable local storage for capture sessions, raw events, screenshots and drafts.
// Prototype implementation on the local file system. Every write is atomic (write temp + rename) and
// events are appended to a JSONL log, so a server crash never loses already-acknowledged events.
// In Azure this maps to: sessions/drafts -> Cosmos DB or Table Storage, events/screenshots -> Blob
// Storage container with lifecycle-management retention (see docs/DEPLOYMENT.md).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

export class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    for (const d of ['sessions', 'drafts', 'screenshots', 'imports']) fs.mkdirSync(path.join(dataDir, d), { recursive: true });
    this.seqCache = new Map();
  }

  // Health check: proves the data volume (Azure Files in production) is mounted and writable.
  ping() {
    const f = path.join(this.dir, '.health');
    fs.writeFileSync(f, String(Date.now()));
  }

  #file(col, id, ext = '.json') {
    if (!/^[a-z]+_[a-f0-9]+$/.test(id)) throw Object.assign(new Error('Invalid id'), { status: 400 });
    return path.join(this.dir, col, id + ext);
  }

  #writeAtomic(file, data) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  }

  put(col, obj) { this.#writeAtomic(this.#file(col, obj.id), JSON.stringify(obj, null, 2)); return obj; }

  get(col, id) {
    try { return JSON.parse(fs.readFileSync(this.#file(col, id), 'utf8')); } catch (e) {
      if (e.code === 'ENOENT' || e.status === 400) return null; throw e;
    }
  }

  list(col) {
    return fs.readdirSync(path.join(this.dir, col))
      .filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(this.dir, col, f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  }

  remove(col, id) { fs.rmSync(this.#file(col, id), { force: true }); }

  // ---- events (append-only) ----
  appendEvents(sessionId, events) {
    const file = this.#file('sessions', sessionId, '.events.jsonl');
    let seq = this.seqCache.get(sessionId) ?? this.readEvents(sessionId).length;
    const stored = events.map((e) => ({ ...e, seq: ++seq }));
    fs.appendFileSync(file, stored.map((e) => JSON.stringify(e)).join('\n') + '\n');
    this.seqCache.set(sessionId, seq);
    return stored;
  }

  readEvents(sessionId) {
    const file = this.#file('sessions', sessionId, '.events.jsonl');
    if (!fs.existsSync(file)) return [];
    // Tolerate a torn final line after a crash: ignore lines that do not parse.
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  // ---- screenshots ----
  saveScreenshot(sessionId, buffer, mime) {
    const id = newId('shot');
    const ext = mime === 'image/png' ? '.png' : '.jpg';
    const dir = path.join(this.dir, 'screenshots', sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id + ext), buffer);
    return { id, mime: mime === 'image/png' ? 'image/png' : 'image/jpeg', bytes: buffer.length };
  }

  screenshotPath(sessionId, shotId) {
    if (!/^shot_[a-f0-9]+$/.test(shotId) || !/^ses_[a-f0-9]+$/.test(sessionId)) return null;
    for (const ext of ['.jpg', '.png']) {
      const p = path.join(this.dir, 'screenshots', sessionId, shotId + ext);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  listScreenshots(sessionId) {
    const dir = path.join(this.dir, 'screenshots', sessionId);
    return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => f.replace(/\.(jpg|png)$/, '')) : [];
  }

  deleteScreenshot(sessionId, shotId) {
    const p = this.screenshotPath(sessionId, shotId);
    if (p) fs.rmSync(p, { force: true });
  }

  // Deletes a recording: its record, raw events and every screenshot not listed in keepShotIds
  // (screenshots that an existing draft still shows are kept).
  removeSession(sessionId, keepShotIds = new Set()) {
    this.purgeRawCapture(sessionId, keepShotIds);
    const dir = path.join(this.dir, 'screenshots', sessionId);
    if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmSync(dir, { recursive: true, force: true });
    this.remove('sessions', sessionId);
  }

  purgeRawCapture(sessionId, keepShotIds = new Set()) {
    fs.rmSync(this.#file('sessions', sessionId, '.events.jsonl'), { force: true });
    this.seqCache.delete(sessionId);
    for (const shot of this.listScreenshots(sessionId)) if (!keepShotIds.has(shot)) this.deleteScreenshot(sessionId, shot);
  }
}
