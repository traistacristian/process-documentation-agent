// SharePoint Online repository adapter (Microsoft Graph v1.0).
//
// Layout in the configured document library:
//   <rootFolder>/<category>/<processId>/
//       <processId> - <title>.docx   <- the official document; SharePoint keeps every published version
//       process.json                  <- machine-readable source used for comparisons on update
//       <processId> - <title> (DE).docx, process.de.json, translations.json  <- other languages
//       screenshots/<id>.jpg
// Metadata columns on the .docx list item (created by ensureSchema): PDA_ProcessId, PDA_Version,
// PDA_Status, PDA_Owner, PDA_Department, PDA_Category, PDA_Approver.
//
// Required Graph application permission: Sites.Selected, with "write" granted to the target site
// only (least privilege; see docs/DEPLOYMENT.md). Sites.ReadWrite.All also works but is broader.
//
// Status: implemented against the documented Graph API and unit-tested with a mocked Graph; it has
// NOT been run against a real tenant from this environment.
import fs from 'node:fs';
import { GraphClient } from './graph.js';

const COLUMNS = ['PDA_ProcessId', 'PDA_Version', 'PDA_Status', 'PDA_Owner', 'PDA_Department', 'PDA_Category', 'PDA_Approver'];
const safe = (s) => String(s || 'Uncategorised').replace(/[\\/:*?"<>|#%]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Uncategorised';
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;

export class SharePointRepository {
  constructor(cfg, { fetchImpl, sleep, credential } = {}) {
    this.cfg = cfg; this.sp = cfg.repository.sharepoint;
    this.graph = new GraphClient({ tenantId: this.sp.tenantId, clientId: this.sp.clientId, clientSecret: process.env[this.sp.clientSecretEnv] || this.sp.clientSecret, auth: this.sp.auth || 'secret', credential, fetchImpl, sleep });
    this.ids = null;
  }

  get label() { return `SharePoint: ${this.sp.siteUrl} › ${this.sp.libraryName} › ${this.sp.rootFolder}`; }

  async #resolve() {
    if (this.ids) return this.ids;
    const u = new URL(this.sp.siteUrl);
    const site = await this.graph.get(`/sites/${u.hostname}:${u.pathname.replace(/\/$/, '') || '/'}`);
    const drives = await this.graph.get(`/sites/${site.id}/drives?$select=id,name,webUrl`);
    const drive = drives.value.find((d) => d.name.toLowerCase() === this.sp.libraryName.toLowerCase());
    if (!drive) throw Object.assign(new Error(`Document library "${this.sp.libraryName}" not found on ${this.sp.siteUrl}`), { status: 404, code: 'LIBRARY_NOT_FOUND' });
    const list = await this.graph.get(`/drives/${drive.id}/list?$select=id`);
    this.ids = { siteId: site.id, driveId: drive.id, listId: list.id, driveUrl: drive.webUrl };
    return this.ids;
  }

  async status() {
    try {
      const ids = await this.#resolve();
      return { mode: 'sharepoint', connected: true, label: this.label, ids };
    } catch (e) {
      return { mode: 'sharepoint', connected: false, label: this.label, error: e.message, code: e.code || e.status };
    }
  }

  // Creates metadata columns and the configured category folders if they are missing.
  async ensureSchema(categories = this.cfg.categories) {
    const { siteId, listId, driveId } = await this.#resolve();
    const cols = await this.graph.get(`/sites/${siteId}/lists/${listId}/columns?$select=name`);
    const have = new Set(cols.value.map((c) => c.name));
    for (const name of COLUMNS) if (!have.has(name)) await this.graph.post(`/sites/${siteId}/lists/${listId}/columns`, { name, displayName: name.replace('PDA_', 'Process '), text: {}, indexed: name === 'PDA_ProcessId' });
    await this.#ensureFolder(driveId, this.sp.rootFolder);
    for (const c of categories) await this.#ensureFolder(driveId, `${this.sp.rootFolder}/${safe(c)}`);
    return { columns: COLUMNS, categories };
  }

  async #ensureFolder(driveId, path) {
    const parts = path.split('/');
    let parent = '';
    for (const name of parts) {
      const full = parent ? `${parent}/${name}` : name;
      try { await this.graph.get(`/drives/${driveId}/root:/${enc(full)}`); } catch (e) {
        if (e.status !== 404) throw e;
        const target = parent ? `/drives/${driveId}/root:/${enc(parent)}:/children` : `/drives/${driveId}/root/children`;
        try { await this.graph.post(target, { name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }); } catch (e2) { if (e2.status !== 409) throw e2; }
      }
      parent = full;
    }
  }

  #toSummary(item) {
    const f = item.fields || {};
    return { processId: f.PDA_ProcessId, title: f.Title || item.driveItem?.name?.replace(/\.docx$/, ''), version: f.PDA_Version, category: f.PDA_Category, owner: f.PDA_Owner, department: f.PDA_Department, status: f.PDA_Status, createdAt: item.createdDateTime, updatedAt: item.lastModifiedDateTime, webUrl: item.webUrl || item.driveItem?.webUrl, itemId: item.driveItem?.id, parentId: item.driveItem?.parentReference?.id };
  }

  async #queryItems(filter) {
    const { siteId, listId } = await this.#resolve();
    const out = [];
    const where = filter ? `&$filter=${encodeURIComponent(filter)}` : '';
    let url = `/sites/${siteId}/lists/${listId}/items?$expand=fields($select=Title,${COLUMNS.join(',')}),driveItem($select=id,name,webUrl,parentReference)${where}&$top=200`;
    while (url) {
      const page = await this.graph.get(url, { headers: { Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' } });
      out.push(...page.value);
      url = page['@odata.nextLink'] || null;
    }
    return out;
  }

  async list() {
    // SharePoint cannot filter on "is not empty", so read the library and keep the documents that carry
    // a process id (the library only holds this tool's documents and their images).
    const items = await this.#queryItems(null);
    return items.map((i) => this.#toSummary(i)).filter((x) => x.processId).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async search(q) {
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const all = await this.list();
    return terms.length ? all.filter((p) => terms.every((t) => `${p.title} ${p.processId} ${p.category} ${p.owner} ${p.department}`.toLowerCase().includes(t))) : all;
  }

  async #findItem(processId) {
    if (!/^[A-Z0-9-]+$/.test(processId)) return null;
    try {
      const items = await this.#queryItems(`fields/PDA_ProcessId eq '${processId}'`);
      return items[0] ? this.#toSummary(items[0]) : null;
    } catch (e) {
      if (e.status !== 400) throw e; // column not indexed yet, or filter refused: read the list instead
      return (await this.list()).find((p) => p.processId === processId) || null;
    }
  }

  async #readJson(driveId, parentId, name) {
    try {
      const it = await this.graph.get(`/drives/${driveId}/items/${parentId}:/${name}`);
      return { item: it, data: JSON.parse((await this.graph.get(`/drives/${driveId}/items/${it.id}/content`, { raw: true })).toString('utf8')) };
    } catch (e) { if (e.status === 404) return null; throw e; }
  }

  // language: return the published translation in that language instead (null if there is none).
  async get(processId, { language } = {}) {
    const item = await this.#findItem(processId);
    if (!item) return null;
    const { driveId } = await this.#resolve();
    const jsonItem = await this.graph.get(`/drives/${driveId}/items/${item.parentId}:/process.json`);
    const doc = JSON.parse((await this.graph.get(`/drives/${driveId}/items/${jsonItem.id}/content`, { raw: true })).toString('utf8'));
    const versions = await this.graph.get(`/drives/${driveId}/items/${item.itemId}/versions?$select=id,lastModifiedDateTime,lastModifiedBy`);
    const tr = await this.#readJson(driveId, item.parentId, 'translations.json').catch(() => null);
    const translations = Object.entries(tr?.data || {}).map(([lang, t]) => ({ language: lang, title: t.title, webUrl: t.webUrl }));
    const base = { etag: jsonItem.eTag, webUrl: item.webUrl, versions: versions.value.map((v) => ({ version: v.id, publishedAt: v.lastModifiedDateTime, publishedBy: v.lastModifiedBy?.user?.displayName })), translations };
    if (language && language !== (doc.info.language || 'en')) {
      if (!/^[a-z]{2}$/.test(language)) return null;
      const t = await this.#readJson(driveId, item.parentId, `process.${language}.json`);
      return t ? { ...base, doc: t.data, webUrl: translations.find((x) => x.language === language)?.webUrl } : null;
    }
    return { ...base, doc };
  }

  async screenshot(processId, shotId) {
    const item = await this.#findItem(processId);
    if (!item || !/^shot_[a-f0-9]+$/.test(shotId)) return null;
    const { driveId } = await this.#resolve();
    try {
      return { buffer: await this.graph.get(`/drives/${driveId}/items/${item.parentId}:/screenshots/${shotId}.jpg:/content`, { raw: true }), mime: 'image/jpeg' };
    } catch (e) { if (e.status === 404) return null; throw e; }
  }

  async file() { return null; } // documents are opened directly in SharePoint via webUrl

  async #upload(driveId, parentPath, name, buffer, extraHeaders = {}) {
    if (buffer.length <= SIMPLE_UPLOAD_LIMIT) return this.graph.put(`/drives/${driveId}/root:/${enc(`${parentPath}/${name}`)}:/content`, buffer, { headers: extraHeaders });
    const session = await this.graph.post(`/drives/${driveId}/root:/${enc(`${parentPath}/${name}`)}:/createUploadSession`, { item: { '@microsoft.graph.conflictBehavior': 'replace' } }, { headers: extraHeaders });
    const CHUNK = 5 * 1024 * 1024 + 2 * 320 * 1024; let res;
    for (let start = 0; start < buffer.length; start += CHUNK) {
      const end = Math.min(start + CHUNK, buffer.length);
      res = await this.graph.fetch(session.uploadUrl, { method: 'PUT', headers: { 'content-range': `bytes ${start}-${end - 1}/${buffer.length}` }, body: buffer.subarray(start, end) });
      if (!res.ok && res.status !== 202) throw Object.assign(new Error(`Upload session chunk failed (${res.status})`), { status: 502 });
    }
    return res.json();
  }

  async publish({ doc, docx, screenshots, expectedEtag, owners = [], translations = [] }) {
    const { driveId } = await this.#resolve();
    const existing = await this.#findItem(doc.info.processId);
    if (existing && expectedEtag === null) throw Object.assign(new Error(`Process ${doc.info.processId} already exists in SharePoint`), { status: 409, code: 'DUPLICATE' });
    if (!existing && expectedEtag) throw Object.assign(new Error('The document no longer exists in SharePoint.'), { status: 409, code: 'CONFLICT' });

    let folderPath;
    if (existing) {
      const parent = await this.graph.get(`/drives/${driveId}/items/${existing.parentId}?$select=name,parentReference`);
      folderPath = `${decodeURIComponent(parent.parentReference.path.replace(/^.*?root:\/?/, ''))}/${parent.name}`;
    } else {
      folderPath = `${this.sp.rootFolder}/${safe(doc.info.category)}/${safe(doc.info.processId)}`;
      await this.#ensureFolder(driveId, `${folderPath}/screenshots`);
    }
    // 1. Optimistic concurrency on the machine-readable source: fails with 412 if someone else published in between.
    try {
      await this.#upload(driveId, folderPath, 'process.json', Buffer.from(JSON.stringify(doc, null, 2)), expectedEtag ? { 'if-match': expectedEtag } : {});
    } catch (e) {
      if (e.status === 412) throw Object.assign(new Error('The document was changed in SharePoint after this draft was created. Reload the latest version and re-apply your changes.'), { status: 409, code: 'CONFLICT' });
      throw e;
    }
    for (const s of screenshots) await this.#upload(driveId, `${folderPath}/screenshots`, `${s.id}.jpg`, fs.readFileSync(s.path));
    // 2. The Word document: upload onto the same item so SharePoint version history is preserved.
    const docName = `${safe(doc.info.processId)} - ${safe(doc.info.title)}.docx`;
    let docItem;
    if (existing) {
      docItem = await this.graph.put(`/drives/${driveId}/items/${existing.itemId}/content`, docx);
      if (docItem.name !== docName) docItem = await this.graph.patch(`/drives/${driveId}/items/${existing.itemId}`, { name: docName });
    } else docItem = await this.#upload(driveId, folderPath, docName, docx);
    // 3. Metadata for categorisation, ownership, status and version.
    if (this.sp.applyMetadata) {
      await this.graph.patch(`/drives/${driveId}/items/${docItem.id}/listItem/fields`, {
        Title: doc.info.title, PDA_ProcessId: doc.info.processId, PDA_Version: doc.info.version, PDA_Status: doc.info.status,
        PDA_Owner: doc.info.owner, PDA_Department: doc.info.department, PDA_Category: doc.info.category, PDA_Approver: doc.info.approver,
      });
    }
    // 4. Optional: give the process owner edit rights on the document.
    if (this.sp.assignOwnerPermissions && owners.length) {
      await this.graph.post(`/drives/${driveId}/items/${docItem.id}/invite`, { recipients: owners.map((email) => ({ email })), roles: ['write'], requireSignIn: true, sendInvitation: false });
    }
    // 5. Translations: "<id> - <translated title> (DE).docx" next to the original, without a process id
    //    so the library lists each process once; renamed in place to keep its version history.
    const published = [];
    if (translations.length) {
      const prev = existing ? (await this.#readJson(driveId, existing.parentId, 'translations.json'))?.data || {} : {};
      const index = {};
      for (const t of translations) {
        const name = `${safe(doc.info.processId)} - ${safe(t.doc.info.title)} (${t.language.toUpperCase()}).docx`;
        const old = prev[t.language]?.fileName;
        if (old && old !== name) {
          try { const it = await this.graph.get(`/drives/${driveId}/root:/${enc(`${folderPath}/${old}`)}`); await this.graph.patch(`/drives/${driveId}/items/${it.id}`, { name }); } catch (e) { if (e.status !== 404) throw e; }
        }
        await this.#upload(driveId, folderPath, `process.${t.language}.json`, Buffer.from(JSON.stringify(t.doc, null, 2)));
        const it = await this.#upload(driveId, folderPath, name, t.docx);
        if (this.sp.applyMetadata) await this.graph.patch(`/drives/${driveId}/items/${it.id}/listItem/fields`, { Title: t.doc.info.title, PDA_Version: doc.info.version, PDA_Status: doc.info.status, PDA_Category: doc.info.category });
        index[t.language] = { fileName: name, title: t.doc.info.title, webUrl: it.webUrl };
        published.push({ language: t.language, webUrl: it.webUrl });
      }
      await this.#upload(driveId, folderPath, 'translations.json', Buffer.from(JSON.stringify(index, null, 2)));
    }
    const jsonItem = await this.graph.get(`/drives/${driveId}/root:/${enc(`${folderPath}/process.json`)}`);
    return { processId: doc.info.processId, version: doc.info.version, etag: jsonItem.eTag, webUrl: docItem.webUrl, location: folderPath, translations: published };
  }
}
