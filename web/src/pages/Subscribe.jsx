import React, { useEffect, useState } from 'react';
import { landingApi, marketplaceToken, currentAccount } from '../api.js';

// Microsoft Marketplace landing page: shows the purchased plan and activates the subscription.
export default function Subscribe() {
  const token = marketplaceToken();
  const [s, setS] = useState(null); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false); const [done, setDone] = useState(null);
  useEffect(() => {
    if (!token) { setErr('This page is opened from Microsoft Marketplace or the Azure portal (SaaS → Configure account). The link has no purchase token.'); return; }
    landingApi('/api/marketplace/resolve', { token }).then(setS).catch((x) => setErr(x.message));
  }, []);
  const activate = async () => {
    setBusy(true); setErr(null);
    try { setDone(await landingApi('/api/marketplace/activate', { token })); try { sessionStorage.removeItem('pda.mpToken'); } catch { /* ignore */ } } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const me = currentAccount();
  return (
    <main><div className="panel" style={{ maxWidth: 620, margin: '60px auto', padding: 36 }} data-testid="subscribe">
      <span className="logo-mark">P</span>
      <h1 style={{ marginTop: 14 }}>Activate your subscription</h1>
      {me && <p className="small muted">Signed in as {me.name || me.username}</p>}
      {err && <div className="alert err">{err}</div>}
      {!s && !err && <div className="spinner" />}
      {s && !done && (
        <>
          <div className="kv" style={{ margin: '12px 0 16px' }}>
            <div>Subscription</div><div>{s.name}</div>
            <div>Plan</div><div>{s.planId}</div>
            {s.quantity != null && <><div>Users (seats)</div><div>{s.quantity}</div></>}
            <div>Organisation (tenant)</div><div><code>{s.beneficiaryTenantId}</code>{s.forOwnOrganisation ? ' (yours)' : ''}</div>
          </div>
          {!s.forOwnOrganisation && <div className="alert warn small">You are buying for another organisation (for example as its IT partner). After activation, one of its Microsoft 365 administrators adds the app and becomes its administrator. You do not get access to its data.</div>}
          {s.alreadyActive ? <div className="alert ok">This subscription is already active.</div>
            : <button className="btn primary big" disabled={busy} onClick={activate} data-testid="activate">Activate subscription</button>}
        </>
      )}
      {done && (
        <div className="alert ok" data-testid="activated">
          <b>Your subscription is active</b> ({done.plan}{done.seats ? `, ${done.seats} seats` : ''}).<br />
          {done.forOwnOrganisation
            ? <>Next: {done.needsConsent ? <a href="/#/signup">add the app to your organisation</a> : <a href="/#/setup">open the organisation setup</a>}.</>
            : <>Send the organisation's Microsoft 365 administrator this link to add the app: <code>{location.origin}/#/signup</code></>}
        </div>
      )}
    </div></main>
  );
}
