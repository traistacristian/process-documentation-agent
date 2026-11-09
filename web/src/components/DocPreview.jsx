import React, { useState } from 'react';
import { AuthImg, Lightbox, fmtDate, MarksHint } from '../util.jsx';

const List = ({ items }) => (items?.length ? <ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="empty">To be confirmed.</p>);

export default function DocPreview({ doc, shotUrl }) {
  const [zoom, setZoom] = useState(null);
  if (!doc) return null;
  const i = doc.info;
  return (
    <div className="paper preview">
      <Lightbox url={zoom} onClose={() => setZoom(null)} />
      <div className="cover">
        <div className="eyebrow">IT work instruction{i.category ? ` · ${i.category}` : ''}</div>
        <h1>{i.title}</h1>
        {doc.purpose && <p style={{ margin: '0 0 18px', color: 'rgba(255,255,255,.88)', maxWidth: 640 }}>{doc.purpose}</p>}
        <div className="facts">
          <div><span>Process ID</span>{i.processId || '–'}</div><div><span>Version</span>{i.version} · {i.status}</div>
          <div><span>Owner</span>{i.owner || '–'}</div><div><span>Steps</span>{doc.steps.length}</div>
        </div>
      </div>
      <div className="content">
      <h2>1. Process Information</h2>
      <table><tbody>
        {[['Process ID', i.processId], ['Version', i.version], ['Status', i.status], ['Created', fmtDate(i.createdAt)], ['Last updated', fmtDate(i.updatedAt)], ['Process owner', i.owner], ['Department', i.department], ['Category', i.category], ['Author', i.author], ['Reviewer / approver', i.approver]].map(([k, v]) => <tr key={k}><th style={{ width: 200 }}>{k}</th><td>{v || '–'}</td></tr>)}
      </tbody></table>
      <h2>2. Purpose</h2>{doc.purpose ? <p style={{ whiteSpace: 'pre-wrap' }}>{doc.purpose}</p> : <p className="empty">To be confirmed.</p>}
      <h2>3. Scope</h2><b>Included</b><List items={doc.scope.included} /><b>Excluded</b><List items={doc.scope.excluded} />
      <h2>4. Prerequisites</h2>
      {[['permissions', 'Required permissions'], ['access', 'Required access'], ['systems', 'Applications and systems'], ['information', 'Required information'], ['dependencies', 'Dependencies']].map(([k, l]) => <div key={k}><b>{l}</b><List items={doc.prerequisites[k]} /></div>)}
      <h2>5. Roles and Responsibilities</h2>
      {doc.roles.length ? <table><thead><tr><th>Role</th><th>Responsibilities</th></tr></thead><tbody>{doc.roles.map((r, k) => <tr key={k}><td>{r.role}</td><td>{r.responsibilities}</td></tr>)}</tbody></table> : <p className="empty">To be confirmed.</p>}
      <h2>6. Process Execution – Step by Step</h2>
      {doc.steps.map((s) => (
        <div key={s.id} className={`step ${s.important ? 'important' : ''}`}>
          <div className="step-head"><div className="step-num">{s.number}</div><h3 style={{ margin: 0 }}>{s.title}</h3>{s.important && <span className="imp-badge" title="A mistake here is costly or hard to undo">★ Important step</span>}</div>
          {s.description && <p>{s.description}</p>}
          <ol>{s.instructions.map((x, k) => <li key={k}>{x}</li>)}</ol>
          <div className="kv small"><div>Application / system</div><div>{s.application || '–'}</div><div>Required input</div><div>{s.input || '–'}</div><div>Expected result</div><div>{s.expectedResult || 'To be confirmed.'}</div></div>
          {s.notes.map((n, k) => <p key={k} className="small"><b>Note:</b> {n}</p>)}
          {s.warnings.map((w, k) => <p key={k} className="warn-line">⚠ {w}</p>)}
          {shotUrl && s.screenshotIds.length > 0 && <div className="shots">{s.screenshotIds.map((id) => <figure key={id}><AuthImg src={shotUrl(id)} alt={`Step ${s.number}`} onClick={setZoom} /></figure>)}</div>}
          {shotUrl && <MarksHint step={s} />}
        </div>
      ))}
      <h2>7. Decision Points and Exceptions</h2>
      {doc.decisions.length ? <ul>{doc.decisions.map((x, k) => <li key={k}><b>If</b> {x.condition} <b>then</b> {x.action}</li>)}</ul> : <p className="empty">No decision points recorded.</p>}
      {doc.exceptions.length > 0 && <table><thead><tr><th>Problem</th><th>Handling</th><th>Escalation</th></tr></thead><tbody>{doc.exceptions.map((e, k) => <tr key={k}><td>{e.problem}</td><td>{e.handling || 'To be confirmed.'}</td><td>{e.escalation || 'To be confirmed.'}</td></tr>)}</tbody></table>}
      <h2>8. Expected Outcome</h2>{doc.expectedOutcome ? <p>{doc.expectedOutcome}</p> : <p className="empty">To be confirmed.</p>}{doc.verification.length > 0 && <List items={doc.verification} />}
      <h2>9. Troubleshooting</h2>{doc.troubleshooting.length ? <ul>{doc.troubleshooting.map((t, k) => <li key={k}><b>{t.issue}:</b> {t.resolution}</li>)}</ul> : <p className="empty">No known issues recorded.</p>}
      <h2>10. Related Documentation</h2>{doc.related.length ? <ul>{doc.related.map((r, k) => <li key={k}><a href={r.url} target="_blank" rel="noreferrer">{r.title}</a></li>)}</ul> : <p className="empty">None.</p>}
      <h2>11. Change History</h2>
      {doc.changeHistory.length ? <table><thead><tr><th>Version</th><th>Date</th><th>Author</th><th>Approver</th><th>Summary</th></tr></thead><tbody>{doc.changeHistory.map((c, k) => <tr key={k}><td>{c.version}</td><td>{fmtDate(c.date)}</td><td>{c.author}</td><td>{c.approver}</td><td>{c.summary}</td></tr>)}</tbody></table> : <p className="empty">Not yet approved.</p>}
      </div>
    </div>
  );
}
