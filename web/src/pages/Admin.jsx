import React, { useEffect, useState } from 'react';
import { api, refreshConfig, download, getConfig } from '../api.js';
import { fmtDate } from '../util.jsx';

const lines = (a) => (a || []).join('\n');
const parse = (t) => t.split('\n').map((x) => x.trim()).filter(Boolean);

function Testers() {
  const [t, setT] = useState(null); const [err, setErr] = useState(null); const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false);
  const [g, setG] = useState({ Contributor: '', Approver: '', Admin: '' }); const [f, setF] = useState({ email: '', name: '', role: 'Contributor' });
  const load = async () => { try { const x = await api('/api/admin/testers'); setT(x); setG({ Contributor: '', Approver: '', Admin: '', ...x.groups }); } catch (e) { setErr(e.message); setT((o) => o || { available: true, configured: true, people: [] }); } };
  useEffect(() => { load(); }, []);
  const run = async (fn, ok) => { setBusy(true); setErr(null); setMsg(null); try { const r = await fn(); setMsg(ok(r)); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  const [perm, setPerm] = useState(null);
  const check = async () => { setErr(null); try { setPerm(await api('/api/admin/testers/permissions')); } catch (e) { setErr(e.message); } };
  const saveGroups = () => run(() => api('/api/admin/settings', { method: 'PUT', body: { invitations: { groups: g } } }), () => 'Role groups saved.');
  const invite = () => run(() => api('/api/admin/testers', { method: 'POST', body: f }), (r) => { setF({ ...f, email: '', name: '' }); return r.existing ? `${r.email} already had an account and was added to the ${r.role} group.` : `Invitation sent to ${r.email} with the ${r.role} role. They sign in after accepting it.`; });
  const remove = (p, role) => { if (window.confirm(`Remove the ${role} role from ${p.name}?`)) run(() => api(`/api/admin/testers/${p.id}?role=${role}`, { method: 'DELETE' }), () => `${p.name} no longer has the ${role} role.`); };
  if (!t) return <div className="panel"><span className="spinner" /></div>;
  return (
    <div className="panel" data-testid="testers">
      <h2>Testers</h2>
      <p className="small muted">Invite people outside your organisation to try the app. They receive a Microsoft guest invitation, sign in with their own e-mail address and need no licence. Their role comes from the role group they are added to.</p>
      {err && <div className="alert err small">{err}</div>}{msg && <div className="alert ok small">{msg}</div>}
      {!t.available ? <div className="alert info small">Available when users sign in with their Microsoft account. In the demo mode the test users are fixed.</div> : (
        <>
          <details open={!t.configured} style={{ marginBottom: 12 }}>
            <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>Setup: role groups {t.configured ? '✓' : '(required once)'}</summary>
            <p className="small muted">The object ids of the Entra groups that hold the app roles (Entra ID → Groups → the group → Object ID). The app also needs the Microsoft Graph permissions User.Invite.All and GroupMember.ReadWrite.All; your global admin grants them with scripts/Grant-InvitePermissions.ps1, which also prints these ids.</p>
            <div className="grid g3" style={{ gap: 10 }}>{['Contributor', 'Approver', 'Admin'].map((r) => <label key={r} className="f">{r} group<input value={g[r]} onChange={(e) => setG({ ...g, [r]: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" data-testid={`group-${r}`} /></label>)}</div>
            <div className="row"><button className="btn sm" onClick={saveGroups} disabled={busy} data-testid="save-groups">Save role groups</button><button className="btn sm" onClick={check} data-testid="check-permissions">Check permissions</button></div>
            {perm && <div className={`alert small ${perm.missing.length ? 'warn' : 'ok'}`} style={{ marginTop: 8 }} data-testid="permissions">
              {perm.missing.length ? <>Missing in the app's current token: <b>{perm.missing.join(', ')}</b>. Grant them with scripts/Grant-InvitePermissions.ps1; Azure can take up to 24 hours to hand a new permission to the app.</> : <>Both permissions are present. Inviting should work.</>}
              <div className="muted">Permissions in the token: {perm.roles.join(', ') || 'none'}{perm.issuedAt ? ` · token issued ${new Date(perm.issuedAt).toLocaleString()}` : ''}</div>
            </div>}
          </details>
          {t.configured && <>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <label className="f" style={{ flex: 2, minWidth: 220, marginBottom: 0 }}>E-mail address<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="name@example.com" data-testid="invite-email" /></label>
              <label className="f" style={{ flex: 2, minWidth: 180, marginBottom: 0 }}>Name <span className="opt">(optional)</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
              <label className="f" style={{ flex: 1, minWidth: 140, marginBottom: 0 }}>Role<select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} data-testid="invite-role"><option>Contributor</option><option>Approver</option><option>Admin</option></select></label>
              <button className="btn primary" onClick={invite} disabled={busy || !f.email.includes('@')} data-testid="invite">Send invitation</button>
            </div>
            <ul className="list" style={{ marginTop: 12 }}>
              {t.people.length === 0 && <li className="empty">Nobody in the role groups yet.</li>}
              {t.people.map((p) => (
                <li key={p.id} data-testid="tester"><span><b>{p.name}</b> <span className="small muted">{p.email}</span> {p.guest && <span className="badge">{p.state === 'PendingAcceptance' ? 'guest · invitation pending' : 'guest'}</span>}</span>
                  <span className="row">{p.roles.map((r) => <span key={r} className="row" style={{ gap: 2 }}><span className="badge approved">{r}</span>{p.guest && <button className="btn sm ghost" disabled={busy} onClick={() => remove(p, r)} aria-label={`Remove ${r} from ${p.name}`}>✕</button>}</span>)}</span></li>
              ))}
            </ul>
            <p className="small muted" style={{ marginBottom: 0 }}>Removing a role keeps the guest account in Entra ID without access to this app. Delete the guest there if it is no longer needed.</p>
          </>}
        </>
      )}
    </div>
  );
}

// AI per category: sensitive categories (for example critical infrastructure) never reach the AI.
function AiPolicy({ categories, off: initial }) {
  const [off, setOff] = useState(new Set(initial)); const [msg, setMsg] = useState(null); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const toggle = (c) => { const n = new Set(off); if (n.has(c)) n.delete(c); else n.add(c); setOff(n); setMsg(null); };
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api('/api/admin/settings', { method: 'PUT', body: { aiPolicy: { offCategories: [...off] } } }); await refreshConfig(); setMsg(off.size ? `Saved. The AI is off for ${off.size} categor${off.size === 1 ? 'y' : 'ies'}.` : 'Saved. The AI may be used for all categories.'); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="panel" data-testid="ai-policy">
      <h2>AI per category</h2>
      <p className="small muted">For sensitive processes (for example critical infrastructure), switch the AI off. Nothing from a process in such a category is sent to the AI: no screenshots, recorded actions, text or meeting transcripts. The rule-based engine drafts it instead, and AI features (step texts, click markers, meeting suggestions, translation, scripts) are not offered.</p>
      <div className="ai-cats">
        {categories.map((c) => (
          <label key={c} className="row between ai-cat">
            <span>{c}</span>
            <span className="row" style={{ gap: 6 }}><input type="checkbox" checked={!off.has(c)} onChange={() => toggle(c)} data-testid={`ai-allowed-${c}`} />{off.has(c) ? <span className="badge rejected">AI off</span> : <span className="badge published">AI allowed</span>}</span>
          </label>
        ))}
      </div>
      {off.size > 0 && <p className="small muted">Personal data in screenshots of these categories is not blurred automatically (that check also uses the AI); the browser add-in still hides e-mail addresses and phone numbers. Reviewers check the screenshots before approval.</p>}
      <button className="btn primary" onClick={save} disabled={busy} data-testid="ai-policy-save">Save</button>
      {msg && <div className="alert ok small" style={{ marginTop: 8 }}>{msg}</div>}{err && <div className="alert err small" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}

// The Teams app: one package to upload, plus the one-time Entra setup.
function TeamsSetup() {
  const [err, setErr] = useState(null); const on = getConfig().teams; const entra = getConfig().authMode === 'entra';
  return (
    <div className="panel" data-testid="teams-setup">
      <h2>Microsoft Teams</h2>
      <p className="small muted">Use the agent as a Teams app (personal app and meeting side panel) and turn meeting transcripts into new or updated work instructions. Transcripts are read on behalf of the signed-in person only: no tenant-wide access, no secrets.</p>
      <div className="kv"><div>Transcripts</div><div>{on ? <span className="badge published">ready</span> : <span className="badge">not set up</span>}</div></div>
      <ol className="small" style={{ margin: '8px 0', paddingLeft: 18 }}>
        <li>Run <code>scripts/Enable-TeamsApp.ps1 -WebAppName &lt;app&gt;</code> once as an administrator (Teams sign-in, consent, keyless credential).</li>
        <li>Download the app package and upload it in the Teams admin center → Teams apps → Manage apps → Upload new app.</li>
        <li>Make sure transcription is allowed in the Teams meeting policy.</li>
      </ol>
      <button className="btn" disabled={!entra} onClick={() => download('/api/admin/teams/package', 'process-documentation-agent-teams.zip').catch((e) => setErr(e.message))} data-testid="teams-package">⬇ Download the Teams app package</button>
      {!entra && <p className="small muted">Needs Microsoft sign-in (Entra ID mode).</p>}
      {err && <div className="alert err small">{err}</div>}
    </div>
  );
}

export default function Admin() {
  const [s, setS] = useState(null); const [repo, setRepo] = useState(null); const [audit, setAudit] = useState([]);
  const [f, setF] = useState(null); const [msg, setMsg] = useState(null); const [err, setErr] = useState(null);
  const load = async () => {
    try {
      const x = await api('/api/admin/settings'); setS(x);
      setF({ categories: lines(x.categories), excludedApps: lines(x.capture.excludedApps), excludedUrlPatterns: lines(x.capture.excludedUrlPatterns), sensitiveFieldPatterns: lines(x.capture.sensitiveFieldPatterns), captureFreeTextValues: x.capture.captureFreeTextValues, screenshotOnClick: x.capture.screenshotOnClick, blurPersonalData: x.capture.blurPersonalData !== false, rawCaptureDays: x.retention.rawCaptureDays, purgeRawAfterPublish: x.retention.purgeRawAfterPublish, webhookUrl: x.notifications.webhookUrl || '' });
      setRepo(await api('/api/repository/status')); setAudit(await api('/api/admin/audit?limit=100'));
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);
  if (!f) return err ? <div className="alert err">{err}</div> : <span className="spinner" />;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = async () => {
    setErr(null); setMsg(null);
    try {
      await api('/api/admin/settings', { method: 'PUT', body: { categories: parse(f.categories), capture: { excludedApps: parse(f.excludedApps), excludedUrlPatterns: parse(f.excludedUrlPatterns), sensitiveFieldPatterns: parse(f.sensitiveFieldPatterns), captureFreeTextValues: f.captureFreeTextValues, screenshotOnClick: f.screenshotOnClick, blurPersonalData: f.blurPersonalData }, retention: { rawCaptureDays: Number(f.rawCaptureDays), purgeRawAfterPublish: f.purgeRawAfterPublish }, notifications: { webhookUrl: f.webhookUrl.trim() } } });
      setMsg('Settings saved. New categories are available right away; capture clients pick up policy changes when they next pair.'); load(); refreshConfig();
    } catch (e) { setErr(e.message); }
  };
  const provision = async () => { setErr(null); try { const r = await api('/api/admin/repository/provision', { method: 'POST' }); setMsg(r.message || 'Repository columns and category folders are in place.'); } catch (e) { setErr(e.message); } };
  const samples = async () => {
    if (!window.confirm(`Publish 4 sample processes (password reset, new employee, leaver, shared mailbox) to ${repo?.label || 'the repository'}? They use the category "Sample" and can be deleted there at any time.`)) return;
    setErr(null); setMsg(null);
    try { const r = await api('/api/admin/samples', { method: 'POST' }); setMsg(r.added.length ? `Added ${r.added.length} sample process(es): ${r.added.map((x) => x.title).join(', ')}.` : 'The sample processes are already there.'); } catch (e) { setErr(e.message); }
  };
  const retention = async () => { try { const r = await api('/api/admin/retention/run', { method: 'POST' }); setMsg(`Retention applied: ${r.purgedSessions.length} recording(s) purged, ${r.abandoned.length} abandoned recording(s) stopped.`); } catch (e) { setErr(e.message); } };

  return (
    <>
      <h1>Administration</h1>
      {err && <div className="alert err">{err}</div>}{msg && <div className="alert ok">{msg}</div>}
      <div className="grid g2">
        <div className="panel">
          <h2>Documentation repository</h2>
          <div className="kv"><div>Destination</div><div>{repo?.label}</div><div>Status</div><div>{repo?.connected ? <span className="badge published">connected</span> : <span className="badge failed">not connected</span>} {repo?.error}</div><div>Documentation engine</div><div>{s.ai.engine === 'rules' ? 'Rule-based (set ANTHROPIC_API_KEY to enable Claude)' : s.ai.engine}</div><div>Authentication</div><div>{s.auth.mode === 'dev' ? 'Prototype test users (not for production)' : 'Microsoft Entra ID'}</div></div>
          {repo?.warning && <div className="alert warn small" style={{ marginTop: 10 }}>{repo.warning}</div>}
          <div className="row" style={{ marginTop: 10 }}><button className="btn" onClick={provision}>Create metadata columns and category folders</button><button className="btn" onClick={retention}>Run retention now</button></div>
        </div>
        <div className="panel">
          <h2>Demo content</h2>
          <p className="small muted">For presentations and first tests: publishes four realistic sample work instructions, so the home page and the library are not empty. They are marked with the category "Sample".</p>
          <button className="btn" onClick={samples} data-testid="add-samples">Add sample processes</button>
        </div>
        <AiPolicy categories={s.categories} off={s.aiPolicy?.offCategories || []} />
        <TeamsSetup />
        <div className="panel">
          <h2>Process categories</h2>
          <p className="small muted">Used as folders in the document library and as a metadata value. One per line.</p>
          <textarea rows={8} value={f.categories} onChange={set('categories')} data-testid="categories" />
        </div>
        <div className="panel">
          <h2>Capture and privacy policy</h2>
          <label className="f">Excluded applications <span className="opt">(name or window-title fragment, one per line)</span><textarea value={f.excludedApps} onChange={set('excludedApps')} /></label>
          <label className="f">Excluded web addresses <span className="opt">(wildcards allowed, e.g. *bank*)</span><textarea value={f.excludedUrlPatterns} onChange={set('excludedUrlPatterns')} /></label>
          <label className="f">Sensitive field names <span className="opt">(values in these fields are never captured, and fields are blurred in screenshots)</span><textarea value={f.sensitiveFieldPatterns} onChange={set('sensitiveFieldPatterns')} /></label>
          <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={f.captureFreeTextValues} onChange={set('captureFreeTextValues')} /> Capture typed text in non-sensitive fields (off by default – check your works council / DPO requirements)</label>
          <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={f.screenshotOnClick} onChange={set('screenshotOnClick')} /> Take a screenshot on each click</label>
          <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={f.blurPersonalData} onChange={set('blurPersonalData')} data-testid="blur-personal-data" /> Blur personal data in screenshots (names, e-mail addresses, phone numbers; uses Claude, needs the AI to be configured)</label>
        </div>
        <div className="panel">
          <h2>Retention and notifications</h2>
          <label className="f">Delete raw recordings (events and unused screenshots) after this many days<input type="number" min="1" value={f.rawCaptureDays} onChange={set('rawCaptureDays')} /></label>
          <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={f.purgeRawAfterPublish} onChange={set('purgeRawAfterPublish')} /> Delete raw recording immediately after publishing</label>
          <label className="f" style={{ marginTop: 10 }}>Webhook for Power Automate / Teams <span className="opt">(called when a process is published)</span><input value={f.webhookUrl} onChange={set('webhookUrl')} placeholder="https://prod-00.westeurope.logic.azure.com/…" /></label>
        </div>
      </div>
      <div className="row" style={{ marginBottom: 16 }}><button className="btn primary" onClick={save} data-testid="save-settings">Save settings</button></div>
      <Testers />
      <div className="panel">
        <h2>Audit log</h2>
        <ul className="list feed">{audit.map((a, i) => <li key={i}><span className="t" style={{ width: 150 }}>{fmtDate(a.ts)}</span><span style={{ width: 120 }}>{a.user?.name || 'system'}</span><span className="badge">{a.action}</span><span className="small muted">{[a.title, a.processId, a.version && `v${a.version}`, a.draftId, a.sessionId, a.error].filter(Boolean).join(' · ')}</span></li>)}</ul>
      </div>
    </>
  );
}
