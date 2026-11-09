import React from 'react';
import { useEffect, useRef, useState } from 'react';
import { authedBlobUrl } from './api.js';

export const fmtDate = (v) => (v ? new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–');
export const fmtDuration = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
export const go = (hash) => { location.hash = hash; };

export function usePoll(fn, ms, deps = []) {
  const saved = useRef(fn); saved.current = fn;
  useEffect(() => {
    let alive = true; let t;
    const tick = async () => { try { await saved.current(); } finally { if (alive) t = setTimeout(tick, ms); } };
    tick();
    return () => { alive = false; clearTimeout(t); };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}

export function AuthImg({ src, alt, onClick }) {
  const [url, setUrl] = useState(null); const [err, setErr] = useState(false);
  useEffect(() => { authedBlobUrl(src).then(setUrl).catch(() => setErr(true)); }, [src]);
  if (err) return <div className="empty small">Screenshot not available</div>;
  return url ? <img src={url} alt={alt} onClick={() => onClick?.(url)} /> : <div className="spinner" />;
}

export function Lightbox({ url, onClose }) {
  if (!url) return null;
  return <div className="lightbox" onClick={onClose}><img src={url} alt="Screenshot" /></div>;
}

export function StatusBadge({ s }) { return <span className={`badge ${s}`}>{s}</span>; }

// Legend under a step's screenshots when they carry numbered click markers.
export function MarksHint({ step }) {
  const shown = (step.marks || []).filter((m) => step.screenshotIds.includes(m.shotId));
  if (!shown.length) return null;
  return <p className="marks-hint small muted"><span className="dot">1</span>The numbers on the screenshot show the order of the {shown.length === 1 ? 'click' : `${shown.length} clicks`}; frames mark the field or button used.</p>;
}
