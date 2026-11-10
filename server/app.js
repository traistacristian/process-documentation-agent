// HTTP API of the Process Documentation Agent.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store, newId } from './store.js';
import { AuditLog } from './audit.js';
import { createAuth, ROLES } from './auth.js';
import { saveAdminSettings } from './config.js';
import { sanitizeEvent } from './engine/redact.js';
import { generateWithRules } from './engine/generate-rules.js';
import { generateWithClaude, aiAvailable, aiProvider } from './engine/generate-llm.js';
import { applyStepDescriptions, findDescription } from './engine/describe.js';
import { describeStepWithClaude, aiDescribeEnabled } from './engine/describe-ai.js';
import { protectScreenshot } from './engine/privacy.js';
import { attachTargets } from './engine/targets.js';
import { SearchIndex } from './search.js';
import { extractKeywords, normalizeKeywords } from './engine/keywords.js';
import { attachMarks, marksFor, cropFor, renderShot } from './engine/annotate.js';
import { locateMarks } from './engine/locate.js';
import { translateDoc, otherLanguages } from './engine/translate.js';
import { generateScript } from './engine/script.js';
import { generateFlow, flowToMarkdown } from './engine/flow.js';
import { compareDocs, mergeWithDecisions, pendingDecisions, similarity } from './engine/compare.js';
import { normalizeDoc } from './engine/schema.js';
import { sampleDocs } from './engine/samples.js';
import { createInviter } from './invite.js';
import { transcribeAudio, findMeetingSuggestions, nearestFrame, speechConfigured } from './engine/meeting.js';
import { applyAnswer } from './engine/clarify.js';
import { renderDocx, renderMarkdown } from './engine/render.js';
import { createRepository } from './repo/index.js';
import { applyRetention } from './retention.js';

const ACTIVE = ['recording', 'paused'];
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
// A name that is valid for SharePoint folders and files (no \ / : * ? " < > | # % or leading dots).
const cleanFileName = (n) => String(n || '').replace(/[\\/:*?"<>|#%\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120);
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

export function createApp(cfg, deps = {}) {
  const store = deps.store || new Store(cfg.dataDir);
  const audit = deps.audit || new AuditLog(cfg.dataDir);
  const repo = deps.repo || createRepository(cfg, deps.repoDeps);
  const searchIndex = deps.searchIndex || new SearchIndex({ repo, dataDir: cfg.dataDir, log: (what, msg) => audit.write(null, what, { error: msg }) });
  const { authenticate, requireRole } = createAuth(cfg);
  const generators = { rules: generateWithRules, claude: deps.generateWithClaude || generateWithClaude };
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind App Service / Front Door: honour X-Forwarded-Proto/For once
  app.use(express.json({ limit: '15mb' }));
  // Liveness/readiness for App Service health checks. No auth, no data.
  app.get('/healthz', (req, res) => {
    try { store.ping?.(); res.json({ ok: true }); } catch (e) { res.status(503).json({ ok: false, error: 'storage unavailable' }); }
  });
  app.use((req, res, next) => { res.set({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', ...(req.secure ? { 'strict-transport-security': 'max-age=31536000' } : {}) }); next(); });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const notify = async (event, payload) => {
    if (!cfg.notifications?.webhookUrl) return;
    try { await fetch(cfg.notifications.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event, ...payload }) }); } catch (e) { audit.write(null, 'webhook.failed', { event, error: e.message }); }
  };
  const isApprover = (u) => u.roles.includes(ROLES.APPROVER) || u.roles.includes(ROLES.ADMIN);
  const canSeeSession = (u, s) => s.createdBy.id === u.id || isApprover(u);
  // Deleting is limited to the person who created the item, or an Admin.
  const canDelete = (u, item) => item.createdBy?.id === u.id || u.roles.includes(ROLES.ADMIN);
  const shotsUsedByDrafts = (sessionId) => {
    const keep = new Set();
    for (const d of store.list('drafts')) if (d.sessionId === sessionId) for (const st of d.doc?.steps || []) for (const id of st.screenshotIds || []) keep.add(id);
    return keep;
  };
  // AI step descriptions are drafted in the background (one short call per finished step) and cached
  // on the session; the recorder's list polls and shows them as soon as they are ready.
  const describeStep = deps.describeStepWithClaude || describeStepWithClaude;
  const aiDescribing = new Set();
  const stepSignature = (st) => `${st.screenshotIds[0] || ''}|${st.evidenceEventSeqs.length}`;
  function queueAiDescription(sessionId, st, firstSeq, sig) {
    const key = `${sessionId}:${firstSeq}`;
    if (aiDescribing.has(key)) return true;
    if (aiDescribing.size >= 4) return true; // a few at a time; the rest are picked up on the next poll
    aiDescribing.add(key);
    const id = st.screenshotIds[0];
    const screenshot = id ? { path: store.screenshotPath(sessionId, id), mime: store.screenshotPath(sessionId, id).endsWith('.png') ? 'image/png' : 'image/jpeg' } : null;
    const remember = (entry) => {
      const cur = store.get('sessions', sessionId);
      if (!cur) return;
      cur.aiDescriptions = { ...(cur.aiDescriptions || {}), [firstSeq]: { sig, ...entry } };
      store.put('sessions', cur);
    };
    Promise.resolve()
      .then(() => (id ? shotReady(sessionId, id) : null))
      .then(() => describeStep({ cfg, step: st, screenshot, language: store.get('sessions', sessionId)?.meta?.language }))
      .then((text) => remember({ text }), (e) => { remember({ text: '', error: e.message }); audit.write(null, 'step.ai_describe_failed', { sessionId, error: e.message }); })
      .finally(() => aiDescribing.delete(key));
    return true;
  }
  const aiTexts = (sess) => Object.fromEntries(Object.entries(sess?.aiDescriptions || {}).filter(([, v]) => v?.text).map(([k, v]) => [k, v.text]));

  const engineName = () => (aiAvailable(cfg) ? `claude (${cfg.ai.model}${aiProvider(cfg) === 'foundry' ? ', Microsoft Foundry' : ''})` : 'rules');
  const publicSession = (s) => { const { captureTokenHash, ...rest } = s; return rest; };

  // ---------------------------------------------------------------- public config
  app.get('/api/config', (req, res) => {
    res.json({
      authMode: cfg.auth.mode,
      devUsers: cfg.auth.mode === 'dev' ? cfg.auth.devUsers : undefined,
      entra: cfg.auth.mode === 'entra' ? { tenantId: cfg.auth.entra.tenantId, clientId: cfg.auth.entra.spaClientId, scope: cfg.auth.entra.apiScope } : undefined,
      repository: { mode: cfg.repository.mode, label: repo.label },
      aiEngine: engineName(),
      meetings: meetingsAvailable(),
      categories: cfg.categories,
    });
  });

  // ---------------------------------------------------------------- capture clients (extension / desktop agent)
  const captureAuth = (req, res, next) => {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    const sid = req.get('x-session-id');
    const s = m && sid ? store.get('sessions', sid) : null;
    if (!s || !s.captureTokenHash || s.captureTokenHash !== hashToken(m[1])) return res.status(401).json({ error: 'Invalid capture token' });
    req.session = s; next();
  };

  app.post('/api/capture/pair', wrap(async (req, res) => {
    const code = String(req.body?.code || '').replace(/\D/g, '');
    const s = store.list('sessions').find((x) => x.pairing?.code === code && ACTIVE.includes(x.status) && x.pairing.expiresAt > Date.now());
    if (!s) return res.status(404).json({ error: 'No active recording with this pairing code' });
    const token = crypto.randomBytes(32).toString('base64url');
    s.captureTokenHash = hashToken(token);
    const client = { type: String(req.body?.client?.type || 'unknown').slice(0, 30), version: String(req.body?.client?.version || '').slice(0, 20), host: String(req.body?.client?.host || '').slice(0, 80), pairedAt: Date.now() };
    s.clients = [...(s.clients || []).filter((c) => c.type !== client.type), client];
    store.put('sessions', s);
    audit.write(s.createdBy, 'capture.paired', { sessionId: s.id, client });
    res.json({ sessionId: s.id, captureToken: token, title: s.meta.title, status: s.status, policy: cfg.capture });
  }));

  app.get('/api/capture/state', captureAuth, (req, res) => res.json({ sessionId: req.session.id, status: req.session.status, title: req.session.meta.title, policy: cfg.capture }));

  function ingestEvents(s, rawEvents, source) {
    if (!Array.isArray(rawEvents)) throw httpError(400, 'events must be an array');
    if (!ACTIVE.includes(s.status)) return { accepted: 0, dropped: rawEvents.length, status: s.status };
    const seen = new Set(s.seenClientIds || []);
    const accepted = []; let dropped = 0;
    for (const raw of rawEvents.slice(0, 500)) {
      if (raw?.clientId && seen.has(raw.clientId)) continue; // idempotent retry from a client
      if (s.status === 'paused' && !['note', 'mark', 'resume'].includes(raw?.type)) { dropped++; continue; }
      const ev = sanitizeEvent({ ...raw, source: source || raw.source }, cfg.capture);
      if (!ev) { dropped++; continue; }
      if (ev.screenshotId && !store.screenshotPath(s.id, ev.screenshotId)) delete ev.screenshotId;
      if (raw.clientId) seen.add(raw.clientId);
      accepted.push(ev);
    }
    const stored = accepted.length ? store.appendEvents(s.id, accepted) : [];
    s.eventCount = (s.eventCount || 0) + stored.length;
    s.lastEventAt = Date.now();
    const lastCtx = [...stored].reverse().find((e) => e.app || e.url || e.windowTitle);
    if (lastCtx) s.currentApplication = { app: lastCtx.app, windowTitle: lastCtx.windowTitle, url: lastCtx.url, pageTitle: lastCtx.pageTitle, source: lastCtx.source };
    s.seenClientIds = [...seen].slice(-5000);
    store.put('sessions', s);
    return { accepted: stored.length, dropped, status: s.status };
  }

  function saveShot(s, body) {
    if (!ACTIVE.includes(s.status)) throw httpError(409, `Recording is ${s.status}`);
    if (store.listScreenshots(s.id).length >= cfg.capture.maxScreenshotsPerSession) throw httpError(429, 'Screenshot limit for this session reached');
    const m = /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(body?.data || '');
    if (!m) throw httpError(400, 'Expected a data URL with a JPEG or PNG image');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 8 * 1024 * 1024) throw httpError(413, 'Screenshot too large');
    const saved = store.saveScreenshot(s.id, buf, m[1]);
    protectShot(s.id, saved.id);
    return saved;
  }

  // GDPR: personal data in each screenshot is pixelated before anyone sees it (Claude finds it).
  // Viewing, describing and generating wait for the check of a screenshot to finish.
  const protectFn = deps.protectScreenshot || protectScreenshot;
  const translate = deps.translateDoc || translateDoc;
  const draftScript = deps.generateScript || generateScript;
  const draftFlow = deps.generateFlow || generateFlow;
  const inviter = createInviter(cfg, { graph: deps.inviteGraph });
  const transcribe = deps.transcribeAudio || transcribeAudio;
  const meetingAnalyse = deps.findMeetingSuggestions || findMeetingSuggestions;
  const meetingsAvailable = () => (!!deps.transcribeAudio || speechConfigured(cfg)) && (!!deps.findMeetingSuggestions || aiAvailable(cfg));
  const scriptCache = new Map(); // processId@version -> script (each draft costs an AI call)
  const privacyJobs = new Map();
  const blurEnabled = () => cfg.capture.blurPersonalData !== false && aiAvailable(cfg);
  function protectShot(sessionId, shotId) {
    if (!blurEnabled()) return;
    const key = `${sessionId}:${shotId}`;
    const job = Promise.resolve()
      .then(() => protectFn({ cfg, path: store.screenshotPath(sessionId, shotId) }))
      .then((r) => { if (r.count) audit.write(null, 'screenshot.personal_data_blurred', { sessionId, shotId, areas: r.count, kinds: r.kinds }); },
        (e) => audit.write(null, 'screenshot.privacy_check_failed', { sessionId, shotId, error: e.message }))
      .finally(() => privacyJobs.delete(key));
    privacyJobs.set(key, job);
  }
  const shotReady = (sessionId, shotId) => privacyJobs.get(`${sessionId}:${shotId}`) || null;
  const sessionShotsReady = (sessionId, timeoutMs = 120000) => Promise.race([
    Promise.all([...privacyJobs].filter(([k]) => k.startsWith(`${sessionId}:`)).map(([, p]) => p)),
    new Promise((r) => setTimeout(r, timeoutMs).unref()),
  ]);

  app.post('/api/capture/events', captureAuth, wrap(async (req, res) => res.json(ingestEvents(req.session, req.body?.events, req.body?.source))));
  app.post('/api/capture/screenshots', captureAuth, wrap(async (req, res) => res.json(saveShot(req.session, req.body))));

  // ---------------------------------------------------------------- everything below requires a signed-in user
  app.use('/api', authenticate);
  app.get('/api/me', (req, res) => res.json(req.user));

  // ---------------------------------------------------------------- repository
  app.get('/api/repository/status', wrap(async (req, res) => res.json(await repo.status())));
  // Search: the full-text index over every published process (falls back to the plain listing filter
  // when the index cannot be refreshed, e.g. SharePoint is briefly unreachable and nothing is cached).
  app.get('/api/processes', wrap(async (req, res) => {
    const q = String(req.query.q || '').slice(0, 200);
    try { await searchIndex.refresh(); } catch (e) { if (!searchIndex.list().length) return res.json(await repo.search(q)); }
    res.json(searchIndex.search(q));
  }));
  app.get('/api/processes/keywords', wrap(async (req, res) => {
    try { await searchIndex.refresh(); } catch { /* serve what is indexed */ }
    res.json(searchIndex.keywords());
  }));
  app.get('/api/processes/duplicates', wrap(async (req, res) => {
    const title = String(req.query.title || '');
    const all = await repo.list();
    res.json(all.map((p) => ({ ...p, score: similarity({ title }, { title: p.title }) })).filter((p) => p.score >= 0.6).sort((a, b) => b.score - a.score).slice(0, 5));
  }));
  app.get('/api/processes/:pid', wrap(async (req, res) => {
    const language = /^[a-z]{2}$/.test(req.query.lang || '') ? req.query.lang : undefined;
    const p = (language && await repo.get(req.params.pid, { language })) || await repo.get(req.params.pid);
    if (!p) return res.status(404).json({ error: 'Process not found' });
    res.json(p);
  }));
  // Recording to script: a PowerShell draft of a published procedure, for an admin to review.
  // Recording to automation: a PowerShell script or a Power Automate flow drafted from a published
  // procedure, for an admin or maker to review. Nothing is run or created in the tenant.
  const automations = { script: { make: (doc) => draftScript({ cfg, doc }), what: 'script' }, flow: { make: (doc) => draftFlow({ cfg, doc }).then((f) => ({ ...f, markdown: flowToMarkdown(f) })), what: 'Power Automate flow' } };
  for (const kind of Object.keys(automations)) app.post(`/api/processes/:pid/${kind}`, requireRole(ROLES.CONTRIBUTOR), wrap(async (req, res) => {
    const a = automations[kind];
    if (!aiAvailable(cfg)) throw httpError(409, `The ${a.what} is drafted by the AI, which is not configured.`);
    const p = await repo.get(req.params.pid);
    if (!p) throw httpError(404, 'Process not found');
    const key = `${kind}:${p.doc.info.processId}@${p.doc.info.version}`;
    if (!req.body?.regenerate && scriptCache.has(key)) return res.json(scriptCache.get(key));
    const out = await a.make(normalizeDoc(p.doc)).catch((e) => { throw httpError(502, `The ${a.what} could not be drafted: ${e.message}`); });
    scriptCache.set(key, out);
    audit.write(req.user, `process.${kind}_drafted`, { processId: key, automatable: out.automatable });
    res.json(out);
  }));
  // Published screenshots are shown with the step's numbered click markers (?raw=1: without).
  const publishedDocs = new Map(); // processId -> { at, doc }: avoids reading process.json for every image
  const publishedDoc = async (pid) => {
    const hit = publishedDocs.get(pid);
    if (hit && Date.now() - hit.at < 60_000) return hit.doc;
    const doc = (await repo.get(pid).catch(() => null))?.doc || null;
    publishedDocs.set(pid, { at: Date.now(), doc });
    if (publishedDocs.size > 200) publishedDocs.delete(publishedDocs.keys().next().value);
    return doc;
  };
  app.get('/api/processes/:pid/screenshots/:shot', wrap(async (req, res) => {
    const s = await repo.screenshot(req.params.pid, req.params.shot);
    if (!s) return res.status(404).end();
    const pdoc = req.query.raw ? null : await publishedDoc(req.params.pid);
    const marks = marksFor(pdoc, req.params.shot); const crop = cropFor(pdoc, req.params.shot);
    res.type(s.mime).send(marks.length || crop ? await renderShot(s.buffer, marks, crop) : s.buffer);
  }));
  app.get('/api/repository/processes/:pid/:file', wrap(async (req, res) => {
    const buf = await repo.file(req.params.pid, req.params.file);
    if (!buf) return res.status(404).end();
    if (req.params.file.endsWith('.docx')) res.attachment(`${req.params.pid}.docx`);
    res.type(path.extname(req.params.file)).send(buf);
  }));

  // ---------------------------------------------------------------- recording sessions
  app.post('/api/sessions', requireRole(ROLES.CONTRIBUTOR), wrap(async (req, res) => {
    const b = req.body || {};
    const mode = b.mode === 'update' ? 'update' : 'new';
    let baseRef = null; let meta;
    if (mode === 'update') {
      const p = await repo.get(String(b.processId || ''));
      if (!p) throw httpError(404, 'Process not found in the repository');
      baseRef = { processId: p.doc.info.processId, version: p.doc.info.version, etag: p.etag, doc: p.doc };
      meta = { title: p.doc.info.title, description: '', department: p.doc.info.department, owner: p.doc.info.owner, category: p.doc.info.category, language: p.doc.info.language || 'en' };
    } else {
      const title = String(b.title || '').trim();
      if (!title) throw httpError(400, 'Process title is required');
      if (!cleanFileName(title)) throw httpError(400, 'The process name must contain letters or digits');
      meta = { title: title.slice(0, 200), description: String(b.description || '').slice(0, 2000), department: String(b.department || '').slice(0, 200), owner: String(b.owner || '').slice(0, 200), category: cfg.categories.includes(b.category) ? b.category : (b.category ? String(b.category).slice(0, 100) : ''), language: b.language === 'de' ? 'de' : 'en', fileName: cleanFileName(b.fileName || title) };
    }
    const s = {
      id: newId('ses'), mode, meta, baseRef, status: 'recording', createdBy: { id: req.user.id, name: req.user.name },
      startedAt: Date.now(), stoppedAt: null, pausedMs: 0, pausedAt: null, eventCount: 0, clients: [],
      pairing: { code: String(crypto.randomInt(100000, 999999)), expiresAt: Date.now() + 8 * 3600_000 },
      consent: { acceptedAt: b.consent ? Date.now() : null, text: 'Recording captures application names, page titles, the names of clicked elements and screenshots while recording is active. Passwords and sensitive fields are never captured.' },
    };
    if (!b.consent) throw httpError(400, 'Explicit consent is required before recording can start');
    store.put('sessions', s);
    store.appendEvents(s.id, [{ type: 'start', ts: Date.now(), source: 'user' }]);
    audit.write(req.user, 'session.started', { sessionId: s.id, mode, title: meta.title, processId: baseRef?.processId });
    res.status(201).json(publicSession(s));
  }));

  app.get('/api/sessions', wrap(async (req, res) => {
    const all = store.list('sessions').filter((s) => canSeeSession(req.user, s)).sort((a, b) => b.startedAt - a.startedAt);
    res.json(all.map((s) => { const { baseRef, ...r } = publicSession(s); return { ...r, baseRef: baseRef ? { processId: baseRef.processId, version: baseRef.version } : null }; }));
  }));

  const loadSession = (req) => {
    const s = store.get('sessions', req.params.id);
    if (!s || !canSeeSession(req.user, s)) throw httpError(404, 'Recording not found');
    return s;
  };

  app.get('/api/sessions/:id', wrap(async (req, res) => {
    const s = loadSession(req);
    const events = store.readEvents(s.id);
    res.json({ ...publicSession(s), recentEvents: events.slice(-30).reverse(), screenshotCount: store.listScreenshots(s.id).length });
  }));

  // Live list of the steps recognised so far, with the author's own description of each.
  app.get('/api/sessions/:id/steps', wrap(async (req, res) => {
    const s = loadSession(req);
    const shots = new Set(store.listScreenshots(s.id));
    const { doc } = generateWithRules({ meta: s.meta, events: store.readEvents(s.id), screenshotsAvailable: shots, base: null, user: req.user });
    const ai = s.aiDescriptions || {};
    const live = s.status === 'recording' || s.status === 'paused';
    const describe = aiDescribeEnabled(cfg) && s.status !== 'generated';
    const out = doc.steps.map((st, i) => {
      const firstSeq = st.evidenceEventSeqs[0] ?? null;
      const description = findDescription(st, s.stepDescriptions);
      const rules = [...st.instructions, st.expectedResult].filter(Boolean).join(' ');
      const sig = stepSignature(st);
      // While recording, the last step may still grow: it is described once it is finished.
      const settled = !live || i < doc.steps.length - 1;
      const cached = firstSeq != null ? ai[firstSeq] : null;
      const aiText = cached?.sig === sig ? cached.text : '';
      let aiPending = false;
      if (describe && settled && !description && firstSeq != null && !aiText && cached?.sig !== sig) aiPending = queueAiDescription(s.id, st, firstSeq, sig);
      return { key: st.evidenceEventSeqs[st.evidenceEventSeqs.length - 1] ?? null, firstSeq, number: st.number, title: st.title, screenshotId: st.screenshotIds[0] || null, description, suggested: aiText || rules, suggestedBy: aiText ? 'ai' : rules ? 'rules' : null, aiPending, screenOnly: /^Screen \d+ \(describe the action\)$/.test(st.title) };
    });
    res.json(out);
  }));
  app.put('/api/sessions/:id/step-descriptions', wrap(async (req, res) => {
    const s = loadSession(req);
    if (s.createdBy.id !== req.user.id) throw httpError(403, 'Only the person recording can describe the steps');
    const seq = Number(req.body?.seq); const text = String(req.body?.text ?? '').slice(0, 2000);
    if (!Number.isInteger(seq) || seq < 1) throw httpError(400, 'seq is required');
    const cur = store.get('sessions', s.id);
    cur.stepDescriptions = { ...(cur.stepDescriptions || {}) };
    // One description per step: drop older entries that belong to the same step.
    const { doc } = generateWithRules({ meta: s.meta, events: store.readEvents(s.id), screenshotsAvailable: new Set(), base: null, user: req.user });
    const same = new Set(doc.steps.find((st) => st.evidenceEventSeqs.includes(seq))?.evidenceEventSeqs || []);
    for (const k of Object.keys(cur.stepDescriptions)) if (Number(k) !== seq && same.has(Number(k))) delete cur.stepDescriptions[k];
    if (text.trim()) cur.stepDescriptions[seq] = text; else delete cur.stepDescriptions[seq];
    store.put('sessions', cur);
    res.json({ ok: true });
  }));

  app.delete('/api/sessions/:id', wrap(async (req, res) => {
    const s = loadSession(req);
    if (!canDelete(req.user, s)) throw httpError(403, 'Only the person who recorded it or an Admin can delete this recording');
    if (['recording', 'paused'].includes(s.status)) throw httpError(409, 'Stop the recording before deleting it');
    store.removeSession(s.id, shotsUsedByDrafts(s.id));
    audit.write(req.user, 'session.deleted', { sessionId: s.id, title: s.meta.title });
    res.json({ ok: true });
  }));

  app.post('/api/sessions/:id/control', wrap(async (req, res) => {
    const s = loadSession(req);
    const action = req.body?.action;
    const now = Date.now();
    if (action === 'pause' && s.status === 'recording') { s.status = 'paused'; s.pausedAt = now; }
    else if (action === 'resume' && s.status === 'paused') { s.status = 'recording'; s.pausedMs += now - s.pausedAt; s.pausedAt = null; }
    else if (action === 'stop' && ACTIVE.includes(s.status)) { if (s.pausedAt) s.pausedMs += now - s.pausedAt; s.status = 'stopped'; s.stoppedAt = now; s.pausedAt = null; s.captureTokenHash = null; }
    else if (action === 'resume' && s.status === 'stopped' && !s.draftId) { s.status = 'recording'; s.stoppedAt = null; } // continue an interrupted / stopped recording
    else if (action === 'discard' && !s.draftId) { s.status = 'discarded'; s.captureTokenHash = null; store.purgeRawCapture(s.id); }
    else throw httpError(409, `Cannot ${action} a recording that is ${s.status}`);
    store.put('sessions', s);
    if (['pause', 'resume', 'stop'].includes(action)) store.appendEvents(s.id, [{ type: action, ts: now, source: 'user' }]);
    audit.write(req.user, `session.${action}`, { sessionId: s.id });
    res.json(publicSession(s));
  }));

  app.post('/api/sessions/:id/notes', wrap(async (req, res) => {
    const s = loadSession(req);
    const kind = req.body?.kind === 'mark' ? 'mark' : 'note';
    const ev = { type: kind, ts: Date.now(), text: String(req.body?.text || '').slice(0, 1000), screenshotId: req.body?.screenshotId };
    res.json(ingestEvents(s, [ev], 'user'));
  }));
  app.post('/api/sessions/:id/events', wrap(async (req, res) => res.json(ingestEvents(loadSession(req), req.body?.events, 'web'))));
  app.post('/api/sessions/:id/screenshots', wrap(async (req, res) => res.json(saveShot(loadSession(req), req.body))));
  app.get('/api/sessions/:id/screenshots/:shot', wrap(async (req, res) => {
    const s = loadSession(req);
    await shotReady(s.id, req.params.shot);
    const p = store.screenshotPath(s.id, req.params.shot);
    if (!p) return res.status(404).end();
    res.sendFile(p);
  }));

  // Starts documentation generation. Runs in the background; the draft shows status "generating".
  app.post('/api/sessions/:id/generate', wrap(async (req, res) => {
    const s = loadSession(req);
    if (ACTIVE.includes(s.status)) throw httpError(409, 'Stop the recording before generating documentation');
    if (s.draftId) { const d = store.get('drafts', s.draftId); if (d && d.status !== 'failed') return res.json(d); }
    const events = store.readEvents(s.id);
    if (!events.some((e) => !['start', 'stop', 'pause', 'resume'].includes(e.type))) throw httpError(422, 'Nothing was captured during this recording. Check that the browser extension or desktop agent was connected.');
    const draft = {
      id: newId('drf'), sessionId: s.id, mode: s.mode, status: 'generating', engine: null, createdBy: s.createdBy, createdAt: Date.now(), updatedAt: Date.now(),
      baseRef: s.baseRef ? { processId: s.baseRef.processId, version: s.baseRef.version, etag: s.baseRef.etag } : null,
      baseDoc: s.baseRef?.doc || null, doc: null, clarifications: [], suggestions: [], comparison: null, decisions: {}, history: [],
    };
    store.put('drafts', draft);
    s.draftId = draft.id; s.status = 'generated'; store.put('sessions', s);
    res.status(202).json(draft);
    runGeneration(draft.id, s, events, req.user, req.body?.engine).catch(() => {});
  }));

  async function runGeneration(draftId, s, events, user, requested) {
    await sessionShotsReady(s.id);
    const draft = store.get('drafts', draftId);
    const shots = store.listScreenshots(s.id).map((id) => ({ id, path: store.screenshotPath(s.id, id), mime: store.screenshotPath(s.id, id).endsWith('.png') ? 'image/png' : 'image/jpeg' }));
    const input = { cfg, meta: s.meta, events, screenshots: shots, screenshotsAvailable: new Set(shots.map((x) => x.id)), base: s.baseRef?.doc || null, user };
    let result;
    try {
      const useAi = requested !== 'rules' && aiAvailable(cfg);
      try {
        result = useAi ? await generators.claude(input) : generators.rules(input);
      } catch (e) {
        if (!useAi) throw e;
        audit.write(user, 'draft.ai_failed', { draftId, error: e.message });
        result = generators.rules(input);
        result.suggestions = [`The AI engine was unavailable (${e.message}); this draft was produced by the rule-based engine.`, ...result.suggestions];
      }
      // The recorder's own corrections win over the AI's draft descriptions.
      const latest = store.get('sessions', s.id) || s;
      applyStepDescriptions(result, latest.stepDescriptions, aiTexts(latest));
      const doc = result.doc;
      doc.info.language = s.meta.language === 'de' ? 'de' : 'en';
      doc.info.fileName = s.meta.fileName || s.baseRef?.doc?.info?.fileName || '';
      attachTargets(doc, events);
      attachMarks(doc, events);
      await locateMissingMarks(doc, s.id, user);
      if (s.mode === 'new') {
        doc.info.processId = `PRC-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        doc.info.version = '0.1'; doc.info.createdAt = new Date().toISOString();
      } else {
        doc.info.processId = s.baseRef.processId;
        doc.info.createdAt = s.baseRef.doc.info.createdAt;
        doc.changeHistory = s.baseRef.doc.changeHistory;
        draft.comparison = compareDocs(s.baseRef.doc, doc);
      }
      Object.assign(draft, { doc, clarifications: result.clarifications, suggestions: result.suggestions, engine: result.engine, status: 'draft', updatedAt: Date.now() });
      store.put('drafts', draft);
      audit.write(user, 'draft.generated', { draftId, engine: result.engine, steps: doc.steps.length, clarifications: result.clarifications.length });
    } catch (e) {
      Object.assign(draft, { status: 'failed', error: e.message, updatedAt: Date.now() });
      store.put('drafts', draft);
      audit.write(user, 'draft.failed', { draftId, error: e.message });
    }
  }

  // Steps whose click positions were not recorded (screen sharing, desktop agent, older add-in): Claude
  // proposes the markers from the screenshot and the instructions. A few at a time, at most 45 seconds
  // in total; whatever is not ready by then is simply left without markers.
  const locate = deps.locateMarks || locateMarks;
  async function locateMissingMarks(doc, sessionId, user) {
    if (!aiAvailable(cfg) || cfg.ai.locateMarks === false) return;
    const todo = doc.steps.filter((st) => !st.marks?.length && st.screenshotIds.length && st.instructions.length).slice(0, 25);
    if (!todo.length) return;
    const deadline = Date.now() + 45_000;
    const run = async (st) => {
      const shotId = st.screenshotIds[0]; const p = store.screenshotPath(sessionId, shotId);
      if (!p || Date.now() > deadline) return;
      try {
        await shotReady(sessionId, shotId);
        const marks = await locate({ cfg, buffer: fs.readFileSync(p), instructions: st.instructions });
        if (Date.now() <= deadline + 15_000) st.marks = marks.map((m) => ({ ...m, shotId }));
      } catch (e) { audit.write(user, 'step.locate_marks_failed', { sessionId, error: e.message }); }
    };
    const queue = [...todo];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => { while (queue.length) await run(queue.shift()); }));
  }

  // ---------------------------------------------------------------- drafts / review / approval / publishing
  const loadDraft = (req) => {
    const d = store.get('drafts', req.params.id);
    if (!d || !(d.createdBy.id === req.user.id || isApprover(req.user))) throw httpError(404, 'Draft not found');
    return d;
  };
  const draftView = (d) => {
    const view = { ...d, meetings: (d.meetings || []).map((m) => { const { transcript, ...rest } = m; return { ...rest, transcriptLines: transcript?.length || 0 }; }), pending: d.comparison ? pendingDecisions(d.comparison, d.decisions) : [] };
    if (d.doc && d.baseDoc && d.comparison) view.mergedDoc = mergeWithDecisions(d.baseDoc, d.doc, d.comparison, d.decisions);
    view.blockers = approvalBlockers(d);
    return view;
  };
  function approvalBlockers(d) {
    const b = [];
    if (!d.doc) return ['Documentation has not been generated yet.'];
    const open = d.clarifications.filter((c) => c.status === 'open').length;
    if (open) b.push(`${open} clarification request(s) are still open. Answer them or mark them as not applicable.`);
    if (!d.doc.info.title) b.push('The process title is missing.');
    if (!d.doc.steps.length) b.push('The document has no steps.');
    const unsupported = d.doc.steps.filter((s) => s.warnings.some((w) => w.startsWith('Not supported by captured evidence'))).length;
    if (unsupported) b.push(`${unsupported} step(s) are not supported by captured evidence. Confirm them (remove the warning) or delete them.`);
    if (d.comparison) { const p = pendingDecisions(d.comparison, d.decisions).length; if (p) b.push(`${p} change(s) still need an accept or reject decision.`); }
    return b;
  }

  app.get('/api/drafts', wrap(async (req, res) => {
    const all = store.list('drafts').filter((d) => d.createdBy.id === req.user.id || isApprover(req.user)).sort((a, b) => b.updatedAt - a.updatedAt);
    res.json(all.map((d) => ({ id: d.id, mode: d.mode, status: d.status, title: d.doc?.info.title || store.get('sessions', d.sessionId)?.meta.title, processId: d.doc?.info.processId || d.baseRef?.processId, createdBy: d.createdBy, updatedAt: d.updatedAt, engine: d.engine, openClarifications: d.clarifications.filter((c) => c.status === 'open').length })));
  }));
  app.get('/api/drafts/:id', wrap(async (req, res) => res.json(draftView(loadDraft(req)))));

  app.delete('/api/drafts/:id', wrap(async (req, res) => {
    const d = loadDraft(req);
    if (!canDelete(req.user, d)) throw httpError(403, 'Only the person who created it or an Admin can delete this draft');
    if (['generating', 'publishing'].includes(d.status)) throw httpError(409, 'Wait until the draft has finished generating or publishing');
    store.remove('drafts', d.id);
    const s = store.get('sessions', d.sessionId);
    if (s && s.draftId === d.id) { s.draftId = null; store.put('sessions', s); }
    // Screenshots only this draft still used go when the recording itself is already gone.
    if (!s) { const keep = shotsUsedByDrafts(d.sessionId); for (const id of store.listScreenshots(d.sessionId)) if (!keep.has(id)) store.deleteScreenshot(d.sessionId, id); }
    audit.write(req.user, 'draft.deleted', { draftId: d.id, sessionId: d.sessionId, status: d.status, title: d.doc?.info.title });
    res.json({ ok: true });
  }));

  // Proposes click markers for one screenshot (used by the screenshot editor's "Suggest with AI").
  app.post('/api/drafts/:id/locate-marks', wrap(async (req, res) => {
    const d = loadDraft(req);
    if (!aiAvailable(cfg)) throw httpError(400, 'Suggesting markers needs the AI engine. Add them by clicking on the screenshot instead.');
    const shotId = String(req.body?.shotId || '');
    const instructions = (Array.isArray(req.body?.instructions) ? req.body.instructions : []).map((x) => String(x).slice(0, 500)).slice(0, 15);
    await shotReady(d.sessionId, shotId);
    const p = store.screenshotPath(d.sessionId, shotId);
    const got = p ? { buffer: fs.readFileSync(p) } : d.baseRef ? await repo.screenshot(d.baseRef.processId, shotId) : null;
    if (!got) throw httpError(404, 'Screenshot not found');
    const marks = await locate({ cfg, buffer: got.buffer, instructions }).catch((e) => { throw httpError(502, `The AI could not place the markers: ${e.message}`); });
    audit.write(req.user, 'draft.marks_suggested', { draftId: d.id, shotId, count: marks.length });
    res.json(marks.map((m) => ({ ...m, shotId })));
  }));

  app.put('/api/drafts/:id', wrap(async (req, res) => {
    const d = loadDraft(req);
    if (!['draft', 'rejected'].includes(d.status)) throw httpError(409, `A draft that is ${d.status} cannot be edited`);
    const b = req.body || {};
    if (b.baseUpdatedAt && b.baseUpdatedAt !== d.updatedAt) throw httpError(409, 'This draft was changed by someone else. Reload it before saving.', 'CONFLICT');
    if (b.doc) {
      let doc;
      try { doc = normalizeDoc(b.doc); } catch (e) {
        const where = e.issues?.[0]?.path?.join(' → ') || 'a field';
        throw httpError(400, `The draft could not be saved: ${where} is not valid. Reload the page and try again.`);
      }
      doc.info.processId = d.doc.info.processId; doc.info.version = d.doc.info.version; doc.info.createdAt = d.doc.info.createdAt; doc.changeHistory = d.doc.changeHistory;
      d.doc = doc;
      if (d.baseDoc) d.comparison = compareDocs(d.baseDoc, d.doc);
    }
    if (Array.isArray(b.clarifications)) {
      for (const upd of b.clarifications) {
        const c = d.clarifications.find((x) => x.id === upd.id);
        if (!c || c.status !== 'open') continue;
        if (upd.status === 'answered' && upd.answer?.trim()) { c.answer = upd.answer.trim(); c.status = 'answered'; applyAnswer(d.doc, c, c.answer); }
        if (upd.status === 'dismissed') { c.status = 'dismissed'; c.answer = upd.answer || ''; }
      }
      if (d.baseDoc) d.comparison = compareDocs(d.baseDoc, d.doc);
    }
    if (b.decisions && typeof b.decisions === 'object') for (const [k, v] of Object.entries(b.decisions)) if (['accept', 'reject', null].includes(v)) { if (v) d.decisions[k] = v; else delete d.decisions[k]; }
    if (d.status === 'rejected') d.status = 'draft';
    d.updatedAt = Date.now();
    d.history.push({ ts: Date.now(), user: req.user.name, action: 'saved' });
    store.put('drafts', d);
    audit.write(req.user, 'draft.saved', { draftId: d.id });
    res.json(draftView(d));
  }));

  // ---------------------------------------------------------------- meetings that fill a draft's gaps
  const meetingDir = path.join(cfg.dataDir, 'meetings'); fs.mkdirSync(meetingDir, { recursive: true });
  const audioPath = (mid) => path.join(meetingDir, `${mid}.webm`);
  const loadMeeting = (req, d) => {
    const m = (d.meetings || []).find((x) => x.id === req.params.mid);
    if (!m) throw httpError(404, 'Meeting not found');
    return m;
  };
  const editableDraft = (req) => {
    const d = loadDraft(req);
    if (!['draft', 'rejected'].includes(d.status)) throw httpError(409, `A draft that is ${d.status} cannot be changed`);
    return d;
  };
  const sanitizeMeeting = (m) => { const { transcript, ...rest } = m; return { ...rest, transcriptLines: transcript?.length || 0 }; };

  async function processMeeting(draftId, mid) {
    const update = (fn) => { const d = store.get('drafts', draftId); const m = d?.meetings?.find((x) => x.id === mid); if (!m) return null; fn(m, d); store.put('drafts', d); return { d, m }; };
    try {
      const cur = store.get('drafts', draftId); const lang = cur.doc.info.language || 'en';
      const transcript = fs.existsSync(audioPath(mid)) && fs.statSync(audioPath(mid)).size > 0 ? await transcribe({ cfg, path: audioPath(mid), language: lang }) : [];
      update((m) => { m.transcript = transcript; m.status = 'analysing'; });
      fs.rmSync(audioPath(mid), { force: true }); // privacy: only the transcript is kept
      const now = store.get('drafts', draftId); const meeting = now.meetings.find((x) => x.id === mid);
      await Promise.all(meeting.frames.map((f) => Promise.resolve(shotReady(now.sessionId, f.id)).catch(() => {})));
      const found = transcript.length ? await meetingAnalyse({ cfg, doc: now.doc, clarifications: now.clarifications, transcript }) : [];
      update((m) => {
        m.suggestions = found.map((x, i) => {
          const atMs = Math.max(0, Math.round(x.atSeconds * 1000));
          const frame = ['answer', 'topic'].includes(x.kind) ? null : nearestFrame(m.frames, atMs);
          return { id: `sug_${i + 1}`, kind: x.kind, clarificationId: x.clarificationId, stepNumber: x.stepNumber, title: x.title, text: x.text, instructions: x.instructions, quote: x.quote, atMs, screenshotId: frame?.id || null, status: 'open' };
        });
        m.status = 'done'; m.finishedAt = Date.now();
      });
      audit.write(null, 'meeting.analysed', { draftId, meetingId: mid, suggestions: found.length, transcriptLines: transcript.length });
    } catch (e) {
      update((m) => { m.status = 'failed'; m.error = e.message; });
      fs.rmSync(audioPath(mid), { force: true });
      audit.write(null, 'meeting.failed', { draftId, meetingId: mid, error: e.message });
    }
  }

  app.post('/api/drafts/:id/meetings', wrap(async (req, res) => {
    const d = editableDraft(req);
    if (!meetingsAvailable()) throw httpError(409, 'Meeting recordings need Azure AI Speech and the AI to be configured.', 'NOT_AVAILABLE');
    if (req.body?.consent !== true) throw httpError(400, 'Confirm that everyone in the meeting agreed to the recording');
    d.meetings ||= [];
    if (d.meetings.some((m) => m.status === 'recording')) throw httpError(409, 'A meeting is already being recorded for this draft');
    const m = { id: newId('mtg'), status: 'recording', startedAt: Date.now(), startedBy: req.user.name, frames: [], audioBytes: 0, suggestions: [] };
    d.meetings.push(m); store.put('drafts', d);
    audit.write(req.user, 'meeting.started', { draftId: d.id, meetingId: m.id });
    res.json(sanitizeMeeting(m));
  }));
  app.post('/api/drafts/:id/meetings/:mid/audio', express.raw({ type: () => true, limit: '25mb' }), wrap(async (req, res) => {
    const d = editableDraft(req); const m = loadMeeting(req, d);
    if (m.status !== 'recording') throw httpError(409, 'The meeting recording has ended');
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (m.audioBytes + buf.length > cfg.meetings.maxAudioMb * 1024 * 1024) throw httpError(413, 'The meeting recording is too long');
    fs.appendFileSync(audioPath(m.id), buf);
    m.audioBytes += buf.length; store.put('drafts', d);
    res.json({ audioBytes: m.audioBytes });
  }));
  app.post('/api/drafts/:id/meetings/:mid/frames', wrap(async (req, res) => {
    const d = editableDraft(req); const m = loadMeeting(req, d);
    if (m.status !== 'recording') throw httpError(409, 'The meeting recording has ended');
    if (m.frames.length >= cfg.meetings.maxFrames) throw httpError(429, 'Screenshot limit for this meeting reached');
    const x = /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(req.body?.data || '');
    if (!x) throw httpError(400, 'Expected a data URL with a JPEG or PNG image');
    const buf = Buffer.from(x[2], 'base64');
    if (buf.length > 8 * 1024 * 1024) throw httpError(413, 'Screenshot too large');
    const saved = store.saveScreenshot(d.sessionId, buf, x[1]);
    protectShot(d.sessionId, saved.id);
    m.frames.push({ id: saved.id, atMs: Math.max(0, Number(req.body.atMs) || Date.now() - m.startedAt) });
    store.put('drafts', d);
    res.json({ id: saved.id, frames: m.frames.length });
  }));
  app.post('/api/drafts/:id/meetings/:mid/stop', wrap(async (req, res) => {
    const d = editableDraft(req); const m = loadMeeting(req, d);
    if (m.status !== 'recording') throw httpError(409, 'The meeting recording has already ended');
    m.status = 'transcribing'; m.stoppedAt = Date.now(); store.put('drafts', d);
    audit.write(req.user, 'meeting.stopped', { draftId: d.id, meetingId: m.id, frames: m.frames.length, audioBytes: m.audioBytes });
    processMeeting(d.id, m.id);
    res.json(sanitizeMeeting(m));
  }));
  app.post('/api/drafts/:id/meetings/:mid/suggestions/:sid', wrap(async (req, res) => {
    const d = editableDraft(req); const m = loadMeeting(req, d);
    const sg = m.suggestions.find((x) => x.id === req.params.sid);
    if (!sg || sg.status !== 'open') throw httpError(404, 'Suggestion not found or already decided');
    const action = req.body?.action;
    if (!['accept', 'reject'].includes(action)) throw httpError(400, 'action must be accept or reject');
    const text = String(req.body?.text ?? sg.text).trim();
    if (action === 'accept') {
      const tag = `meeting ${new Date(m.startedAt).toISOString().slice(0, 10)}`;
      if (sg.kind === 'topic') {
        // Accepting a topic only records the decision; the UI offers to start a recording for it.
      } else if (sg.kind === 'answer') {
        const c = d.clarifications.find((x) => x.id === sg.clarificationId);
        if (!c || c.status !== 'open') throw httpError(409, 'This question was already answered');
        c.answer = text; c.status = 'answered'; applyAnswer(d.doc, c, text);
      } else if (sg.kind === 'note') {
        const st = d.doc.steps.find((x) => x.number === sg.stepNumber);
        if (!st) throw httpError(409, 'The step no longer exists');
        st.notes.push(text);
        if (sg.screenshotId && !st.screenshotIds.includes(sg.screenshotId)) st.screenshotIds.push(sg.screenshotId);
      } else {
        const at = Math.min(Math.max(0, sg.stepNumber ?? d.doc.steps.length), d.doc.steps.length);
        d.doc.steps.splice(at, 0, { id: `stp_${crypto.randomBytes(4).toString('hex')}`, number: 0, title: sg.title || text.slice(0, 80), description: text, instructions: sg.instructions || [], application: '', input: '', expectedResult: '', screenshotIds: sg.screenshotId ? [sg.screenshotId] : [], notes: [`Added from the ${tag}.`], warnings: [], important: false, evidenceEventSeqs: [], targets: [], marks: [] });
        d.doc.steps.forEach((x, i) => { x.number = i + 1; });
        // Later suggestions keep pointing at the same steps.
        for (const o of m.suggestions) if (o !== sg && o.status === 'open' && o.stepNumber != null && o.stepNumber > at) o.stepNumber += 1;
      }
      d.doc = normalizeDoc(d.doc);
      if (d.baseDoc) d.comparison = compareDocs(d.baseDoc, d.doc);
    }
    sg.status = action === 'accept' ? 'accepted' : 'rejected'; sg.decidedBy = req.user.name;
    if (d.status === 'rejected') d.status = 'draft';
    d.updatedAt = Date.now(); d.history.push({ ts: Date.now(), user: req.user.name, action: `meeting suggestion ${sg.status}` });
    store.put('drafts', d);
    audit.write(req.user, `meeting.suggestion_${sg.status}`, { draftId: d.id, meetingId: m.id, kind: sg.kind });
    res.json(draftView(d));
  }));

  app.post('/api/drafts/:id/approve', requireRole(ROLES.APPROVER), wrap(async (req, res) => {
    const d = loadDraft(req);
    if (d.status !== 'draft') throw httpError(409, `Only drafts can be approved (current status: ${d.status})`);
    const blockers = approvalBlockers(d);
    if (blockers.length) throw httpError(422, blockers.join(' '), 'NOT_READY');
    if (cfg.auth.requireSeparateApprover && d.createdBy.id === req.user.id) throw httpError(403, 'The author of a recording cannot approve it (separation of duties is enabled).');
    const final = d.baseDoc ? mergeWithDecisions(d.baseDoc, d.doc, d.comparison, d.decisions) : structuredClone(d.doc);
    const [maj, min] = String(d.baseDoc?.info.version || '0.0').split('.').map(Number);
    final.info.version = !d.baseDoc ? '1.0' : req.body?.major ? `${maj + 1}.0` : `${maj}.${min + 1}`;
    final.info.approver = req.user.name; final.info.status = 'Approved'; final.info.updatedAt = new Date().toISOString();
    const summary = String(req.body?.summary || '').trim() || (d.comparison ? summarizeChanges(d.comparison, d.decisions) : 'Initial version created from a recorded execution.');
    final.changeHistory = [...(final.changeHistory || []), { version: final.info.version, date: final.info.updatedAt, author: d.createdBy.name, approver: req.user.name, summary }];
    d.approvedDoc = final; d.status = 'approved'; d.approvedBy = { id: req.user.id, name: req.user.name, at: Date.now() }; d.updatedAt = Date.now();
    d.history.push({ ts: Date.now(), user: req.user.name, action: 'approved' });
    store.put('drafts', d);
    audit.write(req.user, 'draft.approved', { draftId: d.id, processId: final.info.processId, version: final.info.version });
    res.json(draftView(d));
  }));

  app.post('/api/drafts/:id/reject', requireRole(ROLES.APPROVER), wrap(async (req, res) => {
    const d = loadDraft(req);
    if (!['draft', 'approved'].includes(d.status)) throw httpError(409, `A draft that is ${d.status} cannot be rejected`);
    d.status = 'rejected'; d.rejection = { by: req.user.name, at: Date.now(), reason: String(req.body?.reason || '').slice(0, 2000) }; d.approvedDoc = null; d.updatedAt = Date.now();
    d.history.push({ ts: Date.now(), user: req.user.name, action: 'rejected', reason: d.rejection.reason });
    store.put('drafts', d);
    audit.write(req.user, 'draft.rejected', { draftId: d.id, reason: d.rejection.reason });
    res.json(draftView(d));
  }));

  const shotResolver = (d) => (id) => store.screenshotPath(d.sessionId, id) || null;
  async function baseShotsToTemp(d, doc) {
    // Screenshots kept from the previous version live in the repository, not in this session.
    const out = []; const tmp = path.join(cfg.dataDir, 'tmp', d.id); fs.mkdirSync(tmp, { recursive: true });
    for (const s of doc.steps) for (const id of s.screenshotIds) {
      if (store.screenshotPath(d.sessionId, id)) continue;
      const got = d.baseRef ? await repo.screenshot(d.baseRef.processId, id) : null;
      if (got) { const p = path.join(tmp, `${id}.jpg`); fs.writeFileSync(p, got.buffer); out.push({ id, path: p }); }
    }
    return out;
  }

  app.post('/api/drafts/:id/publish', requireRole(ROLES.APPROVER), wrap(async (req, res) => {
    const d = loadDraft(req);
    if (d.status !== 'approved' || !d.approvedDoc) throw httpError(409, 'Only approved documentation can be published');
    const doc = structuredClone(d.approvedDoc); doc.info.status = 'Published';
    // The name in SharePoint can still be chosen at this point; default: the one given at the start, else the title.
    // The process name is also its title in SharePoint (title column, folder, Word file) and can
    // still be changed by the approver right before publishing.
    if (req.body?.name !== undefined || req.body?.fileName !== undefined) {
      const name = String(req.body.name ?? req.body.fileName).replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!cleanFileName(name)) throw httpError(400, 'The process name is required');
      doc.info.title = name; doc.info.fileName = cleanFileName(name);
    }
    doc.info.fileName = cleanFileName(doc.info.title) || doc.info.fileName;
    doc.keywords = normalizeKeywords(doc.keywords?.length ? doc.keywords : extractKeywords(doc));
    const baseShots = await baseShotsToTemp(d, doc);
    const resolve = (id) => shotResolver(d)(id) || baseShots.find((x) => x.id === id)?.path || null;
    const used = [...new Set(doc.steps.flatMap((s) => s.screenshotIds))];
    const screenshots = used.map((id) => ({ id, path: resolve(id) })).filter((x) => x.path);
    doc.steps.forEach((s) => { s.screenshotIds = s.screenshotIds.filter((id) => resolve(id)); });
    // Other languages: translated by Claude; a failed translation never blocks publishing.
    const translations = []; const translationErrors = [];
    if (aiAvailable(cfg)) {
      for (const language of otherLanguages(cfg, doc.info.language || 'en')) {
        try {
          const t = await translate({ cfg, doc, to: language });
          translations.push({ language, doc: t, docx: await renderDocx(t, resolve), markdown: renderMarkdown(t) });
        } catch (e) { translationErrors.push({ language, error: e.message }); audit.write(req.user, 'draft.translation_failed', { draftId: d.id, language, error: e.message }); }
      }
    }
    let result;
    try {
      result = await repo.publish({ doc, docx: await renderDocx(doc, resolve), markdown: renderMarkdown(doc), screenshots, expectedEtag: d.baseRef ? d.baseRef.etag : null, publishedBy: req.user, owners: [], translations });
    } catch (e) {
      d.lastPublishError = { at: Date.now(), message: e.message, code: e.code || null };
      store.put('drafts', d);
      audit.write(req.user, 'draft.publish_failed', { draftId: d.id, error: e.message, code: e.code });
      throw httpError(e.status && e.status < 600 ? (e.status === 412 ? 409 : e.status >= 500 ? 502 : e.status) : 502, `Publishing failed: ${e.message}`, e.code);
    } finally { fs.rmSync(path.join(cfg.dataDir, 'tmp', d.id), { recursive: true, force: true }); }
    d.status = 'published'; d.published = { ...result, translationErrors, at: Date.now(), by: req.user.name }; d.publishedDoc = doc; d.updatedAt = Date.now(); delete d.lastPublishError;
    d.history.push({ ts: Date.now(), user: req.user.name, action: 'published', version: result.version });
    store.put('drafts', d);
    if (cfg.retention.purgeRawAfterPublish) store.purgeRawCapture(d.sessionId, new Set(used));
    audit.write(req.user, 'draft.published', { draftId: d.id, processId: result.processId, version: result.version, webUrl: result.webUrl });
    notify('process.published', { processId: result.processId, version: result.version, title: doc.info.title, webUrl: result.webUrl });
    searchIndex.refresh({ force: true }).catch(() => {}); // the new version is searchable right away
    res.json(draftView(d));
  }));

  app.get('/api/drafts/:id/preview.docx', wrap(async (req, res) => {
    const d = loadDraft(req);
    const doc = d.publishedDoc || d.approvedDoc || (d.baseDoc ? mergeWithDecisions(d.baseDoc, d.doc, d.comparison, d.decisions) : d.doc);
    const baseShots = await baseShotsToTemp(d, doc);
    try {
      const buf = await renderDocx(doc, (id) => shotResolver(d)(id) || baseShots.find((x) => x.id === id)?.path);
      res.attachment(`${doc.info.processId} - ${doc.info.title.replace(/[^\w .-]/g, '')} (preview).docx`).type('docx').send(buf);
    } finally { fs.rmSync(path.join(cfg.dataDir, 'tmp', d.id), { recursive: true, force: true }); }
  }));

  app.get('/api/drafts/:id/screenshots/:shot', wrap(async (req, res) => {
    const d = loadDraft(req);
    await shotReady(d.sessionId, req.params.shot);
    const p = store.screenshotPath(d.sessionId, req.params.shot);
    const marks = req.query.raw ? [] : marksFor(d.doc, req.params.shot);
    const crop = req.query.raw ? null : cropFor(d.doc, req.params.shot);
    if (p && !marks.length && !crop) return res.sendFile(p);
    const got = p ? { buffer: fs.readFileSync(p), mime: p.endsWith('.png') ? 'image/png' : 'image/jpeg' } : d.baseRef ? await repo.screenshot(d.baseRef.processId, req.params.shot) : null;
    if (!got) return res.status(404).end();
    res.type(got.mime).send(marks.length || crop ? await renderShot(got.buffer, marks, crop) : got.buffer);
  }));

  // ---------------------------------------------------------------- dashboard
  app.get('/api/dashboard', wrap(async (req, res) => {
    let processes = []; let repoError = null;
    try { processes = await repo.list(); } catch (e) { repoError = e.message; }
    const since = Date.now() - 30 * 86400_000;
    const drafts = store.list('drafts').filter((d) => d.createdBy.id === req.user.id || isApprover(req.user));
    const sessions = store.list('sessions').filter((s) => canSeeSession(req.user, s)).sort((a, b) => b.startedAt - a.startedAt);
    res.json({
      repository: { label: repo.label, mode: cfg.repository.mode, error: repoError },
      aiEngine: engineName(),
      totals: {
        processes: processes.length,
        createdRecently: processes.filter((p) => Date.parse(p.createdAt) > since).length,
        updatedRecently: processes.filter((p) => Date.parse(p.updatedAt) > since && p.version !== '1.0').length,
        draftsAwaiting: drafts.filter((d) => ['draft', 'approved'].includes(d.status)).length,
        recordings: sessions.length,
        // Rough estimate shown to management: by hand about 30 min + 5 min per step, with the agent about 10 min of review.
        hoursSaved: Math.round(processes.reduce((t, p) => t + 20 + 5 * (p.stepCount ?? 8), 0) / 6) / 10,
      },
      recentlyCreated: processes.filter((p) => p.version === '1.0').slice(0, 5),
      recentlyUpdated: processes.filter((p) => p.version !== '1.0').slice(0, 5),
      drafts: drafts.filter((d) => ['draft', 'approved', 'rejected', 'generating', 'failed'].includes(d.status)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8)
        .map((d) => ({ id: d.id, status: d.status, mode: d.mode, title: d.doc?.info.title || store.get('sessions', d.sessionId)?.meta.title, updatedAt: d.updatedAt, createdBy: d.createdBy, canDelete: canDelete(req.user, d) && !['generating', 'publishing'].includes(d.status) })),
      recordings: sessions.slice(0, 10).map((s) => ({ id: s.id, title: s.meta.title, mode: s.mode, status: s.status, startedAt: s.startedAt, stoppedAt: s.stoppedAt, eventCount: s.eventCount, draftId: s.draftId, createdBy: s.createdBy, canDelete: canDelete(req.user, s) && !['recording', 'paused'].includes(s.status) })),
    });
  }));

  // ---------------------------------------------------------------- administration
  // Testers: invite guests by e-mail into a role group; list and remove them (guests only).
  app.get('/api/admin/testers', requireRole(ROLES.ADMIN), wrap(async (req, res) => {
    const st = inviter.status();
    res.json({ ...st, people: st.available && st.configured ? await inviter.list() : [] });
  }));
  app.get('/api/admin/testers/permissions', requireRole(ROLES.ADMIN), wrap(async (req, res) => res.json(await inviter.permissions())));
  app.post('/api/admin/testers', requireRole(ROLES.ADMIN), wrap(async (req, res) => {
    const b = req.body || {};
    const r = await inviter.invite({ email: b.email, name: b.name, role: b.role, redirectUrl: cfg.publicUrl || `https://${req.get('host')}`, invitedBy: req.user.name });
    audit.write(req.user, 'admin.tester_invited', { role: r.role, userId: r.id });
    res.json(r);
  }));
  app.delete('/api/admin/testers/:userId', requireRole(ROLES.ADMIN), wrap(async (req, res) => {
    const r = await inviter.remove({ userId: req.params.userId, role: req.query.role });
    audit.write(req.user, 'admin.tester_removed', { role: r.role, userId: r.id });
    res.json(r);
  }));

  // Demo content: publishes a few realistic sample processes (category "Sample"); existing titles are skipped.
  app.post('/api/admin/samples', requireRole(ROLES.ADMIN), wrap(async (req, res) => {
    const existing = new Set((await repo.list()).map((p) => p.title));
    const added = [];
    for (const doc of sampleDocs({ user: req.user, newProcessId: () => `PRC-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}` })) {
      if (existing.has(doc.info.title)) continue;
      const r = await repo.publish({ doc, docx: await renderDocx(doc), markdown: renderMarkdown(doc), screenshots: [], expectedEtag: null, publishedBy: req.user, owners: [], translations: [] });
      added.push({ processId: r.processId, title: doc.info.title });
      searchIndex.refresh({ force: true }).catch(() => {});
    }
    audit.write(req.user, 'admin.samples_added', { count: added.length });
    res.json({ added });
  }));

  app.get('/api/admin/settings', requireRole(ROLES.ADMIN), (req, res) => res.json({ categories: cfg.categories, capture: cfg.capture, retention: cfg.retention, notifications: cfg.notifications, repository: { mode: cfg.repository.mode, label: repo.label }, ai: { engine: engineName() }, auth: { mode: cfg.auth.mode, requireSeparateApprover: cfg.auth.requireSeparateApprover } }));
  app.put('/api/admin/settings', requireRole(ROLES.ADMIN), wrap(async (req, res) => {
    const b = req.body || {};
    if (b.categories && (!Array.isArray(b.categories) || b.categories.some((c) => typeof c !== 'string' || !c.trim()))) throw httpError(400, 'Categories must be a list of names');
    if (b.invitations?.groups && Object.values(b.invitations.groups).some((v) => v && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v).trim()))) throw httpError(400, 'Group ids must be Entra object ids (GUIDs)');
    const invitations = b.invitations?.groups ? { groups: Object.fromEntries(Object.entries(b.invitations.groups).filter(([k]) => Object.values(ROLES).includes(k)).map(([k, v]) => [k, String(v || '').trim()])) } : undefined;
    saveAdminSettings(cfg, { categories: b.categories?.map((c) => c.trim()), capture: b.capture, retention: b.retention, notifications: b.notifications, invitations });
    audit.write(req.user, 'admin.settings_changed', { keys: Object.keys(b) });
    res.json({ ok: true });
  }));
  app.post('/api/admin/repository/provision', requireRole(ROLES.ADMIN), wrap(async (req, res) => {
    if (!repo.ensureSchema) return res.json({ ok: true, message: 'Local repository needs no provisioning.' });
    const r = await repo.ensureSchema(cfg.categories);
    audit.write(req.user, 'admin.repository_provisioned', r);
    res.json({ ok: true, ...r });
  }));
  app.get('/api/admin/audit', requireRole(ROLES.ADMIN), (req, res) => res.json(audit.read({ limit: Number(req.query.limit) || 200 })));
  app.post('/api/admin/retention/run', requireRole(ROLES.ADMIN), (req, res) => res.json(applyRetention({ cfg, store, audit })));

  // ---------------------------------------------------------------- web app + errors
  const dist = path.join(cfg._root, 'web/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, req, res, _next) => {
    const status = err.status || (err.name === 'ZodError' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 && !err.expose && !err.message?.startsWith('Publishing failed') ? 'Internal error' : err.message, code: err.code });
  });
  app.locals = { ...app.locals, store, audit, repo };
  return app;
}

function summarizeChanges(cmp, decisions) {
  const acc = (c) => decisions[c.id] === 'accept';
  const parts = [];
  const n = (kind) => cmp.changes.filter((c) => c.kind === kind && c.role !== 'destination' && acc(c)).length;
  if (n('added')) parts.push(`${n('added')} step(s) added`);
  if (n('modified')) parts.push(`${n('modified')} step(s) modified`);
  if (n('removed')) parts.push(`${n('removed')} step(s) removed`);
  if (n('moved')) parts.push(`${n('moved')} step(s) re-ordered`);
  const sec = cmp.sectionChanges.filter(acc).length;
  if (sec) parts.push(`${sec} section change(s)`);
  return parts.length ? `Updated from a new recorded execution: ${parts.join(', ')}.` : 'Re-validated against a new recorded execution; no step changes accepted.';
}
