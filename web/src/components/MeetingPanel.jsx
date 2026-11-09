// Suggestions from meeting recordings on the review page: answers to open questions, details for
// steps, missing steps and unclear topics worth documenting. Each one is accepted or rejected.
import React, { useState } from 'react';
import { AuthImg, Lightbox, fmtDate } from '../util.jsx';

const mmss = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
const GROUPS = [
  ['answer', 'Answers to open questions'],
  ['note', 'Details for existing steps'],
  ['step', 'Steps missing from the draft'],
  ['topic', 'Unclear topics that should be documented'],
];

export default function MeetingPanel({ d, shotUrl, onDecide, readOnly, busy, dirty }) {
  const [zoom, setZoom] = useState(null); const [edits, setEdits] = useState({}); const [copied, setCopied] = useState(false);
  const meetings = [...(d.meetings || [])].reverse();
  const q = (id) => d.clarifications.find((c) => c.id === id)?.question;
  const summary = (m) => {
    const topics = m.suggestions.filter((s) => s.kind === 'topic' && s.status !== 'rejected');
    const added = m.suggestions.filter((s) => s.kind !== 'topic' && s.status === 'accepted');
    return [`Summary of the meeting on ${fmtDate(m.startedAt)} for "${d.doc.info.title}"`, '',
      ...(added.length ? ['Added to the work instruction:', ...added.map((s) => `- ${s.kind === 'step' ? `New step: ${s.title}` : s.text}`), ''] : []),
      ...(topics.length ? ['Topics that seemed unclear and should be documented:', ...topics.map((s) => `- ${s.title}: ${s.text}`), '', 'Could the person who knows each topic best record it with the Process Documentation Agent?'] : ['No unclear topics were found.'])].join('\n');
  };
  const copy = async (m) => { try { await navigator.clipboard.writeText(summary(m)); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { window.prompt('Copy the summary:', summary(m)); } };

  return (
    <div>
      <Lightbox url={zoom} onClose={() => setZoom(null)} />
      {meetings.map((m) => (
        <div key={m.id} className="panel" data-testid="meeting">
          <div className="row between">
            <h2 style={{ margin: 0 }}>Meeting on {fmtDate(m.startedAt)}</h2>
            <span className="small muted">started by {m.startedBy} · {m.frames.length} screenshots{m.stoppedAt ? ` · ${mmss(m.stoppedAt - m.startedAt)} long` : ''}</span>
          </div>
          {m.status === 'recording' && <p className="small">Recording is still running. <a href={`#/meeting/${d.id}`}>Open the recording</a></p>}
          {['transcribing', 'analysing'].includes(m.status) && <div className="row" style={{ marginTop: 12 }}><span className="spinner" /><span>{m.status === 'transcribing' ? 'Transcribing the conversation…' : 'Looking for answers, missing steps and unclear topics…'}</span></div>}
          {m.status === 'failed' && <div className="alert err" style={{ marginTop: 12 }}>The meeting could not be analysed: {m.error}</div>}
          {m.status === 'done' && (
            <>
              <p className="small muted">{m.suggestions.length ? `${m.suggestions.filter((s) => s.status === 'open').length} of ${m.suggestions.length} suggestions still to decide.` : 'The meeting did not add anything new to this draft.'} The audio was deleted after transcription.</p>
              {dirty && <div className="alert warn small">Save your edits first, then accept suggestions.</div>}
              {GROUPS.map(([kind, label]) => {
                const items = m.suggestions.filter((s) => s.kind === kind);
                if (!items.length) return null;
                return (
                  <div key={kind} style={{ marginTop: 14 }}>
                    <h3>{label}</h3>
                    {items.map((s) => (
                      <div key={s.id} className="step" data-testid="meeting-suggestion">
                        <div className="row between"><b>{kind === 'answer' ? q(s.clarificationId) || 'Open question' : kind === 'note' ? `Step ${s.stepNumber}` : kind === 'step' ? `New step${s.stepNumber ? ` after step ${s.stepNumber}` : ' at the start'}: ${s.title || ''}` : s.title}</b>
                          <span className={`badge ${s.status === 'accepted' ? 'published' : s.status === 'rejected' ? 'rejected' : ''}`}>{s.status === 'open' ? `at ${mmss(s.atMs)}` : s.status}</span></div>
                        {s.status === 'open' && !readOnly && ['answer', 'note'].includes(kind)
                          ? <textarea value={edits[s.id] ?? s.text} onChange={(e) => setEdits({ ...edits, [s.id]: e.target.value })} style={{ minHeight: 44 }} />
                          : <p style={{ margin: '6px 0' }}>{s.text}</p>}
                        {kind === 'step' && s.instructions?.length > 0 && <ol className="small" style={{ margin: '4px 0' }}>{s.instructions.map((x, i) => <li key={i}>{x}</li>)}</ol>}
                        {s.quote && <p className="small muted" style={{ margin: '4px 0', fontStyle: 'italic' }}>“{s.quote}” · {mmss(s.atMs)}</p>}
                        {s.screenshotId && <div className="shots" style={{ maxWidth: 420 }}><figure><AuthImg src={shotUrl(s.screenshotId)} alt={`Meeting at ${mmss(s.atMs)}`} onClick={setZoom} /></figure></div>}
                        {s.status === 'open' && !readOnly && (
                          <div className="row" style={{ marginTop: 8 }}>
                            {kind === 'topic'
                              ? <><a className="btn sm primary" href={`#/new?name=${encodeURIComponent(s.title)}&why=${encodeURIComponent(s.text)}`} onClick={() => onDecide(m, s, 'accept')}>● Record this process</a><button className="btn sm" disabled={busy} onClick={() => onDecide(m, s, 'reject')}>Not needed</button></>
                              : <><button className="btn sm ok" disabled={busy || dirty} onClick={() => onDecide(m, s, 'accept', edits[s.id])} data-testid="meeting-accept">✓ Add to document</button><button className="btn sm" disabled={busy} onClick={() => onDecide(m, s, 'reject')} data-testid="meeting-reject">Reject</button></>}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
              <div className="row" style={{ marginTop: 12 }}><button className="btn sm" onClick={() => copy(m)} data-testid="meeting-summary">{copied ? '✓ Copied' : 'Copy summary for the participants'}</button><span className="small muted">Paste it into the meeting chat or an e-mail, so the participants know what was added and what still needs documenting.</span></div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
