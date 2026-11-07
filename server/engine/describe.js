// The recording author's own description of each step, written during recording (keyed by the
// sequence number of an event in that step, so it survives later re-segmentation).
const short = (t) => { const one = t.split(/\n/)[0].trim(); return one.length > 90 ? `${one.slice(0, 87)}...` : one; };

export function findDescription(step, descriptions = {}) {
  const seqs = new Set(step.evidenceEventSeqs || []);
  const hits = Object.entries(descriptions).filter(([seq, text]) => seqs.has(Number(seq)) && String(text || '').trim());
  return hits.sort((a, b) => Number(a[0]) - Number(b[0])).map(([, t]) => String(t).trim()).join('\n') || '';
}

// `drafts` are the AI's descriptions: used only for steps the author did not describe.
export function applyStepDescriptions(result, descriptions = {}, drafts = {}) {
  if (!Object.keys(descriptions || {}).length && !Object.keys(drafts || {}).length) return result;
  for (const step of result.doc.steps) {
    const text = findDescription(step, descriptions) || findDescription(step, drafts);
    if (!text) continue;
    step.description = text;
    // A step captured from screen sharing only has no recorded actions: the author's words are the evidence.
    if (!step.instructions.length) {
      step.instructions = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
      if (/^Screen \d+ \(describe the action\)$/.test(step.title) || !step.title) step.title = short(text);
      result.clarifications = result.clarifications.filter((c) => !(c.stepId === step.id && /screen sharing only|has no recognised actions/.test(c.question)));
    }
  }
  return result;
}
