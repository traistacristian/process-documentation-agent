import React, { useEffect, useState } from 'react';
import { api, getConfig } from '../api.js';
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

// Recording to script: Claude drafts a PowerShell script for the procedure. It is never run by the
// app; an administrator reviews it and tests it with -WhatIf first.
function ScriptPanel({ processId, title }) {
  const [sc, setSc] = useState(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null); const [copied, setCopied] = useState(false);
  const draft = async (regenerate) => {
    setBusy(true); setErr(null);
    try { setSc(await api(`/api/processes/${processId}/script`, { method: 'POST', body: { regenerate } })); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([sc.script], { type: 'text/plain' }));
    a.download = `${processId} - ${title.replace(/[^\w .-]/g, '')}.ps1`; a.click();
  };
  return (
    <div className="alert" style={{ marginTop: 12 }} data-testid="script-panel">
      <b>Automate it.</b> Claude drafts a PowerShell script that performs this procedure through Microsoft Graph. The app never runs it: review it and test it with <code>-WhatIf</code> in a test tenant first.
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn" onClick={() => draft(false)} disabled={busy} data-testid="script-draft">{busy ? 'Writing the script…' : sc ? 'Show script' : 'Draft a PowerShell script'}</button>
        {sc && <button className="btn sm ghost" onClick={() => draft(true)} disabled={busy}>Write it again</button>}
      </div>
      {err && <div className="alert err small" style={{ marginTop: 8 }}>{err}</div>}
      {sc && (
        <div style={{ marginTop: 10 }} data-testid="script-result">
          <p>{sc.summary}</p>
          {!sc.automatable && <div className="alert warn small">This procedure cannot be automated with supported APIs.</div>}
          {sc.warnings?.length > 0 && <div className="alert warn small"><b>Check before use:</b><ul>{sc.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
          {sc.manualSteps?.length > 0 && <div className="small"><b>Stays manual:</b><ul>{sc.manualSteps.map((m) => <li key={m.stepNumber}>Step {m.stepNumber}: {m.reason}</li>)}</ul></div>}
          {sc.permissions?.length > 0 && <div className="small"><b>Permissions:</b> {sc.permissions.join(', ')}</div>}
          {sc.modules?.length > 0 && <div className="small"><b>Modules:</b> {sc.modules.join(', ')}</div>}
          {sc.parameters?.length > 0 && <div className="small"><b>Parameters:</b> {sc.parameters.map((x) => `${x.name} (${x.description})`).join('; ')}</div>}
          {sc.assumptions?.length > 0 && <div className="small"><b>Assumptions to verify:</b><ul>{sc.assumptions.map((x) => <li key={x}>{x}</li>)}</ul></div>}
          {sc.script && <>
            <div className="row" style={{ margin: '8px 0' }}>
              <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(sc.script); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied' : 'Copy'}</button>
              <button className="btn sm" onClick={download}>Download .ps1</button>
              <span className="small muted">Draft by {sc.model} for version {sc.version}</span>
            </div>
            <pre style={{ maxHeight: 420, overflow: 'auto', background: '#1B2A33', color: '#EEF3F4', padding: 12, borderRadius: 6, fontSize: 12 }}><code>{sc.script}</code></pre>
          </>}
        </div>
      )}
    </div>
  );
}

// Recording to Power Automate: a cloud flow drafted as a build guide (trigger, inputs, actions per step).
function FlowPanel({ processId, title }) {
  const [f, setF] = useState(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const draft = async (regenerate) => {
    setBusy(true); setErr(null);
    try { setF(await api(`/api/processes/${processId}/flow`, { method: 'POST', body: { regenerate } })); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([f.markdown], { type: 'text/markdown' }));
    a.download = `${processId} - ${title.replace(/[^\w .-]/g, '')} - Power Automate.md`; a.click();
  };
  return (
    <div className="alert" style={{ marginTop: 12 }} data-testid="flow-panel">
      <b>Power Automate.</b> Claude drafts a cloud flow for this procedure as a build guide: trigger, inputs, one action per step, connectors and licensing. Nothing is created in your tenant.
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn" onClick={() => draft(false)} disabled={busy} data-testid="flow-draft">{busy ? 'Drafting the flow…' : f ? 'Show flow' : 'Draft a Power Automate flow'}</button>
        {f && <button className="btn sm ghost" onClick={() => draft(true)} disabled={busy}>Draft it again</button>}
        {f && <button className="btn sm" onClick={download}>Download build guide (.md)</button>}
      </div>
      {err && <div className="alert err small" style={{ marginTop: 8 }}>{err}</div>}
      {f && (
        <div style={{ marginTop: 10 }} data-testid="flow-result">
          <p>{f.summary}</p>
          {!f.automatable && <div className="alert warn small">This procedure cannot be automated with Power Automate.</div>}
          <div className="small"><b>Trigger:</b> {f.trigger.type} – {f.trigger.description}</div>
          {f.inputs.length > 0 && <div className="small"><b>Inputs:</b> {f.inputs.map((i) => `${i.name} (${i.type})`).join(', ')}</div>}
          <ol className="small" style={{ marginTop: 6 }}>{f.actions.map((a, i) => <li key={i}><b>{a.name}</b>{a.stepNumber ? ` (step ${a.stepNumber})` : ''}: {a.connector} – <i>{a.action}</i>{a.settings ? `. ${a.settings}` : ''}{a.notes ? ` (${a.notes})` : ''}</li>)}</ol>
          <div className="small"><b>Connectors:</b> {f.connectors.map((c) => `${c.name}${c.premium ? ' (premium)' : ''}`).join(', ')}</div>
          {f.powerAppsForm.recommended && <div className="small"><b>Power Apps form:</b> {f.powerAppsForm.fields.join(', ')}{f.powerAppsForm.notes ? `. ${f.powerAppsForm.notes}` : ''}</div>}
          {f.desktopFlowSteps.length > 0 && <div className="small"><b>Power Automate Desktop:</b> {f.desktopFlowSteps.map((x) => `step ${x.stepNumber} (${x.reason})`).join('; ')}</div>}
          {f.manualSteps.length > 0 && <div className="small"><b>Stays manual:</b> {f.manualSteps.map((x) => `step ${x.stepNumber} (${x.reason})`).join('; ')}</div>}
          <div className="small"><b>Licensing:</b> {f.licensing}</div>
          {f.assumptions.length > 0 && <div className="small"><b>Assumptions to verify:</b><ul>{f.assumptions.map((x) => <li key={x}>{x}</li>)}</ul></div>}
        </div>
      )}
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
      {getConfig()?.aiEngine !== 'rules' && <><ScriptPanel processId={processId} title={p.doc.info.title} /><FlowPanel processId={processId} title={p.doc.info.title} /></>}
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
