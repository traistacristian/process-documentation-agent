// Guided mode needs to know, for each documented step, which page elements were used. They are taken
// from the recorded browser events behind the step (role + accessible name + page, never values).
const CLICKY = new Set(['click', 'input', 'change', 'key']);

const pageOf = (url) => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return ''; } };

export function attachTargets(doc, events) {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  for (const step of doc.steps) {
    const out = [];
    for (const seq of step.evidenceEventSeqs || []) {
      const e = bySeq.get(seq);
      if (!e || !CLICKY.has(e.type) || !e.url || !e.element) continue;
      const name = String(e.element.name || e.element.label || '').trim().slice(0, 120);
      if (!name || e.element.isPassword || /\[(REDACTED|VALUE_ENTERED)/.test(name)) continue;
      const t = { role: String(e.element.role || '').slice(0, 40), name, url: pageOf(e.url) };
      const last = out[out.length - 1];
      if (last && last.role === t.role && last.name === t.name) continue;
      out.push(t);
    }
    step.targets = out.slice(0, 12);
  }
  return doc;
}
