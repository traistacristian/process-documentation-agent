// LOCAL repository adapter - a folder on the server's disk with the same layout and version
// semantics as the SharePoint adapter. It exists so the whole workflow can be run and tested
// without a Microsoft 365 tenant. It is NOT SharePoint and the UI labels it as such.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const safe = (s) => String(s || 'Uncategorised').replace(/[\\/:*?"<>|#%]/g, '-').trim() || 'Uncategorised';

export class LocalRepository {
  constructor(cfg) { this.cfg = cfg; this.root = cfg.repository.local.path; fs.mkdirSync(this.root, { recursive: true }); }

  get label() { return `Local folder (${this.root}) – not SharePoint`; }

  async status() { return { mode: 'local', connected: true, label: this.label, warning: 'Documents are stored on the application server, not in SharePoint. Configure repository.mode = "sharepoint" for production.' }; }

  #all() {
    const out = [];
    if (!fs.existsSync(this.root)) return out;
    for (const cat of fs.readdirSync(this.root)) {
      const cdir = path.join(this.root, cat);
      if (!fs.statSync(cdir).isDirectory()) continue;
      for (const pid of fs.readdirSync(cdir)) {
        const meta = path.join(cdir, pid, 'meta.json');
        if (fs.existsSync(meta)) out.push({ dir: path.join(cdir, pid), meta: JSON.parse(fs.readFileSync(meta, 'utf8')) });
      }
    }
    return out;
  }

  #find(processId) { return this.#all().find((x) => x.meta.processId === processId) || null; }

  #summary({ dir, meta }) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'process.json'), 'utf8'));
    return { processId: meta.processId, title: doc.info.title, version: doc.info.version, category: doc.info.category, owner: doc.info.owner, department: doc.info.department, status: doc.info.status, createdAt: doc.info.createdAt, updatedAt: doc.info.updatedAt, etag: meta.etag, webUrl: `/api/repository/processes/${meta.processId}/document.docx`, stepCount: doc.steps.length };
  }

  async list() { return this.#all().map((x) => this.#summary(x)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }

  async search(q) {
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const all = await this.list();
    return terms.length ? all.filter((p) => terms.every((t) => `${p.title} ${p.processId} ${p.category} ${p.owner} ${p.department}`.toLowerCase().includes(t))) : all;
  }

  // language: return the published translation in that language instead (null if there is none).
  async get(processId, { language } = {}) {
    const f = this.#find(processId);
    if (!f) return null;
    const doc = JSON.parse(fs.readFileSync(path.join(f.dir, 'process.json'), 'utf8'));
    const translations = (f.meta.translations || []).map((t) => ({ language: t.language, title: t.title, webUrl: `/api/repository/processes/${processId}/document.${t.language}.docx` }));
    const base = { etag: f.meta.etag, webUrl: this.#summary(f).webUrl, versions: f.meta.versions, translations };
    if (language && language !== (doc.info.language || 'en')) {
      const tp = path.join(f.dir, `process.${language}.json`);
      if (!/^[a-z]{2}$/.test(language) || !fs.existsSync(tp)) return null;
      return { ...base, doc: JSON.parse(fs.readFileSync(tp, 'utf8')), webUrl: translations.find((t) => t.language === language)?.webUrl };
    }
    return { ...base, doc };
  }

  async screenshot(processId, shotId) {
    const f = this.#find(processId);
    if (!f || !/^shot_[a-f0-9]+$/.test(shotId)) return null;
    for (const ext of ['.jpg', '.png']) {
      const p = path.join(f.dir, 'screenshots', shotId + ext);
      if (fs.existsSync(p)) return { buffer: fs.readFileSync(p), mime: ext === '.png' ? 'image/png' : 'image/jpeg' };
    }
    return null;
  }

  async file(processId, name) {
    const f = this.#find(processId);
    if (!f || !/^(document(\.[a-z]{2})?\.(docx|md)|process(\.[a-z]{2})?\.json)$/.test(name) || !fs.existsSync(path.join(f.dir, name))) return null;
    return fs.readFileSync(path.join(f.dir, name));
  }

  // expectedEtag: null for a new process; for an update, the etag the draft was based on.
  async publish({ doc, docx, markdown, screenshots, expectedEtag, publishedBy, translations = [] }) {
    const existing = this.#find(doc.info.processId);
    if (existing && expectedEtag === null) throw Object.assign(new Error(`Process ${doc.info.processId} already exists`), { status: 409, code: 'DUPLICATE' });
    if (existing && expectedEtag && existing.meta.etag !== expectedEtag) throw Object.assign(new Error('The document was changed in the repository after this draft was created. Reload the latest version and re-apply your changes.'), { status: 409, code: 'CONFLICT' });
    if (!existing && expectedEtag) throw Object.assign(new Error('The document no longer exists in the repository.'), { status: 409, code: 'CONFLICT' });

    const dir = existing?.dir || path.join(this.root, safe(doc.info.category), safe(doc.info.processId));
    fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
    const meta = existing?.meta || { processId: doc.info.processId, versions: [] };
    if (existing) { // keep the previous approved version, like SharePoint version history
      const vdir = path.join(dir, '_versions', meta.versions.at(-1)?.version || 'previous');
      fs.mkdirSync(vdir, { recursive: true });
      for (const n of fs.readdirSync(dir).filter((x) => /^(process|document)[.\w]*\.(json|docx|md)$/.test(x))) fs.copyFileSync(path.join(dir, n), path.join(vdir, n));
    }
    for (const s of screenshots) fs.copyFileSync(s.path, path.join(dir, 'screenshots', s.id + path.extname(s.path)));
    fs.writeFileSync(path.join(dir, 'process.json'), JSON.stringify(doc, null, 2));
    fs.writeFileSync(path.join(dir, 'document.docx'), docx);
    fs.writeFileSync(path.join(dir, 'document.md'), markdown);
    for (const t of translations) {
      fs.writeFileSync(path.join(dir, `process.${t.language}.json`), JSON.stringify(t.doc, null, 2));
      fs.writeFileSync(path.join(dir, `document.${t.language}.docx`), t.docx);
      fs.writeFileSync(path.join(dir, `document.${t.language}.md`), t.markdown);
    }
    meta.translations = translations.map((t) => ({ language: t.language, title: t.doc.info.title }));
    meta.etag = crypto.randomBytes(8).toString('hex');
    meta.versions.push({ version: doc.info.version, publishedAt: new Date().toISOString(), publishedBy: publishedBy?.name, approver: doc.info.approver });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    return { processId: doc.info.processId, version: doc.info.version, etag: meta.etag, webUrl: `/api/repository/processes/${doc.info.processId}/document.docx`, location: dir, translations: translations.map((t) => ({ language: t.language, webUrl: `/api/repository/processes/${doc.info.processId}/document.${t.language}.docx` })) };
  }
}
