import React, { useEffect, useRef, useState } from 'react';
import { authedBlobUrl } from '../api.js';

// Screenshots with numbered click markers and an optional crop, drawn in the browser so edits show
// at once. The server draws the same markers into the published Word document and the library.
// Positions are fractions of the full image: x, y, w, h (frame) and cx, cy (circle centre).

const GREEN = '#2FA84F'; const GREEN_DARK = '#1E6E34';

function useBlob(src) {
  const [url, setUrl] = useState(null); const [err, setErr] = useState(false); const [size, setSize] = useState(null);
  useEffect(() => {
    let alive = true; setUrl(null); setErr(false);
    authedBlobUrl(src).then((u) => {
      if (!alive) return;
      const im = new Image(); im.onload = () => alive && (setSize({ W: im.naturalWidth, H: im.naturalHeight }), setUrl(u)); im.onerror = () => setErr(true); im.src = u;
    }).catch(() => setErr(true));
    return () => { alive = false; };
  }, [src]);
  return { url, err, size };
}

const framed = (m) => m.w > 0 && m.h > 0 && (m.kind === 'field' || (m.w < 0.4 && m.h < 0.2));

export function MarksOverlay({ marks, W, H, selected, onPick }) {
  const k = Math.max(0.6, W / 1280); const r = 15 * k;
  const frames = []; const badges = [];
  for (const m of marks) {
    const sel = selected === m.n;
    let cx; let cy;
    if (framed(m)) {
      const st = (m.kind === 'field' ? 3 : 2.5) * k;
      const x = m.x * W - st; const y = m.y * H - st; const w = m.w * W + 2 * st; const h = m.h * H + 2 * st;
      frames.push(<g key={`f${m.n}`}><rect x={x} y={y} width={w} height={h} rx={3 * k} fill="none" stroke="#fff" strokeWidth={st + 2 * k} opacity=".8" />
        <rect x={x} y={y} width={w} height={h} rx={3 * k} fill={sel ? 'rgba(47,168,79,.12)' : 'none'} stroke={sel ? '#E8590C' : GREEN} strokeWidth={st} /></g>);
      cx = Math.min(W - r, Math.max(r, x + w)); cy = Math.min(H - r, Math.max(r, y));
    } else { cx = Math.min(W - r, Math.max(r, m.cx * W)); cy = Math.min(H - r, Math.max(r, m.cy * H)); }
    badges.push(<g key={`b${m.n}`} onPointerDown={onPick ? (e) => { e.stopPropagation(); onPick(m.n, e); } : undefined} style={onPick ? { cursor: 'move' } : undefined}>
      <circle cx={cx} cy={cy} r={r * 1.12} fill="#fff" />
      <circle cx={cx} cy={cy} r={r} fill={sel ? '#E8590C' : GREEN} stroke={sel ? '#9a3412' : GREEN_DARK} strokeWidth={r * 0.08} />
      <text x={cx} y={cy} dy=".35em" textAnchor="middle" fontSize={r * (m.n > 9 ? 0.95 : 1.15)} fontWeight="700" fontFamily="Segoe UI, Arial, sans-serif" fill="#fff" style={{ pointerEvents: 'none' }}>{m.n}</text>
    </g>);
  }
  return <svg className="marks-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ pointerEvents: onPick ? 'auto' : 'none' }}>{frames}{badges}</svg>;
}

// A screenshot as it appears in the document: markers on top, cut to the crop.
export function MarkedShot({ src, marks = [], crop, alt, onClick }) {
  const { url, err, size } = useBlob(src);
  if (err) return <div className="empty small">Screenshot not available</div>;
  if (!url) return <div className="spinner" />;
  const c = crop && crop.w > 0 && crop.h > 0 ? crop : { x: 0, y: 0, w: 1, h: 1 };
  return (
    <div className="marked-shot" style={{ aspectRatio: `${c.w * size.W} / ${c.h * size.H}` }} onClick={onClick} role={onClick ? 'button' : undefined} title={onClick ? 'Edit markers and crop' : undefined}>
      <div className="marked-inner" style={{ width: `${100 / c.w}%`, left: `${(-c.x / c.w) * 100}%`, top: `${(-c.y / c.h) * 100}%` }}>
        <img src={url} alt={alt} draggable={false} />
        <MarksOverlay marks={marks} W={size.W} H={size.H} />
      </div>
    </div>
  );
}

const renumber = (list) => [...list].sort((a, b) => a.n - b.n).map((m, i) => ({ ...m, n: i + 1 }));
const r4 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;

// Full-screen editor for one screenshot: add a numbered click or a frame, drag markers, change their
// order, remove them, let the AI suggest them, and crop the screenshot.
export function ShotEditor({ src, shotId, marks: initialMarks, crop: initialCrop, instructions, onSuggest, onSave, onClose }) {
  const { url, err, size } = useBlob(src);
  const [marks, setMarks] = useState(initialMarks || []); const [crop, setCrop] = useState(initialCrop || null);
  const [mode, setMode] = useState('click'); const [sel, setSel] = useState(null); const [drag, setDrag] = useState(null);
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(null);
  const box = useRef(null);
  useEffect(() => {
    const key = (e) => {
      if (e.key === 'Escape') onClose();
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel && e.target.tagName !== 'INPUT') { setMarks((l) => renumber(l.filter((m) => m.n !== sel))); setSel(null); }
    };
    addEventListener('keydown', key); return () => removeEventListener('keydown', key);
  }, [sel, onClose]);

  const at = (e) => { const r = box.current.getBoundingClientRect(); return { fx: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), fy: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
  const down = (e) => {
    if (!size) return;
    const p = at(e); box.current.setPointerCapture?.(e.pointerId);
    if (mode === 'click') {
      const n = marks.length + 1;
      setMarks([...marks, { shotId, n, kind: 'click', x: 0, y: 0, w: 0, h: 0, cx: r4(p.fx), cy: r4(p.fy) }]); setSel(n);
    } else setDrag({ kind: mode, x0: p.fx, y0: p.fy, x1: p.fx, y1: p.fy });
  };
  const pick = (n, e) => { setSel(n); const p = at(e); box.current.setPointerCapture?.(e.pointerId); setDrag({ kind: 'move', n, px: p.fx, py: p.fy, orig: marks.find((m) => m.n === n) }); };
  const move = (e) => {
    if (!drag) return;
    const p = at(e);
    if (drag.kind === 'move') {
      const dx = p.fx - drag.px; const dy = p.fy - drag.py; const o = drag.orig;
      setMarks((l) => l.map((m) => (m.n !== drag.n ? m : { ...m, x: r4(o.x + dx), y: r4(o.y + dy), cx: r4(o.cx + dx), cy: r4(o.cy + dy) })));
    } else setDrag({ ...drag, x1: p.fx, y1: p.fy });
  };
  const up = () => {
    if (!drag) return;
    if (drag.kind !== 'move') {
      const x = Math.min(drag.x0, drag.x1); const y = Math.min(drag.y0, drag.y1); const w = Math.abs(drag.x1 - drag.x0); const h = Math.abs(drag.y1 - drag.y0);
      if (w > 0.01 && h > 0.01) {
        if (drag.kind === 'frame') { const n = marks.length + 1; setMarks([...marks, { shotId, n, kind: 'field', x: r4(x), y: r4(y), w: r4(w), h: r4(h), cx: r4(x + w / 2), cy: r4(y + h / 2) }]); setSel(n); }
        if (drag.kind === 'crop') { setCrop({ shotId, x: r4(x), y: r4(y), w: r4(w), h: r4(h) }); setMode('click'); }
      }
    }
    setDrag(null);
  };
  const shift = (d) => {
    const i = marks.findIndex((m) => m.n === sel); const j = i + d;
    if (i < 0 || j < 0 || j >= marks.length) return;
    const l = renumber(marks); [l[i].n, l[j].n] = [l[j].n, l[i].n]; setMarks(renumber(l)); setSel(sel + d);
  };
  const suggest = async () => {
    setBusy(true); setMsg(null);
    try { const got = await onSuggest(instructions); setMarks(renumber(got.map((m) => ({ ...m, shotId })))); setSel(null); setMsg(got.length ? `The AI placed ${got.length} marker${got.length === 1 ? '' : 's'}. Check them and move or remove any that are off.` : 'The AI could not find the elements of this step on the screenshot. Add the markers by clicking.'); } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };
  const rect = drag && drag.kind !== 'move' ? { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) } : null;
  const tool = (m, label, title) => <button className={`btn sm${mode === m ? ' primary' : ''}`} onClick={() => setMode(m)} title={title} data-testid={`tool-${m}`}>{label}</button>;

  return (
    <div className="shot-editor-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="shot-editor" role="dialog" aria-label="Edit screenshot" data-testid="shot-editor">
        <div className="row between" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 6 }}>
            {tool('click', '① Add click', 'Click on the screenshot where the user clicks')}
            {tool('frame', '▭ Add frame', 'Drag around a field or area')}
            {tool('crop', '✂ Crop', 'Drag the part of the screenshot to keep')}
            {onSuggest && <button className="btn sm" onClick={suggest} disabled={busy || !instructions?.length} title={instructions?.length ? 'Let the AI place markers from the step instructions' : 'Add instructions to the step first'} data-testid="suggest-marks">{busy ? 'Placing…' : '✦ Suggest with AI'}</button>}
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={onClose}>Cancel</button>
            <button className="btn sm primary" onClick={() => onSave({ marks: renumber(marks), crop })} data-testid="shot-save">Apply</button>
          </div>
        </div>
        <div className="row small" style={{ gap: 6, margin: '8px 0', minHeight: 30 }}>
          {sel ? <>Marker {sel}: <button className="btn sm" onClick={() => shift(-1)} disabled={sel <= 1}>◀ Earlier</button><button className="btn sm" onClick={() => shift(1)} disabled={sel >= marks.length}>Later ▶</button><button className="btn sm" onClick={() => { setMarks(renumber(marks.filter((m) => m.n !== sel))); setSel(null); }} data-testid="mark-remove">Remove</button><span className="muted">Drag the number to move it.</span></>
            : <span className="muted">{mode === 'click' ? 'Click where the user clicks; numbers follow the order you add them.' : mode === 'frame' ? 'Drag a frame around a field or area.' : 'Drag the part of the screenshot to keep.'}</span>}
          <span style={{ flex: 1 }} />
          {marks.length > 0 && <button className="btn sm" onClick={() => { setMarks([]); setSel(null); }}>Remove all markers</button>}
          {crop && <button className="btn sm" onClick={() => setCrop(null)} data-testid="crop-reset">Undo crop</button>}
        </div>
        {msg && <div className="alert small" style={{ marginBottom: 8 }}>{msg}</div>}
        {err ? <div className="empty">Screenshot not available</div> : !url ? <div className="spinner" /> : (
          <div className="shot-canvas" ref={box} onPointerDown={down} onPointerMove={move} onPointerUp={up} style={{ cursor: mode === 'click' ? 'crosshair' : 'cell' }} data-testid="shot-canvas">
            <img src={url} alt="Screenshot" draggable={false} />
            <MarksOverlay marks={marks} W={size.W} H={size.H} selected={sel} onPick={pick} />
            {crop && <svg className="marks-svg" viewBox="0 0 1 1" preserveAspectRatio="none" style={{ pointerEvents: 'none' }}><path fillRule="evenodd" fill="rgba(15,23,42,.55)" d={`M0 0H1V1H0Z M${crop.x} ${crop.y}h${crop.w}v${crop.h}h${-crop.w}Z`} /><rect x={crop.x} y={crop.y} width={crop.w} height={crop.h} fill="none" stroke="#fff" strokeWidth=".003" strokeDasharray=".01 .006" /></svg>}
            {rect && <div className={`drag-rect ${drag.kind}`} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} />}
          </div>
        )}
      </div>
    </div>
  );
}
