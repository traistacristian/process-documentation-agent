import React from 'react';

const ROLES = [
  ['Contributor', 'Records processes, reviews the drafted steps and answers open questions.'],
  ['Approver', 'Everything a Contributor can, plus approve, reject and publish to SharePoint.'],
  ['Admin', 'Everything an Approver can, plus settings, demo content and inviting people.'],
];
const FAQ = [
  ['Can I document a process from a Teams meeting?', 'Yes. After a meeting with transcription switched on, open "From Teams" (or the Process Docs side panel in the meeting) and choose Analyse. The agent suggests which documents to update, which new ones to draft and which topics were unclear. Only the organiser or a co-organiser can import a transcript, and nothing changes until you accept it in a draft.'],
  ['Is my password recorded?', 'No. Password fields are never read, and names, e-mail addresses and phone numbers are blurred in the screenshots before anyone sees them.'],
  ['What if I make a mistake while recording?', 'Pause, or just carry on. You can delete, move or rewrite any step in the review before it is approved.'],
  ['Where do the documents go?', 'After approval they are published as Word files to SharePoint, in English and German, with every earlier version kept.'],
  ['A process changed. Do I start from scratch?', 'No. Choose "Update an existing process", do the task the new way, and accept or reject each detected change.'],
  ['Who sees my drafts?', 'You, the approvers and the admins. Nothing is published without an approver.'],
];

export default function Help({ me }) {
  return (
    <div className="help">
      <div className="panel">
        <h1>Help and getting started</h1>
        <p className="muted" style={{ marginTop: 0 }}>Everything you need for your first documented process, in about five minutes.</p>
        <div className="grid g3" style={{ marginTop: 12 }}>
          {[['1', 'Record', 'Click "Record a new process", give it a name, and do the task as usual in the browser or on your desktop.'], ['2', 'Review', 'Each step is described for you. Correct what is wrong and answer the open questions; the progress bar shows what is missing.'], ['3', 'Approve and publish', 'An approver checks the draft and publishes it to SharePoint as a branded Word document.']].map(([n, h, t]) => (
            <div key={n} className="step" style={{ marginBottom: 0 }}><div className="step-head"><div className="step-num">{n}</div><b>{h}</b></div><p className="small" style={{ margin: 0 }}>{t}</p></div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 16 }}><a className="btn primary" href="#/new">● Record a new process</a><a className="btn" href="#/library">Browse the process library</a></div>
      </div>
      <div className="grid g2">
        <div className="panel">
          <h2>Install the browser add-in</h2>
          <p className="small">The add-in records clicks and screenshots in web consoles (Microsoft 365, Entra, Azure and others) and powers guided mode. Your IT department usually installs it for you through Intune.</p>
          <ol className="small">
            <li>Ask IT whether the add-in is already installed (look for the Process Documentation Agent icon next to the address bar).</li>
            <li>If not, IT can install it centrally; for a test, an admin can load the <code>extension</code> folder in Edge or Chrome under Extensions → Developer mode → Load unpacked.</li>
            <li>Start a recording here; the add-in connects to it automatically.</li>
          </ol>
          <p className="small muted" style={{ marginBottom: 0 }}>Without the add-in you can still record with screen sharing.</p>
        </div>
        <div className="panel">
          <h2>Roles</h2>
          <ul className="list">{ROLES.map(([r, t]) => <li key={r} style={{ alignItems: 'flex-start' }}><span className="badge approved" style={{ minWidth: 92, textAlign: 'center' }}>{r}</span><span className="small" style={{ flex: 1 }}>{t}</span></li>)}</ul>
          {me && <p className="small muted" style={{ marginBottom: 0 }}>You are signed in as {me.name} with the role{me.roles.length > 1 ? 's' : ''} {me.roles.join(', ')}.</p>}
        </div>
      </div>
      <div className="panel">
        <h2>Frequently asked questions</h2>
        {FAQ.map(([q, a]) => <div key={q} className="q"><b>{q}</b><span className="small">{a}</span></div>)}
      </div>
    </div>
  );
}
