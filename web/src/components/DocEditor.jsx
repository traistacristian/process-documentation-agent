import React, { useState } from 'react';
import { AuthImg, Lightbox, MarksHint } from '../util.jsx';

const toLines = (t) => t.split('\n').map((x) => x.trim()).filter(Boolean);
const LinesField = ({ label, value, onChange, disabled, testid }) => (
  <label className="f">{label} <span className="opt">(one per line)</span>
    <textarea value={(value || []).join('\n')} onChange={(e) => onChange(e.target.value.split('\n'))} onBlur={(e) => onChange(toLines(e.target.value))} disabled={disabled} data-testid={testid} />
  </label>
);

// Which of the ten sections are filled in; drives the progress bar on the review page.
export function sectionStatus(doc) {
  const has = (a) => (a || []).some((x) => String(x).trim());
  return [
    { n: 1, title: 'Process information', done: !!(doc.info.title && doc.info.owner && doc.info.department) },
    { n: 2, title: 'Purpose', done: !!doc.purpose.trim() },
    { n: 3, title: 'Scope', done: has(doc.scope.included) },
    { n: 4, title: 'Prerequisites', done: has(doc.prerequisites.permissions) || has(doc.prerequisites.access) },
    { n: 5, title: 'Roles', done: doc.roles.length > 0 },
    { n: 6, title: 'Steps', done: doc.steps.length > 0 && doc.steps.every((x) => x.instructions.length && !x.warnings.length) },
    { n: 7, title: 'Decisions', done: doc.decisions.length + doc.exceptions.length > 0, optional: true },
    { n: 8, title: 'Outcome', done: !!doc.expectedOutcome.trim() },
    { n: 9, title: 'Troubleshooting', done: doc.troubleshooting.length > 0, optional: true },
    { n: 10, title: 'Related', done: doc.related.length > 0, optional: true },
  ];
}

// Search keywords as removable chips; type and press Enter or comma to add one.
function KeywordsField({ value, onChange, disabled }) {
  const [t, setT] = useState('');
  const add = (raw) => {
    const parts = raw.split(/[,;]/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const next = [...value];
    for (const x of parts) if (!next.some((k) => k.toLowerCase() === x.toLowerCase())) next.push(x.slice(0, 60));
    onChange(next.slice(0, 20)); setT('');
  };
  return (
    <div className="f" style={{ marginTop: 10 }}>
      Keywords <span className="opt">(used by the search; the systems, objects and actions people would type)</span>
      <div className="tags edit" data-testid="keywords">
        {value.map((k) => <span key={k} className="tag">{k}{!disabled && <button type="button" aria-label={`Remove ${k}`} onClick={() => onChange(value.filter((x) => x !== k))}>✕</button>}</span>)}
        {!disabled && value.length < 20 && <input value={t} placeholder={value.length ? 'Add keyword…' : 'e.g. password, reset, MFA'} onChange={(e) => (/[,;]/.test(e.target.value) ? add(e.target.value) : setT(e.target.value))}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (t.trim()) add(t); } else if (e.key === 'Backspace' && !t && value.length) onChange(value.slice(0, -1)); }}
          onBlur={() => t.trim() && add(t)} data-testid="keyword-input" />}
      </div>
    </div>
  );
}

const Sec = ({ st, title, children, right }) => (
  <details className="panel sec" open id={`sec-${st.n}`}>
    <summary><span className={`check ${st.done ? 'on' : ''}`}>✓</span><h2>{st.n}. {title}</h2>{st.optional && !st.done && <span className="small muted">optional</span>}{right}</summary>
    <div className="body">{children}</div>
  </details>
);

export default function DocEditor({ doc, onChange, shotUrl, readOnly }) {
  const [zoom, setZoom] = useState(null);
  const st = sectionStatus(doc);
  const set = (path, v) => {
    const d = structuredClone(doc); let o = d; const p = path.split('.');
    for (const k of p.slice(0, -1)) o = o[k];
    o[p.at(-1)] = v; onChange(d);
  };
  const setStep = (i, k, v) => { const d = structuredClone(doc); d.steps[i][k] = v; onChange(d); };
  const moveStep = (i, dir) => { const d = structuredClone(doc); const [x] = d.steps.splice(i, 1); d.steps.splice(i + dir, 0, x); d.steps.forEach((s, n) => { s.number = n + 1; }); onChange(d); };
  const delStep = (i) => { const d = structuredClone(doc); d.steps.splice(i, 1); d.steps.forEach((s, n) => { s.number = n + 1; }); onChange(d); };
  const addStep = () => { const d = structuredClone(doc); d.steps.push({ id: `stp_${Math.random().toString(16).slice(2, 10)}`, number: d.steps.length + 1, title: 'New step', description: '', instructions: [], application: '', input: '', expectedResult: '', screenshotIds: [], notes: [], warnings: [], important: false, evidenceEventSeqs: [], targets: [], marks: [] }); onChange(d); };
  const pairs = (key, fields, labels) => (
    <div>
      {doc[key].map((row, i) => (
        <div key={i} className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', marginBottom: 6 }}>
          {fields.map((f, k) => <textarea key={f} placeholder={labels[k]} value={row[f] ?? ''} disabled={readOnly} style={{ minHeight: 38 }} onChange={(e) => { const d = structuredClone(doc); d[key][i][f] = e.target.value; onChange(d); }} />)}
          {!readOnly && <button className="btn sm" style={{ marginTop: 6 }} onClick={() => { const d = structuredClone(doc); d[key].splice(i, 1); onChange(d); }}>✕</button>}
        </div>
      ))}
      {!readOnly && <button className="btn sm" onClick={() => { const d = structuredClone(doc); d[key].push({ ...(key === 'decisions' ? { stepNumber: null } : {}), ...Object.fromEntries(fields.map((f) => [f, ''])) }); onChange(d); }}>+ Add</button>}
    </div>
  );

  return (
    <div>
      <Lightbox url={zoom} onClose={() => setZoom(null)} />
      <Sec st={st[0]} title="Process information">
        <div className="grid g3" style={{ gap: 12 }}>
          <label className="f">Process title<input value={doc.info.title} disabled={readOnly} onChange={(e) => set('info.title', e.target.value)} /></label>
          <label className="f">Process owner<input value={doc.info.owner} disabled={readOnly} onChange={(e) => set('info.owner', e.target.value)} /></label>
          <label className="f">Responsible department<input value={doc.info.department} disabled={readOnly} onChange={(e) => set('info.department', e.target.value)} /></label>
        </div>
        <KeywordsField value={doc.keywords || []} onChange={(v) => set('keywords', v)} disabled={readOnly} />
        <p className="small muted">Process ID {doc.info.processId} · version {doc.info.version} (assigned at approval) · author {doc.info.author}</p>
      </Sec>
      <Sec st={st[1]} title="Purpose">
        <textarea value={doc.purpose} disabled={readOnly} onChange={(e) => set('purpose', e.target.value)} placeholder="Why does this process exist and what does it achieve?" data-testid="purpose" />
      </Sec>
      <Sec st={st[2]} title="Scope">
        <div className="grid g2" style={{ gap: 12 }}>
          <LinesField label="Included" value={doc.scope.included} onChange={(v) => set('scope.included', v)} disabled={readOnly} />
          <LinesField label="Excluded" value={doc.scope.excluded} onChange={(v) => set('scope.excluded', v)} disabled={readOnly} />
        </div>
      </Sec>
      <Sec st={st[3]} title="Prerequisites">
        <div className="grid g2" style={{ gap: 12 }}>
          {[['permissions', 'Required permissions'], ['access', 'Required access'], ['systems', 'Applications and systems'], ['information', 'Required information'], ['dependencies', 'Dependencies']].map(([k, l]) => <LinesField key={k} label={l} value={doc.prerequisites[k]} onChange={(v) => set(`prerequisites.${k}`, v)} disabled={readOnly} />)}
        </div>
      </Sec>
      <Sec st={st[4]} title="Roles and responsibilities">
        {pairs('roles', ['role', 'responsibilities'], ['Role', 'Responsibilities'])}
      </Sec>
      <Sec st={st[5]} title="Process execution – step by step" right={!readOnly && <button className="btn sm" onClick={(e) => { e.preventDefault(); addStep(); }}>+ Add step</button>}>
        {doc.steps.map((s, i) => (
          <div key={s.id} className={`step ${s.important ? 'important' : ''}`} data-testid="step">
            <div className="step-head">
              <div className="step-num">{s.number}</div>
              <input value={s.title} disabled={readOnly} onChange={(e) => setStep(i, 'title', e.target.value)} style={{ fontWeight: 600, marginTop: 0 }} data-testid="step-title" />
              {readOnly ? s.important && <span className="imp-badge">★ Important step</span>
                : <label className="imp-toggle" title="Highlight this step in the document: a mistake here is costly or hard to undo"><input type="checkbox" checked={!!s.important} onChange={(e) => setStep(i, 'important', e.target.checked)} data-testid="step-important" />★ Important</label>}
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
            <MarksHint step={s} />
            <p className="small muted" style={{ marginBottom: 0 }}>{s.evidenceEventSeqs.length ? `Based on ${s.evidenceEventSeqs.length} recorded action(s).` : 'Added manually – not based on recorded actions.'}</p>
          </div>
        ))}
      </Sec>
      <Sec st={st[6]} title="Decision points and exceptions">
        <h3>Decision points</h3>
        {pairs('decisions', ['condition', 'action'], ['If (condition)…', '…then (action)'])}
        <h3 style={{ marginTop: 12 }}>Exceptions and error handling</h3>
        {pairs('exceptions', ['problem', 'handling', 'escalation'], ['Problem', 'Handling / recovery', 'Escalation path'])}
      </Sec>
      <Sec st={st[7]} title="Expected outcome">
        <textarea value={doc.expectedOutcome} disabled={readOnly} onChange={(e) => set('expectedOutcome', e.target.value)} />
        <LinesField label="Verification checks" value={doc.verification} onChange={(v) => set('verification', v)} disabled={readOnly} />
      </Sec>
      <Sec st={st[8]} title="Troubleshooting">
        {pairs('troubleshooting', ['issue', 'resolution'], ['Known issue', 'Solution'])}
      </Sec>
      <Sec st={st[9]} title="Related documentation">
        {pairs('related', ['title', 'url'], ['Title', 'Link (SharePoint, wiki…)'])}
      </Sec>
    </div>
  );
}
