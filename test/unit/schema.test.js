import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDoc } from '../../server/engine/schema.js';

test('rows added in the editor without every field are completed, not rejected', () => {
  const d = normalizeDoc({
    decisions: [{ condition: 'The user is external', action: 'Invite as guest' }, { condition: '', action: '', stepNumber: 'x' }],
    exceptions: [{ problem: 'The invited user received an error' }],
    troubleshooting: [{ issue: 'x' }], roles: [{ role: 'Helpdesk' }], related: [{ title: 'Wiki' }],
  });
  assert.deepEqual(d.decisions.map((x) => x.stepNumber), [null, null]);
  assert.deepEqual(d.exceptions[0], { problem: 'The invited user received an error', handling: '', escalation: '' });
  assert.equal(d.troubleshooting[0].resolution, '');
  assert.equal(d.roles[0].responsibilities, '');
  assert.equal(d.related[0].url, '');
});
