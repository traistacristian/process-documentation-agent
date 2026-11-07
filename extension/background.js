// Process Documentation Agent – extension service worker.
// Holds the pairing (session id + capture token), queues events durably in chrome.storage.local so
// nothing is lost during network interruptions or service-worker restarts, takes privacy-masked
// screenshots of the active tab, and mirrors the recording state (badge: REC / II).

const DEFAULT = { apiBase: null, sessionId: null, token: null, status: 'idle', title: '', policy: null, queue: [] };
const get = async () => ({ ...DEFAULT, ...(await chrome.storage.local.get(Object.keys(DEFAULT))) });
const set = (patch) => chrome.storage.local.set(patch);
let flushing = false; let lastShotAt = 0;
// Serialises read-modify-write access to the stored queue (events arrive concurrently).
let lock = Promise.resolve();
const withLock = (fn) => (lock = lock.then(fn, fn));

async function api(path, { method = 'GET', body } = {}) {
  const s = await get();
  const res = await fetch(`${s.apiBase}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.token}`, 'x-session-id': s.sessionId },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { await reset('Pairing expired'); throw new Error('unauthorized'); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function reset(reason) {
  await set({ ...DEFAULT, lastMessage: reason || '' });
  await broadcast();
  updateBadge('idle');
}

function updateBadge(status) {
  const map = { recording: ['REC', '#C92A2A'], paused: ['II', '#E67700'], idle: ['', '#868E96'] };
  const [text, color] = map[status] || map.idle;
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setTitle({ title: status === 'recording' ? 'Process Documentation Agent – RECORDING' : status === 'paused' ? 'Process Documentation Agent – paused' : 'Process Documentation Agent – not recording' });
}

async function contentState() {
  const s = await get();
  let apiOrigin = null; try { apiOrigin = new URL(s.apiBase).origin; } catch { /* not paired */ }
  return { recording: ['recording', 'paused'].includes(s.status), paused: s.status === 'paused', policy: s.policy, apiOrigin, title: s.title };
}

async function broadcast() {
  const st = await contentState();
  for (const tab of await chrome.tabs.query({})) chrome.tabs.sendMessage(tab.id, { type: 'state', state: st }).catch(() => {});
}

function glob(p) { return new RegExp('^' + p.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'); }
function excluded(url, policy) {
  try {
    const u = new URL(url); const hp = (u.host + u.pathname).toLowerCase();
    return (policy?.excludedUrlPatterns || []).some((p) => glob(p).test(u.host.toLowerCase()) || glob(p).test(hp));
  } catch { return false; }
}

async function pair(code, apiBase) {
  const res = await fetch(`${apiBase}/api/capture/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, client: { type: 'browser-extension', version: chrome.runtime.getManifest().version, host: navigator.userAgent.slice(0, 80) } }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
  await set({ apiBase, sessionId: body.sessionId, token: body.captureToken, status: body.status, title: body.title, policy: body.policy, queue: [] });
  updateBadge(body.status);
  await broadcast();
  chrome.alarms.create('pda-sync', { periodInMinutes: 0.5 });
  syncLoop();
  return { ok: true };
}

async function enqueue(ev) {
  await withLock(async () => {
    const s = await get();
    if (!['recording', 'paused'].includes(s.status)) return;
    await set({ queue: [...s.queue, ev].slice(-2000) });
  });
  flush();
}

async function flush() {
  if (flushing) return; flushing = true;
  try {
    for (;;) {
      const s = await get();
      if (!s.queue.length || !s.token) break;
      const batch = s.queue.slice(0, 50);
      const r = await api('/api/capture/events', { method: 'POST', body: { events: batch, source: 'extension' } });
      await withLock(async () => { const after = await get(); await set({ queue: after.queue.slice(batch.length) }); });
      if (r.status !== s.status) await onStatus(r.status);
    }
  } catch { /* offline: events stay queued and are retried by the sync loop */ } finally { flushing = false; }
}

async function screenshot(tabId, windowId, rect) {
  const now = Date.now();
  if (now - lastShotAt < 700) return null; // Chrome limits captureVisibleTab to ~2 calls / second
  lastShotAt = now;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'mask', rect });
    const data = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 70 });
    await chrome.tabs.sendMessage(tabId, { type: 'unmask' }).catch(() => {});
    const r = await api('/api/capture/screenshots', { method: 'POST', body: { data } });
    return r.id;
  } catch {
    chrome.tabs.sendMessage(tabId, { type: 'unmask' }).catch(() => {});
    return null;
  }
}

async function onStatus(status) {
  if (status === 'stopped' || status === 'discarded' || status === 'generated') { await flush(); await reset('Recording finished'); return; }
  await set({ status }); updateBadge(status); await broadcast();
}

let syncing = false;
async function syncLoop() {
  if (syncing) return; syncing = true;
  try {
    for (;;) {
      const s = await get();
      if (!s.token) break;
      try { const st = await api('/api/capture/state'); if (st.status !== s.status) await onStatus(st.status); } catch { /* offline */ }
      await flush();
      await new Promise((r) => setTimeout(r, 2500));
    }
  } finally { syncing = false; }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === 'hello') return contentState();
    if (msg.type === 'status') { const s = await get(); return { status: s.status, title: s.title, queued: s.queue.length, paired: !!s.token }; }
    if (msg.type === 'pair') return pair(String(msg.code || ''), msg.apiBase);
    if (msg.type === 'unpair') { await reset('Disconnected by user'); return { ok: true }; }
    if (msg.type === 'event') {
      const s = await get();
      if (s.status !== 'recording' || !sender.tab) return { ok: false };
      if (excluded(msg.event.url, s.policy)) return { ok: false, excluded: true };
      const ev = { ...msg.event, tabId: undefined };
      if (msg.screenshot) ev.screenshotId = await screenshot(sender.tab.id, sender.tab.windowId, msg.rect) || undefined;
      await enqueue(ev);
      return { ok: true };
    }
    return null;
  })().then(reply);
  return true;
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const s = await get();
  if (s.status !== 'recording') return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url || !/^https?:/.test(tab.url) || excluded(tab.url, s.policy)) return;
  try { if (new URL(tab.url).origin === new URL(s.apiBase).origin) return; } catch { /* ignore */ }
  enqueue({ type: 'navigate', ts: Date.now(), url: tab.url, pageTitle: tab.title, app: 'Browser', switchedTab: true, clientId: `tab-${Date.now()}` });
});

chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'pda-sync') syncLoop(); });
chrome.runtime.onStartup.addListener(async () => { const s = await get(); updateBadge(s.status); if (s.token) syncLoop(); });
get().then((s) => { updateBadge(s.status); if (s.token) syncLoop(); });
