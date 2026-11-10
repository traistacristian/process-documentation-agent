// Keywords for a process document: the words people will type when they look for it. They are
// generated with the draft (by Claude, or by the rules below when no AI is used), can be edited in the
// review, are printed in the Word document and stored as SharePoint metadata, and feed the search index.

const STOP = new Set(`a an and are as at be by for from has have how in into is it its of on or that the this to was were will with your you
via per not no all any each new then than when where which who what after before under over out up down
click select open enter choose press go type fill set use add show shown screen page field button tab menu step steps process
der die das den dem des ein eine einen einem einer und oder ist sind im in am an auf aus bei mit nach von vor zu zum zur für über unter
klicken sie wählen öffnen eingeben seite feld schaltfläche schritt prozess`.split(/\s+/));

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
export const foldKey = (s) => clean(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');

// Words worth indexing: letters/digits, not a stop word, at least 3 characters (or an acronym like "MFA").
function words(text) {
  return (String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]*[\p{L}\p{N}+#]|[\p{L}\p{N}]{2,}/gu) || [])
    .filter((w) => (w.length >= 3 || /^[A-Z0-9]{2,}$/.test(w)) && !STOP.has(w.toLowerCase()) && !/^\d+$/.test(w));
}

// Suggests up to `max` keywords from the document itself: the systems used, the names of the menus,
// buttons and fields that were used (quoted in the instructions), the category and the title's words.
export function extractKeywords(doc, max = 12) {
  const score = new Map(); // folded -> { text, score, first }
  let order = 0;
  const add = (text, w) => {
    const t = clean(text).replace(/^["'„“]|["'“”]$/g, '');
    if (!t || t.length < 2 || t.length > 40 || /^\[|REDACTED|VALUE_ENTERED/.test(t)) return;
    if (t.split(' ').every((x) => STOP.has(x.toLowerCase()))) return;
    const k = foldKey(t);
    const cur = score.get(k) || { text: t, score: 0, first: order++ };
    cur.score += w; score.set(k, cur);
  };
  for (const s of doc.prerequisites?.systems || []) add(s, 6);
  for (const s of doc.steps || []) if (s.application) add(s.application, 2);
  if (doc.info?.category) add(doc.info.category, 4);
  for (const w of words(doc.info?.title)) add(w, 5);
  for (const s of doc.steps || []) {
    // Step titles are not used: generated ones name the page, which can be a person ("Save in John Doe").
    for (const line of s.instructions || []) for (const m of line.matchAll(/"([^"]{2,40})"/g)) {
      const t = m[1].trim();
      if (/[,.:/…]/.test(t) || t.split(' ').length > 4) continue; // values, sentences and URLs are not keywords
      add(t, 2);
    }
  }
  for (const w of words(doc.purpose)) add(w, 0.5);
  // A word that is already part of a longer kept keyword adds little ("Admin" next to "Admin center").
  const ranked = [...score.values()].sort((a, b) => b.score - a.score || a.first - b.first);
  const out = [];
  for (const k of ranked) {
    const f = foldKey(k.text);
    if (out.some((o) => foldKey(o).split(' ').includes(f))) continue;
    out.push(k.text);
    if (out.length >= max) break;
  }
  return out;
}

// Normalises an edited or generated list: trimmed, no duplicates (case and accents ignored), max 20.
export function normalizeKeywords(list) {
  const seen = new Set(); const out = [];
  for (const raw of Array.isArray(list) ? list : String(list || '').split(/[,;\n]/)) {
    const t = clean(raw).slice(0, 60);
    const k = foldKey(t);
    if (!t || seen.has(k)) continue;
    seen.add(k); out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}
