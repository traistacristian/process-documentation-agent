import React, { useEffect, useState } from 'react';
import { api, download, getConfig } from '../api.js';
import { usePoll, fmtDate, StatusBadge } from '../util.jsx';
import DocEditor from '../components/DocEditor.jsx';
import DiffView from '../components/DiffView.jsx';
import DocPreview from '../components/DocPreview.jsx';

export default function Review({ id, me }) {
  const cfg = getConfig();
  const [d, setD] = useState(null); const [doc, setDoc] = useState(null); const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState('doc'); const [err, setErr] = useState(null); const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState({}); const [rejectOpen, setRejectOpen] = useState(false); const [reason, setReason] = useState(''); const [summary, setSummary] = useState(''); const [pubName, setPubName] = useState(null);

  const load = (x) => { setD(x); if (x.doc) setDoc(x.doc); setDirty(false); };
  usePoll(async () => { if (!d || d.status === 'generating') { try { load(await api(`/api/drafts/${id}`)); } catch (e) { setErr(e.message); } } }, 1500, [id, d?.status]);
  useEffect(() => { if (d?.mode === 'update') setTab('changes'); }, [d?.mode]);

  if (!d) return err ? <div className="alert err">{err}</div> : <span className="spinner" />;
  if (d.status === 'generating') return <div className="panel" style={{ textAlign: 'center', padding: 40 }}><span className="spinner" /><h2 style={{ marginTop: 12 }}>Analysing the recording and writing the documentation…</h2><p className="muted">The agent groups your actions into steps, identifies inputs, results and errors, and prepares questions where information is missing.</p></div>;
  if (d.status === 'failed') return <div className="alert err">Documentation could not be generated: {d.error}</div>;

  const editable = ['draft', 'rejected'].includes(d.status);
  const isApprover = me?.roles.some((r) => r === 'Approver' || r === 'Admin');
  const shotUrl = (sid) => `/api/drafts/${id}/screenshots/${sid}`;
  const openClar = d.clarifications.filter((c) => c.status === 'open');
  const repoName = cfg.repository.mode === 'sharepoint' ? 'SharePoint' : 'the local repository';

  const call = async (fn, okMsg) => {
    setBusy(true); setErr(null); setMsg(null);
    try { const r = await fn(); load(r); if (okMsg) setMsg(okMsg); return r; } catch (e) { setErr(e.message); return null; } finally { setBusy(false); }
  };
  const save = (extra = {}) => call(() => api(`/api/drafts/${id}`, { method: 'PUT', body: { baseUpdatedAt: d.updatedAt, ...(dirty ? { doc } : {}), ...extra } }), extra.silent ? null : 'Draft saved.');
  const decide = (cid, v) => save({ decisions: { [cid]: v }, silent: true });
  const decideAll = (v) => {
    const all = {};
    for (const c of d.comparison.changes) if (c.kind !== 'unchanged' && !(c.kind === 'moved' && c.role === 'destination')) all[c.id] = v;
    for (const c of d.comparison.sectionChanges) all[c.id] = v;
    save({ decisions: all, silent: true });
  };
  const answer = (c, status) => save({ clarifications: [{ id: c.id, status, answer: answers[c.id] || '' }], silent: true });
  const approve = () => call(() => api(`/api/drafts/${id}/approve`, { method: 'POST', body: { summary } }), 'Approved. You can now publish this version.');
  const reject = () => call(() => api(`/api/drafts/${id}/reject`, { method: 'POST', body: { reason } }), 'The draft was rejected and returned to the author.').then(() => setRejectOpen(false));
  const publish = () => call(() => api(`/api/drafts/${id}/publish`, { method: 'POST', body: { fileName: pubName ?? (d.approvedDoc?.info.fileName || d.approvedDoc?.info.title || '') } }));

  return (
    <>
      <div className="panel">
        <div className="row between">
          <div>
            <h1 style={{ marginBottom: 4 }}>{doc.info.title}</h1>
            <div className="row small muted"><StatusBadge s={d.status} /><span>{d.mode === 'update' ? `Update of ${d.baseRef.processId} (current v${d.baseRef.version})` : `New process ${doc.info.processId}`}</span>
              <span>· recorded by {d.createdBy.name}</span><span>· {d.engine === 'rules' ? 'written by the rule-based engine (no AI model configured)' : `written by ${d.engine}`}</span></div>
          </div>
          <button className="btn" onClick={() => download(`/api/drafts/${id}/preview.docx`, `${doc.info.processId}.docx`).catch((e) => setErr(e.message))}>⬇ Word preview</button>
        </div>
        {err && <div className="alert err" style={{ marginTop: 12 }} data-testid="error">{err}</div>}
        {msg && <div className="alert ok" style={{ marginTop: 12 }}>{msg}</div>}
        {d.status === 'published' && <div className="alert ok" style={{ marginTop: 12 }} data-testid="published">Published to {repoName} as version <b>{d.published.version}</b> on {fmtDate(d.published.at)}. <a href={d.published.webUrl} target="_blank" rel="noreferrer">Open the published document</a> · <a href={`#/library/${d.published.processId}`}>View in library</a>
          {d.published.translations?.map((t) => <span key={t.language}> · <a href={t.webUrl} target="_blank" rel="noreferrer">Open the {t.language === 'de' ? 'German' : 'English'} version</a></span>)}
          {d.published.translationErrors?.length > 0 && <div className="small" style={{ marginTop: 6 }}>Translation not published: {d.published.translationErrors.map((t) => `${t.language.toUpperCase()} (${t.error})`).join(', ')}</div>}</div>}
        {d.status === 'rejected' && <div className="alert err" style={{ marginTop: 12 }}>Rejected by {d.rejection.by}: {d.rejection.reason || 'no reason given'}. Edit the draft and save it to send it back for approval.</div>}
        {d.lastPublishError && <div className="alert err" style={{ marginTop: 12 }}>Last publishing attempt failed: {d.lastPublishError.message} The approved draft is kept; you can retry.</div>}
        {editable && d.blockers.length > 0 && <div className="alert warn" style={{ marginTop: 12 }} data-testid="blockers"><b>Before this can be approved:</b><ul style={{ margin: '4px 0 0' }}>{d.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul></div>}
      </div>

      <div className="tabs">
        {d.mode === 'update' && <button className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')} data-testid="tab-changes">Changes ({d.pending.length} to decide)</button>}
        <button className={tab === 'doc' ? 'active' : ''} onClick={() => setTab('doc')} data-testid="tab-doc">{d.mode === 'update' ? 'Proposed documentation' : 'Generated documentation'}</button>
        <button className={tab === 'clar' ? 'active' : ''} onClick={() => setTab('clar')} data-testid="tab-clar">Clarifications ({openClar.length} open)</button>
        <button className={tab === 'sugg' ? 'active' : ''} onClick={() => setTab('sugg')}>Suggestions ({d.suggestions.length})</button>
        <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')} data-testid="tab-preview">Final document preview</button>
      </div>

      {tab === 'changes' && d.comparison && <div className="panel"><DiffView baseDoc={d.baseDoc} doc={d.doc} comparison={d.comparison} decisions={d.decisions} onDecide={decide} onDecideAll={decideAll} readOnly={!editable || busy} /></div>}
      {tab === 'doc' && <DocEditor doc={doc} onChange={(x) => { setDoc(x); setDirty(true); }} shotUrl={shotUrl} readOnly={!editable} />}
      {tab === 'clar' && (
        <div className="panel">
          <h2>Missing information</h2>
          <p className="muted">The agent does not guess. These questions cover information the recording could not show. Your answer is added to the relevant section; you can still edit it afterwards.</p>
          {d.clarifications.length === 0 && <p className="empty">No questions.</p>}
          {d.clarifications.map((c) => (
            <div key={c.id} className="step" data-testid="clarification">
              <div className="row between"><b>{c.question}</b><span className="badge">{c.section}</span></div>
              {c.status === 'open' && editable ? (
                <>
                  <textarea value={answers[c.id] || ''} onChange={(e) => setAnswers({ ...answers, [c.id]: e.target.value })} placeholder="Your answer" data-testid="clar-answer" />
                  <div className="row" style={{ marginTop: 6 }}><button className="btn sm primary" disabled={!answers[c.id]?.trim() || busy} onClick={() => answer(c, 'answered')} data-testid="clar-apply">Add answer to document</button><button className="btn sm" disabled={busy} onClick={() => answer(c, 'dismissed')} data-testid="clar-dismiss">Not applicable</button></div>
                </>
              ) : <p className="small">{c.status === 'answered' ? <>✓ Answered: {c.answer}</> : c.status === 'dismissed' ? 'Marked as not applicable.' : 'Open'}</p>}
            </div>
          ))}
        </div>
      )}
      {tab === 'sugg' && <div className="panel"><h2>Suggested improvements</h2>{d.suggestions.length ? <ul>{d.suggestions.map((s, i) => <li key={i}>{s}</li>)}</ul> : <p className="empty">No suggestions.</p>}<p className="small muted">Suggestions are not added to the document automatically.</p></div>}
      {tab === 'preview' && <div className="panel"><p className="small muted">This is the document that will be published{d.mode === 'update' ? ', with your accept / reject decisions applied' : ''}.</p><DocPreview doc={d.publishedDoc || d.approvedDoc || d.mergedDoc || doc} shotUrl={shotUrl} /></div>}

      <div className="sticky-actions">
        <div className="row">
          {editable && <button className="btn" onClick={() => save()} disabled={busy || !dirty} data-testid="save">{dirty ? 'Save as draft' : 'Saved'}</button>}
          {editable && isApprover && <><input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Change summary (optional)" style={{ width: 260, marginTop: 0 }} /><button className="btn ok" onClick={approve} disabled={busy || dirty || d.blockers.length > 0} data-testid="approve" title={dirty ? 'Save your edits first' : ''}>✓ Approve</button></>}
          {isApprover && ['draft', 'approved'].includes(d.status) && <button className="btn" onClick={() => setRejectOpen(!rejectOpen)} disabled={busy}>Reject</button>}
          {d.status === 'approved' && isApprover && <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>Name in SharePoint <input value={pubName ?? (d.approvedDoc?.info.fileName || d.approvedDoc?.info.title || '')} onChange={(e) => setPubName(e.target.value)} maxLength={120} style={{ width: 280, marginTop: 0 }} data-testid="publish-name" /></label>}
          {d.status === 'approved' && isApprover && <button className="btn primary" onClick={publish} disabled={busy} data-testid="publish">{busy ? 'Publishing…' : `Publish to ${cfg.repository.mode === 'sharepoint' ? 'SharePoint' : 'repository (local)'}`}</button>}
          {!isApprover && editable && <span className="small muted">An approver will review and publish this draft.</span>}
          {dirty && <span className="small" style={{ color: 'var(--warn)' }}>Unsaved changes</span>}
        </div>
        {rejectOpen && <div className="row" style={{ marginTop: 8 }}><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for rejection" style={{ maxWidth: 500, marginTop: 0 }} /><button className="btn danger" onClick={reject} disabled={busy}>Reject draft</button></div>}
      </div>
    </>
  );
}
