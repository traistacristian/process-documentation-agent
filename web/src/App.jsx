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
        <a className="logo" href="#/"><span className="mark" /> Process Documentation Agent</a>
        <nav>
          {link('/', 'Home')}
          {link('/library', 'Process library')}
          {me?.roles.includes('Admin') && link('/admin', 'Administration')}
        </nav>
        <div className="spacer" />
        {active && page !== 'record' && <a className="rec-pill" href={`#/record/${active.id}`}>{active.status === 'paused' ? '❚❚ PAUSED' : '● RECORDING'} – {active.meta.title}</a>}
        {cfg.authMode === 'dev' ? (
          <label className="small muted" title="Prototype mode: choose which test user you are. In production users sign in with Microsoft Entra ID.">
            Test user:&nbsp;
            <select style={{ width: 'auto', marginTop: 0 }} value={devUser()} onChange={(e) => { setDevUser(e.target.value); location.reload(); }}>
              {cfg.devUsers.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.roles.join(', ')})</option>)}
            </select>
          </label>
        ) : <span className="small">{me?.name}</span>}
      </header>
      <main>{view}</main>
    </>
  );
}
