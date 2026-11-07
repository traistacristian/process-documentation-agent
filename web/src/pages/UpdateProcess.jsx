import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { go, fmtDate } from '../util.jsx';
import Consent from '../components/Consent.jsx';
import DocPreview from '../components/DocPreview.jsx';

export default function UpdateProcess({ processId }) {
  const [q, setQ] = useState(''); const [results, setResults] = useState(null); const [sel, setSel] = useState(null);
  const [consent, setConsent] = useState(false); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);

  useEffect(() => { const t = setTimeout(() => api(`/api/processes?q=${encodeURIComponent(q)}`).then(setResults).catch((e) => setErr(e.message)), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => { if (processId) api(`/api/processes/${processId}`).then(setSel).catch((e) => setErr(e.message)); else setSel(null); }, [processId]);

  const start = async () => {
    setBusy(true); setErr(null);
    try { const s = await api('/api/sessions', { method: 'POST', body: { mode: 'update', processId, consent } }); go(`/record/${s.id}`); } catch (x) { setErr(x.message); setBusy(false); }
  };

  if (processId && sel) {
    return (
      <>
        <div className="panel">
          <div className="row between"><div><a href="#/update" className="small">← Choose another process</a><h1 style={{ marginTop: 6 }}>Update: {sel.doc.info.title}</h1>
            <p className="muted" style={{ margin: 0 }}>{sel.doc.info.processId} · current version <b>{sel.doc.info.version}</b> · {sel.doc.steps.length} steps · last updated {fmtDate(sel.doc.info.updatedAt)}</p></div>
            {sel.webUrl && <a className="btn" href={sel.webUrl} target="_blank" rel="noreferrer">Open current document</a>}
          </div>
          <p>Perform the process the way it is done <b>now</b>, including any changed or additional steps. The agent will compare your execution with the current documentation and show you every difference before anything is changed. The current version stays in the repository until you approve and publish the update.</p>
          {err && <div className="alert err">{err}</div>}
          <Consent checked={consent} onChange={setConsent} />
          <div className="row" style={{ marginTop: 16 }}><button className="btn danger big" disabled={!consent || busy} onClick={start} data-testid="start">● Start Recording</button></div>
        </div>
        <div className="panel"><h2>Current documentation (version {sel.doc.info.version})</h2>
          <DocPreview doc={sel.doc} shotUrl={(id) => `/api/processes/${processId}/screenshots/${id}`} />
          {sel.versions?.length > 0 && <><h2>Version history</h2><ul className="list">{sel.versions.map((v, k) => <li key={k}><span>Version {v.version}</span><span className="small muted">{fmtDate(v.publishedAt)} · {v.publishedBy}</span></li>)}</ul></>}
        </div>
      </>
    );
  }
  return (
    <div className="panel" style={{ maxWidth: 820, margin: '0 auto' }}>
      <h1>Update existing process recording</h1>
      <p className="muted">Search the documentation repository and select the process that has changed.</p>
      {err && <div className="alert err">{err}</div>}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by title, process ID, owner or category" data-testid="search" autoFocus />
      {results === null ? <p><span className="spinner" /></p> : results.length ? (
        <ul className="list" style={{ marginTop: 10 }}>{results.map((p) => (
          <li key={p.processId}><span><b>{p.title}</b><br /><span className="small muted">{p.processId} · v{p.version} · {p.category || 'Uncategorised'} · owner {p.owner || '–'}</span></span><a className="btn sm primary" href={`#/update/${p.processId}`}>Select</a></li>
        ))}</ul>) : <p className="empty">No documented processes match your search.</p>}
    </div>
  );
}
