import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWithRules } from '../../server/engine/generate-rules.js';
import { segmentEvents } from '../../server/engine/segment.js';
import { v1Events, SHOTS } from './helpers.js';

test('events are segmented into meaningful steps', () => {
  const segs = segmentEvents(v1Events());
  assert.equal(segs.length, 2);
});

test('rule engine writes instructions from evidence only and asks for the rest', () => {
  const { doc, clarifications } = generateWithRules({ meta: { title: 'Grant helpdesk permissions' }, events: v1Events(), screenshotsAvailable: SHOTS, user: { name: 'Alex' } });
  assert.equal(doc.steps.length, 2);
  const [s1, s2] = doc.steps;
  assert.equal(s1.title, 'Search Active users and open the entry');
  assert.deepEqual(s1.instructions, ['Open the "Active users" page (admin.contoso.example/portal).', 'Enter the required value in the "Search users" field and press Enter.', 'Select the relevant entry in the list.']);
  assert.equal(s2.title, 'Save in John Doe');
  assert.deepEqual(s2.instructions, ['Select "Helpdesk administrator" in "Permission level".', 'Click "Save".']);
  assert.equal(s2.expectedResult, 'The confirmation "Changes saved successfully" is displayed.');
  assert.ok(s1.screenshotIds.length && s2.screenshotIds.length);
  assert.ok(s1.evidenceEventSeqs.length > 0);
  assert.equal(doc.purpose, '', 'purpose is not invented');
  for (const sec of ['purpose', 'scope', 'prerequisites', 'roles']) assert.ok(clarifications.some((c) => c.section === sec), `asks about ${sec}`);
  assert.ok(clarifications.some((c) => /value or format/.test(c.question)), 'asks what to enter in the field whose value was not recorded');
});

test('paused periods are ignored', () => {
  const ev = v1Events();
  ev.splice(7, 0, { type: 'pause', ts: 0, seq: 100 }, { type: 'click', ts: 0, seq: 101, element: { role: 'button', name: 'Private thing' }, url: ev[6].url }, { type: 'resume', ts: 0, seq: 102 });
  const { doc } = generateWithRules({ meta: { title: 'x' }, events: ev, user: {} });
  assert.doesNotMatch(JSON.stringify(doc.steps), /Private thing/);
});

test('errors shown by the application become exceptions with a clarification', () => {
  const ev = v1Events();
  ev.push({ type: 'feedback', ts: Date.now(), seq: 50, url: ev[6].url, pageTitle: ev[6].pageTitle, text: 'Access denied', level: 'error' });
  const { doc, clarifications } = generateWithRules({ meta: { title: 'x' }, events: ev, user: {} });
  assert.match(doc.exceptions[0].problem, /Access denied/);
  assert.equal(doc.exceptions[0].handling, '');
  assert.ok(clarifications.some((c) => c.section === 'exceptions'));
});
