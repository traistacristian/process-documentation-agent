import React, { useState } from 'react';
import { AuthImg, Lightbox } from '../util.jsx';

const toLines = (t) => t.split('\n').map((x) => x.trim()).filter(Boolean);
const LinesField = ({ label, value, onChange, disabled, testid }) => (
  <label className="f">{label} <span className="opt">(one per line)</span>
    <textarea value={(value || []).join('\n')} onChange={(e) => onChange(e.target.value.split('\n'))} onBlur={(e) => onChange(toLines(e.target.value))} disabled={disabled} data-testid={testid} />
  </label>
);

export default function DocEditor({ doc, onChange, shotUrl, readOnly }) {
  const [zoom, setZoom] = useState(null);
  const set = (path, v) => {
    const d = structuredClone(doc); let o = d; const p = path.split('.');
    for (const k of p.slice(0, -1)) o = o[k];
    o[p.at(-1)] = v; onChange(d);
  };
  const setStep = (i, k, v) => { const d = structuredClone(doc); d.steps[i][k] = v; onChange(d); };
  const moveStep = (i, dir) => { const d = structuredClone(doc); const [x] = d.steps.splice(i, 1); d.steps.splice(i + dir, 0, x); d.steps.forEach((s, n) => { s.number = n + 1; }); onChange(d); };
  const delStep = (i) => { const d = structuredClone(doc); d.steps.splice(i, 1); d.steps.forEach((s, n) => { s.number = n + 1; }); onChange(d); };
  const addStep = () => { const d = structuredClone(doc); d.steps.push({ id: `stp_${Math.random().toString(16).slice(2, 10)}`, number: d.steps.length + 1, title: 'New step', description: '', instructions: [], application: '', input: '', expectedResult: '', screenshotIds: [], notes: [], warnings: [], important: false, evidenceEventSeqs: [] }); onChange(d); };
  const pairs = (key, fields, labels) => (
    <div>
      {doc[key].map((row, i) => (
        <div key={i} className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', marginBottom: 6 }}>
          {fields.map((f, k) => <textarea key={f} placeholder={labels[k]} value={row[f] ?? ''} disabled={readOnly} style={{ minHeight: 38 }} onChange={(e) => { const d = structuredClone(doc); d[key][i][f] = e.target.value; onChange(d); }} />)}
          {!readOnly && <button className="btn sm" style={{ marginTop: 6 }} onClick={() => { const d = structuredClone(doc); d[key].splice(i, 1); onChange(d); }}>✕</button>}
        </div>
      ))}
      {!readOnly && <button className="btn sm" onClick={() => { const d = structuredClone(doc); d[key].push(Object.fromEntries(fields.map((f) => [f, f === 'stepNumber' ? null : '']))); onChange(d); }}>+ Add</button>}
    </div>
  );

  return (
    <div>
      <Lightbox url={zoom} onClose={() => setZoom(null)} />
      <section className="panel">
        <h2>1. Process information</h2>
        <div className="grid g3" style={{ gap: 12 }}>
          <label className="f">Process title<input value={doc.info.title} disabled={readOnly} onChange={(e) => set('info.title', e.target.value)} /></label>
          <label className="f">Process owner<input value={doc.info.owner} disabled={readOnly} onChange={(e) => set('info.owner', e.target.value)} /></label>
          <label className="f">Responsible department<input value={doc.info.department} disabled={readOnly} onChange={(e) => set('info.department', e.target.value)} /></label>
        </div>
        <p className="small muted">Process ID {doc.info.processId} · version {doc.info.version} (assigned at approval) · author {doc.info.author}</p>
      </section>
      <section className="panel">
        <h2>2. Purpose</h2>
        <textarea value={doc.purpose} disabled={readOnly} onChange={(e) => set('purpose', e.target.value)} placeholder="Why does this process exist and what does it achieve?" data-testid="purpose" />
        <h2 style={{ marginTop: 16 }}>3. Scope</h2>
        <div className="grid g2" style={{ gap: 12 }}>
          <LinesField label="Included" value={doc.scope.included} onChange={(v) => set('scope.included', v)} disabled={readOnly} />
          <LinesField label="Excluded" value={doc.scope.excluded} onChange={(v) => set('scope.excluded', v)} disabled={readOnly} />
        </div>
      </section>
      <section className="panel">
        <h2>4. Prerequisites</h2>
        <div className="grid g2" style={{ gap: 12 }}>
          {[['permissions', 'Required permissions'], ['access', 'Required access'], ['systems', 'Applications and systems'], ['information', 'Required information'], ['dependencies', 'Dependencies']].map(([k, l]) => <LinesField key={k} label={l} value={doc.prerequisites[k]} onChange={(v) => set(`prerequisites.${k}`, v)} disabled={readOnly} />)}
        </div>
        <h2 style={{ marginTop: 8 }}>5. Roles and responsibilities</h2>
        {pairs('roles', ['role', 'responsibilities'], ['Role', 'Responsibilities'])}
      </section>

      <section className="panel">
        <div className="row between"><h2>6. Process execution – step by step</h2>{!readOnly && <button className="btn sm" onClick={addStep}>+ Add step</button>}</div>
        {doc.steps.map((s, i) => (
          <div key={s.id} className={`step ${s.important ? 'important' : ''}`} data-testid="step">
            <div className="step-head">
              <div className="step-num">{s.number}</div>
              <input value={s.title} disabled={readOnly} onChange={(e) => setStep(i, 'title', e.target.value)} style={{ fontWeight: 600, marginTop: 0 }} data-testid="step-title" />
              {!readOnly && <div className="row" style={{ flexWrap: 'nowrap' }}>
                <button className="btn sm" disabled={i === 0} onClick={() => moveStep(i, -1)} title="Move up">↑</button>
                <button className="btn sm" disabled={i === doc.steps.length - 1} onClick={() => moveStep(i, 1)} title="Move down">↓</button>
                <button className="btn sm" onClick={() => delStep(i)} title="Delete step">✕</button>
              </div>}
            </div>
            <label className="f">Description<textarea value={s.description} disabled={readOnly} onChange={(e) => setStep(i, 'description', e.target.value)} style={{ minHeight: 40 }} /></label>
            <LinesField label="Instructions" value={s.instructions} onChange={(v) => setStep(i, 'instructions', v)} disabled={readOnly} testid="step-instructions" />
            <div className="grid g3" style={{ gap: 12 }}>
              <label className="f">Application / system<input value={s.application} disabled={readOnly} onChange={(e) => setStep(i, 'application', e.target.value)} /></label>
              <label className="f">Required input<input value={s.input} disabled={readOnly} onChange={(e) => setStep(i, 'input', e.target.value)} /></label>
              <label className="f">Expected result<input value={s.expectedResult} disabled={readOnly} onChange={(e) => setStep(i, 'expectedResult', e.target.value)} /></label>
            </div>
            <LinesField label="Notes" value={s.notes} onChange={(v) => setStep(i, 'notes', v)} disabled={readOnly} />
            {s.warnings.map((w, k) => (
              <div key={k} className="warn-line">⚠ {w} {!readOnly && <button className="btn sm" onClick={() => setStep(i, 'warnings', s.warnings.filter((_, j) => j !== k))} data-testid="confirm-warning">{w.startsWith('Not supported') ? 'Confirm step' : 'Dismiss'}</button>}</div>
            ))}
            {s.screenshotIds.length > 0 && <div className="shots">{s.screenshotIds.map((id) => (
              <figure key={id}><AuthImg src={shotUrl(id)} alt={`Step ${s.number}`} onClick={setZoom} />{!readOnly && <button className="btn sm" title="Remove screenshot" onClick={() => setStep(i, 'screenshotIds', s.screenshotIds.filter((x) => x !== id))}>✕</button>}</figure>
            ))}</div>}
            <p className="small muted" style={{ marginBottom: 0 }}>{s.evidenceEventSeqs.length ? `Based on ${s.evidenceEventSeqs.length} recorded action(s).` : 'Added manually – not based on recorded actions.'}</p>
          </div>
        ))}
      </section>

      <section className="panel">
        <h2>7. Decision points and exceptions</h2>
        <h3>Decision points</h3>
        {pairs('decisions', ['condition', 'action'], ['If (condition)…', '…then (action)'])}
        <h3 style={{ marginTop: 12 }}>Exceptions and error handling</h3>
        {pairs('exceptions', ['problem', 'handling', 'escalation'], ['Problem', 'Handling / recovery', 'Escalation path'])}
      </section>
      <section className="panel">
        <h2>8. Expected outcome</h2>
        <textarea value={doc.expectedOutcome} disabled={readOnly} onChange={(e) => set('expectedOutcome', e.target.value)} />
        <LinesField label="Verification checks" value={doc.verification} onChange={(v) => set('verification', v)} disabled={readOnly} />
        <h2>9. Troubleshooting</h2>
        {pairs('troubleshooting', ['issue', 'resolution'], ['Known issue', 'Solution'])}
        <h2 style={{ marginTop: 12 }}>10. Related documentation</h2>
        {pairs('related', ['title', 'url'], ['Title', 'Link (SharePoint, wiki…)'])}
      </section>
    </div>
  );
}
