// Recording to Power Automate: Claude drafts a cloud flow (trigger, inputs, one or more actions per
// documented step, connectors with their licence tier) and, where useful, a Power Apps form that
// starts it. The result is a build guide for a maker; nothing is created in the tenant.
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { createClient } from './generate-llm.js';

const FlowOut = z.object({
  automatable: z.boolean(),
  summary: z.string(),
  trigger: z.object({ type: z.string(), description: z.string() }),
  inputs: z.array(z.object({ name: z.string(), type: z.string(), description: z.string() })),
  actions: z.array(z.object({ stepNumber: z.number().int().nullable(), name: z.string(), connector: z.string(), action: z.string(), settings: z.string(), notes: z.string() })),
  connectors: z.array(z.object({ name: z.string(), premium: z.boolean() })),
  powerAppsForm: z.object({ recommended: z.boolean(), fields: z.array(z.string()), notes: z.string() }),
  desktopFlowSteps: z.array(z.object({ stepNumber: z.number().int(), reason: z.string() })),
  manualSteps: z.array(z.object({ stepNumber: z.number().int(), reason: z.string() })),
  licensing: z.string(),
  assumptions: z.array(z.string()),
});

const SYSTEM = `You are an experienced Microsoft Power Platform maker and Microsoft 365 administrator. You turn an approved IT work instruction into a Power Automate cloud flow that a maker can build, step by step.

Rules:
- Prefer standard connectors (Office 365 Users, Office 365 Outlook, Microsoft Teams, SharePoint, Approvals). Use premium connectors (HTTP with Microsoft Entra ID, Microsoft Entra ID, Azure Automation, HTTP) only where a standard one cannot do the step, and mark each connector as premium or not.
- Everything that differs per run (user, groups, licence, manager) is a flow input. Never put values, people, tenant ids or secrets into the flow; secrets come from Azure Key Vault or are never handled by the flow.
- Follow the order of the documented steps; give each action the step number it implements. Add an Approvals action before privileged changes when the procedure mentions an approval or a privileged role.
- A step that is only possible by clicking in a portal or desktop app goes under desktopFlowSteps (Power Automate Desktop, attended or unattended) with the reason; a human decision or physical action goes under manualSteps.
- Recommend a Power Apps form only when people would start the flow by entering data; list its fields.
- Explain the licensing in one or two sentences (standard connectors are included in most Microsoft 365 licences; premium connectors and desktop flows need Power Automate Premium or a process licence) and say that prices and entitlements must be checked.
- Only name connectors and actions that exist. When you are not sure, add it to assumptions.
- Write all texts in the language of the document.
- If nothing can be automated, set automatable to false.`;

export async function generateFlow({ cfg, doc, client }) {
  const steps = doc.steps.map((s) => ({ number: s.number, title: s.title, description: s.description, instructions: s.instructions, application: s.application, input: s.input, expectedResult: s.expectedResult, clicked: (s.targets || []).map((t) => `${t.role} "${t.name}" on ${t.url}`) }));
  const brief = { title: doc.info.title, language: doc.info.language || 'en', purpose: doc.purpose, prerequisites: doc.prerequisites, roles: doc.roles, decisions: doc.decisions, exceptions: doc.exceptions, expectedOutcome: doc.expectedOutcome, steps };
  const anthropic = client || (await createClient(cfg));
  const format = zodOutputFormat(FlowOut);
  const stream = anthropic.messages.stream({
    model: cfg.ai.model,
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    output_config: { effort: cfg.ai.scriptEffort || cfg.ai.effort, format: { type: format.type, schema: format.schema } },
    system: SYSTEM,
    messages: [{ role: 'user', content: `<approved_procedure>\n${JSON.stringify(brief, null, 2)}\n</approved_procedure>\nDraft the Power Automate flow for this procedure.` }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('The AI model declined to draft a flow for this procedure.'), { code: 'AI_REFUSAL' });
  if (msg.stop_reason === 'max_tokens') throw Object.assign(new Error('The flow draft was too long and was cut off.'), { code: 'AI_TRUNCATED' });
  const out = format.parse(msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  return { ...out, model: msg.model, generatedAt: new Date().toISOString(), processId: doc.info.processId, version: doc.info.version, title: doc.info.title };
}

// The build guide as Markdown, for download or for a ticket.
export function flowToMarkdown(f) {
  const L = [`# Power Automate flow: ${f.title}`, '', `Draft for ${f.processId} v${f.version}, written by ${f.model} on ${f.generatedAt.slice(0, 10)}. Review before building.`, '', f.summary, ''];
  L.push('## Trigger', '', `**${f.trigger.type}** – ${f.trigger.description}`, '');
  if (f.inputs.length) L.push('## Inputs', '', '| Name | Type | Description |', '|---|---|---|', ...f.inputs.map((i) => `| ${i.name} | ${i.type} | ${i.description} |`), '');
  L.push('## Actions', '');
  f.actions.forEach((a, i) => L.push(`${i + 1}. **${a.name}**${a.stepNumber ? ` (step ${a.stepNumber})` : ''} – ${a.connector}: *${a.action}*`, ...(a.settings ? [`   - Settings: ${a.settings}`] : []), ...(a.notes ? [`   - Note: ${a.notes}`] : [])));
  L.push('', '## Connectors', '', ...f.connectors.map((c) => `- ${c.name}${c.premium ? ' (premium)' : ''}`), '');
  if (f.powerAppsForm.recommended) L.push('## Power Apps form', '', `Fields: ${f.powerAppsForm.fields.join(', ')}`, '', f.powerAppsForm.notes, '');
  if (f.desktopFlowSteps.length) L.push('## Power Automate Desktop', '', ...f.desktopFlowSteps.map((s) => `- Step ${s.stepNumber}: ${s.reason}`), '');
  if (f.manualSteps.length) L.push('## Stays manual', '', ...f.manualSteps.map((s) => `- Step ${s.stepNumber}: ${s.reason}`), '');
  L.push('## Licensing', '', f.licensing, '');
  if (f.assumptions.length) L.push('## Assumptions to verify', '', ...f.assumptions.map((a) => `- ${a}`), '');
  return L.join('\n');
}
