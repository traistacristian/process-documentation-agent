import React from 'react';

const LABEL = { unchanged: 'Unchanged', modified: 'Modified', added: 'New step', removed: 'Removed', moved: 'Moved' };
const StepCell = ({ s }) => (s ? (
  <div className="cell"><h4>{s.number}. {s.title}</h4><ol>{s.instructions.map((x, i) => <li key={i}>{x}</li>)}</ol>{s.application && <div className="small muted">{s.application}</div>}</div>
) : <div className="cell empty">—</div>);

function Decision({ id, value, onChange, disabled }) {
  return (
    <div className="seg" data-testid={`decision-${id}`}>
      <button className={`acc ${value === 'accept' ? 'on' : ''}`} onClick={() => onChange(id, 'accept')} disabled={disabled}>Accept</button>
      <button className={`rej ${value === 'reject' ? 'on' : ''}`} onClick={() => onChange(id, 'reject')} disabled={disabled}>Reject</button>
    </div>
  );
}

export default function DiffView({ baseDoc, doc, comparison, decisions, onDecide, onDecideAll, readOnly }) {
  const { changes, sectionChanges, inconsistencies, summary } = comparison;
  const rows = changes.filter((c) => !(c.kind === 'moved' && c.role === 'origin'));
  return (
    <div>
      <div className="row between" style={{ marginBottom: 12 }}>
        <div className="row" data-testid="diff-summary">
          {['unchanged', 'modified', 'added', 'removed', 'moved'].map((k) => <span key={k} className={`badge ${k}`}>{summary[k]} {LABEL[k].toLowerCase()}</span>)}
          {summary.sectionChanges > 0 && <span className="badge modified">{summary.sectionChanges} section change(s)</span>}
        </div>
        {!readOnly && <div className="row"><button className="btn sm ok" onClick={() => onDecideAll('accept')} data-testid="accept-all">Accept all changes</button><button className="btn sm" onClick={() => onDecideAll('reject')}>Reject all</button></div>}
      </div>
      {inconsistencies.map((t, i) => <div key={i} className="alert warn small">⚠ {t}</div>)}
      <div className="diff-head"><div>Current version {baseDoc.info.version}</div><div>Proposed (new recording)</div><div>Decision</div></div>
      {rows.map((c) => {
        const o = c.oldIndex !== null ? baseDoc.steps[c.oldIndex] : null;
        const n = c.newIndex !== null ? doc.steps[c.newIndex] : null;
        const decisionId = c.kind === 'moved' ? c.pairId : c.id;
        return (
          <div key={c.id} className={`diff-row ${c.kind}`} data-testid="diff-row" data-kind={c.kind}>
            <StepCell s={c.kind === 'added' ? null : o} />
            <StepCell s={c.kind === 'removed' ? null : n} />
            <div>
              <span className={`badge ${c.kind}`}>{LABEL[c.kind]}{c.kind === 'unchanged' && c.renumbered ? ` (now step ${c.newNumber})` : ''}</span>
              {c.kind === 'modified' && <div className="small muted" style={{ margin: '4px 0' }}>Changed: {c.fields.map((f) => f.field).join(', ')}</div>}
              {c.kind === 'moved' && <div className="small muted" style={{ margin: '4px 0' }}>Was step {o?.number}, now step {n?.number}</div>}
              {c.kind === 'removed' && <div className="small muted" style={{ margin: '4px 0' }}>Not performed in the new recording</div>}
              {c.kind !== 'unchanged' && <div style={{ marginTop: 6 }}><Decision id={decisionId} value={decisions[decisionId]} onChange={onDecide} disabled={readOnly} /></div>}
            </div>
          </div>
        );
      })}
      {sectionChanges.length > 0 && <h3 style={{ marginTop: 16 }}>Other section changes</h3>}
      {sectionChanges.map((c) => (
        <div key={c.id} className={`diff-row ${c.kind}`}>
          <div className="cell">{c.kind === 'removed' ? <><b>{c.section}</b>: {JSON.stringify(c.before).replace(/"/g, '')}</> : <span className="empty">—</span>}</div>
          <div className="cell">{c.kind === 'added' ? <><b>{c.section}</b>: {JSON.stringify(c.after).replace(/"/g, '')}</> : <span className="empty">—</span>}</div>
          <div><span className={`badge ${c.kind}`}>{c.kind}</span><div style={{ marginTop: 6 }}><Decision id={c.id} value={decisions[c.id]} onChange={onDecide} disabled={readOnly} /></div></div>
        </div>
      ))}
      <p className="small muted">Rejecting a change keeps the current approved content. Unchanged steps keep their approved wording. The previous version stays in the repository's version history.</p>
    </div>
  );
}
