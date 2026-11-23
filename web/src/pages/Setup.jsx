import React, { useEffect, useState } from 'react';
import { api, getConfig, signOut } from '../api.js';

// Multi-tenant deployment: adding the app to an organisation.
//   Signup – public page (no sign-in yet): a Microsoft 365 administrator gives admin consent.
//   Setup  – after consent: start the trial, choose who may use the app, connect SharePoint.

export function Signup() {
  const err = new URLSearchParams(location.hash.split('?')[1] || '').get('consent_error');
  return (
    <main><div className="panel" style={{ maxWidth: 620, margin: '60px auto', padding: 36 }} data-testid="signup">
      <span className="logo-mark">P</span>
      <h1 style={{ marginTop: 14 }}>Add the Process Documentation Agent to your organisation</h1>
      {err && <div className="alert err">Microsoft did not complete the consent ({err}). Sign in as a Global Administrator, Application Administrator or Cloud Application Administrator and try again.</div>}
      <ol className="steps-list">
        <li><b>Give consent.</b> As a Microsoft 365 administrator, approve the app for your organisation. Microsoft shows exactly which permissions it asks for: sign-in, access to only the SharePoint site you choose later, and Teams meeting transcripts that the signed-in person may read.</li>
        <li><b>Start your free trial.</b> 5 days, for you as the administrator (1 seat). Subscribe to add your colleagues.</li>
        <li><b>Connect a SharePoint site.</b> Published documents are stored there, in your own tenant.</li>
      </ol>
      <a className="btn primary big" href="/api/onboarding/consent" data-testid="consent">Add to my organisation</a>
      <p className="small muted" style={{ marginTop: 16 }}>Already added? <a href="/">Sign in</a>.</p>
    </div></main>
  );
}

export function StartTrial({ tenant }) {
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const start = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api('/api/onboarding/start', { method: 'POST', body: { name } }); location.hash = '#/setup'; location.reload(); } catch (x) { setErr(x.message); setBusy(false); }
  };
  return (
    <main><form className="panel" style={{ maxWidth: 560, margin: '60px auto', padding: 36 }} onSubmit={start} data-testid="start-trial">
      <span className="logo-mark">P</span>
      <h1 style={{ marginTop: 14 }}>Start your free trial</h1>
      {err && <div className="alert err">{err}</div>}
      <label className="f">Organisation name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Contoso IT" maxLength={120} autoFocus data-testid="org-name" /></label>
      <p className="small muted">Organisation (tenant) ID: <code>{tenant.id}</code></p>
      <div className="row"><button className="btn primary big" disabled={busy} data-testid="start">Start trial</button><button type="button" className="btn" onClick={signOut}>Sign out</button></div>
    </form></main>
  );
}

export default function Setup({ me }) {
  const cfg = getConfig();
  const [t, setT] = useState(null); const [err, setErr] = useState(null); const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false);
  const [sp, setSp] = useState({ siteUrl: '', libraryName: 'Documents', rootFolder: 'IT Process Documentation' });
  const [sub, setSub] = useState(null);
  useEffect(() => { api('/api/onboarding').then((v) => { setT(v); if (v.sharepoint) setSp(v.sharepoint); }).catch((x) => setErr(x.message)); }, []);
  useEffect(() => { api('/api/subscription').then(setSub).catch(() => {}); }, []);
  if (!cfg.multiTenant) return <div className="panel">This page is only used in the multi-tenant deployment.</div>;
  if (!me?.roles.includes('Admin')) return <div className="panel">Only administrators of the app can change the organisation setup.</div>;
  if (!t) return <div className="panel">{err ? <div className="alert err">{err}</div> : <div className="spinner" />}</div>;

  const save = async (body, done) => {
    setBusy(true); setErr(null); setMsg(null);
    try { setT(await api('/api/onboarding', { method: 'PUT', body })); setMsg(done); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const connect = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null); setMsg(null);
    try { const r = await api('/api/onboarding/sharepoint', { method: 'POST', body: sp }); setT(r); setMsg(`Connected to ${r.site?.name || r.sharepoint.siteUrl}. Published documents now go to this site.`); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const set = (k) => (e) => setSp({ ...sp, [k]: e.target.value });
  return (
    <div className="panel" style={{ maxWidth: 760, margin: '0 auto' }} data-testid="setup">
      <h1>Organisation setup</h1>
      <p className="muted">{t.name} · {t.status === 'trial' && t.trialEndsAt ? `Trial until ${new Date(t.trialEndsAt).toLocaleDateString()}` : `Subscription: ${t.status}`}</p>
      {err && <div className="alert err">{err}</div>}
      {msg && <div className="alert ok">{msg}</div>}

      {sub && (
        <div className="alert" data-testid="subscription">
          <b>Plan: {sub.plan}</b>{sub.readOnly ? ` · read-only (${sub.reason === 'trial_ended' ? 'trial ended' : 'suspended'})` : ''}<br />
          Seats this month: {sub.seatsUsed} of {sub.seats ?? 'unlimited'} · AI-drafted documents this month: {sub.aiUsed} of {sub.aiGenerations ?? 'unlimited'}
          {sub.plan === 'trial' && <><br /><span className="small muted">The trial is for you only (1 seat) and lasts until {new Date(sub.trialEndsAt).toLocaleString()}. Subscribe to add your colleagues.</span></>}
        </div>
      )}

      <h2>1. Who can use the app</h2>
      <p className="small muted">Roles assigned to users or groups in your Entra ID (Enterprise applications → {cfg.appName || 'Process Documentation Agent API'} → Users and groups) always apply. Without such a role, people get the default role below.</p>
      <label className="f" style={{ maxWidth: 420 }}>Default role for everybody in {t.name}
        <select value={t.defaultRole} onChange={(e) => save({ defaultRole: e.target.value }, 'Saved.')} disabled={busy} data-testid="default-role">
          <option value="Contributor">Contributor: records processes and edits own drafts</option>
          <option value="Approver">Approver: also approves and publishes</option>
          <option value="">No access unless a role is assigned in Entra ID</option>
        </select>
      </label>
      <p className="small muted">Administrators of the app: {t.admins.length} (including you). More can be added as app role assignments in Entra ID.</p>

      <h2>2. SharePoint site for published documents</h2>
      <p className="small muted">The app gets write access to this one site only (Microsoft Graph Sites.Selected). Connecting needs a SharePoint administrator or the site owner.</p>
      <form onSubmit={connect}>
        <label className="f">Site address<input required value={sp.siteUrl} onChange={set('siteUrl')} placeholder="https://contoso.sharepoint.com/sites/ITOps" data-testid="site-url" /></label>
        <div className="grid g3" style={{ gap: 12 }}>
          <label className="f">Document library<input value={sp.libraryName} onChange={set('libraryName')} /></label>
          <label className="f">Folder<input value={sp.rootFolder} onChange={set('rootFolder')} /></label>
        </div>
        <button className="btn primary" disabled={busy} data-testid="connect">{t.sharepoint ? 'Connect again' : 'Connect site'}</button>
        {t.sharepoint && <span className="small muted" style={{ marginLeft: 12 }}>Connected: {t.sharepoint.siteUrl} › {t.sharepoint.libraryName} › {t.sharepoint.rootFolder}</span>}
      </form>

      <h2>3. Capture tools</h2>
      <p className="small muted">Install the browser extension for your users (Microsoft Edge add-ons or Intune policy). It pairs with this app by a code shown when a recording starts. See Help for the desktop agent.</p>
    </div>
  );
}
