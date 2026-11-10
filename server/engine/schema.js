// The standard process document model. Every document - whichever engine produced it - follows this
// structure, which maps 1:1 to the 11 sections of the documentation template.
import { z } from 'zod';

const str = z.string();
const strList = z.array(z.string());

export const StepSchema = z.object({
  id: str,
  number: z.number().int(),
  title: str,
  description: str,
  instructions: strList,
  application: str,
  input: str,
  expectedResult: str,
  screenshotIds: strList,
  notes: strList,
  warnings: strList,
  important: z.boolean(),
  evidenceEventSeqs: z.array(z.number().int()),
  // What to click in this step (from the recording), used by guided mode to highlight it.
  targets: z.array(z.object({ role: str, name: str, url: str })),
  // Numbered click markers on the step's screenshots (positions as fractions of the image).
  marks: z.array(z.object({ shotId: str, n: z.number().int(), kind: z.enum(['click', 'field']), x: z.number(), y: z.number(), w: z.number(), h: z.number(), cx: z.number(), cy: z.number() })),
  // Part of a screenshot to show (fractions of the image); the stored screenshot stays complete.
  crops: z.array(z.object({ shotId: str, x: z.number(), y: z.number(), w: z.number(), h: z.number() })),
});

export const DocSchema = z.object({
  info: z.object({
    processId: str, title: str, version: str, createdAt: str, updatedAt: str,
    owner: str, department: str, category: str, author: str, approver: str, status: str,
    language: z.enum(['en', 'de']),
    fileName: str, // name of the folder and Word file in SharePoint ('' = the title)
  }),
  purpose: str,
  // Search keywords (the words people type to find this process).
  keywords: strList,
  scope: z.object({ included: strList, excluded: strList }),
  prerequisites: z.object({ permissions: strList, access: strList, systems: strList, information: strList, dependencies: strList }),
  roles: z.array(z.object({ role: str, responsibilities: str })),
  steps: z.array(StepSchema),
  decisions: z.array(z.object({ condition: str, action: str, stepNumber: z.number().int().nullable() })),
  exceptions: z.array(z.object({ problem: str, handling: str, escalation: str })),
  expectedOutcome: str,
  verification: strList,
  troubleshooting: z.array(z.object({ issue: str, resolution: str })),
  related: z.array(z.object({ title: str, url: str })),
  changeHistory: z.array(z.object({ version: str, date: str, author: str, approver: str, summary: str })),
});

export const ClarificationSchema = z.object({
  id: str, section: str, stepId: str.nullable(), question: str,
  answer: str, status: z.enum(['open', 'answered', 'dismissed']),
});

export function emptyDoc(info = {}) {
  const now = new Date().toISOString();
  return {
    info: { processId: '', title: '', version: '0.1', createdAt: now, updatedAt: now, owner: '', department: '', category: '', author: '', approver: '', status: 'Draft', language: 'en', fileName: '', ...info },
    purpose: '', keywords: [], scope: { included: [], excluded: [] },
    prerequisites: { permissions: [], access: [], systems: [], information: [], dependencies: [] },
    roles: [], steps: [], decisions: [], exceptions: [], expectedOutcome: '', verification: [],
    troubleshooting: [], related: [], changeHistory: [],
  };
}

export function emptyStep(n) {
  return { id: `step_${n}`, number: n, title: '', description: '', instructions: [], application: '', input: '', expectedResult: '', screenshotIds: [], notes: [], warnings: [], important: false, evidenceEventSeqs: [], targets: [], marks: [], crops: [] };
}

// Coerces a possibly partial object (e.g. hand-edited in the UI) into a valid document.
export function normalizeDoc(doc) {
  const base = emptyDoc();
  const d = { ...base, ...doc, info: { ...base.info, ...(doc?.info || {}) }, scope: { ...base.scope, ...(doc?.scope || {}) }, prerequisites: { ...base.prerequisites, ...(doc?.prerequisites || {}) } };
  d.steps = (d.steps || []).map((s, i) => ({ ...emptyStep(i + 1), ...s, number: i + 1 }));
  // Rows added in the editor carry only the fields that have an input box; complete them.
  const rows = (list, blank) => (Array.isArray(list) ? list : []).map((r) => ({ ...blank, ...r }));
  d.roles = rows(d.roles, { role: '', responsibilities: '' });
  d.decisions = rows(d.decisions, { condition: '', action: '', stepNumber: null }).map((x) => ({ ...x, stepNumber: Number.isInteger(x.stepNumber) ? x.stepNumber : null }));
  d.exceptions = rows(d.exceptions, { problem: '', handling: '', escalation: '' });
  d.troubleshooting = rows(d.troubleshooting, { issue: '', resolution: '' });
  d.related = rows(d.related, { title: '', url: '' });
  return DocSchema.parse(d);
}
