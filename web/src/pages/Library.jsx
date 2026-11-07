import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtDate } from '../util.jsx';
import DocPreview from '../components/DocPreview.jsx';

export default function Library({ processId }) {
  const [list, setList] = useState(null); const [p, setP] = useState(null); const [err, setErr] = useState(null); const [q, setQ] = useState('');
  useEffect(() => { api(`/api/processes?q=${encodeURIComponent(q)}`).then(setList).catch((e) => setErr(e.message)); }, [q]);
  useEffect(() => { if (processId) api(`/api/processes/${processId}`).then(setP).catch((e) => setErr(e.message)); else setP(null); }, [processId]);
  if (processId && p) return (
    <div className="panel">
      <div className="row between"><a href="#/library" className="small">← All processes</a>
        <div className="row"><a className="btn" href={`#/update/${processId}`}>Update this process</a>{p.webUrl && <a className="btn primary" href={p.webUrl} target="_blank" rel="noreferrer">Open published document</a>}</div></div>
      <DocPreview doc={p.doc} shotUrl={(id) => `/api/processes/${processId}/screenshots/${id}`} />
    </div>
  );
  return (
    <div className="panel">
      <h1>Process library</h1>
      {err && <div className="alert err">{err}</div>}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" />
      {list && (list.length ? <ul className="list" style={{ marginTop: 10 }}>{list.map((x) => <li key={x.processId}><span><a href={`#/library/${x.processId}`}><b>{x.title}</b></a><br /><span className="small muted">{x.processId} · {x.category || 'Uncategorised'} · owner {x.owner || '–'}</span></span><span className="small muted">v{x.version} · {fmtDate(x.updatedAt)}</span></li>)}</ul> : <p className="empty">No processes published yet.</p>)}
    </div>
  );
}
