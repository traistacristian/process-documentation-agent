import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, redactUrl, sanitizeEvent, isExcluded } from '../../server/engine/redact.js';
import { loadConfig } from '../../server/config.js';

const capture = loadConfig().capture;

test('secrets are removed from free text', () => {
  const t = redactText('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U and Bearer abcdefghijklmnop1234 key sk-ant-abcdefghijklmnopqrstuv AccountKey=abc123== card 4111 1111 1111 1111 mail john.doe@contoso.com');
  assert.doesNotMatch(t, /eyJhbGci|abcdefghijklmnop1234|sk-ant|abc123==|4111 1111|john\.doe/);
  assert.match(t, /\[REDACTED:JWT\]/);
  assert.match(t, /j\*\*\*@contoso\.com/);
});

test('sensitive URL parameters and credentials are redacted', () => {
  const u = redactUrl('https://user:pw@login.example.com/cb?code=SECRET123&state=xyz&page=2#access_token=abc');
  assert.doesNotMatch(u, /SECRET123|pw@|access_token=abc|xyz/);
  assert.match(u, /page=2/);
});

test('password fields never keep their value; free text is not kept by default; toggles are kept', () => {
  const pw = sanitizeEvent({ type: 'input', element: { label: 'New password', inputType: 'password' }, value: 'Hunter2!' }, capture);
  assert.equal(pw.value, '[REDACTED:SENSITIVE_FIELD]');
  const pin = sanitizeEvent({ type: 'input', element: { label: 'PIN', inputType: 'text' }, value: '1234' }, capture);
  assert.equal(pin.value, '[REDACTED:SENSITIVE_FIELD]');
  const name = sanitizeEvent({ type: 'input', element: { label: 'Display name', inputType: 'text' }, value: 'John' }, capture);
  assert.equal(name.value, '[VALUE_ENTERED]');
  const sel = sanitizeEvent({ type: 'change', element: { label: 'Permission level', inputType: 'select-one' }, value: 'Global reader' }, capture);
  assert.equal(sel.value, 'Global reader');
  const mfa = sanitizeEvent({ type: 'change', element: { label: 'Require MFA', inputType: 'checkbox' }, value: 'checked' }, capture);
  assert.equal(mfa.value, 'checked');
});

test('excluded applications and URLs are dropped', () => {
  assert.equal(sanitizeEvent({ type: 'click', app: 'KeePass', windowTitle: 'db.kdbx' }, capture), null);
  assert.equal(sanitizeEvent({ type: 'navigate', url: 'https://online.mybank.com/login' }, capture), null);
  assert.ok(isExcluded({ url: 'https://outlook.office.com/mail/inbox' }, capture));
  assert.ok(!isExcluded({ url: 'https://admin.microsoft.com/#/users' }, capture));
});
