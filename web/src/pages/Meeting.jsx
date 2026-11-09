// Records a meeting for a draft: the shared screen (a screenshot whenever it changes) and the audio
// (the meeting window or tab, plus this computer's microphone). Afterwards the server transcribes the
// audio and proposes answers, notes, missing steps and unclear topics on the review page.
import React, { useEffect, useRef, useState } from 'react';
import { api, apiUpload } from '../api.js';
import { fmtDuration, go } from '../util.jsx';

export default function Meeting({ draftId }) {
  const [d, setD] = useState(null); const [err, setErr] = useState(null); const [consent, setConsent] = useState(false);
  const [m, setM] = useState(null); const [state, setState] = useState('idle'); const [now, setNow] = useState(Date.now());
  const [frames, setFrames] = useState(0); const [hasMeetingAudio, setHasMeetingAudio] = useState(null); const [hasMic, setHasMic] = useState(null); const [paused, setPaused] = useState(false);
  const r = useRef({}); const video = useRef(null);

  useEffect(() => { api(`/api/drafts/${draftId}`).then(setD).catch((e) => setErr(e.message)); }, [draftId]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  useEffect(() => () => cleanup(), []); // eslint-disable-line react-hooks/exhaustive-deps

  function cleanup() {
    const x = r.current;
    x.worker?.terminate(); x.streams?.forEach((s) => s.getTracks().forEach((t) => t.stop())); x.ctx?.close().catch(() => {});
  }

  const grab = async (force) => {
    const x = r.current; const v = video.current; if (!v?.videoWidth || x.paused) return;
    const w = Math.min(1600, v.videoWidth); const h = Math.round(v.videoHeight * (w / v.videoWidth));
    const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(v, 0, 0, w, h);
    const tiny = document.createElement('canvas'); tiny.width = 32; tiny.height = 18; tiny.getContext('2d').drawImage(c, 0, 0, 32, 18);
    const px = tiny.getContext('2d').getImageData(0, 0, 32, 18).data; const sig = []; for (let i = 0; i < px.length; i += 4) sig.push((px[i] + px[i + 1] + px[i + 2]) / 3);
    const diff = x.sig ? sig.reduce((a, y, i) => a + Math.abs(y - x.sig[i]), 0) / sig.length : 255;
    if (!force && diff < 6) return;
    x.sig = sig;
    const res = await api(`/api/drafts/${draftId}/meetings/${x.mid}/frames`, { method: 'POST', body: { data: c.toDataURL('image/jpeg', 0.7), atMs: Date.now() - x.t0 } }).catch(() => null);
    if (res) setFrames(res.frames);
  };

  const start = async () => {
    setErr(null);
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: { suppressLocalAudioPlayback: false }, systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include' });
      let mic = null; try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch { mic = null; }
      setHasMeetingAudio(screen.getAudioTracks().length > 0); setHasMic(!!mic);
      const ctx = new AudioContext(); const dest = ctx.createMediaStreamDestination();
      for (const s of [screen, mic]) if (s?.getAudioTracks().length) ctx.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(dest);
      const meeting = await api(`/api/drafts/${draftId}/meetings`, { method: 'POST', body: { consent: true } });
      const x = r.current; Object.assign(x, { mid: meeting.id, t0: Date.now(), streams: [screen, mic].filter(Boolean), ctx, chain: Promise.resolve(), paused: false });
      setM(meeting);
      video.current.srcObject = screen; await video.current.play().catch(() => {});
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
      const rec = new MediaRecorder(dest.stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32000 });
      rec.ondataavailable = (e) => { if (e.data.size) x.chain = x.chain.then(() => apiUpload(`/api/drafts/${draftId}/meetings/${x.mid}/audio`, e.data)).catch((er) => setErr(er.message)); };
      rec.start(15000); x.rec = rec;
      // Timers in hidden tabs are throttled; a worker's timer is not.
      try { x.worker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 3000)'], { type: 'text/javascript' }))); x.worker.onmessage = () => grab(false); } catch { x.worker = { terminate: clearInterval.bind(null, setInterval(() => grab(false), 3000)) }; }
      screen.getVideoTracks()[0].addEventListener('ended', () => { if (r.current.rec?.state !== 'inactive') stop(); });
      setTimeout(() => grab(true), 800);
      setState('recording');
    } catch (e) { cleanup(); setErr(e.name === 'NotAllowedError' ? 'Screen sharing was cancelled.' : e.message); }
  };

  const togglePause = () => {
    const x = r.current; if (!x.rec) return;
    if (x.rec.state === 'recording') { x.rec.pause(); x.paused = true; setPaused(true); } else { x.rec.resume(); x.paused = false; setPaused(false); }
  };

  async function stop() {
    const x = r.current; if (!x.rec || x.stopping) return; x.stopping = true; setState('stopping');
    await new Promise((res) => { x.rec.onstop = res; try { x.rec.stop(); } catch { res(); } });
    await x.chain;
    cleanup();
    try { await api(`/api/drafts/${draftId}/meetings/${x.mid}/stop`, { method: 'POST' }); go(`/review/${draftId}?tab=meeting`); } catch (e) { setErr(e.message); setState('recording'); }
  }

  if (!d) return err ? <div className="alert err">{err}</div> : <span className="spinner" />;
  const title = d.doc?.info.title || 'Draft';
  const open = d.clarifications.filter((c) => c.status === 'open');
  return (
    <div style={{ maxWidth: 880, margin: '0 auto' }}>
      <a className="small" href={`#/review/${draftId}`}>← Back to the draft</a>
      {state === 'idle' ? (
        <div className="panel" style={{ marginTop: 8 }}>
          <h1>Fill the gaps from a meeting</h1>
          <p className="muted" style={{ marginTop: 0 }}>For <b>{title}</b>. Start this before or during a meeting in which the process is explained. The agent records the shared screen and the conversation, then suggests answers to the open questions, missing details and steps, and topics that seem unclear and should be documented. You decide what goes into the document.</p>
          {open.length > 0 && <div className="alert info small"><b>{open.length} open question{open.length > 1 ? 's' : ''} the meeting could answer:</b><ul style={{ margin: '4px 0 0' }}>{open.slice(0, 6).map((c) => <li key={c.id}>{c.question}</li>)}</ul></div>}
          <ol className="small">
            <li>Click <b>Start</b> and choose the Teams meeting window or the browser tab of the meeting.</li>
            <li>Tick <b>"Share audio"</b> (tab) or <b>"Share system audio"</b> (window or screen), otherwise only your microphone is recorded.</li>
            <li>Leave this tab open. When the meeting ends, click <b>Stop and analyse</b>.</li>
          </ol>
          <div className="consent"><label><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="meeting-consent" /> Everyone in the meeting knows about and agrees to the recording. The audio is deleted after it is transcribed; names, e-mail addresses and phone numbers in screenshots are blurred.</label></div>
          {err && <div className="alert err" style={{ marginTop: 10 }}>{err}</div>}
          <div className="row" style={{ marginTop: 14 }}><button className="btn danger big" disabled={!consent} onClick={start} data-testid="meeting-start">● Start meeting recording</button></div>
        </div>
      ) : (
        <>
          <div className={`recbar ${paused ? 'paused' : ''}`} style={{ marginTop: 8 }}>
            <div className="dot" />
            <div><div className="title">Meeting · {title}</div><div className="small">{paused ? 'Paused' : 'Recording screen and audio'} · {frames} screenshot{frames === 1 ? '' : 's'}</div></div>
            <div style={{ flex: 1 }} />
            <div className="time">{fmtDuration(now - (r.current.t0 || now))}</div>
          </div>
          {hasMeetingAudio === false && <div className="alert warn small">The meeting's sound is not shared, so only your microphone is recorded. Stop and start again, and tick "Share audio" or "Share system audio" in the sharing dialog.</div>}
          {hasMic === false && <div className="alert warn small">No microphone access: your own voice is not recorded.</div>}
          {err && <div className="alert err">{err}</div>}
          <div className="panel">
            <div className="row">
              <button className="btn" onClick={togglePause} disabled={state !== 'recording'}>{paused ? '▶ Resume' : '❚❚ Pause'}</button>
              <button className="btn primary" onClick={stop} disabled={state !== 'recording'} data-testid="meeting-stop">{state === 'stopping' ? 'Uploading…' : '■ Stop and analyse'}</button>
            </div>
          </div>
        </>
      )}
      <video ref={video} muted playsInline style={{ display: state === 'idle' ? 'none' : 'block', width: '100%', borderRadius: 8, background: '#000' }} />
    </div>
  );
}
