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
});

export const DocSchema = z.object({
  info: z.object({
    processId: str, title: str, version: str, createdAt: str, updatedAt: str,
    owner: str, department: str, category: str, author: str, approver: str, status: str,
  }),
  purpose: str,
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
    info: { processId: '', title: '', version: '0.1', createdAt: now, updatedAt: now, owner: '', department: '', category: '', author: '', approver: '', status: 'Draft', ...info },
    purpose: '', scope: { included: [], excluded: [] },
    prerequisites: { permissions: [], access: [], systems: [], information: [], dependencies: [] },
    roles: [], steps: [], decisions: [], exceptions: [], expectedOutcome: '', verification: [],
    troubleshooting: [], related: [], changeHistory: [],
  };
}

export function emptyStep(n) {
  return { id: `step_${n}`, number: n, title: '', description: '', instructions: [], application: '', input: '', expectedResult: '', screenshotIds: [], notes: [], warnings: [], important: false, evidenceEventSeqs: [] };
}

// Coerces a possibly partial object (e.g. hand-edited in the UI) into a valid document.
export function normalizeDoc(doc) {
  const base = emptyDoc();
  const d = { ...base, ...doc, info: { ...base.info, ...(doc?.info || {}) }, scope: { ...base.scope, ...(doc?.scope || {}) }, prerequisites: { ...base.prerequisites, ...(doc?.prerequisites || {}) } };
  d.steps = (d.steps || []).map((s, i) => ({ ...emptyStep(i + 1), ...s, number: i + 1 }));
  return DocSchema.parse(d);
}
