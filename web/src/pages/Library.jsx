import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtDate } from '../util.jsx';
import DocPreview from '../components/DocPreview.jsx';

// Guided mode: the published steps are handed to the browser add-in, which shows them on top of
// the real pages, highlights what to click next and moves on when it was clicked.
function useExtension() {
  const [ext, setExt] = useState(null);
  useEffect(() => {
    const on = (e) => {
      if (e.source !== window || e.data?.source !== 'pda-extension') return;
      if (e.data.type === 'PDA_PONG') setExt({ installed: true, version: e.data.version });
      if (e.data.type === 'PDA_GUIDE_STARTED') setExt((x) => ({ ...x, guideStarted: e.data.ok, error: e.data.error }));
    };
    window.addEventListener('message', on);
    window.postMessage({ source: 'pda-app', type: 'PDA_PING' }, location.origin);
    return () => window.removeEventListener('message', on);
  }, []);
  return [ext, setExt];
}

function GuideButton({ doc }) {
  const [ext, setExt] = useExtension();
  const start = () => {
    setExt((x) => ({ ...x, guideStarted: undefined }));
    const guide = { processId: doc.info.processId, title: doc.info.title, version: doc.info.version, language: doc.info.language || 'en',
      steps: doc.steps.map((s) => ({ number: s.number, title: s.title, description: s.description, instructions: s.instructions, expectedResult: s.expectedResult, targets: s.targets || [] })) };
    window.postMessage({ source: 'pda-app', type: 'PDA_GUIDE', guide }, location.origin);
  };
  const first = doc.steps.flatMap((s) => s.targets || []).find((t) => t.url)?.url;
  return (
    <div className="alert" style={{ marginTop: 12 }} data-testid="guide-panel">
      <b>Guided mode.</b> The browser add-in shows the steps on top of the real pages, highlights what to click next and moves on when you have done it.
      {!ext?.installed ? <div className="small muted" style={{ marginTop: 6 }}>Install the Process Documentation Agent browser add-in (version 1.1 or later) to use guided mode.</div>
        : <div className="row" style={{ marginTop: 8 }}>
          <button className="btn primary" onClick={start} data-testid="guide-start">Guide me through this process</button>
          {ext.guideStarted && <span className="small">Started. {first ? <a href={first} target="_blank" rel="noreferrer">Open {new URL(first).host}</a> : 'Switch to the application tab.'}</span>}
          {ext.guideStarted === false && <span className="small err">{ext.error || 'The add-in is too old for guided mode. Update it.'}</span>}
        </div>}
    </div>
  );
}

export default function Library({ processId }) {
  const [list, setList] = useState(null); const [p, setP] = useState(null); const [err, setErr] = useState(null); const [q, setQ] = useState(''); const [lang, setLang] = useState('');
  useEffect(() => { api(`/api/processes?q=${encodeURIComponent(q)}`).then(setList).catch((e) => setErr(e.message)); }, [q]);
  useEffect(() => { if (processId) api(`/api/processes/${processId}${lang ? `?lang=${lang}` : ''}`).then(setP).catch((e) => setErr(e.message)); else setP(null); }, [processId, lang]);
  if (processId && p) return (
    <div className="panel">
      <div className="row between"><a href="#/library" className="small">← All processes</a>
        <div className="row"><a className="btn" href={`#/update/${processId}`}>Update this process</a>{p.webUrl && <a className="btn primary" href={p.webUrl} target="_blank" rel="noreferrer">Open published document</a>}</div></div>
      {p.translations?.length > 0 && <div className="row small" style={{ marginTop: 8 }} data-testid="languages">Language:
        {[p.doc.info.language === 'de' && !lang ? 'de' : 'en', ...['en', 'de']].filter((x, i, a) => a.indexOf(x) === i).map((l) => <button key={l} className={`btn sm${(p.doc.info.language || 'en') === l ? ' primary' : ''}`} onClick={() => setLang(l)}>{l === 'de' ? 'Deutsch' : 'English'}</button>)}</div>}
      <GuideButton doc={p.doc} />
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
