// Structured comparison of an existing (approved) process document with a newly recorded version.
// Deterministic and explainable by design: the reviewer must be able to trust exactly what changed.
//
// 1. Each step is reduced to a bag of normalised tokens (title weighted x2, instructions, application).
// 2. Steps are aligned with a Needleman-Wunsch style dynamic program that maximises total similarity
//    while preserving order (matches below MIN_MATCH are not allowed).
// 3. Unmatched old/new pairs with high similarity are paired again as "moved" (sequence change).
// 4. Matched pairs are classified unchanged / modified; field-level differences are listed.
// 5. Section-level changes (prerequisites, decisions, exceptions...) are diffed as sets.

const STOP = new Set('the a an to of in on for and or with by from at is are be this that it its into as then your you required relevant new'.split(' '));
const MIN_MATCH = 0.34;
const UNCHANGED = 0.8;
const MOVED = 0.6;

export function tokens(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9äöüßéèàç\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => w.replace(/(ings?|ed|es|s)$/, '') || w);
}

function bag(step) {
  const m = new Map();
  const add = (t, w) => { for (const k of tokens(t)) m.set(k, (m.get(k) || 0) + w); };
  add(step.title, 2);
  add((step.instructions || []).join(' '), 1);
  add(step.description, 0.5);
  return m;
}

export function similarity(a, b) {
  const A = bag(a); const B = bag(b);
  let inter = 0; let total = 0;
  for (const [k, v] of A) { inter += Math.min(v, B.get(k) || 0); total += v; }
  for (const v of B.values()) total += v;
  const dice = total ? (2 * inter) / total : 0;
  const sameApp = a.application && b.application && a.application === b.application ? 0.05 : 0;
  return Math.min(1, dice + sameApp);
}

function align(oldSteps, newSteps) {
  const n = oldSteps.length; const m = newSteps.length;
  const sim = oldSteps.map((o) => newSteps.map((s) => similarity(o, s)));
  const score = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const move = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));
  for (let i = 1; i <= n; i++) move[i][0] = 'up';
  for (let j = 1; j <= m; j++) move[0][j] = 'left';
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      let best = score[i - 1][j]; let mv = 'up';
      if (score[i][j - 1] > best) { best = score[i][j - 1]; mv = 'left'; }
      const s = sim[i - 1][j - 1];
      if (s >= MIN_MATCH && score[i - 1][j - 1] + s >= best) { best = score[i - 1][j - 1] + s; mv = 'diag'; }
      score[i][j] = best; move[i][j] = mv;
    }
  }
  const ops = [];
  let i = n; let j = m;
  while (i > 0 || j > 0) {
    const mv = move[i][j];
    if (mv === 'diag') { ops.push({ oldIndex: i - 1, newIndex: j - 1, sim: sim[i - 1][j - 1] }); i--; j--; }
    else if (mv === 'up') { ops.push({ oldIndex: i - 1, newIndex: null }); i--; }
    else { ops.push({ oldIndex: null, newIndex: j - 1 }); j--; }
  }
  return { ops: ops.reverse(), sim };
}

const FIELDS = ['title', 'description', 'instructions', 'application', 'input', 'expectedResult', 'notes', 'warnings'];
function fieldChanges(o, s) {
  const out = [];
  for (const f of FIELDS) {
    const a = JSON.stringify(o[f] ?? ''); const b = JSON.stringify(s[f] ?? '');
    if (a !== b && !(f === 'description' && !s[f])) out.push({ field: f, before: o[f], after: s[f] });
  }
  return out;
}

function setDiff(section, before = [], after = [], key = (x) => (typeof x === 'string' ? x.toLowerCase().trim() : JSON.stringify(x))) {
  const B = new Map(before.map((x) => [key(x), x])); const A = new Map(after.map((x) => [key(x), x]));
  const out = [];
  for (const [k, v] of A) if (!B.has(k)) out.push({ section, kind: 'added', after: v });
  for (const [k, v] of B) if (!A.has(k)) out.push({ section, kind: 'removed', before: v });
  return out;
}

export function compareDocs(oldDoc, newDoc) {
  const oldSteps = oldDoc.steps || []; const newSteps = newDoc.steps || [];
  const { ops, sim } = align(oldSteps, newSteps);

  // Second pass: detect moved steps among the unmatched ones.
  const unOld = ops.filter((o) => o.newIndex === null).map((o) => o.oldIndex);
  const unNew = ops.filter((o) => o.oldIndex === null).map((o) => o.newIndex);
  const movedPairs = new Map(); const usedNew = new Set();
  for (const oi of unOld) {
    let best = null;
    for (const ni of unNew) if (!usedNew.has(ni) && sim[oi][ni] >= MOVED && (!best || sim[oi][ni] > best.s)) best = { ni, s: sim[oi][ni] };
    if (best) { movedPairs.set(oi, best); usedNew.add(best.ni); }
  }
  const movedNewToOld = new Map([...movedPairs].map(([oi, b]) => [b.ni, { oi, s: b.s }]));

  // Change ids are stable (derived from the step ids), so reviewer decisions survive re-comparison
  // after the proposed document is edited.
  const changes = [];
  const sid = (kind, o, n) => `chg_${kind}_${o?.id || 'x'}_${n?.id || 'x'}`;
  for (const op of ops) {
    if (op.oldIndex !== null && op.newIndex !== null) {
      const o = oldSteps[op.oldIndex]; const s = newSteps[op.newIndex];
      const diffs = fieldChanges(o, s);
      const kind = op.sim >= UNCHANGED && !diffs.some((d) => ['title', 'instructions', 'application'].includes(d.field)) ? 'unchanged' : 'modified';
      changes.push({ id: sid('step', o, s), kind, oldIndex: op.oldIndex, newIndex: op.newIndex, oldNumber: o.number, newNumber: s.number, similarity: round(op.sim), title: s.title, oldTitle: o.title, fields: kind === 'unchanged' ? diffs : diffs, renumbered: o.number !== s.number });
    } else if (op.oldIndex !== null) {
      const o = oldSteps[op.oldIndex];
      if (movedPairs.has(op.oldIndex)) {
        const { ni, s } = movedPairs.get(op.oldIndex); const n = newSteps[ni];
        changes.push({ id: sid('moved', o, n), kind: 'moved', role: 'origin', oldIndex: op.oldIndex, newIndex: ni, oldNumber: o.number, newNumber: n.number, similarity: round(s), title: n.title, oldTitle: o.title, fields: fieldChanges(o, n) });
      } else changes.push({ id: sid('removed', o, null), kind: 'removed', oldIndex: op.oldIndex, newIndex: null, oldNumber: o.number, newNumber: null, title: o.title, oldTitle: o.title });
    } else {
      const s = newSteps[op.newIndex];
      if (movedNewToOld.has(op.newIndex)) {
        const origin = changes.find((c) => c.kind === 'moved' && c.newIndex === op.newIndex);
        // Origin may come later in the alignment; create a placeholder that will be linked below.
        changes.push({ id: sid('moveddest', oldSteps[movedNewToOld.get(op.newIndex).oi], s), kind: 'moved', role: 'destination', oldIndex: movedNewToOld.get(op.newIndex).oi, newIndex: op.newIndex, newNumber: s.number, title: s.title, pairId: origin?.id });
      } else changes.push({ id: sid('added', null, s), kind: 'added', oldIndex: null, newIndex: op.newIndex, oldNumber: null, newNumber: s.number, title: s.title });
    }
  }
  // Link moved origin/destination pairs (decision is made once, on the origin).
  for (const c of changes.filter((x) => x.kind === 'moved' && x.role === 'destination')) {
    const origin = changes.find((x) => x.kind === 'moved' && x.role === 'origin' && x.oldIndex === c.oldIndex);
    c.pairId = origin.id; origin.pairId = c.id;
  }

  const sectionChanges = [
    ...setDiff('prerequisites.permissions', oldDoc.prerequisites?.permissions, newDoc.prerequisites?.permissions),
    ...setDiff('prerequisites.access', oldDoc.prerequisites?.access, newDoc.prerequisites?.access),
    ...setDiff('prerequisites.systems', oldDoc.prerequisites?.systems, newDoc.prerequisites?.systems),
    ...setDiff('prerequisites.dependencies', oldDoc.prerequisites?.dependencies, newDoc.prerequisites?.dependencies),
    ...setDiff('decisions', oldDoc.decisions, newDoc.decisions, (d) => `${d.condition}`.toLowerCase()),
    ...setDiff('exceptions', oldDoc.exceptions, newDoc.exceptions, (d) => `${d.problem}`.toLowerCase()),
  ].map((c) => ({ ...c, id: `sec_${c.section}_${c.kind}_${hash(JSON.stringify(c.after ?? c.before))}` }));

  const inconsistencies = [];
  for (const c of changes) {
    if (c.kind === 'removed') inconsistencies.push(`Step ${c.oldNumber} ("${c.title}") of the current documentation was not performed in the new recording. Confirm it is really obsolete and not just skipped.`);
  }
  const decisionsChanged = sectionChanges.filter((c) => c.section === 'decisions');
  if (decisionsChanged.length) inconsistencies.push('Decision points differ from the current documentation; check that alternative paths are still valid.');

  const summary = { unchanged: 0, modified: 0, added: 0, removed: 0, moved: 0 };
  for (const c of changes) if (!(c.kind === 'moved' && c.role === 'destination')) summary[c.kind]++;
  summary.sectionChanges = sectionChanges.length;
  return { changes, sectionChanges, inconsistencies, summary };
}

const hash = (t) => { let h = 0; for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };
const round = (x) => Math.round(x * 100) / 100;

// Builds the document that results from the reviewer's per-change decisions.
// decisions: { [changeId]: 'accept' | 'reject' } - "unchanged" entries need no decision.
// Rejecting a change keeps the approved content exactly as it was; nothing in the existing
// document is lost unless a change that removes it was explicitly accepted.
export function mergeWithDecisions(oldDoc, newDoc, comparison, decisions = {}) {
  const out = structuredClone(newDoc);
  const steps = [];
  const accepted = (c) => decisions[c.id] === 'accept';
  for (const c of comparison.changes) {
    const o = c.oldIndex !== null ? oldDoc.steps[c.oldIndex] : null;
    const n = c.newIndex !== null ? newDoc.steps[c.newIndex] : null;
    switch (c.kind) {
      case 'unchanged': steps.push(o); break; // keep the approved wording
      case 'modified': steps.push(accepted(c) ? { ...n, id: o.id } : o); break;
      case 'added': if (accepted(c)) steps.push(n); break;
      case 'removed': if (!accepted(c)) steps.push(o); break;
      case 'moved': {
        const originDecision = c.role === 'origin' ? decisions[c.id] : decisions[c.pairId];
        const take = originDecision === 'accept';
        if (c.role === 'origin' && !take) steps.push(o);
        if (c.role === 'destination' && take) steps.push({ ...n, id: o.id });
        break;
      }
      default: break;
    }
  }
  out.steps = steps.map((s, i) => ({ ...s, number: i + 1 }));
  for (const sc of comparison.sectionChanges) {
    if (decisions[sc.id] === 'accept') continue;
    const [sec, sub] = sc.section.split('.');
    const list = sub ? out[sec][sub] : out[sec];
    if (sc.kind === 'added') {
      const k = JSON.stringify(sc.after);
      const idx = list.findIndex((x) => JSON.stringify(x) === k);
      if (idx >= 0) list.splice(idx, 1);
    } else if (sc.kind === 'removed') list.push(sc.before);
  }
  return out;
}

export function pendingDecisions(comparison, decisions = {}) {
  const need = [
    ...comparison.changes.filter((c) => c.kind !== 'unchanged' && !(c.kind === 'moved' && c.role === 'destination')),
    ...comparison.sectionChanges,
  ];
  return need.filter((c) => !['accept', 'reject'].includes(decisions[c.id])).map((c) => c.id);
}
