// Recording to script: Claude drafts a PowerShell script (Microsoft Graph PowerShell SDK, or the
// matching module for the product) that performs a published procedure. The app never runs it:
// an administrator reviews it, tests it with -WhatIf in a test tenant and decides.
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { createClient } from './generate-llm.js';

const ScriptOut = z.object({
  automatable: z.boolean(),
  summary: z.string(),
  script: z.string(),
  modules: z.array(z.string()),
  permissions: z.array(z.string()),
  parameters: z.array(z.object({ name: z.string(), description: z.string() })),
  manualSteps: z.array(z.object({ stepNumber: z.number().int(), reason: z.string() })),
  assumptions: z.array(z.string()),
});

const SYSTEM = `You are a senior Microsoft 365 and Windows administrator. You turn an approved IT work instruction into a PowerShell script that does the same thing through supported APIs, for an administrator to review before anyone runs it.

Rules:
- Prefer the Microsoft Graph PowerShell SDK (Connect-MgGraph with the least-privilege -Scopes the script needs). Use Exchange Online, Teams or ActiveDirectory modules only where Graph cannot do the step.
- Everything that differs per run (user names, e-mail addresses, groups, licences, passwords) is a mandatory parameter. Never hard-code values, tenant ids, people or secrets; read secrets with Read-Host -AsSecureString or a SecureString parameter.
- Use [CmdletBinding(SupportsShouldProcess)] and wrap every change in $PSCmdlet.ShouldProcess so -WhatIf shows what would happen without changing anything. Set $ErrorActionPreference = 'Stop', check that objects exist before changing them, and print what was done.
- Follow the order of the documented steps and put a comment with the step number above each part. Write comments in the language of the document.
- A step that only checks or reads something on screen becomes a Get-/verification command. A step that has no supported API (a portal-only setting, a physical action, a human decision) is not scripted: list it under manualSteps with the reason and leave a comment in the script.
- Only use cmdlets and parameters that exist. When you are not sure a cmdlet or property exists, say so under assumptions instead of guessing silently.
- If nothing in the procedure can be automated, set automatable to false and return an empty script.`;

export async function generateScript({ cfg, doc, client }) {
  const steps = doc.steps.map((s) => ({ number: s.number, title: s.title, description: s.description, instructions: s.instructions, application: s.application, input: s.input, expectedResult: s.expectedResult, clicked: (s.targets || []).map((t) => `${t.role} "${t.name}" on ${t.url}`) }));
  const brief = { title: doc.info.title, language: doc.info.language || 'en', purpose: doc.purpose, prerequisites: doc.prerequisites, decisions: doc.decisions, exceptions: doc.exceptions, expectedOutcome: doc.expectedOutcome, verification: doc.verification, steps };
  const anthropic = client || (await createClient(cfg));
  const format = zodOutputFormat(ScriptOut);
  const stream = anthropic.messages.stream({
    model: cfg.ai.model,
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    output_config: { effort: cfg.ai.scriptEffort || cfg.ai.effort, format: { type: format.type, schema: format.schema } },
    system: SYSTEM,
    messages: [{ role: 'user', content: `<approved_procedure>\n${JSON.stringify(brief, null, 2)}\n</approved_procedure>\nDraft the PowerShell script for this procedure.` }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('The AI model declined to write a script for this procedure.'), { code: 'AI_REFUSAL' });
  if (msg.stop_reason === 'max_tokens') throw Object.assign(new Error('The script was too long and was cut off.'), { code: 'AI_TRUNCATED' });
  const out = format.parse(msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  return { ...out, warnings: reviewWarnings(out.script), model: msg.model, generatedAt: new Date().toISOString(), processId: doc.info.processId, version: doc.info.version };
}

// Simple static checks shown next to the script; they do not replace a review.
export function reviewWarnings(script) {
  const w = [];
  if (!script.trim()) return w;
  if (!/SupportsShouldProcess/i.test(script)) w.push('The script does not support -WhatIf (SupportsShouldProcess is missing).');
  if (/Invoke-Expression|\biex\b|DownloadString|Start-BitsTransfer/i.test(script)) w.push('The script downloads or evaluates code at run time. Remove that before use.');
  if (/(ConvertTo-SecureString\s+["'][^"']+["']\s+-AsPlainText|password\s*=\s*["'][^"']+["'])/i.test(script)) w.push('A password appears to be written in the script. Use a SecureString parameter instead.');
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(script)) w.push('The script contains a fixed id (GUID). Check that it is not tenant-specific.');
  if (/Remove-|Delete|Disable-/i.test(script)) w.push('The script deletes or disables something. Test it with -WhatIf first.');
  return w;
}
