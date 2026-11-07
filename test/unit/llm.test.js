// The Claude engine is tested with a fake client (no API key in CI). It checks the request shape and
// the server-side guardrails applied to the model's answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateWithClaude } from '../../server/engine/generate-llm.js';
import { loadConfig } from '../../server/config.js';
import { v1Events } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-llm-'));
const shotPath = path.join(tmp, 'a.png');
fs.writeFileSync(shotPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

const step = (o) => ({ title: '', description: '', instructions: [], application: 'Contoso Admin Portal', input: '', expectedResult: '', screenshotIds: [], notes: [], warnings: [], important: false, evidenceEventSeqs: [], ...o });
const answer = {
  doc: {
    purpose: '', scope: { included: [], excluded: [] }, prerequisites: { permissions: [], access: [], systems: ['Contoso Admin Portal'], information: [], dependencies: [] },
    roles: [], decisions: [], exceptions: [], expectedOutcome: 'The user has the Helpdesk administrator role.', verification: [], troubleshooting: [], related: [],
    steps: [
      step({ title: 'Find the user account', instructions: ['Open Active users.', 'Search for the user by username.', 'Open the user.'], evidenceEventSeqs: [2, 3, 4, 6], screenshotIds: ['shot_aa01', 'shot_invented'] }),
      step({ title: 'Update user permissions', instructions: ['Select Helpdesk administrator in Permission level.', 'Click Save.'], evidenceEventSeqs: [8, 9, 10] }),
      step({ title: 'Notify the user by e-mail', instructions: ['Send an e-mail.'], evidenceEventSeqs: [999] }),
    ],
  },
  clarifications: [{ section: 'scope', stepNumber: null, question: 'Does this also apply to external accounts?' }],
  suggestions: ['Add a verification step.'],
};

function fakeClient(responseText, capture) {
  return { beta: { messages: { stream: (req) => { capture.req = req; return { finalMessage: async () => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: responseText }] }) }; } } } };
}

test('request uses structured output, adaptive thinking, fallbacks and sends screenshots as images', async () => {
  const cap = {};
  const cfg = loadConfig();
  const r = await generateWithClaude({ cfg, meta: { title: 'Grant helpdesk permissions' }, events: v1Events(), screenshots: [{ id: 'shot_aa01', path: shotPath, mime: 'image/png' }], base: null, user: { name: 'Alex' }, client: fakeClient(JSON.stringify(answer), cap) });
  assert.equal(cap.req.model, 'claude-opus-5-5');
  assert.deepEqual(cap.req.thinking, { type: 'adaptive' });
  assert.equal(cap.req.output_config.format.type, 'json_schema');
  assert.equal(cap.req.fallbacks, 'default');
  assert.ok(cap.req.messages[0].content.some((b) => b.type === 'image'));
  assert.match(cap.req.system, /Never invent information/);

  assert.equal(r.engine, 'claude:claude-opus-5-5');
  assert.equal(r.doc.steps.length, 3);
  assert.deepEqual(r.doc.steps[0].screenshotIds, ['shot_aa01'], 'unknown screenshot ids are dropped');
  const invented = r.doc.steps[2];
  assert.deepEqual(invented.evidenceEventSeqs, []);
  assert.match(invented.warnings.join(), /Not supported by captured evidence/);
  assert.ok(r.clarifications.some((c) => c.stepId === invented.id), 'unsupported step must be confirmed by a person');
  assert.ok(r.clarifications.some((c) => c.section === 'purpose'), 'empty purpose is asked');
  assert.ok(r.clarifications.some((c) => /external accounts/.test(c.question)));
});

test('malformed model output is rejected (the API then falls back to the rule engine)', async () => {
  await assert.rejects(generateWithClaude({ cfg: loadConfig(), meta: { title: 'x' }, events: v1Events(), screenshots: [], base: null, user: {}, client: fakeClient('{"doc": 1}', {}) }));
});

test('AI provider selection: Foundry, Claude API, rules', async () => {
  const { aiProvider, createClient } = await import('../../server/engine/generate-llm.js');
  const saved = { ...process.env };
  try {
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_API_KEY']) delete process.env[k];
    const cfg = (provider, foundry) => ({ ai: { provider, foundry } });
    assert.equal(aiProvider(cfg('auto')), null);
    assert.equal(aiProvider(cfg('rules')), null);
    process.env.ANTHROPIC_API_KEY = 'x';
    assert.equal(aiProvider(cfg('auto')), 'anthropic');
    assert.equal(aiProvider(cfg('rules')), null);
    assert.equal(aiProvider(cfg('auto', { resource: 'contoso-ai' })), 'foundry');
    process.env.ANTHROPIC_FOUNDRY_API_KEY = 'k';
    const c = await createClient(cfg('foundry', { resource: 'contoso-ai' }));
    assert.equal(c.constructor.name, 'AnthropicFoundry');
    assert.match(c.baseURL, /contoso-ai\.services\.ai\.azure\.com\/anthropic/);
  } finally { process.env = saved; }
});
