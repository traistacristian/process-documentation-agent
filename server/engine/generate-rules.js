// Rule-based documentation engine. Used when no AI model is configured, and as the evidence
// skeleton passed to the AI engine. It only writes what was observed: anything it cannot know
// (purpose, scope, permissions, the business meaning of values) is left empty and raised as a
// clarification request instead of being invented.
import crypto from 'node:crypto';
import { emptyDoc, emptyStep, normalizeDoc } from './schema.js';
import { segmentEvents, pageName, applicationName } from './segment.js';

const q = (s) => `"${String(s).trim()}"`;
const isPlaceholderValue = (v) => !v || /^\[(VALUE_ENTERED|REDACTED)/.test(v);

function describeAction(ev) {
  const el = ev.element || {};
  const name = (el.name || el.label || '').trim();
  const label = (el.label || el.name || 'the field').trim();
  const role = (el.role || '').toLowerCase();
  switch (ev.type) {
    case 'navigate': return ev.causedByAction ? null : `Open the ${q(pageName(ev))} page${ev.url ? ` (${shortUrl(ev.url)})` : ''}.`;
    case 'window_focus': return `Switch to ${ev.app || 'the application'}${ev.windowTitle ? `, window ${q(ev.windowTitle)}` : ''}.`;
    case 'click':
      if (!name) return null;
      if (role === 'tab') return `Open the ${q(name)} tab.`;
      if (role === 'link') return `Select the ${q(name)} link.`;
      if (role === 'menuitem') return `Choose ${q(name)} from the menu.`;
      if (role === 'checkbox' || role === 'switch') return `Toggle ${q(name)}.`;
      if (role === 'row' || role === 'listitem' || role === 'gridcell' || role === 'option') return `Select the relevant entry in the list${el.context ? ` (${el.context})` : ''}.`;
      return `Click ${q(name)}${el.context ? ` in ${q(el.context)}` : ''}.`;
    case 'input':
      if (ev.sensitive) return `Enter the ${label} (sensitive value - not recorded).`;
      return isPlaceholderValue(ev.value) ? `Enter the required value in the ${q(label)} field.` : `Enter ${q(ev.value)} in the ${q(label)} field.`;
    case 'change': case 'select':
      if (el.inputType === 'checkbox') return isPlaceholderValue(ev.value) ? `Set the ${q(label)} checkbox as required.` : `${ev.value === 'true' || ev.value === 'checked' ? 'Select' : 'Clear'} the ${q(label)} checkbox.`;
      if (el.inputType === 'radio') return `Choose the ${q(label)} option.`;
      return isPlaceholderValue(ev.value) ? `Set the ${q(label)} field.` : `Select ${q(ev.value)} in ${q(label)}.`;
    case 'submit': return name ? `Submit the form with ${q(name)}.` : 'Submit the form.';
    case 'key': return ev.text ? `Press ${ev.text}${ev.element?.label ? ` in the ${q(ev.element.label)} field` : ''}.` : null;
    default: return null;
  }
}

function shortUrl(url) {
  try { const u = new URL(url); return `${u.host}${u.pathname}`.replace(/\/$/, ''); } catch { return url; }
}

function stepTitle(seg, n) {
  if (seg.markLabel) return seg.markLabel;
  if (seg.reason === 'screen') return `Screen ${n} (describe the action)`;
  const page = pageName(seg.location);
  const acts = seg.events.filter((e) => ['click', 'submit', 'input', 'change', 'select'].includes(e.type));
  const SAVE = /^(save|apply|submit|ok|confirm|update|create|add|assign|delete|remove|reset|send|finish)/i;
  const last = [...acts].reverse().find((e) => (e.type === 'click' || e.type === 'submit') && SAVE.test(e.element?.name || ''));
  const verb = last?.element?.name;
  if (!acts.length) return `Open ${page}`;
  const searched = acts.some((e) => /search|find|filter|look ?up/i.test(`${e.element?.label || ''} ${e.element?.role || ''}`));
  const opened = acts.some((e) => ['row', 'gridcell', 'listitem', 'option', 'treeitem'].includes((e.element?.role || '').toLowerCase()));
  if (searched && opened) return `Search ${page} and open the entry`;
  if (searched) return `Search ${page}`;
  if (verb) return `${verb.replace(/\s+changes?$/i, '')} in ${page}`;
  return `Work in ${page}`;
}

export function generateWithRules({ meta, events, screenshotsAvailable = new Set(), base = null, user }) {
  const segs = segmentEvents(events);
  const doc = base ? structuredClone(base) : emptyDoc();
  const now = new Date().toISOString();
  doc.info = {
    ...doc.info,
    title: meta.title || doc.info.title,
    owner: meta.owner || doc.info.owner,
    department: meta.department || doc.info.department,
    category: meta.category || doc.info.category,
    author: doc.info.author || user?.name || '',
    updatedAt: now,
    status: 'Draft',
  };
  if (!base) doc.purpose = meta.description ? meta.description : '';

  const clarifications = [];
  const ask = (section, question, stepId = null) => clarifications.push({ id: `clr_${crypto.randomBytes(4).toString('hex')}`, section, stepId, question, answer: '', status: 'open' });
  const systems = new Set();
  const errors = [];

  doc.steps = segs.map((seg, i) => {
    const s = emptyStep(i + 1);
    s.id = `stp_${crypto.randomBytes(4).toString('hex')}`;
    s.title = stepTitle(seg, i + 1);
    s.application = applicationName(seg.location);
    systems.add(s.application);
    s.important = seg.important;
    s.notes = seg.notes.filter(Boolean);
    s.evidenceEventSeqs = seg.events.map((e) => e.seq).filter(Number.isFinite);
    const instr = [];
    for (const ev of seg.events) {
      let line = describeAction(ev);
      if (ev.type === 'key' && ev.afterInput && instr.length && /field\.$/.test(instr[instr.length - 1])) { instr[instr.length - 1] = instr[instr.length - 1].replace(/\.$/, ' and press Enter.'); line = null; }
      if (line && instr[instr.length - 1] !== line) instr.push(line);
      if (ev.type === 'feedback' && ev.level === 'error') errors.push({ step: s, text: ev.text });
    }
    if (!seg.events.some((e) => e.type === 'navigate' || e.type === 'window_focus') && i === 0 && (seg.location?.url || seg.location?.windowTitle)) {
      instr.unshift(`Open ${q(pageName(seg.location))} in ${s.application}.`);
    }
    s.instructions = instr;
    const inputs = seg.events.filter((e) => ['input', 'change', 'select'].includes(e.type)).map((e) => e.element?.label || e.element?.name).filter(Boolean);
    s.input = [...new Set(inputs)].join(', ');
    const ok = [...seg.events].reverse().find((e) => e.type === 'feedback' && e.level !== 'error');
    const nextSeg = segs[i + 1];
    const lastEv = seg.events[seg.events.length - 1];
    const trailingNav = lastEv?.type === 'navigate' && lastEv.causedByAction && seg.events.indexOf(lastEv) > 0 ? lastEv : null;
    const results = [];
    if (ok?.text) results.push(`The confirmation ${q(ok.text)} is displayed.`);
    if (trailingNav) results.push(`The ${q(pageName(trailingNav))} screen is shown.`);
    else if (!ok?.text && nextSeg) results.push(`The ${q(pageName(nextSeg.location))} screen is shown.`);
    s.expectedResult = results.join(' ');
    s.description = s.instructions.length ? `Performed in ${s.application} on the ${q(pageName(seg.location))} screen.` : '';
    const shots = seg.events.map((e) => e.screenshotId).filter((id) => id && screenshotsAvailable.has(id));
    s.screenshotIds = [...new Set(shots)].slice(0, seg.important ? 3 : 1);
    if (!s.screenshotIds.length && screenshotsAvailable.size) s.warnings.push('No screenshot was captured for this step.');
    if (seg.reason === 'screen') ask('steps', `Step ${i + 1} was captured with screen sharing only, so the clicks are not known. What is done on this screen? (Rename the step and add the instructions.)`, s.id);
    else if (!s.instructions.length) ask('steps', `Step ${i + 1} ("${s.title}") has no recognised actions. What is done in this step?`, s.id);
    if (seg.events.some((e) => e.type === 'input' && isPlaceholderValue(e.value) && !e.sensitive)) {
      ask('steps', `Step ${i + 1}: what value or format should be entered (${s.input || 'field'})? The typed value was not recorded for privacy reasons.`, s.id);
    }
    if (!s.expectedResult) ask('steps', `Step ${i + 1}: how does the user know this step succeeded?`, s.id);
    return s;
  });

  for (const e of errors) {
    doc.exceptions.push({ problem: `Error observed during recording in step ${e.step.number}: ${q(e.text)}`, handling: '', escalation: '' });
    ask('exceptions', `An error appeared in step ${e.step.number} (${q(e.text)}). How should it be handled, and who is the escalation contact?`);
  }

  if (!base) {
    doc.prerequisites.systems = [...systems];
    if (!doc.purpose) ask('purpose', 'Why does this process exist and what does it achieve?');
    ask('scope', 'What is included in and excluded from this process?');
    ask('prerequisites', 'Which permissions or admin roles are required to perform this process?');
    ask('roles', 'Which roles perform or approve this process?');
    const last = doc.steps[doc.steps.length - 1];
    doc.expectedOutcome = last?.expectedResult ? `The process is complete when: ${last.expectedResult.replace(/\.$/, '')}.` : '';
    if (!doc.expectedOutcome) ask('expectedOutcome', 'How can the user verify that the whole process completed successfully?');
  } else {
    for (const s of systems) if (!doc.prerequisites.systems.includes(s)) doc.prerequisites.systems.push(s);
  }
  if (!doc.steps.length) ask('steps', 'No process steps could be recognised from the recording. Was the capture component connected?');

  const suggestions = [];
  const unshot = doc.steps.filter((s) => !s.screenshotIds.length).length;
  if (unshot) suggestions.push(`${unshot} step(s) have no screenshot. Consider re-recording with screen capture enabled or attaching images.`);
  if (doc.steps.length > 15) suggestions.push('This process has many steps; consider splitting it into sub-processes.');

  return { doc: normalizeDoc(doc), clarifications, suggestions, engine: 'rules' };
}
