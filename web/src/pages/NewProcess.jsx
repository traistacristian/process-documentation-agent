import React, { useEffect, useState } from 'react';
import { api, getConfig, refreshConfig } from '../api.js';
import { go } from '../util.jsx';
import Consent from '../components/Consent.jsx';

export default function NewProcess({ me }) {
  const [cfg, setCfg] = useState(getConfig());
  // Categories can be changed by an admin at any time: always show the current list.
  useEffect(() => { refreshConfig().then((c) => setCfg({ ...c })); }, []);
  const [f, setF] = useState({ title: '', description: '', department: '', owner: '', category: '', language: 'en' });
  const [consent, setConsent] = useState(false); const [dups, setDups] = useState([]); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    if (f.title.trim().length < 4) { setDups([]); return; }
    const t = setTimeout(() => api(`/api/processes/duplicates?title=${encodeURIComponent(f.title)}`).then(setDups).catch(() => {}), 400);
    return () => clearTimeout(t);
  }, [f.title]);

  const start = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const s = await api('/api/sessions', { method: 'POST', body: { mode: 'new', ...f, consent } }); go(`/record/${s.id}`); } catch (x) { setErr(x.message); setBusy(false); }
  };

  return (
    <form className="panel" onSubmit={start} style={{ maxWidth: 720, margin: '0 auto' }}>
      <h1>Create new process recording</h1>
      <p className="muted">Tell us which process you are about to perform. Only the title is required.</p>
      {err && <div className="alert err">{err}</div>}
      <label className="f">Process name <span className="opt">(required – also the title, folder and Word file name in SharePoint, so choose a name people will search for; it can still be changed before publishing)</span><input required value={f.title} onChange={set('title')} placeholder="e.g. Reset user password - Microsoft 365" maxLength={120} data-testid="title" autoFocus /></label>
      {dups.length > 0 && (
        <div className="alert warn">
          <b>A similar process is already documented.</b> If it describes the same activity, update it instead of creating a duplicate.
          <ul className="list">{dups.map((p) => <li key={p.processId}><span>{p.title} <span className="small muted">({p.processId}, v{p.version})</span></span><a className="btn sm" href={`#/update/${p.processId}`}>Update this process instead</a></li>)}</ul>
        </div>
      )}
      <label className="f">Short description <span className="opt">(optional)</span><textarea value={f.description} onChange={set('description')} placeholder="What does this process achieve?" /></label>
      <div className="grid g3" style={{ gap: 12 }}>
        <label className="f">IT department or functional area <span className="opt">(optional)</span><input value={f.department} onChange={set('department')} /></label>
        <label className="f">Process owner <span className="opt">(optional)</span><input value={f.owner} onChange={set('owner')} placeholder={me?.name} /></label>
        <label className="f">Category <span className="opt">(optional)</span>
          <select value={f.category} onChange={set('category')}><option value="">Choose…</option>{cfg.categories.map((c) => <option key={c}>{c}</option>)}</select>
        </label>
      </div>
      <label className="f" style={{ maxWidth: 320 }}>Document language
        <select value={f.language} onChange={set('language')} data-testid="language"><option value="en">English</option><option value="de">Deutsch (German)</option></select>
        <span className="small muted">The AI writes the document in this language; on publishing, the other language is added as a translated copy.</span>
      </label>
      <Consent checked={consent} onChange={setConsent} />
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn danger big" disabled={!f.title.trim() || !consent || busy} data-testid="start">● Start Recording</button>
        <a className="btn" href="#/">Cancel</a>
      </div>
    </form>
  );
}
