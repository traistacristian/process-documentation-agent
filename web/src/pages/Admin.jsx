import React, { useEffect, useState } from 'react';
import { api, refreshConfig } from '../api.js';
import { fmtDate } from '../util.jsx';

const lines = (a) => (a || []).join('\n');
const parse = (t) => t.split('\n').map((x) => x.trim()).filter(Boolean);

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
      <div className="panel">
        <h2>Audit log</h2>
        <ul className="list feed">{audit.map((a, i) => <li key={i}><span className="t" style={{ width: 150 }}>{fmtDate(a.ts)}</span><span style={{ width: 120 }}>{a.user?.name || 'system'}</span><span className="badge">{a.action}</span><span className="small muted">{[a.title, a.processId, a.version && `v${a.version}`, a.draftId, a.sessionId, a.error].filter(Boolean).join(' · ')}</span></li>)}</ul>
      </div>
    </>
  );
}
