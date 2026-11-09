// Redaction and capture policy. Applied by capture clients before sending AND again on the server
// (defence in depth: a misconfigured or outdated client cannot leak secrets into storage).

const SECRET_PATTERNS = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED:JWT]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, 'Bearer [REDACTED:TOKEN]'],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:API_KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:AWS_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED:GITHUB_TOKEN]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED:SLACK_TOKEN]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:PRIVATE_KEY]'],
  [/\b(?:AccountKey|SharedAccessSignature|sig|password|pwd)=([^;&\s]+)/gi, (m, v) => m.replace(v, '[REDACTED]')],
  [/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/g, '[REDACTED:IBAN]'],
];

const SENSITIVE_QUERY_PARAMS = /^(code|token|access_token|id_token|refresh_token|client_secret|password|pwd|secret|sig|signature|key|apikey|api_key|session|sessionid|state|nonce|assertion|samlresponse|otp)$/i;

function luhn(num) {
  let sum = 0; let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = Number(num[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

export function maskEmail(text) {
  return text.replace(/\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '$1***@$2');
}

export function redactText(text, policy = {}) {
  if (text == null) return text;
  let out = String(text);
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => (luhn(m.replace(/\D/g, '')) ? '[REDACTED:CARD]' : m));
  if (policy.maskEmails !== false) out = maskEmail(out);
  return out;
}

export function redactUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    u.username = ''; u.password = '';
    for (const k of [...u.searchParams.keys()]) if (SENSITIVE_QUERY_PARAMS.test(k)) u.searchParams.set(k, '[REDACTED]');
    if (/(access_token|id_token|code)=/.test(u.hash)) u.hash = '#[REDACTED]';
    return u.toString().replace(/%5BREDACTED%5D/g, '[REDACTED]');
  } catch {
    return redactText(url);
  }
}

function globToRegex(glob) {
  return new RegExp('^' + glob.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
}

export function isExcluded(event, capture) {
  const app = `${event.app || ''} ${event.windowTitle || ''}`.toLowerCase();
  if ((capture.excludedApps || []).some((a) => a && app.includes(a.toLowerCase()))) return true;
  if (event.url) {
    let hostPath = event.url.toLowerCase();
    try { const u = new URL(event.url); hostPath = (u.host + u.pathname).toLowerCase(); } catch { /* keep raw */ }
    const host = hostPath.split('/')[0];
    if ((capture.excludedUrlPatterns || []).some((p) => {
      const re = globToRegex(p);
      return re.test(host) || re.test(hostPath) || re.test(hostPath.replace(/\/$/, ''));
    })) return true;
  }
  return false;
}

export function isSensitiveField(element = {}, capture = {}) {
  if (element.inputType === 'password' || element.isPassword) return true;
  if (/^cc-|one-time-code|current-password|new-password/.test(element.autocomplete || '')) return true;
  const label = `${element.label || ''} ${element.name || ''} ${element.fieldName || ''}`.toLowerCase();
  return (capture.sensitiveFieldPatterns || []).some((p) => new RegExp(`(^|[^a-z])${p.toLowerCase()}([^a-z]|$)`).test(label));
}

// Position of the clicked element / field on screen (CSS pixels): only numbers are kept.
function sanitizeBox(b) {
  if (!b || typeof b !== 'object') return undefined;
  const n = (v, min, max) => (Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : null);
  const out = { x: n(b.x, -20000, 20000), y: n(b.y, -20000, 20000), w: n(b.w, 0, 20000), h: n(b.h, 0, 20000), vw: n(b.vw, 1, 20000), vh: n(b.vh, 1, 20000), sx: n(b.sx, 0, 1e7) ?? 0, sy: n(b.sy, 0, 1e7) ?? 0 };
  if ([out.x, out.y, out.w, out.h, out.vw, out.vh].includes(null)) return undefined;
  const px = n(b.px, -20000, 20000); const py = n(b.py, -20000, 20000);
  if (px !== null && py !== null) Object.assign(out, { px, py });
  return out;
}

// Normalise and sanitise one incoming capture event. Returns null when the event must be dropped.
export function sanitizeEvent(raw, capture) {
  const ev = {
    type: String(raw.type || 'unknown').slice(0, 40),
    ts: Number.isFinite(raw.ts) ? raw.ts : Date.now(),
    source: String(raw.source || 'unknown').slice(0, 20),
    app: raw.app ? redactText(String(raw.app).slice(0, 200), capture) : undefined,
    windowTitle: raw.windowTitle ? redactText(String(raw.windowTitle).slice(0, 300), capture) : undefined,
    url: raw.url ? redactUrl(String(raw.url).slice(0, 2000)) : undefined,
    pageTitle: raw.pageTitle ? redactText(String(raw.pageTitle).slice(0, 300), capture) : undefined,
    text: raw.text ? redactText(String(raw.text).slice(0, 1000), capture) : undefined,
    screenshotId: typeof raw.screenshotId === 'string' ? raw.screenshotId : undefined,
    level: ['success', 'error', 'warning', 'info'].includes(raw.level) ? raw.level : undefined,
    clientId: raw.clientId ? String(raw.clientId).slice(0, 80) : undefined,
    box: sanitizeBox(raw.box),
  };
  if (raw.element && typeof raw.element === 'object') {
    const e = raw.element;
    ev.element = {
      role: e.role ? String(e.role).slice(0, 40) : undefined,
      name: e.name ? redactText(String(e.name).slice(0, 200), capture) : undefined,
      label: e.label ? redactText(String(e.label).slice(0, 200), capture) : undefined,
      inputType: e.inputType ? String(e.inputType).slice(0, 30) : undefined,
      context: e.context ? redactText(String(e.context).slice(0, 200), capture) : undefined,
    };
  }
  if (isExcluded(ev, capture)) return null;

  if (raw.value !== undefined && raw.value !== null) {
    const toggle = ['checkbox', 'radio'].includes(raw.element?.inputType) && ['checked', 'unchecked', 'true', 'false'].includes(String(raw.value));
    const sensitive = !toggle && isSensitiveField(raw.element || {}, capture);
    const freeText = ['input', 'change'].includes(ev.type) && !['checkbox', 'radio', 'select', 'select-one'].includes(raw.element?.inputType);
    if (sensitive) ev.value = '[REDACTED:SENSITIVE_FIELD]';
    else if (freeText && !capture.captureFreeTextValues) ev.value = '[VALUE_ENTERED]';
    else ev.value = redactText(String(raw.value).slice(0, 300), capture);
    ev.sensitive = sensitive || undefined;
  }
  return ev;
}
