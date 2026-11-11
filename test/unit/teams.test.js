import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseVtt, threadFromJoinUrl, meetingIdFor, createTeamsGraph, teamsManifest, zipStore, teamsPackage } from '../../server/teams.js';

const cfg = { auth: { mode: 'entra', entra: { tenantId: 'tid', apiClientId: '11111111-2222-3333-4444-555555555555' } }, teams: { miClientId: 'mi-client' } };

test('parseVtt joins short cues of the same speaker and keeps times', () => {
  const vtt = 'WEBVTT\n\nabc/1-0\n00:00:01.000 --> 00:00:03.000\n<v Dana Lee>First we open</v>\n\nabc/2-0\n00:00:03.200 --> 00:00:05.000\n<v Dana Lee>the admin center.</v>\n\n00:01:02.500 --> 00:01:04.000\n<v Sam>Which role?</v>\n';
  const t = parseVtt(vtt);
  assert.equal(t.length, 2);
  assert.deepEqual(t[0], { ms: 1000, durationMs: 4000, speaker: 'Dana Lee', text: 'First we open the admin center.' });
  assert.equal(t[1].ms, 62500); assert.equal(t[1].speaker, 'Sam');
});

test('meeting ids come from the join link or the meeting chat', () => {
  const thread = '19:meeting_NjQ5@thread.v2';
  assert.equal(threadFromJoinUrl(`https://teams.microsoft.com/l/meetup-join/${encodeURIComponent(thread)}/0?context=%7b%7d`), thread);
  assert.equal(threadFromJoinUrl('https://example.com/x'), null);
  assert.equal(Buffer.from(meetingIdFor('oid-1', thread), 'base64').toString(), `1*oid-1*0**${thread}`);
});

test('Graph is called on behalf of the user with a keyless client assertion', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.includes('/oauth2/v2.0/token')) return new Response(JSON.stringify({ access_token: 'graph-token', expires_in: 3600 }), { status: 200 });
    if (url.includes('/me/onlineMeetings/') && url.includes('/transcripts/') && url.includes('/content')) return new Response('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v A>Hi</v>', { status: 200 });
    if (url.includes('/transcripts')) return new Response(JSON.stringify({ value: [{ id: 't1', createdDateTime: '2026-11-10T10:00:00Z' }] }), { status: 200 });
    if (url.includes('/me/onlineMeetings/')) return new Response(JSON.stringify({ error: { code: 'NotFound' } }), { status: 404 });
    if (url.includes('/me/onlineMeetings?$filter=')) return new Response(JSON.stringify({ value: [{ id: 'MSo-m1', subject: 'Onboarding walkthrough', startDateTime: '2026-11-10T09:00:00Z' }] }), { status: 200 });
    throw new Error(`unexpected ${url}`);
  };
  const g = createTeamsGraph(cfg, { fetchImpl, credential: { getToken: async (scope) => { assert.equal(scope, 'api://AzureADTokenExchange/.default'); return { token: 'mi-assertion' }; } } });
  const link = `https://teams.microsoft.com/l/meetup-join/${encodeURIComponent('19:meeting_x@thread.v2')}/0`;
  const m = await g.findMeeting('user-token', { joinUrl: link, userId: 'oid-1' });
  assert.equal(m.id, 'MSo-m1'); assert.equal(m.subject, 'Onboarding walkthrough');
  const tok = calls.filter((c) => c.url.includes('/token'));
  assert.equal(tok.length, 1, 'the on-behalf-of token is cached');
  const body = new URLSearchParams(tok[0].opts.body.toString());
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(body.get('assertion'), 'user-token');
  assert.equal(body.get('client_assertion'), 'mi-assertion');
  assert.equal(body.get('client_secret'), null, 'no secret');
  assert.match(body.get('scope'), /OnlineMeetingTranscript\.Read\.All/);
  assert.ok(!body.get('scope').includes('.default'), 'only the two delegated permissions are requested');
  assert.deepEqual((await g.transcripts('user-token', 'MSo-m1')).map((t) => t.id), ['t1']);
  assert.match(await g.content('user-token', 'MSo-m1', 't1'), /WEBVTT/);
  assert.ok(calls.every((c) => !c.url.includes('/users/') && !c.url.includes('getAllTranscripts')), 'only /me endpoints');
});

test('clear messages for missing consent and switched-off transcripts', async () => {
  const consent = createTeamsGraph(cfg, { fetchImpl: async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'AADSTS65001: The user or administrator has not consented' }), { status: 400 }), credential: { getToken: async () => ({ token: 'x' }) } });
  await assert.rejects(consent.transcripts('u', 'm'), { code: 'TEAMS_CONSENT' });
  const off = createTeamsGraph(cfg, { fetchImpl: async (url) => (url.includes('/token') ? new Response(JSON.stringify({ access_token: 'g' }), { status: 200 }) : new Response(JSON.stringify({ error: { code: 'Forbidden', innerError: { code: 'GraphAccessToTranscriptsDisabled' } } }), { status: 403 })), credential: { getToken: async () => ({ token: 'x' }) } });
  await assert.rejects(off.transcripts('u', 'm'), { code: 'GraphAccessToTranscriptsDisabled' });
});

test('the Teams app package is a valid zip with manifest and icons', async () => {
  const m = teamsManifest(cfg, 'pda.example.net');
  assert.equal(m.webApplicationInfo.resource, `api://pda.example.net/${cfg.auth.entra.apiClientId}`);
  assert.deepEqual(m.validDomains, ['pda.example.net']);
  assert.match(m.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(teamsManifest(cfg, 'pda.example.net').id, m.id, 'stable id');
  assert.ok(!m.authorization, 'no resource-specific application permissions');
  assert.ok(m.configurableTabs[0].context.includes('meetingSidePanel'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-zip-'));
  const f = path.join(dir, 'app.zip');
  fs.writeFileSync(f, await teamsPackage(cfg, 'pda.example.net'));
  const out = execFileSync('python3', ['-I', '-c', 'import sys,zipfile,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(",".join(z.namelist()));print(json.loads(z.read("manifest.json"))["name"]["short"])', f]).toString();
  assert.match(out, /manifest\.json,color\.png,outline\.png/);
  assert.match(out, /Process Docs/);
  assert.ok(zipStore([['a.txt', Buffer.from('a')]]).length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
