// Search index over the published processes. Every word of a document is indexed, weighted by where
// it appears (title and keywords count most, then systems and step titles, then the text), in an
// inverted index: word -> the processes that contain it and how strongly. Queries match whole words,
// word beginnings ("lic" finds "licence") and small typos ("pasword"), ignore case and accents
// ("Benutzer" = "benutzer", "loschen" = "löschen") and need every query word to match.
//
// The index is kept on disk (<dataDir>/search-index.json), so a restart does not re-read every
// document from SharePoint. It is refreshed when a process is published and, at most every 30
// seconds, against the repository listing (new, changed and removed documents).
import fs from 'node:fs';
import path from 'node:path';
import { extractKeywords, foldKey } from './engine/keywords.js';

const VERSION = 2;
const FIELD_WEIGHT = { id: 12, title: 10, keyword: 8, meta: 5, system: 5, stepTitle: 4, purpose: 3, step: 2, other: 1 };
const STOP = new Set('a an and are as at be by for from in into is it of on or the to with der die das den dem des ein eine und oder ist im in am an auf aus bei mit von zu für'.split(' '));

export const fold = foldKey;
// Words of a text, folded (lower case, no accents); a plural "s" is removed so "users" finds "user".
export function tokenize(text) {
  const out = [];
  for (const w of fold(text).match(/[\p{L}\p{N}]+/gu) || []) {
    if (STOP.has(w)) continue;
    out.push(w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
  }
  return out;
}

function editDistanceAtMost1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// What is stored per process: the listing fields shown in the library plus the weighted words.
export function buildEntry(summary, doc) {
  const keywords = doc.keywords?.length ? doc.keywords : extractKeywords(doc);
  const terms = {};
  const add = (text, field) => { for (const t of tokenize(text)) terms[t] = (terms[t] || 0) + FIELD_WEIGHT[field]; };
  add(doc.info.processId, 'id'); add(doc.info.title, 'title');
  for (const k of keywords) add(k, 'keyword');
  add(`${doc.info.category} ${doc.info.department} ${doc.info.owner}`, 'meta');
  for (const s of doc.prerequisites.systems) add(s, 'system');
  add(doc.purpose, 'purpose');
  const steps = doc.steps.map((s) => {
    add(s.title, 'stepTitle'); add(s.application, 'system');
    const text = [s.description, ...s.instructions, s.input, s.expectedResult, ...s.notes, ...s.warnings].join(' ');
    add(text, 'step');
    return { n: s.number, title: s.title, words: [...new Set(tokenize(`${s.title} ${s.application} ${text}`))] };
  });
  const other = [...doc.scope.included, ...doc.scope.excluded, ...Object.values(doc.prerequisites).flat(), ...doc.roles.flatMap((r) => [r.role, r.responsibilities]),
    ...doc.decisions.flatMap((x) => [x.condition, x.action]), ...doc.exceptions.flatMap((x) => [x.problem, x.handling, x.escalation]), doc.expectedOutcome, ...doc.verification,
    ...doc.troubleshooting.flatMap((x) => [x.issue, x.resolution])].join(' ');
  add(other, 'other');
  return { summary: { ...summary, keywords }, stamp: `${summary.updatedAt}|${summary.version}|${summary.etag || ''}`, terms, steps };
}

export class SearchIndex {
  constructor({ repo, dataDir, refreshMs = 30_000, log = () => {} }) {
    this.repo = repo; this.file = dataDir ? path.join(dataDir, 'search-index.json') : null; this.refreshMs = refreshMs; this.log = log;
    this.entries = new Map(); this.postings = null; this.checkedAt = 0; this.pending = null;
    try {
      const saved = this.file && fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : null;
      if (saved?.version === VERSION) for (const e of saved.entries) this.entries.set(e.summary.processId, e);
    } catch { /* a damaged index file is rebuilt from the repository */ }
  }

  #save() {
    if (!this.file) return;
    try { fs.writeFileSync(this.file, JSON.stringify({ version: VERSION, entries: [...this.entries.values()] })); } catch (e) { this.log('search_index_save_failed', e.message); }
  }

  #postings() {
    if (this.postings) return this.postings;
    const p = new Map();
    for (const e of this.entries.values()) for (const [t, w] of Object.entries(e.terms)) { if (!p.has(t)) p.set(t, []); p.get(t).push([e.summary.processId, w]); }
    return (this.postings = p);
  }

  // Adds or replaces one process right after it was published.
  upsert(summary, doc) {
    this.entries.set(summary.processId, buildEntry(summary, doc)); this.postings = null; this.#save();
  }

  // Brings the index in line with the repository: indexes new and changed documents, drops removed ones.
  refresh({ force = false } = {}) {
    if (!force && Date.now() - this.checkedAt < this.refreshMs) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const list = await this.repo.list();
      const seen = new Set(); let changed = false;
      for (const s of list) {
        seen.add(s.processId);
        const cur = this.entries.get(s.processId);
        const stamp = `${s.updatedAt}|${s.version}|${s.etag || ''}`;
        if (cur && cur.stamp === stamp) { cur.summary = { ...s, keywords: cur.summary.keywords }; continue; }
        try {
          const got = await this.repo.get(s.processId);
          if (got?.doc) { this.entries.set(s.processId, buildEntry(s, got.doc)); changed = true; }
        } catch (e) { this.log('search_index_read_failed', `${s.processId}: ${e.message}`); if (!cur) this.entries.set(s.processId, { summary: { ...s, keywords: [] }, stamp: '', terms: {}, steps: [] }); }
      }
      for (const id of [...this.entries.keys()]) if (!seen.has(id)) { this.entries.delete(id); changed = true; }
      if (changed) { this.postings = null; this.#save(); }
      this.checkedAt = Date.now();
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  // All processes, newest first, with their keywords.
  list() { return [...this.entries.values()].map((e) => e.summary).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); }

  // The keywords in use, most frequent first (for the keyword filter in the library).
  keywords(limit = 40) {
    const count = new Map();
    for (const e of this.entries.values()) for (const k of e.summary.keywords || []) {
      const f = fold(k); const c = count.get(f) || { keyword: k, count: 0 }; c.count++; count.set(f, c);
    }
    return [...count.values()].sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword)).slice(0, limit);
  }

  search(q, { limit = 50 } = {}) {
    const words = [...new Set(tokenize(q))];
    if (!words.length) return this.list();
    const postings = this.#postings();
    const vocab = [...postings.keys()];
    const perWord = words.map((w) => {
      const hits = new Map(); // processId -> { score, terms }
      for (const t of vocab) {
        let quality = 0;
        if (t === w) quality = 1;
        else if (w.length >= 2 && t.startsWith(w)) quality = 0.75;
        else if (w.length >= 5 && editDistanceAtMost1(t, w)) quality = 0.5;
        else if (w.length >= 4 && t.length >= 8 && t.includes(w)) quality = 0.4; // part of a compound word ("benutzerkonto")
        if (!quality) continue;
        for (const [pid, weight] of postings.get(t)) {
          const h = hits.get(pid) || { score: 0, terms: new Set() };
          h.score += weight * quality; h.terms.add(t); hits.set(pid, h);
        }
      }
      return hits;
    });
    const results = [];
    for (const [pid] of perWord[0]) {
      if (!perWord.every((h) => h.has(pid))) continue; // every query word must match
      const e = this.entries.get(pid);
      const terms = new Set(perWord.flatMap((h) => [...h.get(pid).terms]));
      const score = perWord.reduce((s, h) => s + h.get(pid).score, 0);
      const keywords = (e.summary.keywords || []).filter((k) => tokenize(k).some((t) => terms.has(t)));
      const steps = e.steps.filter((s) => s.words.some((t) => terms.has(t))).slice(0, 3).map((s) => ({ n: s.n, title: s.title }));
      results.push({ ...e.summary, score: Math.round(score * 10) / 10, matched: { keywords, steps, terms: [...terms] } });
    }
    return results.sort((a, b) => b.score - a.score || String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
  }
}
