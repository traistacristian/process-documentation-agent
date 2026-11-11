// Teams meetings as a source: find a meeting (pasted link, or the meeting itself when the app runs in
// a Teams meeting), analyse its transcript, then create new drafts or open existing documents for an
// update. Nothing is changed until someone opens a draft and accepts what the meeting adds.
import React, { useEffect, useState } from 'react';
import { api, getConfig, inTeams, teamsContext, teamsSdk } from '../api.js';
import { fmtDate, go, usePoll } from '../util.jsx';

const mmss = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
const GROUPS = [
  ['update', 'Existing documents the meeting updates', 'Open an update draft'],
  ['new', 'New documents the meeting explains', 'Create a draft'],
  ['topic', 'Unclear topics that should be documented', 'Draft anyway'],
];

export function TeamsImport({ importId }) {
  const cfg = getConfig();
  if (!cfg.teams) {
    return (
      <div className="panel"><h1>Document from a Teams meeting</h1>
        <p>Not set up yet. An administrator runs <code>scripts/Enable-TeamsApp.ps1</code> once and uploads the Teams app (Administration → Microsoft Teams).</p></div>
    );
  }
  return importId ? <ImportView id={importId} /> : <FindMeeting />;
}

function FindMeeting() {
  const ctx = teamsContext();
  const chatId = ctx?.chat?.id && ['sidePanel', 'meetingStage', 'content'].includes(ctx.page?.frameContext) && ctx.meeting?.id ? ctx.chat.id : '';
  const [link, setLink] = useState(''); const [meeting, setMeeting] = useState(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const [language, setLanguage] = useState(/^de/i.test(ctx?.app?.locale || navigator.language || '') ? 'de' : 'en');
  const [past, setPast] = useState([]);
  useEffect(() => { api('/api/teams/imports').then(setPast).catch(() => {}); }, []);
  const find = async (q) => {
    setBusy(true); setErr(null); setMeeting(null);
    try { setMeeting(await api(`/api/teams/meeting?${new URLSearchParams(q)}`)); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  useEffect(() => { if (chatId) find({ chatId }); }, [chatId]);
  const analyse = async (t) => {
    setBusy(true); setErr(null);
    try {
      const x = await api('/api/teams/imports', { method: 'POST', body: { meetingId: meeting.id, transcriptId: t.id, subject: meeting.subject, startDateTime: meeting.startDateTime, language } });
      go(`#/teams/${x.id}`);
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <div className="teams">
      <div className="panel">
        <h1>Document from a Teams meeting</h1>
        <p className="muted">The agent reads the meeting transcript and suggests which work instructions to update, which new ones to draft and which topics were unclear. You decide on every change.</p>
        {!chatId && (
          <form className="row" onSubmit={(e) => { e.preventDefault(); find({ joinUrl: link }); }} style={{ alignItems: 'flex-end' }}>
            <label style={{ flex: 1, minWidth: 240 }}>Meeting link<input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://teams.microsoft.com/l/meetup-join/…" data-testid="teams-link" /></label>
            <button className="btn primary" disabled={busy || !link.trim()} data-testid="teams-find">Find the transcript</button>
          </form>
        )}
        <p className="small muted">{chatId ? 'This is the meeting you are in.' : 'In Teams: open the meeting in the calendar → copy the join link.'} Transcription must be switched on in the meeting. Only the organiser (or a co-organiser) can import a transcript.</p>
        {busy && <div className="row"><span className="spinner" /><span>{meeting ? 'Reading the transcript and comparing it with the library…' : 'Looking for the meeting…'}</span></div>}
        {err && <div className="alert err">{err}</div>}
        {meeting && (
          <div className="step" data-testid="teams-meeting">
            <div className="row between"><b>{meeting.subject || 'Meeting without subject'}</b><span className="small muted">{fmtDate(meeting.startDateTime)}</span></div>
            {!meeting.transcripts.length && <p className="small">No transcript yet. {chatId ? 'It appears here a few minutes after the meeting ends, if transcription was on.' : 'Was transcription switched on? It appears a few minutes after the meeting ends.'}</p>}
            {meeting.transcripts.length > 0 && (
              <div className="row" style={{ marginTop: 8 }}>
                <label className="small">Language of the documents <select value={language} onChange={(e) => setLanguage(e.target.value)}><option value="en">English</option><option value="de">Deutsch</option></select></label>
                {meeting.transcripts.map((t, i) => <button key={t.id} className="btn primary" disabled={busy} onClick={() => analyse(t)} data-testid="teams-analyse">Analyse {meeting.transcripts.length > 1 ? `transcript ${i + 1} (${fmtDate(t.createdDateTime)})` : 'the transcript'}</button>)}
              </div>
            )}
          </div>
        )}
      </div>
      {past.length > 0 && (
        <div className="panel">
          <h2>Earlier meetings</h2>
          {past.map((x) => <a key={x.id} className="step row between" href={`#/teams/${x.id}`} style={{ display: 'flex' }}><b>{x.subject || 'Meeting'}</b><span className="small muted">{fmtDate(x.startDateTime || x.createdAt)} · {x.items.length} suggestion(s)</span></a>)}
        </div>
      )}
    </div>
  );
}

function ImportView({ id }) {
  const [x, setX] = useState(null); const [err, setErr] = useState(null); const [busy, setBusy] = useState(null); const [copied, setCopied] = useState(false);
  usePoll(async () => { if (!x) setX(await api(`/api/teams/imports/${id}`).catch((e) => { setErr(e.message); return null; })); }, 60_000, [id]);
  if (err) return <div className="alert err">{err}</div>;
  if (!x) return <div className="row"><span className="spinner" /><span>Loading…</span></div>;
  const act = async (it, action) => {
    setBusy(it.n); setErr(null);
    try {
      const r = await api(`/api/teams/imports/${id}/items/${it.n}`, { method: 'POST', body: { action } });
      setX(r);
      const got = r.items.find((i) => i.n === it.n);
      if (action === 'draft' && got?.draftId) go(`#/review/${got.draftId}${it.action === 'update' ? '?tab=meeting' : ''}`);
    } catch (e) { setErr(e.message); } finally { setBusy(null); }
  };
  const summary = [`Summary of the Teams meeting "${x.subject || ''}"${x.startDateTime ? ` on ${fmtDate(x.startDateTime)}` : ''}`, '', x.summary, '',
    ...GROUPS.flatMap(([kind, label]) => { const its = x.items.filter((i) => i.action === kind && i.status !== 'dismissed'); return its.length ? [`${label}:`, ...its.map((i) => `- ${i.title}: ${i.reason}`), ''] : []; }),
    x.items.some((i) => i.action === 'topic' && i.status !== 'dismissed') ? 'Could the person who knows each unclear topic best record it with the Process Documentation Agent?' : ''].join('\n').trim();
  const copy = async () => { try { await navigator.clipboard.writeText(summary); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { window.prompt('Copy the summary:', summary); } };
  const share = () => { const sdk = teamsSdk(); if (sdk?.sharing?.isSupported?.()) sdk.sharing.shareWebContent({ content: [{ type: 'URL', url: `${location.origin}/#/teams/${id}`, message: summary, preview: false }] }).catch(copy); else copy(); };
  return (
    <div className="teams" data-testid="teams-import">
      <div className="panel">
        <div className="row between"><h1 style={{ margin: 0 }}>{x.subject || 'Teams meeting'}</h1><span className="small muted">{fmtDate(x.startDateTime || x.createdAt)} · {x.transcriptLines} transcript {x.transcriptLines === 1 ? "line" : "lines"}</span></div>
        <p>{x.summary}</p>
        <div className="row">
          <button className="btn" onClick={copy} data-testid="teams-summary">{copied ? '✓ Copied' : 'Copy summary for the participants'}</button>
          {inTeams() && <button className="btn" onClick={share}>Share in Teams</button>}
        </div>
        {err && <div className="alert err" style={{ marginTop: 10 }}>{err}</div>}
        {!x.items.length && <p className="muted">The meeting contained nothing to document.</p>}
      </div>
      {GROUPS.map(([kind, label, button]) => {
        const items = x.items.filter((i) => i.action === kind);
        if (!items.length) return null;
        return (
          <div key={kind} className="panel">
            <h2>{label}</h2>
            {items.map((it) => (
              <div key={it.n} className="step" data-testid="teams-item">
                <div className="row between"><b>{it.title}</b>{it.processId && <span className="small muted">{it.processId}</span>}</div>
                <p style={{ margin: '6px 0' }}>{it.reason}</p>
                {it.quote && <p className="small muted" style={{ margin: '4px 0', fontStyle: 'italic' }}>“{it.quote}” · {mmss(it.atMs)}</p>}
                <div className="row" style={{ marginTop: 8 }}>
                  {it.draftId
                    ? <a className="btn primary" href={`#/review/${it.draftId}${it.action === 'update' ? '?tab=meeting' : ''}`} data-testid="teams-open-draft">Open the draft</a>
                    : it.status === 'dismissed' ? <span className="badge">not needed</span>
                      : <>
                        <button className={`btn ${kind === 'topic' ? '' : 'primary'}`} disabled={busy != null} onClick={() => act(it, 'draft')} data-testid="teams-draft">{busy === it.n ? 'Working…' : button}</button>
                        <button className="btn" disabled={busy != null} onClick={() => act(it, 'dismiss')}>Not needed</button>
                      </>}
                </div>
              </div>
            ))}
          </div>
        );
      })}
      <p className="small muted">The transcript is kept with this meeting so drafts can be made from it; passwords and other secrets in it are masked. <button className="linklike" onClick={async () => { if (confirm('Delete this meeting and its transcript from the app? Drafts already created stay.')) { await api(`/api/teams/imports/${id}`, { method: 'DELETE' }); go('#/teams'); } }}>Delete it</button></p>
    </div>
  );
}

// Configuration page Teams shows when the app is added to a meeting (side panel / tab).
export function TeamsConfig() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const sdk = teamsSdk();
    if (!sdk) return;
    sdk.pages.config.registerOnSaveHandler((e) => {
      sdk.pages.config.setConfig({ entityId: 'pda-meeting', suggestedDisplayName: 'Process Docs', contentUrl: `${location.origin}/?inTeams=1#/teams`, websiteUrl: `${location.origin}/#/teams` }).then(() => e.notifySuccess(), (x) => e.notifyFailure(String(x)));
    });
    sdk.pages.config.setValidityState(true);
    setReady(true);
  }, []);
  return (
    <main><div className="panel" style={{ maxWidth: 520, margin: '24px auto' }}>
      <h1>Process Documentation Agent</h1>
      <p>Adds the agent to this meeting. After the meeting, the organiser opens it here to turn the transcript into new or updated work instructions.</p>
      <p className="small muted">Remember to switch on transcription in the meeting.{ready ? ' Click Save to add it.' : ''}</p>
    </div></main>
  );
}
