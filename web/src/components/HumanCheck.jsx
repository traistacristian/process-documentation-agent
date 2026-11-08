import React, { useEffect, useRef, useState } from 'react';
import { api, getConfig, humanPass, setHumanPass, HUMAN_CHECK_EVENT } from '../api.js';

// Security check after sign-in: the user solves a small calculation or number puzzle before the
// app opens. The answer is checked on the server, which then issues a pass for this browser tab.
function HumanCheck({ onPassed }) {
  const [c, setC] = useState(null); const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const input = useRef(null);
  const load = async (msg = null) => {
    setAnswer(''); setErr(msg);
    try {
      const r = await api('/api/human-check');
      if (!r.enabled) return onPassed();
      setC(r); setTimeout(() => input.current?.focus(), 0);
    } catch (e) { setC(null); setErr(e.message); }
  };
  useEffect(() => { load(); }, []);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true);
    try {
      const r = await api('/api/human-check', { method: 'POST', body: { challengeId: c.challengeId, answer } });
      if (r.pass) { setHumanPass({ pass: r.pass, expiresAt: r.expiresAt }); onPassed(); } else onPassed();
    } catch (x) { await load(x.message); } finally { setBusy(false); }
  };
  return (
    <main className="hc-wrap">
      <form className="panel hc" onSubmit={submit} data-testid="human-check">
        <div className="hc-ico" aria-hidden="true">🧩</div>
        <h2>Quick security check</h2>
        <p className="muted">Solve this small puzzle to confirm you are a person. It keeps automated sign-ins out.</p>
        {c && <>
          <div className="eyebrow">{c.hint}</div>
          <div className="hc-q" data-testid="human-check-question">{c.question}</div>
          <label className="f">Your answer
            <input ref={input} inputMode="numeric" autoComplete="off" value={answer} onChange={(e) => setErr(null) || setAnswer(e.target.value.replace(/[^\d-]/g, '').slice(0, 7))} data-testid="human-check-answer" />
          </label>
        </>}
        {err && <div className="alert err small" role="alert">{err}</div>}
        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <button className="btn primary" type="submit" disabled={busy || !c || !answer} data-testid="human-check-submit">{busy ? 'Checking…' : 'Continue'}</button>
          <button className="btn" type="button" onClick={() => load()} disabled={busy}>New puzzle</button>
        </div>
      </form>
    </main>
  );
}

export default function HumanCheckGate({ children }) {
  const needed = () => !!getConfig()?.humanCheck && !humanPass();
  const [show, setShow] = useState(needed);
  useEffect(() => { const f = () => setShow(needed()); addEventListener(HUMAN_CHECK_EVENT, f); return () => removeEventListener(HUMAN_CHECK_EVENT, f); }, []);
  return show ? <HumanCheck onPassed={() => setShow(false)} /> : children;
}
