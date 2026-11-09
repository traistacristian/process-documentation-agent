// Process Documentation Agent – capture content script.
// Observes the page ONLY while a recording is active and the user has paired this browser.
// Captures semantic UI events (what was clicked, which field was filled, what the page answered),
// never raw keystrokes. Password and sensitive field values are never read.
(() => {
  if (window.__pdaInjected) return;
  window.__pdaInjected = true;

  let state = { recording: false, paused: false, policy: null, apiOrigin: null };
  const send = (msg) => { try { return chrome.runtime.sendMessage(msg); } catch { return Promise.resolve(); } };
  const isAppPage = () => state.apiOrigin && location.origin === state.apiOrigin;
  const active = () => state.recording && !state.paused && !isAppPage();

  // ---------------------------------------------------------------- pairing bridge with the web app
  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.source !== 'pda-app') return;
    if (e.data.type === 'PDA_PING') {
      const st = await send({ type: 'status' });
      window.postMessage({ source: 'pda-extension', type: 'PDA_PONG', version: chrome.runtime.getManifest().version, status: st }, location.origin);
    }
    if (e.data.type === 'PDA_GUIDE') {
      const r = await send({ type: 'guide-start', guide: e.data.guide, appOrigin: location.origin });
      window.postMessage({ source: 'pda-extension', type: 'PDA_GUIDE_STARTED', ok: !!r?.ok, error: r?.error }, location.origin);
    }
    if (e.data.type === 'PDA_PAIR') {
      const r = await send({ type: 'pair', code: e.data.code, apiBase: location.origin });
      window.postMessage({ source: 'pda-extension', type: 'PDA_PAIRED', ok: !!r?.ok, error: r?.error }, location.origin);
    }
  });

  // ---------------------------------------------------------------- element description
  const ROLE_BY_TAG = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', option: 'option', li: 'listitem', tr: 'row', td: 'gridcell', summary: 'button', h1: 'heading', h2: 'heading', h3: 'heading' };
  const INTERACTIVE = 'a,button,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=option],[role=checkbox],[role=switch],[role=radio],[role=row],[role=gridcell],[role=treeitem],[role=listitem],[onclick],[tabindex]:not([tabindex="-1"]),li,tr';
  const clean = (t, n = 80) => (t || '').replace(/\s+/g, ' ').trim().slice(0, n);

  function roleOf(el) {
    const r = el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      return { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', search: 'searchbox', range: 'slider' }[t] || 'textbox';
    }
    return ROLE_BY_TAG[tag] || tag;
  }

  function labelOf(el) {
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' '); if (clean(t)) return clean(t); }
    if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return clean(l.innerText); }
    const wrap = el.closest('label');
    if (wrap) { const c = wrap.cloneNode(true); c.querySelectorAll('select,option,input,textarea,button').forEach((n) => n.remove()); if (clean(c.textContent)) return clean(c.textContent); }
    return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '');
  }

  function nameOf(el) {
    const tag = el.tagName.toLowerCase();
    if (['input', 'select', 'textarea'].includes(tag) && !['button', 'submit', 'reset'].includes(el.type)) return labelOf(el);
    return clean(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('alt') || el.querySelector?.('img[alt]')?.alt || '');
  }

  function contextOf(el) {
    const dlg = el.closest('[role=dialog],[role=alertdialog],dialog');
    if (dlg) return clean(dlg.getAttribute('aria-label') || dlg.querySelector('h1,h2,h3,[role=heading]')?.innerText || 'dialog', 60);
    const region = el.closest('[role=tabpanel],[role=region],section,fieldset,form');
    if (region) return clean(region.getAttribute('aria-label') || region.querySelector('legend,h1,h2,h3')?.innerText || '', 60);
    return '';
  }

  function isSensitive(el) {
    if (!el || !el.tagName) return false;
    if ((el.type || '').toLowerCase() === 'password') return true;
    if (/^cc-|one-time-code|current-password|new-password/.test(el.getAttribute('autocomplete') || '')) return true;
    if (el.closest('[data-pda-sensitive],[data-sensitive]')) return true;
    const pats = state.policy?.sensitiveFieldPatterns || [];
    const text = `${labelOf(el)} ${el.name || ''} ${el.id || ''}`.toLowerCase();
    return pats.some((p) => new RegExp(`(^|[^a-z])${p.toLowerCase()}([^a-z]|$)`).test(text));
  }

  function describe(el) {
    return { role: roleOf(el), name: nameOf(el), label: labelOf(el), inputType: el.type ? String(el.type).toLowerCase() : undefined, context: contextOf(el) || undefined, isPassword: isSensitive(el) || undefined };
  }

  const base = () => ({ ts: Date.now(), url: location.href, pageTitle: document.title, app: 'Browser', clientId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` });
  // Where the element is on the screen (CSS pixels of the visible page), so the generated document can
  // number the clicks and frame the fields on the step's screenshot. Positions only, never content.
  const boxOf = (el, pt) => {
    const r = el?.getBoundingClientRect?.();
    if (!r || (!r.width && !r.height)) return undefined;
    const round = (n) => Math.round(n);
    return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height), vw: innerWidth, vh: innerHeight, sx: round(scrollX), sy: round(scrollY), ...(pt ? { px: round(pt.clientX), py: round(pt.clientY) } : {}) };
  };

  // ---------------------------------------------------------------- interactions
  let lastPointer = null;
  document.addEventListener('pointerdown', (e) => {
    if (!active() || e.button !== 0 || (guideHost && e.target === guideHost)) return;
    const el = e.target.closest?.(INTERACTIVE) || e.target;
    if (!el || ['input', 'textarea'].includes(el.tagName.toLowerCase()) && !['checkbox', 'radio', 'button', 'submit'].includes(el.type)) { lastPointer = { el, ts: Date.now(), focusOnly: true }; return; }
    lastPointer = { el, ts: Date.now() };
    const r = el.getBoundingClientRect();
    send({ type: 'event', event: { ...base(), type: 'click', element: describe(el), box: boxOf(el, e) }, screenshot: !!state.policy?.screenshotOnClick, rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
  }, true);

  document.addEventListener('click', (e) => {
    if (!active() || e.detail !== 0) return; // keyboard-activated clicks (Enter / Space)
    const el = e.target.closest?.(INTERACTIVE) || e.target;
    send({ type: 'event', event: { ...base(), type: 'click', element: describe(el), box: boxOf(el) }, screenshot: false });
  }, true);

  // Text fields report "change" only on blur, which happens after the pointerdown of the next click.
  // Timestamp the entry at the moment typing started so the recorded order matches what the user did.
  const editStart = new WeakMap();
  document.addEventListener('input', (e) => { if (active() && e.target?.tagName && !editStart.has(e.target)) editStart.set(e.target, Date.now()); }, true);

  document.addEventListener('change', (e) => {
    if (!active()) return;
    const el = e.target;
    if (!el?.tagName) return;
    const tag = el.tagName.toLowerCase();
    const type = (el.type || '').toLowerCase();
    const element = describe(el);
    let value;
    const isToggle = type === 'checkbox' || type === 'radio';
    if (isSensitive(el) && !isToggle) value = '[REDACTED:SENSITIVE_FIELD]';
    else if (tag === 'select') value = clean(el.options[el.selectedIndex]?.text || el.value, 120);
    else if (type === 'checkbox' || type === 'radio') value = el.checked ? 'checked' : 'unchecked';
    else value = state.policy?.captureFreeTextValues ? clean(el.value, 200) : '[VALUE_ENTERED]';
    const evType = tag === 'select' || type === 'checkbox' || type === 'radio' ? 'change' : 'input';
    const ts = evType === 'input' && editStart.has(el) ? editStart.get(el) : Date.now();
    editStart.delete(el);
    send({ type: 'event', event: { ...base(), ts, type: evType, element, value, box: boxOf(el) } });
  }, true);

  document.addEventListener('submit', (e) => {
    if (!active()) return;
    const btn = e.submitter;
    send({ type: 'event', event: { ...base(), type: 'submit', element: btn ? describe(btn) : { role: 'form', name: clean(e.target.getAttribute('aria-label') || '') } } });
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!active() || e.key !== 'Enter' || e.isComposing) return;
    const el = e.target;
    if (el?.tagName?.toLowerCase() === 'input' && !isSensitive(el)) send({ type: 'event', event: { ...base(), type: 'key', text: 'Enter', element: describe(el), box: boxOf(el) } });
  }, true);

  // ---------------------------------------------------------------- navigation (incl. single-page apps)
  let lastUrl = null;
  function checkNavigation(force) {
    if (!active()) return;
    if (force || location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(() => send({ type: 'event', event: { ...base(), type: 'navigate' }, screenshot: true }), 400); // let the title update
    }
  }
  setInterval(() => checkNavigation(false), 700);
  window.addEventListener('popstate', () => checkNavigation(false));
  window.addEventListener('hashchange', () => checkNavigation(false));

  // ---------------------------------------------------------------- application feedback (toasts, alerts, errors)
  const FEEDBACK_SEL = '[role=alert],[role=status],[aria-live=assertive],[aria-live=polite],.toast,.notification,.alert,.ms-MessageBar';
  const seenFeedback = new Map();
  function levelOf(el) {
    const cls = `${el.className || ''} ${el.getAttribute('data-level') || ''}`.toLowerCase();
    if (/error|danger|fail|critical/.test(cls) || el.getAttribute('role') === 'alert' && /error|fail|denied|invalid|not /i.test(el.innerText)) return 'error';
    if (/warn/.test(cls)) return 'warning';
    if (/success|ok|saved|confirm/.test(cls) || /saved|success|updated|completed|created|applied/i.test(el.innerText)) return 'success';
    return 'info';
  }
  function scanFeedback(root) {
    if (!active()) return;
    const nodes = root.matches?.(FEEDBACK_SEL) ? [root] : [...(root.querySelectorAll?.(FEEDBACK_SEL) || [])];
    for (const el of nodes) {
      const text = clean(el.innerText, 300);
      if (!text || el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue;
      if (seenFeedback.get(el) === text) continue;
      seenFeedback.set(el, text);
      send({ type: 'event', event: { ...base(), type: 'feedback', text, level: levelOf(el), element: { role: el.getAttribute('role') || 'status', name: '' } }, screenshot: true });
    }
  }
  new MutationObserver((muts) => {
    if (!active()) return;
    for (const m of muts) {
      const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (!t) continue;
      const host = t.closest?.(FEEDBACK_SEL);
      if (host) scanFeedback(host);
      for (const n of m.addedNodes) if (n.nodeType === 1) scanFeedback(n);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // ---------------------------------------------------------------- privacy masking for screenshots
  let maskStyle = null; let hl = null; let piiBoxes = [];
  // E-mail addresses and international phone numbers visible on the page are covered before the
  // screenshot (the server additionally has Claude blur names and anything else personal).
  const PII_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+|\b00)\d[\d\s()/.-]{6,}\d/gi;
  function cover(rect) {
    if (!rect.width || rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) return;
    const d = document.createElement('div');
    Object.assign(d.style, { position: 'fixed', left: `${rect.left - 2}px`, top: `${rect.top - 2}px`, width: `${rect.width + 4}px`, height: `${rect.height + 4}px`, backdropFilter: 'blur(7px)', background: 'rgba(190,197,205,.6)', borderRadius: '3px', zIndex: 2147483646, pointerEvents: 'none' });
    document.documentElement.appendChild(d); piiBoxes.push(d);
  }
  function coverPersonalData() {
    if (state.policy?.blurPersonalData === false || !document.body) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode()) && piiBoxes.length < 400) {
      const t = n.nodeValue;
      if (!t || t.length < 6 || !/[@+0]/.test(t)) continue;
      PII_RE.lastIndex = 0; let m;
      while ((m = PII_RE.exec(t))) {
        const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);
        for (const rect of r.getClientRects()) cover(rect);
      }
    }
    for (const el of document.querySelectorAll('input:not([type=password]),textarea')) {
      PII_RE.lastIndex = 0;
      if (el.value && PII_RE.test(el.value)) cover(el.getBoundingClientRect());
    }
  }
  function mask(rect) {
    if (guideHost) guideHost.style.visibility = 'hidden';
    if (guideBox) guideBox.style.visibility = 'hidden';
    maskStyle = document.createElement('style');
    const pats = (state.policy?.sensitiveFieldPatterns || []).map((p) => `input[name*="${p}" i],input[id*="${p}" i]`).join(',');
    maskStyle.textContent = `input[type=password],input[autocomplete^=cc-],input[autocomplete=one-time-code],[data-pda-sensitive],[data-sensitive]${pats ? ',' + pats : ''}{filter:blur(6px)!important;-webkit-text-security:disc!important}`;
    document.documentElement.appendChild(maskStyle);
    // The clicked element is no longer outlined on the page: the server numbers every click of a
    // step on the screenshot instead (see server/engine/annotate.js).
    try { coverPersonalData(); } catch { /* never block the screenshot */ }
  }
  function unmask() { if (guideHost) guideHost.style.visibility = ''; if (guideBox) guideBox.style.visibility = ''; maskStyle?.remove(); hl?.remove(); piiBoxes.forEach((d) => d.remove()); piiBoxes = []; maskStyle = null; hl = null; }

  // ---------------------------------------------------------------- guided mode
  let guide = null; let guideHost = null; let guideRoot = null; let guideBox = null; let guideEl = null;
  const TXT = {
    en: { step: (n, t) => `Step ${n} of ${t}`, click: 'Click', fill: 'Fill in', choose: 'Choose in', back: 'Back', next: 'Next', stop: 'End guide', done: 'Done', finished: 'All steps are done.', notHere: (h) => `This step happens on ${h}.`, open: 'Open it', notFound: 'Look for', expected: 'Expected result', guided: 'Guided procedure' },
    de: { step: (n, t) => `Schritt ${n} von ${t}`, click: 'Klicken Sie auf', fill: 'Füllen Sie aus:', choose: 'Wählen Sie in', back: 'Zurück', next: 'Weiter', stop: 'Anleitung beenden', done: 'Fertig', finished: 'Alle Schritte sind erledigt.', notHere: (h) => `Dieser Schritt findet auf ${h} statt.`, open: 'Öffnen', notFound: 'Suchen Sie nach', expected: 'Erwartetes Ergebnis', guided: 'Geführter Ablauf' },
  };
  const norm = (t) => clean(t, 200).toLowerCase();
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const showsHere = () => guide && location.origin !== guide.appOrigin;

  function findTarget(t) {
    const want = norm(t?.name);
    if (!want) return null;
    let best = null; let score = 0;
    for (const el of document.querySelectorAll(`${INTERACTIVE},input,select,textarea`)) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
      const n = norm(nameOf(el) || labelOf(el));
      if (!n) continue;
      let sc = n === want ? 3 : ((n.startsWith(want) || want.startsWith(n)) && Math.min(n.length, want.length) >= 3) ? 2 : (n.includes(want) && want.length >= 4) ? 1 : 0;
      if (!sc) continue;
      if (t.role && roleOf(el) === t.role) sc += 0.5;
      if (n.length > want.length * 4) sc -= 0.5; // a whole row or panel that merely contains the name
      if (sc > score) { score = sc; best = el; }
    }
    return best;
  }

  function move(step, target, extra = {}) { send({ type: 'guide-move', step, target, ...extra }); }
  function next() {
    const s = guide.steps[guide.step];
    if (guide.target + 1 < (s.targets || []).length) return move(guide.step, guide.target + 1);
    if (guide.step + 1 < guide.steps.length) return move(guide.step + 1, 0);
    return move(guide.step, guide.target, { finished: true });
  }

  function renderGuide() {
    if (!showsHere()) { guideHost?.remove(); guideBox?.remove(); guideHost = guideRoot = guideBox = guideEl = null; return; }
    if (!guideHost) {
      guideHost = document.createElement('div');
      guideHost.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
      guideRoot = guideHost.attachShadow({ mode: 'open' });
      document.documentElement.appendChild(guideHost);
      guideBox = document.createElement('div');
      guideBox.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:3px solid #2A9D8F;border-radius:6px;box-shadow:0 0 0 6px rgba(42,157,143,.25);display:none;transition:all .15s;';
      document.documentElement.appendChild(guideBox);
    }
    const T = TXT[guide.language] || TXT.en;
    const s = guide.steps[guide.step]; const t = (s.targets || [])[guide.target];
    let where = '';
    if (t?.url) { try { const u = new URL(t.url); if (u.host !== location.host) where = `<div class="warn">${esc(T.notHere(u.host))} <a href="${esc(u.href)}" target="_blank" rel="noreferrer">${esc(T.open)}</a></div>`; } catch { /* ignore */ } }
    guideRoot.innerHTML = `<style>
      .p{width:340px;max-height:60vh;overflow:auto;background:#fff;color:#1B2A33;font:14px/1.45 "Segoe UI",system-ui,sans-serif;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25);border-top:5px solid #2A9D8F}
      .h{padding:10px 14px 4px;font-size:12px;color:#5B7083;display:flex;justify-content:space-between}
      .t{padding:0 14px;font-weight:600;font-size:16px;color:#0F4C5C}.b{padding:6px 14px}ol{margin:4px 0 0 18px;padding:0}li{margin:2px 0}
      .c{margin:8px 14px;padding:8px 10px;background:#EEF3F4;border-radius:6px}.warn{margin:8px 14px;padding:8px 10px;background:#FFF4E0;border-radius:6px}
      .f{display:flex;gap:6px;justify-content:flex-end;padding:10px 14px 12px}button{font:inherit;border:0;border-radius:5px;padding:6px 10px;cursor:pointer;background:#E9EEF0;color:#1B2A33}
      button.pr{background:#0F4C5C;color:#fff}.ok{margin:8px 14px;color:#2A9D8F;font-weight:600}a{color:#0F4C5C}</style>
      <div class="p" role="dialog" aria-label="${esc(T.guided)}">
        <div class="h"><span>${esc(T.guided)}: ${esc(guide.title)}</span><span>${esc(T.step(guide.step + 1, guide.steps.length))}</span></div>
        <div class="t">${esc(s.title)}</div>
        <div class="b">${s.description ? `<div>${esc(s.description)}</div>` : ''}<ol>${(s.instructions || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
          ${s.expectedResult ? `<div style="margin-top:6px;color:#5B7083">${esc(T.expected)}: ${esc(s.expectedResult)}</div>` : ''}</div>
        ${t ? `<div class="c" data-target>${esc(['textbox', 'searchbox'].includes(t.role) ? T.fill : t.role === 'combobox' ? T.choose : T.click)} <b>${esc(t.name)}</b></div>` : ''}${where}
        ${guide.finished ? `<div class="ok">${esc(T.finished)}</div>` : ''}
        <div class="f"><button data-a="stop">${esc(guide.finished ? T.done : T.stop)}</button><button data-a="back" ${guide.step === 0 && guide.target === 0 ? 'disabled' : ''}>${esc(T.back)}</button>${guide.finished ? '' : `<button class="pr" data-a="next">${esc(T.next)}</button>`}</div>
      </div>`;
    guideRoot.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.a;
      if (a === 'stop') move(0, 0, { done: true });
      if (a === 'next') next();
      if (a === 'back') { if (guide.target > 0) move(guide.step, guide.target - 1); else if (guide.step > 0) move(guide.step - 1, Math.max(0, (guide.steps[guide.step - 1].targets || []).length - 1)); }
    }));
    placeHighlight();
  }

  function placeHighlight() {
    if (!guideBox || !showsHere()) return;
    const t = (guide.steps[guide.step].targets || [])[guide.target];
    guideEl = !guide.finished && t ? findTarget(t) : null;
    if (!guideEl) { guideBox.style.display = 'none'; return; }
    const r = guideEl.getBoundingClientRect();
    Object.assign(guideBox.style, { display: 'block', left: `${r.left - 5}px`, top: `${r.top - 5}px`, width: `${r.width + 10}px`, height: `${r.height + 10}px` });
  }
  setInterval(() => { if (guide) placeHighlight(); }, 600);
  window.addEventListener('scroll', () => { if (guide) placeHighlight(); }, true);

  // Clicking the highlighted element completes it and moves the guide on.
  document.addEventListener('pointerdown', (e) => {
    if (!showsHere() || guide.finished || !guideEl || e.button !== 0) return;
    if (guideEl === e.target || guideEl.contains(e.target)) setTimeout(next, 150);
  }, true);

  function applyGuide(g) { guide = g || null; renderGuide(); }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'guide') { applyGuide(msg.guide); reply({ ok: true }); return false; }
    if (msg.type === 'mask') { mask(msg.rect); requestAnimationFrame(() => requestAnimationFrame(() => reply({ ok: true }))); return true; }
    if (msg.type === 'unmask') { unmask(); reply({ ok: true }); }
    if (msg.type === 'state') { applyState(msg.state); reply({ ok: true }); }
    return false;
  });

  function applyState(s) {
    const was = active();
    state = { ...state, ...s };
    if (!was && active()) { lastUrl = null; checkNavigation(true); }
  }
  send({ type: 'hello' }).then((s) => { if (!s) return; const { guide: g, ...st } = s; applyState(st); if (document.body) applyGuide(g); else document.addEventListener('DOMContentLoaded', () => applyGuide(g)); });
})();
