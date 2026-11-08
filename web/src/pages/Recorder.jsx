import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { usePoll, fmtDuration, fmtDate, go } from '../util.jsx';

const describe = (e) => {
  const el = e.element || {};
  switch (e.type) {
    case 'navigate': return `Opened ${e.pageTitle || e.url}`;
    case 'window_focus': return `Switched to ${e.app}${e.windowTitle ? ` – ${e.windowTitle}` : ''}`;
    case 'click': return `Clicked ${el.role ? `${el.role} ` : ''}"${el.name || el.label || '?'}"`;
    case 'input': return `Entered a value in "${el.label || el.name || 'field'}"`;
    case 'change': return `Set "${el.label || el.name}" to ${e.value}`;
    case 'submit': return 'Submitted a form';
    case 'feedback': return `${e.level === 'error' ? 'Error' : 'Message'} shown: "${e.text}"`;
    case 'key': return `Pressed ${e.text}`;
    case 'note': return `Note: ${e.text}`;
    case 'mark': return `★ Marked important step${e.text ? `: ${e.text}` : ''}`;
    case 'screenshot': return 'Screenshot taken';
    default: return e.type;
  }
};

// Screen capture through the browser's screen-sharing dialog (getDisplayMedia). Works for any
// application on the user's screen, but only provides screenshots - not clicks or element names.
function useScreenShare(sessionId, active) {
  const [stream, setStream] = useState(null); const [surface, setSurface] = useState(null); const video = useRef(null); const lastSig = useRef(null); const latest = useRef(null);
  const capture = async (force) => {
    if (!stream) return null;
    // While the user works in another tab or app, this tab is hidden and the browser stops painting
    // the <video>, so frames are read from the track itself (ImageCapture) whenever available.
    let src = null; let sw = 0; let sh = 0;
    const track = stream.getVideoTracks()[0];
    if (latest.current) { src = latest.current; sw = src.displayWidth; sh = src.displayHeight; }
    else if (typeof window.ImageCapture === 'function' && track?.readyState === 'live') {
      try { src = await new window.ImageCapture(track).grabFrame(); sw = src.width; sh = src.height; } catch { src = null; }
    }
    if (!src) { if (!video.current?.videoWidth) return null; src = video.current; sw = src.videoWidth; sh = src.videoHeight; }
    const w = Math.min(1600, sw); const h = Math.round(sh * (w / sw));
    const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(src, 0, 0, w, h);
    if (src.close && src !== latest.current) src.close();
    const tiny = document.createElement('canvas'); tiny.width = 32; tiny.height = 18; tiny.getContext('2d').drawImage(c, 0, 0, 32, 18);
    const px = tiny.getContext('2d').getImageData(0, 0, 32, 18).data; const sig = []; for (let i = 0; i < px.length; i += 4) sig.push((px[i] + px[i + 1] + px[i + 2]) / 3);
    const diff = lastSig.current ? sig.reduce((a, x, i) => a + Math.abs(x - lastSig.current[i]), 0) / sig.length : 255;
    if (!force && diff < 6) return null; // screen did not change meaningfully
    lastSig.current = sig;
    const { id } = await api(`/api/sessions/${sessionId}/screenshots`, { method: 'POST', body: { data: c.toDataURL('image/jpeg', 0.7) } });
    return id;
  };
  useEffect(() => {
    if (!stream || !active) return;
    const tick = async () => { const id = await capture(false).catch(() => null); if (id) api(`/api/sessions/${sessionId}/events`, { method: 'POST', body: { events: [{ type: 'screenshot', ts: Date.now(), screenshotId: id }] } }).catch(() => {}); };
    // Timers in hidden tabs are throttled to once a minute; a worker's timer is not.
    let worker = null; let t = null;
    try {
      worker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 2000)'], { type: 'text/javascript' })));
      worker.onmessage = tick;
    } catch { t = setInterval(tick, 2000); }
    return () => { worker?.terminate(); if (t) clearInterval(t); };
  }, [stream, active]);
  // Chromium/Edge: read frames straight from the track (MediaStreamTrackProcessor). This keeps working
  // while this tab is in the background, unlike painting the <video> element.
  useEffect(() => {
    if (!stream || typeof window.MediaStreamTrackProcessor !== 'function') return undefined;
    let stop = false; let reader = null;
    try { reader = new window.MediaStreamTrackProcessor({ track: stream.getVideoTracks()[0] }).readable.getReader(); } catch { return undefined; }
    (async () => {
      while (!stop) {
        const { value, done } = await reader.read().catch(() => ({ done: true }));
        if (done) break;
        latest.current?.close(); latest.current = value;
      }
    })();
    return () => { stop = true; reader.cancel().catch(() => {}); latest.current?.close(); latest.current = null; };
  }, [stream]);
  useEffect(() => () => stream?.getTracks().forEach((t) => t.stop()), [stream]);
  const start = async () => {
    // Ask for the entire screen: sharing a single tab would only show that tab.
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2, displaySurface: 'monitor' }, audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'include', monitorTypeSurfaces: 'include' });
    const track = s.getVideoTracks()[0];
    track.addEventListener('ended', () => setStream(null));
    setSurface(track.getSettings?.().displaySurface || null);
    setStream(s); setTimeout(() => { if (video.current) { video.current.srcObject = s; video.current.play(); } }, 0);
  };
  const stop = () => { stream?.getTracks().forEach((t) => t.stop()); setStream(null); };
  return { stream, start, stop, capture, video, surface };
}

export default function Recorder({ id }) {
  const [s, setS] = useState(null); const [err, setErr] = useState(null); const [now, setNow] = useState(Date.now());
  const [ext, setExt] = useState(null); const [note, setNote] = useState(''); const [mark, setMark] = useState(''); const [busy, setBusy] = useState(false);
  const active = s && ['recording', 'paused'].includes(s.status);
  const share = useScreenShare(id, s?.status === 'recording');

  usePoll(async () => { try { setS(await api(`/api/sessions/${id}`)); } catch (e) { setErr(e.message); } }, 1500, [id]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!s) return undefined;
    const prev = document.title;
    document.title = s.status === 'recording' ? `● REC – ${s.meta.title}` : s.status === 'paused' ? `❚❚ Paused – ${s.meta.title}` : prev;
    return () => { document.title = 'Process Documentation Agent'; };
  }, [s?.status]);

  // Auto-pair the browser extension (if installed) with this recording.
  useEffect(() => {
    if (!s || !active) return undefined;
    const onMsg = (e) => {
      if (e.source !== window || e.data?.source !== 'pda-extension') return;
      if (e.data.type === 'PDA_PONG') { setExt({ installed: true, ...e.data.status }); if (!s.clients?.some((c) => c.type === 'browser-extension')) window.postMessage({ source: 'pda-app', type: 'PDA_PAIR', code: s.pairing.code }, location.origin); }
      if (e.data.type === 'PDA_PAIRED') setExt((x) => ({ ...x, pairedNow: e.data.ok, error: e.data.error }));
    };
    addEventListener('message', onMsg);
    window.postMessage({ source: 'pda-app', type: 'PDA_PING' }, location.origin);
    return () => removeEventListener('message', onMsg);
  }, [s?.id, s?.status, s?.clients?.length]);

  const control = async (action) => {
    setBusy(true); setErr(null);
    try { setS({ ...s, ...(await api(`/api/sessions/${id}/control`, { method: 'POST', body: { action } })) }); if (action === 'stop') share.stop(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const addNote = async (kind) => {
    const text = kind === 'mark' ? mark : note;
    let screenshotId;
    if (kind === 'mark' && share.stream) screenshotId = await share.capture(true).catch(() => undefined);
    await api(`/api/sessions/${id}/notes`, { method: 'POST', body: { kind, text, screenshotId } }).catch((e) => setErr(e.message));
    kind === 'mark' ? setMark('') : setNote('');
  };
  const generate = async () => {
    setBusy(true); setErr(null);
    try { const d = await api(`/api/sessions/${id}/generate`, { method: 'POST', body: {} }); go(`/review/${d.id}`); } catch (e) { setErr(e.message); setBusy(false); }
  };

  if (!s) return err ? <div className="alert err">{err}</div> : <span className="spinner" />;
  const elapsed = (s.stoppedAt || now) - s.startedAt - s.pausedMs - (s.pausedAt ? now - s.pausedAt : 0);
  const clientTypes = new Set((s.clients || []).map((c) => c.type));
  const cur = s.currentApplication;

  return (
    <>
      <div className={`recbar ${s.status === 'recording' ? '' : s.status === 'paused' ? 'paused' : 'stopped'}`} data-testid="recbar">
        <div className="dot" />
        <div style={{ flex: 1 }}>
          <div className="small" style={{ opacity: .9, textTransform: 'uppercase', letterSpacing: '.06em' }}>{s.status === 'recording' ? 'Recording – your activity is being captured' : s.status === 'paused' ? 'Recording paused – nothing is captured' : `Recording ${s.status}`}</div>
          <div className="title">{s.meta.title}{s.mode === 'update' && <span className="small"> · update of {s.baseRef.processId} v{s.baseRef.version}</span>}</div>
        </div>
        <div className="time" data-testid="duration">{fmtDuration(elapsed)}</div>
      </div>
      {err && <div className="alert err">{err}</div>}
      {s.autoStopped && <div className="alert warn">This recording was stopped automatically because no activity was received for a long time. You can continue it or generate documentation from what was captured.</div>}

      <div className="grid g2">
        <div className="panel">
          <h2>Controls</h2>
          <div className="kv" style={{ marginBottom: 14 }}>
            <div>Status</div><div><b data-testid="status">{s.status}</b></div>
            <div>Duration</div><div>{fmtDuration(elapsed)}</div>
            <div>Current application</div><div data-testid="current-app">{cur ? `${cur.app === 'Browser' ? cur.pageTitle || cur.url : `${cur.app}${cur.windowTitle ? ` – ${cur.windowTitle}` : ''}`}` : <span className="empty">Waiting for activity…</span>}</div>
            <div>Actions captured</div><div data-testid="event-count">{s.eventCount}</div>
            <div>Screenshots</div><div>{s.screenshotCount}</div>
          </div>
          {active ? (
            <>
              <div className="row" style={{ marginBottom: 14 }}>
                {s.status === 'recording' ? <button className="btn" onClick={() => control('pause')} disabled={busy} data-testid="pause">❚❚ Pause recording</button> : <button className="btn primary" onClick={() => control('resume')} disabled={busy} data-testid="resume">● Resume recording</button>}
                <button className="btn danger" onClick={() => control('stop')} disabled={busy} data-testid="stop">■ Stop recording</button>
              </div>
              <label className="f">Add note <span className="opt">(context the screen cannot show, e.g. why you chose an option)</span>
                <div className="row" style={{ flexWrap: 'nowrap' }}><input value={note} onChange={(e) => setNote(e.target.value)} data-testid="note-input" /><button className="btn" disabled={!note.trim()} onClick={() => addNote('note')} data-testid="add-note">Add note</button></div></label>
              <label className="f">Mark important step <span className="opt">(starts a new step; optional title)</span>
                <div className="row" style={{ flexWrap: 'nowrap' }}><input value={mark} onChange={(e) => setMark(e.target.value)} placeholder="e.g. Update user permissions" data-testid="mark-input" /><button className="btn" onClick={() => addNote('mark')} data-testid="mark">★ Mark step</button></div></label>
            </>
          ) : (
            <div className="row">
              <button className="btn primary big" onClick={generate} disabled={busy || s.status === 'discarded'} data-testid="generate">{busy ? 'Generating…' : 'Generate documentation'}</button>
              {s.status === 'stopped' && !s.draftId && <button className="btn" onClick={() => control('resume')} disabled={busy}>Continue recording</button>}
              {!s.draftId && s.status !== 'discarded' && <button className="btn" onClick={() => control('discard')} disabled={busy}>Discard recording</button>}
              {s.draftId && <a className="btn" href={`#/review/${s.draftId}`}>Open draft</a>}
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Capture sources</h2>
          <ul className="list">
            <li><span><b>Browser extension</b><br /><span className="small muted">Web consoles (Microsoft 365, Entra, Azure, ServiceNow…): clicks, fields, messages, masked screenshots.</span></span>
              <span className={`badge ${clientTypes.has('browser-extension') ? 'published' : ''}`} data-testid="ext-status">{clientTypes.has('browser-extension') ? 'connected' : ext?.installed ? 'connecting…' : 'not detected'}</span></li>
            <li><span><b>Desktop agent</b><br /><span className="small muted">Windows applications and consoles (MMC, PowerShell ISE, RDP…).</span></span>
              <span className={`badge ${clientTypes.has('desktop-agent') ? 'published' : ''}`}>{clientTypes.has('desktop-agent') ? 'connected' : 'not connected'}</span></li>
            <li><span><b>Screen sharing</b><br /><span className="small muted">Screenshots of any window when the screen changes. No click details.</span></span>
              {share.stream ? <button className="btn sm" onClick={share.stop}>Stop sharing</button> : <button className="btn sm" disabled={!active} onClick={() => share.start().catch((e) => setErr(`Screen sharing was not started: ${e.message}`))}>Share screen</button>}</li>
          </ul>
          {active && <p className="small">Pairing code for the desktop agent or a browser on another computer: <code className="pair" data-testid="pairing-code">{s.pairing.code}</code></p>}
          {active && !clientTypes.size && !share.stream && <div className="alert warn small">No capture source is connected yet, so only your notes will be recorded. Install the browser extension or start the desktop agent with the pairing code above.</div>}
          {share.stream && share.surface === 'browser' && <div className="alert warn small" data-testid="share-tab-warning">You are sharing a single browser tab, so other tabs and apps will not be captured. Click <b>Stop sharing</b>, then <b>Share screen</b> again and choose <b>Entire screen</b>.</div>}
          {active && !clientTypes.has('browser-extension') && <div className="alert small">For click-by-click steps in other browser tabs, load the browser extension. Its icon shows <b>REC</b> while it records.</div>}
          <video ref={share.video} muted style={{ display: share.stream ? 'block' : 'none', width: '100%', borderRadius: 8, marginTop: 8 }} />
        </div>
      </div>

      <StepDescriptions id={id} status={s.status} />

      <div className="panel">
        <h2>Captured activity</h2>
        <p className="small muted">Shown exactly as stored. Sensitive values appear as [REDACTED] or [VALUE_ENTERED].</p>
        {s.recentEvents.length ? <ul className="list feed" data-testid="feed">{s.recentEvents.filter((e) => e.type !== 'start').map((e) => <li key={e.seq}><span className="t">{new Date(e.ts).toLocaleTimeString()}</span><span>{describe(e)}</span>{e.source && <span className="badge">{e.source}</span>}{e.screenshotId && <span className="badge">📷</span>}</li>)}</ul> : <p className="empty">Nothing captured yet.</p>}
        <p className="small muted">Started {fmtDate(s.startedAt)} by {s.createdBy.name}.</p>
      </div>
    </>
  );
}

// The author describes each recognised step in their own words while recording. The text goes into the
// step's description in the document (and becomes its instructions when no clicks were captured).
function StepDescriptions({ id, status }) {
  const [steps, setSteps] = useState(null); const [edit, setEdit] = useState({}); const [saved, setSaved] = useState({}); const [err, setErr] = useState(null);
  usePoll(async () => { try { setSteps(await api(`/api/sessions/${id}/steps`)); } catch (e) { setErr(e.message); } }, 3000, [id]);
  const save = async (st) => {
    const text = edit[st.firstSeq];
    if (text === undefined || text === (st.description || st.suggested)) return;
    try {
      await api(`/api/sessions/${id}/step-descriptions`, { method: 'PUT', body: { seq: st.firstSeq, text } });
      setSaved((x) => ({ ...x, [st.firstSeq]: Date.now() }));
      setSteps(await api(`/api/sessions/${id}/steps`));
      setEdit((x) => { const { [st.firstSeq]: _, ...rest } = x; return rest; });
    } catch (e) { setErr(e.message); }
  };
  if (!steps) return null;
  return (
    <div className="panel">
      <h2>Steps so far</h2>
      <p className="small muted">Each step is described automatically from its screenshot and what was recognised (finished steps first; the current step is described when you move on). Check it and correct it only if it is wrong; your correction replaces the automatic text in the document. You can also change it later on the review page.</p>
      {err && <div className="alert err small">{err}</div>}
      {steps.length ? <ol className="list" data-testid="step-descriptions" style={{ paddingLeft: 0 }}>{steps.map((st) => (
        <li key={st.firstSeq ?? st.number} style={{ display: 'block' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}><b>{st.number}. {st.title}</b><span className="small muted">{saved[st.firstSeq] ? 'saved' : st.description ? 'edited by you' : st.suggestedBy === 'ai' ? 'written by AI - check it' : st.aiPending ? 'AI is describing this step...' : st.suggested ? 'automatic' : ''}</span></div>
          <textarea data-testid="step-description" rows={2} style={{ width: '100%', marginTop: 6 }} placeholder={st.aiPending ? 'The AI is writing a description from the screenshot...' : st.screenOnly ? 'Screen sharing shows the screen but not your clicks: describe what you did here.' : 'What did you do in this step?'}
            value={edit[st.firstSeq] ?? (st.description || st.suggested)}
            onChange={(e) => setEdit((x) => ({ ...x, [st.firstSeq]: e.target.value }))}
            onBlur={() => save(st)} disabled={st.firstSeq == null || status === 'generated'} />
        </li>
      ))}</ol> : <p className="empty">Steps appear here as soon as something is captured.</p>}
    </div>
  );
}
