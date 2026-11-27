// Create (or update) a process from a file: a written instruction, a slide deck, a PDF guide, a
// text or subtitle file, or a video in which someone shows and explains the process.
import React, { useEffect, useRef, useState } from 'react';
import { api, apiUpload, getConfig, refreshConfig } from '../api.js';
import { go } from '../util.jsx';
import { openVideo, closeVideo, captureFrames, soundTrack } from '../video.js';

const DOC_EXT = ['pdf', 'docx', 'pptx', 'txt', 'md', 'markdown', 'csv', 'html', 'htm', 'vtt', 'srt'];
const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv'];
const ext = (n) => (/\.([a-z0-9]+)$/i.exec(n || '') || [])[1]?.toLowerCase() || '';
const kindOf = (file) => (!file ? null : file.type.startsWith('video/') || VIDEO_EXT.includes(ext(file.name)) ? 'video' : 'document');
const mb = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(n > 10 * 1024 * 1024 ? 0 : 1)} MB`);
const CHUNK = 20 * 1024 * 1024;

export default function Upload({ me }) {
  const [cfg, setCfg] = useState(getConfig());
  useEffect(() => { refreshConfig().then((c) => setCfg({ ...c })); }, []);
  const processId = new URLSearchParams(location.hash.split('?')[1] || '').get('processId') || '';
  const [target, setTarget] = useState(null);
  useEffect(() => { if (processId) api(`/api/processes/${processId}`).then(setTarget).catch((e) => setErr(e.message)); }, [processId]);
  const [file, setFile] = useState(null); const [subs, setSubs] = useState(null);
  const [f, setF] = useState({ title: '', description: '', department: '', owner: '', category: '', language: 'en' });
  const [consent, setConsent] = useState(false); const [err, setErr] = useState(null);
  const [phase, setPhase] = useState(null); const [progress, setProgress] = useState(0);
  const [drag, setDrag] = useState(false);
  const abort = useRef(null);
  useEffect(() => () => abort.current?.abort(), []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const kind = kindOf(file);
  const limits = cfg.uploads || { maxDocumentMb: 50, maxFrames: 60, maxAudioMb: 200, transcription: false };
  const category = target?.doc.info.category || f.category;
  const aiOff = (cfg.aiOffCategories || []).includes(category);
  const willTranscribe = kind === 'video' && !subs && limits.transcription && !aiOff;
  const tooBig = kind === 'document' && file && file.size > limits.maxDocumentMb * 1024 * 1024;
  const unsupported = file && kind === 'document' && !DOC_EXT.includes(ext(file.name));

  const choose = (fl) => { setErr(null); setFile(fl || null); };
  const drop = (e) => { e.preventDefault(); setDrag(false); choose(e.dataTransfer.files?.[0]); };

  const start = async (e) => {
    e.preventDefault(); setErr(null);
    const ctl = new AbortController(); abort.current = ctl;
    let video = null;
    try {
      setPhase('Preparing'); setProgress(0);
      if (kind === 'video') video = await openVideo(file); // fails early for a video the browser cannot play
      const up = await api('/api/uploads', { method: 'POST', body: { kind, fileName: file.name, consent, ...(processId ? { processId } : f) } });
      if (kind === 'document') {
        setPhase('Reading the document and writing the draft');
        const d = await apiUpload(`/api/uploads/${up.id}/document`, file);
        go(`/review/${d.id}`); return;
      }
      if (subs) {
        await apiUpload(`/api/uploads/${up.id}/subtitles?fileName=${encodeURIComponent(subs.name)}`, subs);
      }
      setPhase('Finding the screens in the video');
      await captureFrames(video, { maxFrames: limits.maxFrames, signal: ctl.signal, onProgress: setProgress, send: (fr) => api(`/api/uploads/${up.id}/frames`, { method: 'POST', body: fr }) });
      if (willTranscribe) {
        setPhase('Reading the sound track'); setProgress(0);
        const track = await soundTrack(file, { maxBytes: limits.maxAudioMb * 1024 * 1024 });
        if (track) {
          setPhase(`Sending the sound track${track.cut ? ' (only the beginning: the video is too long)' : ''}`);
          for (let i = 0; i < track.blob.size; i += CHUNK) {
            if (ctl.signal.aborted) throw new Error('Cancelled');
            await apiUpload(`/api/uploads/${up.id}/audio`, track.blob.slice(i, i + CHUNK));
            setProgress(Math.min(1, (i + CHUNK) / track.blob.size));
          }
        }
      }
      setPhase(willTranscribe ? 'Transcribing what is said and writing the draft' : 'Writing the draft'); setProgress(0);
      await api(`/api/uploads/${up.id}/finish`, { method: 'POST' });
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        if (ctl.signal.aborted) return;
        const s = await api(`/api/uploads/${up.id}`);
        if (s.draftId) { go(`/review/${s.draftId}`); return; }
        if (s.status === 'failed') throw new Error(s.error || 'The video could not be processed');
      }
    } catch (x) {
      if (x.message !== 'Cancelled') setErr(x.message);
      setPhase(null);
    } finally { if (video) closeVideo(video); }
  };

  const busy = !!phase;
  return (
    <form className="panel" onSubmit={start} style={{ maxWidth: 760, margin: '0 auto' }}>
      <h1>{target ? `Update "${target.doc.info.title}" from a file` : 'Create a process from a video or document'}</h1>
      <p className="muted">Upload a video in which someone shows or explains the process, or a document that describes it: a Word or PDF work instruction, a PowerPoint deck, a text or Markdown file. The agent reads the steps from it and writes a draft in the standard format, which you review and approve as usual.</p>
      {err && <div className="alert err" data-testid="upload-error">{err}</div>}

      <label className={`dropzone${drag ? ' drag' : ''}${file ? ' has' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={drop}>
        <input type="file" accept={[...DOC_EXT, ...VIDEO_EXT].map((x) => `.${x}`).join(',') + ',video/*'} onChange={(e) => choose(e.target.files?.[0])} disabled={busy} data-testid="upload-file" />
        {file ? <span><b>{kind === 'video' ? '🎬' : '📄'} {file.name}</b> <span className="muted small">· {mb(file.size)} · {kind === 'video' ? 'video' : 'document'}</span></span>
          : <span><b>Drop a file here or choose one</b><br /><span className="small muted">PDF, Word (.docx), PowerPoint (.pptx), text, Markdown, HTML, subtitles (.vtt, .srt) · videos: MP4, MOV, WebM</span></span>}
      </label>
      {unsupported && <div className="alert warn small">This file type is not supported. Save it as PDF or Word (.docx) and upload that file.</div>}
      {tooBig && <div className="alert warn small">This file is larger than {limits.maxDocumentMb} MB.</div>}

      {kind === 'video' && (
        <div className="alert info small" data-testid="video-note">
          The video stays on this computer: this browser takes a screenshot whenever the screen changes (up to {limits.maxFrames}){willTranscribe ? ' and sends the sound track, which is transcribed and then deleted' : ''}.
          {!subs && !limits.transcription && <> Transcription (Azure AI Speech) is not set up, so the draft is based on the screenshots only. If you have subtitles, add them below.</>}
          {!subs && limits.transcription && aiOff && <> AI is off for this category, so the sound is not transcribed. If you have subtitles, add them below.</>}
          <label className="f" style={{ marginTop: 8 }}>Subtitles or transcript <span className="opt">(optional, .vtt or .srt – used instead of transcribing the sound)</span>
            <input type="file" accept=".vtt,.srt" onChange={(e) => setSubs(e.target.files?.[0] || null)} disabled={busy} data-testid="upload-subtitles" />
          </label>
        </div>
      )}

      {!target && (
        <>
          <label className="f">Process name <span className="opt">(optional – taken from the document's title when empty)</span><input value={f.title} onChange={set('title')} placeholder="e.g. Reset user password - Microsoft 365" maxLength={120} data-testid="upload-title" /></label>
          <label className="f">Short description <span className="opt">(optional)</span><textarea value={f.description} onChange={set('description')} placeholder="What does this process achieve?" /></label>
          <div className="grid g3" style={{ gap: 12 }}>
            <label className="f">IT department or functional area <span className="opt">(optional)</span><input value={f.department} onChange={set('department')} /></label>
            <label className="f">Process owner <span className="opt">(optional)</span><input value={f.owner} onChange={set('owner')} placeholder={me?.name} /></label>
            <label className="f">Category <span className="opt">(optional)</span>
              <select value={f.category} onChange={set('category')} data-testid="upload-category"><option value="">Choose…</option>{cfg.categories.map((c) => <option key={c} value={c}>{c}{(cfg.aiOffCategories || []).includes(c) ? ' (AI off)' : ''}</option>)}</select>
              {aiOff && <span className="small ai-off-note">🔒 AI is off for this category. Nothing is sent to the AI; the draft is made by the rule-based engine.</span>}
            </label>
          </div>
          <label className="f" style={{ maxWidth: 320 }}>Document language
            <select value={f.language} onChange={set('language')} data-testid="upload-language"><option value="en">English</option><option value="de">Deutsch (German)</option></select>
            <span className="small muted">The draft is written in this language, whatever the language of the file.</span>
          </label>
        </>
      )}

      <div className="consent">
        <p style={{ marginTop: 0 }}><b>Before you upload.</b> {kind === 'video' ? 'The video itself is not uploaded: only the screenshots and the sound track (deleted after transcription).' : 'The file itself is not kept: only its text and pictures.'} Passwords, keys and card numbers in the text are removed, e-mail addresses are masked, and personal data in pictures is blurred. Nothing is published without review and approval.</p>
        <label><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="upload-consent" /> I may use this file for our documentation, and everyone who can be heard or seen in it agrees.</label>
      </div>

      {busy && (
        <div className="upload-progress" data-testid="upload-progress">
          <span className="spinner" /> <b>{phase}…</b>
          {progress > 0 && <div className="bar"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>}
        </div>
      )}
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn primary big" disabled={!file || !consent || busy || tooBig || unsupported} data-testid="upload-start">⇪ Create the draft</button>
        {busy && kind === 'video' ? <button type="button" className="btn" onClick={() => { abort.current?.abort(); setPhase(null); }}>Cancel</button> : <a className="btn" href={target ? `#/update/${processId}` : '#/'}>Cancel</a>}
      </div>
    </form>
  );
}
