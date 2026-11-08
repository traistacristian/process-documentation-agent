// Recording to script: request shape, review warnings and the API route (fake Claude client).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateScript, reviewWarnings } from '../../server/engine/script.js';
import { emptyDoc, emptyStep, normalizeDoc } from '../../server/engine/schema.js';
import { loadConfig } from '../../server/config.js';

const doc = () => { const d = emptyDoc({ processId: 'PRC-2026-AA0001', title: 'Create a new user', version: '1.0' }); d.steps = [{ ...emptyStep(1), title: 'Create the user', instructions: ['Click "Add a user".'], targets: [{ role: 'button', name: 'Add a user', url: 'https://admin.microsoft.com/Adminportal/Home' }] }]; return normalizeDoc(d); };
const good = `[CmdletBinding(SupportsShouldProcess)]\nparam([Parameter(Mandatory)][string]$UserPrincipalName)\n$ErrorActionPreference = 'Stop'\nConnect-MgGraph -Scopes User.ReadWrite.All\n# Step 1\nif ($PSCmdlet.ShouldProcess($UserPrincipalName, 'Create user')) { New-MgUser -UserPrincipalName $UserPrincipalName }`;

test('the script is drafted from the approved steps and the recorded clicks', async () => {
  let req;
  const client = { messages: { stream: (r) => { req = r; return { finalMessage: async () => ({ model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ automatable: true, summary: 'Creates the user.', script: good, modules: ['Microsoft.Graph.Users'], permissions: ['User.ReadWrite.All'], parameters: [{ name: 'UserPrincipalName', description: 'UPN' }], manualSteps: [], assumptions: [] }) }] }) }; } } };
  const out = await generateScript({ cfg: loadConfig(), doc: doc(), client });
  assert.equal(req.model, 'claude-haiku-5-5');
  assert.match(req.system, /SupportsShouldProcess/);
  assert.match(req.messages[0].content, /button \\"Add a user\\"/);
  assert.equal(out.processId, 'PRC-2026-AA0001');
  assert.deepEqual(out.warnings, []);
});

test('review warnings flag risky scripts', () => {
  const w = reviewWarnings('$p = ConvertTo-SecureString "Passw0rd!" -AsPlainText -Force\nRemove-MgUser -UserId 0b5e1c1e-1111-2222-3333-444455556666\niex (irm https://x)');
  assert.equal(w.length, 5);
  assert.deepEqual(reviewWarnings(''), []);
});

test('a Power Automate flow is drafted as a build guide', async () => {
  const { generateFlow, flowToMarkdown } = await import('../../server/engine/flow.js');
  const flow = { automatable: true, summary: 'Creates the user.', trigger: { type: 'Power Apps (V2)', description: 'Started from the onboarding form' }, inputs: [{ name: 'UserPrincipalName', type: 'Text', description: 'UPN' }], actions: [{ stepNumber: 1, name: 'Create user', connector: 'HTTP with Microsoft Entra ID', action: 'Invoke an HTTP request', settings: 'POST /v1.0/users', notes: '' }], connectors: [{ name: 'HTTP with Microsoft Entra ID', premium: true }], powerAppsForm: { recommended: true, fields: ['First name', 'Last name'], notes: '' }, desktopFlowSteps: [], manualSteps: [{ stepNumber: 2, reason: 'Hand over the laptop' }], licensing: 'Needs Power Automate Premium.', assumptions: [] };
  let req;
  const client = { messages: { stream: (r) => { req = r; return { finalMessage: async () => ({ model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(flow) }] }) }; } } };
  const out = await generateFlow({ cfg: loadConfig(), doc: doc(), client });
  assert.match(req.system, /standard connectors/);
  const md = flowToMarkdown(out);
  assert.match(md, /HTTP with Microsoft Entra ID \(premium\)/);
  assert.match(md, /Step 2: Hand over the laptop/);
  assert.match(md, /Fields: First name, Last name/);
});
