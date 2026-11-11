// Microsoft Teams: the app as a Teams app (personal tab + meeting tab, signed in with Teams SSO) and
// Teams meeting transcripts as a source for new or updated work instructions.
//
// Least privilege: transcripts are read with DELEGATED permissions on behalf of the signed-in person
// (on-behalf-of flow), so the app only sees the meetings that person may see. There is no tenant-wide
// application permission and no application access policy. The on-behalf-of exchange needs a credential
// for the API app registration; it is a federated identity credential that trusts the App Service's
// user-assigned managed identity, so no client secret exists anywhere.
//
// Graph (delegated, admin consent once, see scripts/Enable-TeamsApp.ps1):
//   OnlineMeetings.Read               find the meeting from its join link or the meeting chat
//   OnlineMeetingTranscript.Read.All  read that meeting's transcript (only meetings the person may read)
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { createClient } from './engine/generate-llm.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const err = (status, message, code) => Object.assign(new Error(message), { status, code });

export const teamsEnabled = (cfg) => cfg.auth.mode === 'entra' && !!cfg.teams?.miClientId;

// ------------------------------------------------------------------ Graph on behalf of the user
export function createTeamsGraph(cfg, { fetchImpl = globalThis.fetch, credential } = {}) {
  const tenant = cfg.auth.entra.tenantId; const clientId = cfg.auth.entra.apiClientId;
  const cache = new Map(); // sha256(user token) -> { token, exp }
  let mi = credential;

  async function assertion() {
    if (!mi) { const { ManagedIdentityCredential } = await import('@azure/identity'); mi = new ManagedIdentityCredential({ clientId: cfg.teams.miClientId }); }
    return (await mi.getToken('api://AzureADTokenExchange/.default')).token;
  }

  async function obo(userToken) {
    const key = crypto.createHash('sha256').update(userToken).digest('hex');
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now() + 60_000) return hit.token;
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', requested_token_use: 'on_behalf_of',
      client_id: clientId, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: await assertion(),
      assertion: userToken, scope: 'https://graph.microsoft.com/OnlineMeetings.Read https://graph.microsoft.com/OnlineMeetingTranscript.Read.All',
    });
    const res = await fetchImpl(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw explainSignIn(j);
    cache.set(key, { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return j.access_token;
  }

  async function call(userToken, path, { text = false } = {}) {
    const res = await fetchImpl(`${GRAPH}${path}`, { headers: { authorization: `Bearer ${await obo(userToken)}`, ...(text ? { accept: 'text/vtt' } : {}) } });
    if (res.ok) return text ? res.text() : res.json();
    const j = await res.json().catch(() => ({}));
    throw explainGraph(res.status, j?.error);
  }

  const one = async (userToken, id) => { try { return await call(userToken, `/me/onlineMeetings/${encodeURIComponent(id)}?$select=id,subject,startDateTime,endDateTime,joinWebUrl`); } catch (e) { if (e.status === 404 || e.status === 400) return null; throw e; } };

  return {
    // The meeting from a pasted join link, or from the meeting chat when the app runs in a Teams meeting.
    async findMeeting(userToken, { joinUrl, chatId, userId }) {
      let meeting = null;
      const thread = chatId || threadFromJoinUrl(joinUrl);
      if (thread && userId) meeting = await one(userToken, meetingIdFor(userId, thread));
      if (!meeting && joinUrl) {
        const r = await call(userToken, `/me/onlineMeetings?$filter=${encodeURIComponent(`JoinWebUrl eq '${String(joinUrl).trim().replace(/'/g, "''")}'`)}`);
        meeting = r.value?.[0] || null;
      }
      if (!meeting) throw err(404, 'This meeting was not found for your account. Transcripts can be imported by the meeting organiser (or a co-organiser). Check the link, or ask the organiser to import it.', 'MEETING_NOT_FOUND');
      return { id: meeting.id, subject: meeting.subject || '', startDateTime: meeting.startDateTime || null, endDateTime: meeting.endDateTime || null };
    },
    async transcripts(userToken, meetingId) {
      const r = await call(userToken, `/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`);
      return (r.value || []).map((t) => ({ id: t.id, createdDateTime: t.createdDateTime || null, endDateTime: t.endDateTime || null })).sort((a, b) => String(b.createdDateTime).localeCompare(String(a.createdDateTime)));
    },
    content: (userToken, meetingId, transcriptId) => call(userToken, `/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content?$format=text/vtt`, { text: true }),
  };
}

function explainSignIn(j) {
  const d = `${j.error || ''} ${j.error_description || ''}`;
  if (/AADSTS65001|consent/i.test(d)) return err(502, 'Microsoft has not been given consent for the Teams transcript permissions yet. An administrator runs scripts/Enable-TeamsApp.ps1 once.', 'TEAMS_CONSENT');
  if (/AADSTS700213|AADSTS70021|AADSTS700222|federated/i.test(d)) return err(502, 'The app cannot sign in to Microsoft Graph for Teams (the federated credential of the API app is missing or wrong). An administrator runs scripts/Enable-TeamsApp.ps1 again.', 'TEAMS_FIC');
  return err(502, `Microsoft sign-in for Teams failed: ${(j.error_description || j.error || 'no details').split('\r\n')[0]}`, 'TEAMS_SIGNIN');
}
function explainGraph(status, e = {}) {
  const code = e.innerError?.code || e.code || '';
  if (code === 'GraphAccessToTranscriptsDisabled') return err(403, 'Your Teams administrator has switched off access to meeting transcripts for apps (Teams admin center → Meetings → Meeting policies).', code);
  if (status === 401 || status === 403) return err(403, 'Microsoft Graph refused access to this meeting. Only the organiser or a co-organiser can import its transcript.', 'TEAMS_FORBIDDEN');
  if (status === 404) return err(404, 'The meeting or its transcript was not found. Transcription must have been switched on during the meeting.', 'NOT_FOUND');
  return err(status >= 500 ? 502 : 400, `Microsoft Graph: ${e.message || status}`, code);
}

// Join links look like https://teams.microsoft.com/l/meetup-join/19%3ameeting_…%40thread.v2/0?context=…
export function threadFromJoinUrl(url) {
  const m = /meetup-join\/([^/?#]+)/i.exec(String(url || ''));
  if (!m) return null;
  try { const t = decodeURIComponent(m[1]); return /^19:.+@thread\.(v2|skype|tacv2)$/i.test(t) ? t : null; } catch { return null; }
}
// The Graph id of a scheduled meeting encodes its organiser and its meeting chat.
export const meetingIdFor = (organizerId, threadId) => Buffer.from(`1*${organizerId}*0**${threadId}`).toString('base64');

// ------------------------------------------------------------------ transcript
// WebVTT from Teams: cues "00:01:02.345 --> 00:01:05.000" followed by "<v Speaker Name>text</v>".
export function parseVtt(vtt) {
  const out = [];
  const ts = (s) => { const p = s.trim().split(':').map(Number); const [h, m, sec] = p.length === 3 ? p : [0, ...p]; return Math.round(((h * 60 + m) * 60 + sec) * 1000); };
  for (const block of String(vtt || '').replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n').filter(Boolean);
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const raw = lines.slice(i + 1).join(' ');
    const v = /<v\s+([^>]*)>/.exec(raw);
    const text = raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const ms = ts(a); const end = ts(b.split(/\s/).filter(Boolean)[0] || a);
    const speaker = v ? v[1].trim() : null;
    const prev = out[out.length - 1];
    // Teams cuts long speeches into short cues; joining them gives the model whole sentences.
    if (prev && prev.speaker === speaker && ms - (prev.ms + prev.durationMs) < 1500 && prev.text.length < 600) { prev.text += ` ${text}`; prev.durationMs = end - prev.ms; continue; }
    out.push({ ms, durationMs: Math.max(0, end - ms), speaker, text });
  }
  return out;
}

// Spoken secrets ("the password is Summer2026!", "das Kennwort lautet …") are masked in the transcript.
export const maskSpokenSecrets = (text) => String(text).replace(/\b(password|passwort|kennwort|passcode|pin|secret|token|api key|key)(\s+(?:is|was|ist|lautet|war|=|:)\s*|\s*[:=]\s*)(["'“„]?)(\S+?)(["'”“]?)(?=[\s.,;!?]*(?:\s|$))/gi, (m, w, sep, q1, v, q2) => `${w}${sep}[REDACTED]`);

const mmss = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
export const transcriptText = (lines) => lines.map((p) => `[${mmss(p.ms)}]${p.speaker ? ` ${p.speaker}:` : ''} ${p.text}`).join('\n');

// ------------------------------------------------------------------ what the meeting means for the library
const Plan = z.object({
  summary: z.string(),
  items: z.array(z.object({
    action: z.enum(['update', 'new', 'topic']),
    processId: z.string().nullable(),
    title: z.string(),
    reason: z.string(),
    quote: z.string(),
    atSeconds: z.number(),
  })),
});

const PLAN_SYSTEM = `You read the transcript of a Microsoft Teams meeting in which colleagues talked about IT work, and the list of work instructions that already exist in the library. Decide what the meeting means for the documentation:
- action "update": the meeting explains, corrects or extends a process that already has a work instruction. Set processId to that document's id and title to its title. reason says in one sentence what the meeting adds or changes.
- action "new": the meeting explains a process in enough detail (several concrete steps) to write a first draft, and no existing document covers it. title is a short process name, verb first ("Reset a user's MFA method"). reason says in one sentence what was explained.
- action "topic": a subject came up that is unclear, disputed, known by only one person or not documented anywhere, but the meeting did not explain it well enough for a draft. title is a short process name, verb first; reason says why it should be documented.
For every item give quote (the words from the transcript it is based on, shortened if long) and atSeconds (when it was said).
summary: two or three sentences on what the meeting was about, for the participants.
Rules: only IT procedures and work instructions; ignore small talk, scheduling and personal matters. Never invent names, values or settings. Never include passwords or secrets. Prefer "update" over "new" when an existing document is about the same process. Write titles, reasons and the summary in the language of the meeting. Return an empty list when the meeting contains nothing to document.`;

export async function planFromTranscript({ cfg, transcript, library, subject, client }) {
  const lib = library.slice(0, 400).map((p) => ({ processId: p.processId, title: p.title, department: p.department || '', keywords: (p.keywords || []).slice(0, 8) }));
  const anthropic = client || (await createClient(cfg));
  const format = zodOutputFormat(Plan);
  const stream = anthropic.messages.stream({
    model: cfg.ai.model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: cfg.ai.effort, format: { type: format.type, schema: format.schema } },
    system: PLAN_SYSTEM,
    messages: [{ role: 'user', content: `<meeting subject="${String(subject || '').replace(/"/g, "'")}">\n</meeting>\n<library>\n${JSON.stringify(lib)}\n</library>\n<transcript>\n${transcriptText(transcript).slice(0, 400_000)}\n</transcript>\nWhat does this meeting mean for the documentation?` }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('The AI model declined to analyse this meeting.'), { code: 'AI_REFUSAL' });
  if (msg.stop_reason === 'max_tokens') throw Object.assign(new Error('The meeting analysis was cut off.'), { code: 'AI_TRUNCATED' });
  const out = format.parse(msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  const known = new Map(library.map((p) => [p.processId, p]));
  const items = out.items
    .map((x) => (x.action === 'update' && !known.has(x.processId) ? { ...x, action: 'new', processId: null } : x))
    .filter((x) => x.title.trim())
    .map((x) => ({ ...x, processId: x.action === 'update' ? x.processId : null, title: x.action === 'update' ? known.get(x.processId).title : x.title.trim().slice(0, 200) }));
  return { summary: out.summary, items };
}

// ------------------------------------------------------------------ Teams app package
// A stable app id per API app registration, so a re-uploaded package updates the same Teams app.
const stableGuid = (seed) => { const h = crypto.createHash('sha256').update(`pda-teams:${seed}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`; };

export function teamsManifest(cfg, host) {
  const base = `https://${host}`; const clientId = cfg.auth.entra.apiClientId;
  return {
    $schema: 'https://developer.microsoft.com/en-us/json-schemas/teams/v1.19/MicrosoftTeams.schema.json',
    manifestVersion: '1.19',
    version: cfg.teams?.appVersion || '1.0.0',
    id: stableGuid(clientId),
    developer: { name: cfg.teams?.developerName || 'Process Documentation Agent', websiteUrl: base, privacyUrl: `${base}/#/help`, termsOfUseUrl: `${base}/#/help` },
    name: { short: 'Process Docs', full: 'Process Documentation Agent' },
    description: {
      short: 'Turn Teams meetings and recordings into IT work instructions.',
      full: 'Record IT tasks, review and approve work instructions, and turn Teams meeting transcripts into new or updated process documents. Transcripts are read on your behalf: only meetings you organised.',
    },
    icons: { color: 'color.png', outline: 'outline.png' },
    accentColor: '#0B6E66',
    staticTabs: [
      { entityId: 'home', name: 'Home', contentUrl: `${base}/?inTeams=1#/`, websiteUrl: base, scopes: ['personal'] },
      { entityId: 'teams-import', name: 'From a meeting', contentUrl: `${base}/?inTeams=1#/teams`, websiteUrl: `${base}/#/teams`, scopes: ['personal'] },
    ],
    configurableTabs: [{ configurationUrl: `${base}/?inTeams=1#/teams/config`, canUpdateConfiguration: true, scopes: ['groupChat'], context: ['meetingSidePanel', 'meetingChatTab', 'meetingDetailsTab'] }],
    permissions: ['identity'],
    validDomains: [host],
    webApplicationInfo: { id: clientId, resource: `api://${host}/${clientId}` },
  };
}

const ICON = (size, outline) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">${outline ? '' : '<rect width="32" height="32" rx="6" fill="#0B6E66"/>'}<path d="M10 7h9l5 5v13H10z" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><path d="M13 16h7M13 20h7" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>`);

export async function teamsPackage(cfg, host) {
  const sharp = (await import('sharp')).default;
  const files = [
    ['manifest.json', Buffer.from(JSON.stringify(teamsManifest(cfg, host), null, 2))],
    ['color.png', await sharp(ICON(192, false)).png().toBuffer()],
    ['outline.png', await sharp(ICON(32, true)).png().toBuffer()],
  ];
  return zipStore(files);
}

// Minimal ZIP writer (stored entries), enough for a Teams app package.
export function zipStore(files) {
  const parts = []; const central = []; let offset = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name); const crc = zlib.crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    parts.push(local, n, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
