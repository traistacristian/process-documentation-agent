import React, { useEffect, useState } from 'react';
import { api, getConfig, devUser, setDevUser } from './api.js';
import { usePoll } from './util.jsx';
import Landing from './pages/Landing.jsx';
import NewProcess from './pages/NewProcess.jsx';
import UpdateProcess from './pages/UpdateProcess.jsx';
import Recorder from './pages/Recorder.jsx';
import Review from './pages/Review.jsx';
import Admin from './pages/Admin.jsx';
import Library from './pages/Library.jsx';

// Top-bar menu for Admins: invite a tester by e-mail with a role (Contributor by default).
function InviteMenu() {
  const [open, setOpen] = useState(false); const [email, setEmail] = useState(''); const [role, setRole] = useState('Contributor');
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(null); const [err, setErr] = useState(null); const [st, setSt] = useState(null);
  const ref = React.useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    api('/api/admin/testers').then(setSt).catch(() => setSt({ available: true, configured: true }));
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const send = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null); setMsg(null);
    try { const r = await api('/api/admin/testers', { method: 'POST', body: { email: email.trim(), role } }); setMsg(`Invitation sent to ${r.email} as ${r.role}.`); setEmail(''); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div className="invite" ref={ref}>
      <button className="btn sm primary" onClick={() => { setOpen(!open); setMsg(null); setErr(null); }} aria-expanded={open} data-testid="invite-menu">＋ Invite</button>
      {open && (
        <form className="invite-pop" onSubmit={send} data-testid="invite-pop">
          <b>Invite a person</b>
          {st && !st.available ? <p className="small muted">Inviting works when users sign in with their Microsoft account. In the demo mode the test users are fixed.</p>
            : st && !st.configured ? <p className="small muted">One-time setup needed: enter the role groups under <a href="#/admin" onClick={() => setOpen(false)}>Administration → Testers</a>.</p>
            : <>
              <label className="f">E-mail address<input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" data-testid="invite-pop-email" /></label>
              <label className="f">Role<select value={role} onChange={(e) => setRole(e.target.value)} data-testid="invite-pop-role">
                <option value="Contributor">Contributor – records and edits</option>
                <option value="Approver">Approver – also approves and publishes</option>
                <option value="Admin">Admin – also manages settings</option>
              </select></label>
              {err && <div className="alert err small">{err}</div>}{msg && <div className="alert ok small">{msg}</div>}
              <button className="btn primary" type="submit" disabled={busy || !valid} data-testid="invite-pop-send" style={{ width: '100%', justifyContent: 'center' }}>{busy ? 'Sending…' : 'Send invitation'}</button>
              <p className="small muted" style={{ margin: '8px 0 0' }}>They get a Microsoft invitation and sign in with this e-mail. No licence needed.</p>
            </>}
        </form>
      )}
    </div>
  );
}

function useHash() {
  const [h, setH] = useState(location.hash.slice(1) || '/');
  useEffect(() => { const f = () => { setH(location.hash.slice(1) || '/'); window.scrollTo(0, 0); }; addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return h;
}

export default function App() {
  const route = useHash();
  const cfg = getConfig();
  const [me, setMe] = useState(null);
  const [active, setActive] = useState(null);
  useEffect(() => { api('/api/me').then(setMe).catch(() => setMe(null)); }, []);
  usePoll(async () => {
    const list = await api('/api/sessions').catch(() => []);
    setActive(list.find((s) => s.status === 'recording' || s.status === 'paused' ) || null);
  }, 4000, [route]);

  const [, page, id] = route.split('/');
  let view;
  if (!page) view = <Landing me={me} />;
  else if (page === 'new') view = <NewProcess me={me} />;
  else if (page === 'update') view = <UpdateProcess me={me} processId={id} />;
  else if (page === 'record') view = <Recorder id={id} />;
  else if (page === 'review') view = <Review id={id} me={me} />;
  else if (page === 'library') view = <Library processId={id} />;
  else if (page === 'admin') view = <Admin />;
  else view = <div className="panel">Page not found.</div>;

  const link = (href, label) => <a href={`#${href}`} className={(`/${page || ''}` === href || (href === '/' && !page)) ? 'active' : ''}>{label}</a>;
  return (
    <>
      <header className="topbar">
        <a className="logo" href="#/"><span className="mark">P</span><span>Process Documentation Agent<small>Do it once. Documented for good.</small></span></a>
        <nav>
          {link('/', 'Home')}
          {link('/library', 'Process library')}
          {me?.roles.includes('Admin') && link('/admin', 'Administration')}
        </nav>
        <div className="spacer" />
        {active && page !== 'record' && <a className="rec-pill" href={`#/record/${active.id}`}>{active.status === 'paused' ? '❚❚ PAUSED' : '● RECORDING'} – {active.meta.title}</a>}
        {me?.roles.includes('Admin') && <InviteMenu />}
        {cfg.authMode === 'dev' ? (
          <label className="devswitch" title="Demo mode: switch between test users to see each role. In production users sign in with their Microsoft account.">
            Viewing as
            <select value={devUser()} onChange={(e) => { setDevUser(e.target.value); location.reload(); }}>
              {cfg.devUsers.map((u) => <option key={u.id} value={u.id}>{u.name} · {u.roles.at(-1)}</option>)}
            </select>
          </label>
        ) : me && <span className="row small" title={me.roles.join(', ')}><span className="avatar">{(me.name || '?').split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase()}</span>{me.name}</span>}
      </header>
      <main>{view}</main>
    </>
  );
}
