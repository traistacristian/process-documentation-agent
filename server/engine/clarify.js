// Applies a reviewer's answer to a clarification request into the right section of the document.
// The answer text is the employee's own information, so it is inserted verbatim.
const lines = (t) => String(t).split(/\r?\n|;\s*/).map((x) => x.replace(/^[-*•]\s*/, '').trim()).filter(Boolean);

export function applyAnswer(doc, clarification, answer) {
  const a = String(answer || '').trim();
  if (!a) return doc;
  const step = clarification.stepId ? doc.steps.find((s) => s.id === clarification.stepId) : null;
  switch (clarification.section) {
    case 'purpose': doc.purpose = doc.purpose ? `${doc.purpose}\n\n${a}` : a; break;
    case 'expectedOutcome': doc.expectedOutcome = doc.expectedOutcome ? `${doc.expectedOutcome} ${a}` : a; break;
    case 'scope': {
      for (const l of lines(a)) {
        const m = /^(excluded|out of scope|not included)\s*:\s*(.+)$/i.exec(l);
        if (m) doc.scope.excluded.push(m[2]);
        else doc.scope.included.push(l.replace(/^(included|in scope)\s*:\s*/i, ''));
      }
      break;
    }
    case 'prerequisites': doc.prerequisites.permissions.push(...lines(a)); break;
    case 'roles':
      for (const l of lines(a)) {
        const [role, ...rest] = l.split(':');
        doc.roles.push({ role: role.trim(), responsibilities: rest.join(':').trim() });
      }
      break;
    case 'exceptions': {
      const open = doc.exceptions.find((e) => !e.handling);
      if (open) open.handling = a; else doc.exceptions.push({ problem: clarification.question, handling: a, escalation: '' });
      break;
    }
    case 'steps':
      if (step) {
        if (/how does the user know|succeeded/i.test(clarification.question) && !step.expectedResult) step.expectedResult = a;
        else if (/what value|format should be entered/i.test(clarification.question)) step.input = step.input ? `${step.input} – ${a}` : a;
        else if (/has no recognised actions/i.test(clarification.question)) step.instructions.push(a);
        else step.notes.push(a);
      }
      break;
    default:
      if (step) step.notes.push(a);
  }
  return doc;
}
