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

  // ---------------------------------------------------------------- interactions
  let lastPointer = null;
  document.addEventListener('pointerdown', (e) => {
    if (!active() || e.button !== 0) return;
    const el = e.target.closest?.(INTERACTIVE) || e.target;
    if (!el || ['input', 'textarea'].includes(el.tagName.toLowerCase()) && !['checkbox', 'radio', 'button', 'submit'].includes(el.type)) { lastPointer = { el, ts: Date.now(), focusOnly: true }; return; }
    lastPointer = { el, ts: Date.now() };
    const r = el.getBoundingClientRect();
    send({ type: 'event', event: { ...base(), type: 'click', element: describe(el) }, screenshot: !!state.policy?.screenshotOnClick, rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
  }, true);

  document.addEventListener('click', (e) => {
    if (!active() || e.detail !== 0) return; // keyboard-activated clicks (Enter / Space)
    const el = e.target.closest?.(INTERACTIVE) || e.target;
    send({ type: 'event', event: { ...base(), type: 'click', element: describe(el) }, screenshot: false });
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
    send({ type: 'event', event: { ...base(), ts, type: evType, element, value } });
  }, true);

  document.addEventListener('submit', (e) => {
    if (!active()) return;
    const btn = e.submitter;
    send({ type: 'event', event: { ...base(), type: 'submit', element: btn ? describe(btn) : { role: 'form', name: clean(e.target.getAttribute('aria-label') || '') } } });
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!active() || e.key !== 'Enter' || e.isComposing) return;
    const el = e.target;
    if (el?.tagName?.toLowerCase() === 'input' && !isSensitive(el)) send({ type: 'event', event: { ...base(), type: 'key', text: 'Enter', element: describe(el) } });
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
  let maskStyle = null; let hl = null;
  function mask(rect) {
    maskStyle = document.createElement('style');
    const pats = (state.policy?.sensitiveFieldPatterns || []).map((p) => `input[name*="${p}" i],input[id*="${p}" i]`).join(',');
    maskStyle.textContent = `input[type=password],input[autocomplete^=cc-],input[autocomplete=one-time-code],[data-pda-sensitive],[data-sensitive]${pats ? ',' + pats : ''}{filter:blur(6px)!important;-webkit-text-security:disc!important}`;
    document.documentElement.appendChild(maskStyle);
    if (rect && rect.w > 0) {
      hl = document.createElement('div');
      Object.assign(hl.style, { position: 'fixed', left: `${rect.x - 3}px`, top: `${rect.y - 3}px`, width: `${rect.w + 6}px`, height: `${rect.h + 6}px`, border: '3px solid #E8590C', borderRadius: '4px', zIndex: 2147483647, pointerEvents: 'none', boxShadow: '0 0 0 4px rgba(232,89,12,.25)' });
      document.documentElement.appendChild(hl);
    }
  }
  function unmask() { maskStyle?.remove(); hl?.remove(); maskStyle = null; hl = null; }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
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
  send({ type: 'hello' }).then((s) => s && applyState(s));
})();
