import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareDocs, mergeWithDecisions, pendingDecisions } from '../../server/engine/compare.js';
import { emptyDoc, emptyStep } from '../../server/engine/schema.js';

const mk = (titles, prefix) => {
  const d = emptyDoc();
  d.steps = titles.map((t, i) => ({ ...emptyStep(i + 1), id: `${prefix}${i}`, title: t, instructions: [`${t}.`], application: 'Admin portal' }));
  return d;
};
const OLD = mk(['Open the administration portal', 'Search for the user', 'Open the account', 'Assign the required permissions', 'Save changes'], 'o');
const NEW = mk(['Open the administration portal', 'Search for the user', 'Open the account', 'Navigate to the new Security tab', 'Assign the required permissions', 'Activate an additional security option', 'Save changes', 'Verify the result'], 'n');

test('specification example: unchanged, inserted and renumbered steps are identified', () => {
  const c = compareDocs(OLD, NEW);
  const kinds = c.changes.map((x) => `${x.kind}:${x.oldNumber ?? '-'}>${x.newNumber ?? '-'}`);
  assert.deepEqual(kinds, ['unchanged:1>1', 'unchanged:2>2', 'unchanged:3>3', 'added:->4', 'unchanged:4>5', 'added:->6', 'unchanged:5>7', 'added:->8']);
  assert.equal(c.summary.added, 3);
  assert.ok(c.changes.find((x) => x.oldNumber === 4).renumbered);
});

test('modified, removed and moved steps', () => {
  const old = mk(['Open the portal', 'Export the report to CSV', 'Search for the user', 'Reset the password'], 'o');
  const nw = mk(['Open the portal', 'Search for the user', 'Reset the password and require change at next sign-in', 'Export the report to CSV'], 'n');
  nw.steps[2].instructions = ['Reset the password.', 'Select "Require change at next sign-in".'];
  const c = compareDocs(old, nw);
  const byKind = (k) => c.changes.filter((x) => x.kind === k);
  assert.equal(byKind('modified').length, 1);
  assert.equal(byKind('moved').length, 2, 'origin and destination');
  assert.ok(c.inconsistencies.length === 0);
  const removed = compareDocs(old, mk(['Open the portal', 'Search for the user', 'Reset the password'], 'n'));
  assert.equal(removed.changes.filter((x) => x.kind === 'removed').length, 1);
  assert.match(removed.inconsistencies[0], /not performed/);
});

test('decisions: rejected changes keep the approved content; nothing is lost silently', () => {
  const c = compareDocs(OLD, NEW);
  assert.equal(pendingDecisions(c, {}).length, 3);
  const added = c.changes.filter((x) => x.kind === 'added');
  const decisions = { [added[0].id]: 'accept', [added[1].id]: 'reject', [added[2].id]: 'accept' };
  assert.equal(pendingDecisions(c, decisions).length, 0);
  const merged = mergeWithDecisions(OLD, NEW, c, decisions);
  assert.deepEqual(merged.steps.map((s) => s.title), ['Open the administration portal', 'Search for the user', 'Open the account', 'Navigate to the new Security tab', 'Assign the required permissions', 'Save changes', 'Verify the result']);
  assert.deepEqual(merged.steps.map((s) => s.number), [1, 2, 3, 4, 5, 6, 7]);

  const old = mk(['Open the portal', 'Search for the user', 'Delete the mailbox'], 'o');
  const nw = mk(['Open the portal', 'Search for the user'], 'n');
  const c2 = compareDocs(old, nw);
  const rem = c2.changes.find((x) => x.kind === 'removed');
  assert.equal(mergeWithDecisions(old, nw, c2, { [rem.id]: 'reject' }).steps.length, 3, 'rejecting a removal keeps the step');
  assert.equal(mergeWithDecisions(old, nw, c2, { [rem.id]: 'accept' }).steps.length, 2);
});

test('change ids are stable across re-comparison', () => {
  assert.deepEqual(compareDocs(OLD, NEW).changes.map((c) => c.id), compareDocs(OLD, NEW).changes.map((c) => c.id));
});
