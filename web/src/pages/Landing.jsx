import React, { useState } from 'react';
import { api } from '../api.js';
import { usePoll, fmtDate, StatusBadge } from '../util.jsx';

export default function Landing({ me }) {
  const isAdmin = me?.roles.includes('Admin');
  const [d, setD] = useState(null); const [err, setErr] = useState(null);
  usePoll(async () => { try { setD(await api('/api/dashboard')); setErr(null); } catch (e) { setErr(e.message); } }, 8000);
  const remove = async (kind, item) => {
    const what = kind === 'drafts' ? 'draft' : 'recording';
    const extra = kind === 'sessions' ? ' Its captured actions and screenshots are deleted too (screenshots used by a draft are kept).' : ' The recording it came from is kept.';
    if (!window.confirm(`Delete the ${what} "${item.title || 'Untitled'}"? This cannot be undone.${extra}`)) return;
    try { await api(`/api/${kind}/${item.id}`, { method: 'DELETE' }); setD(await api('/api/dashboard')); setErr(null); } catch (e) { setErr(e.message); }
  };
  const Del = ({ kind, item }) => (item.canDelete ? <button className="btn sm ghost" title="Delete" aria-label={`Delete ${item.title || 'item'}`} data-testid={`delete-${kind}`} onClick={() => remove(kind, item)}>Delete</button> : null);
  const interrupted = d?.recordings.filter((r) => ['recording', 'paused', 'stopped'].includes(r.status) && !r.draftId) || [];

  return (
    <>
      <section className="hero">
        <div>
          <div className="eyebrow">IT process documentation</div>
          <h1>Do the task once.<br />Get the work instruction for free.</h1>
          <p>Perform an IT task as you normally would. The agent records each step with screenshots, writes a standard work instruction, and publishes it to SharePoint after review and approval.</p>
          <div className="cta">
            <a className="btn big light" href="#/new" data-testid="choice-new">● Record a new process</a>
            <a className="btn big outline" href="#/update" data-testid="choice-update">↻ Update an existing process</a>
          </div>
        </div>
        <div className="hero-steps">
          <div><b>1</b><span><strong>Record</strong> – do the task in the browser or on the desktop</span></div>
          <div><b>2</b><span><strong>Review</strong> – the agent drafts the steps, you fill the gaps</span></div>
          <div><b>3</b><span><strong>Approve &amp; publish</strong> – a Word document in SharePoint, in English and German</span></div>
        </div>
      </section>

      {err && <div className="alert err">{err}</div>}
      {d?.repository.error && <div className="alert err">The documentation repository could not be reached: {d.repository.error}</div>}
      {isAdmin && d?.repository.mode === 'local' && <div className="alert warn small">Prototype configuration: documents are published to a <b>local folder on the server</b>, not to SharePoint. An administrator can connect SharePoint in the configuration (see the deployment guide).</div>}

      {interrupted.length > 0 && (
        <div className="alert info">
          <b>Unfinished recordings</b>
          <ul className="list">
            {interrupted.map((r) => (
              <li key={r.id}><span>{r.title} <span className="muted small">· started {fmtDate(r.startedAt)} · {r.eventCount} actions captured</span></span>
                <a className="btn sm" href={`#/record/${r.id}`}>{r.status === 'stopped' ? 'Continue or generate' : 'Return to recording'}</a></li>
            ))}
          </ul>
        </div>
      )}

      {d && (
        <>
          <div className="grid g5" style={{ marginBottom: 16 }}>
            <div className="panel stat hl" title="Estimate: writing a work instruction by hand takes about 30 minutes plus 5 minutes per step; with the agent about 10 minutes of review.">
              <div className="n">{d.totals.hoursSaved ?? 0} h</div><div className="l">Time saved (estimate)</div><div className="hint">vs. writing the documents by hand</div>
            </div>
            {[['Documented processes', d.totals.processes], ['Created (30 days)', d.totals.createdRecently], ['Updated (30 days)', d.totals.updatedRecently], ['Awaiting approval', d.totals.draftsAwaiting]].map(([l, n]) => (
              <div className="panel stat" key={l}><div className="n">{n}</div><div className="l">{l}</div></div>
            ))}
          </div>
          {isAdmin && d.totals.processes === 0 && <div className="alert info small">Showing the app to someone? Add a few realistic sample processes under <a href="#/admin">Administration → Demo content</a>.</div>}
          <div className="grid g2">
            <div className="panel">
              <h2>Drafts awaiting review or approval</h2>
              {d.drafts.length ? <ul className="list">{d.drafts.map((x) => (
                <li key={x.id}><a href={`#/review/${x.id}`}>{x.title || 'Untitled'}</a><span className="row"><span className="small muted">{x.mode === 'update' ? 'Update' : 'New'} · {fmtDate(x.updatedAt)}</span><StatusBadge s={x.status} /><Del kind="drafts" item={x} /></span></li>
              ))}</ul> : <p className="empty">No drafts at the moment.</p>}
            </div>
            <div className="panel">
              <h2>Recording history</h2>
              {d.recordings.length ? <ul className="list">{d.recordings.map((r) => (
                <li key={r.id}><a href={r.draftId ? `#/review/${r.draftId}` : `#/record/${r.id}`}>{r.title}</a><span className="row"><span className="small muted">{r.createdBy.name} · {fmtDate(r.startedAt)}</span><StatusBadge s={r.status} /><Del kind="sessions" item={r} /></span></li>
              ))}</ul> : <p className="empty">No recordings yet.</p>}
            </div>
            <div className="panel">
              <h2>Recently created processes</h2>
              {d.recentlyCreated.length ? <ul className="list">{d.recentlyCreated.map((p) => <li key={p.processId}><a href={`#/library/${p.processId}`}>{p.title}</a><span className="small muted">{p.processId} · v{p.version}</span></li>)}</ul> : <p className="empty">Nothing published yet. Your first recording will appear here.</p>}
            </div>
            <div className="panel">
              <h2>Recently updated processes</h2>
              {d.recentlyUpdated.length ? <ul className="list">{d.recentlyUpdated.map((p) => <li key={p.processId}><a href={`#/library/${p.processId}`}>{p.title}</a><span className="small muted">{p.processId} · v{p.version}</span></li>)}</ul> : <p className="empty">No updates yet.</p>}
            </div>
          </div>
          {isAdmin && <p className="footnote">Repository: {d.repository.label} · Documentation engine: {d.aiEngine === 'rules' ? 'rule-based (no AI model configured)' : d.aiEngine} · Signed in as {me?.name}</p>}
        </>
      )}
    </>
  );
}
