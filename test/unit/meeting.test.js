// Meeting helpers: picking the screenshot for a moment, and the Azure AI Speech request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nearestFrame, transcribeAudio } from '../../server/engine/meeting.js';

test('nearestFrame prefers the screenshot shown just after something was said', () => {
  const frames = [{ id: 'a', atMs: 1000 }, { id: 'b', atMs: 10_000 }, { id: 'c', atMs: 14_000 }];
  assert.equal(nearestFrame(frames, 9_000).id, 'b');
  assert.equal(nearestFrame(frames, 12_500).id, 'c', 'shortly after wins over shortly before');
  assert.equal(nearestFrame(frames, 500_000), null, 'nothing within 90 seconds');
});

test('transcribeAudio calls fast transcription with a managed identity token and maps the phrases', async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pda-stt-')), 'a.webm'); fs.writeFileSync(f, 'audio');
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ phrases: [{ offsetMilliseconds: 1200, durationMilliseconds: 800, speaker: 2, text: 'Hallo zusammen' }, { offsetMilliseconds: 3000, text: ' ' }] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  const out = await transcribeAudio({ cfg: { speech: { endpoint: 'https://pda-speech.cognitiveservices.azure.com/' } }, path: f, language: 'de', credential: { getToken: async (scope) => { assert.equal(scope, 'https://cognitiveservices.azure.com/.default'); return { token: 'T' }; } }, fetchImpl });
  assert.equal(seen.url, 'https://pda-speech.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15');
  assert.equal(seen.init.headers.authorization, 'Bearer T');
  assert.deepEqual(JSON.parse(seen.init.body.get('definition')).locales, ['de-DE', 'en-US']);
  assert.deepEqual(out, [{ ms: 1200, durationMs: 800, speaker: 2, text: 'Hallo zusammen' }]);
});
