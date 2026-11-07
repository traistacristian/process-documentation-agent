// Turns a raw, ordered stream of capture events into candidate process steps.
// This is deterministic and explainable: every candidate step keeps the sequence numbers of the
// events it was built from, so reviewers (and the AI engine) can trace each instruction to evidence.

const KNOWN_APPS = [
  [/admin\.microsoft\.com/, 'Microsoft 365 admin center'],
  [/entra\.microsoft\.com|aad\.portal\.azure\.com/, 'Microsoft Entra admin center'],
  [/portal\.azure\.com/, 'Azure portal'],
  [/intune\.microsoft\.com|endpoint\.microsoft\.com/, 'Microsoft Intune admin center'],
  [/admin\.exchange\.microsoft\.com/, 'Exchange admin center'],
  [/admin\.teams\.microsoft\.com/, 'Teams admin center'],
  [/-admin\.sharepoint\.com/, 'SharePoint admin center'],
  [/security\.microsoft\.com/, 'Microsoft Defender portal'],
  [/compliance\.microsoft\.com|purview\.microsoft\.com/, 'Microsoft Purview portal'],
  [/\.service-now\.com/, 'ServiceNow'],
  [/\.atlassian\.net/, 'Jira / Confluence'],
];

const BROWSER_SUFFIX = /\s[-–—|]\s(Google Chrome|Microsoft Edge|Mozilla Firefox|Chromium|Safari)$/i;

export function pageName(ev) {
  const t = (ev.pageTitle || ev.windowTitle || '').replace(BROWSER_SUFFIX, '').trim();
  if (!t) {
    if (ev.url) { try { const u = new URL(ev.url); return u.pathname.split('/').filter(Boolean).pop() || u.host; } catch { /* ignore */ } }
    return ev.app || 'Unknown screen';
  }
  // "Active users - Microsoft 365 admin center" -> "Active users"
  const parts = t.split(/\s[-–—|]\s/);
  return parts[0].trim() || t;
}

export function applicationName(ev) {
  if (ev.url) {
    const known = KNOWN_APPS.find(([re]) => re.test(ev.url));
    if (known) return known[1];
    const t = (ev.pageTitle || '').replace(BROWSER_SUFFIX, '');
    const parts = t.split(/\s[-–—|]\s/);
    if (parts.length > 1) return parts[parts.length - 1].trim();
    try { return new URL(ev.url).host; } catch { /* ignore */ }
  }
  return ev.app || 'Unknown application';
}

function locationKey(ev) {
  if (ev.url) {
    try { const u = new URL(ev.url); return `${u.host}${u.pathname}${u.hash.split('?')[0]}`.toLowerCase(); } catch { return ev.url; }
  }
  return `${ev.app || ''}|${ev.windowTitle || ''}`.toLowerCase();
}

const INTERACTIONS = new Set(['click', 'input', 'change', 'select', 'submit', 'key']);

// Drops noise: duplicate clicks, a click on a field immediately followed by typing into the same field,
// repeated inputs into the same field (keep the last), navigations with no interaction (redirect chains).
export function cleanEvents(input) {
  // Capture clients upload asynchronously (a click waits for its screenshot), so restore the real
  // order using the client timestamps; the sequence number breaks ties.
  const events = [...input].sort((a, b) => (a.ts - b.ts) || ((a.seq ?? 0) - (b.seq ?? 0)));
  const out = [];
  let paused = false;
  for (let ev of events) {
    if (ev.type === 'pause') { paused = true; continue; }
    if (ev.type === 'resume') { paused = false; continue; }
    if (paused && ev.source !== 'user') continue;
    const prev = out[out.length - 1];
    const sameField = (a, b) => a?.element && b?.element && (a.element.label || a.element.name) === (b.element.label || b.element.name);
    if (prev && ev.type === 'click' && prev.type === 'click' && sameField(prev, ev) && ev.ts - prev.ts < 800) continue;
    if (prev && (ev.type === 'input' || ev.type === 'change') && prev.type === 'click' && sameField(prev, ev) && ['textbox', 'combobox', 'searchbox', 'input', 'edit', 'textarea', 'checkbox', 'radio', 'switch'].includes(prev.element.role)) {
      out.pop();
    }
    const last = out[out.length - 1];
    // Clicking a checkbox/radio/switch also fires a change event: keep only the change.
    if (last && ev.type === 'click' && ['checkbox', 'radio', 'switch'].includes((ev.element?.role || '').toLowerCase()) && last.type === 'change' && sameField(last, ev) && Math.abs(ev.ts - last.ts) < 1500) continue;
    if (last && ev.type === 'input' && last.type === 'input' && sameField(last, ev)) { out[out.length - 1] = { ...ev, screenshotId: ev.screenshotId || last.screenshotId }; continue; }
    if (last && ev.type === 'navigate' && last.type === 'navigate') { out[out.length - 1] = { ...ev, redirectedFrom: last.url }; continue; }
    // Enter pressed in a field fires before the field's change event: restore the natural order.
    const p2 = out[out.length - 1];
    if (p2 && p2.type === 'key' && p2.text === 'Enter' && (ev.type === 'input' || ev.type === 'change') && sameField(p2, ev) && ev.ts - p2.ts < 1500) {
      out[out.length - 1] = ev; out.push({ ...p2, afterInput: true }); continue;
    }
    if (p2 && ev.type === 'key' && ev.text === 'Enter' && p2.type === 'input' && sameField(p2, ev) && ev.ts - p2.ts < 30000) ev = { ...ev, afterInput: true };
    // A form submit right after Enter is the effect of that Enter, not a separate action.
    if (p2 && ev.type === 'submit' && p2.type === 'key' && p2.text === 'Enter' && ev.ts - p2.ts < 1500) continue;
    // A navigation right after a click is the result of that click.
    if (ev.type === 'navigate' && p2 && ['click', 'submit', 'key'].includes(p2.type) && ev.ts - p2.ts < 3000 && !ev.switchedTab) ev = { ...ev, causedByAction: true };
    out.push(ev);
  }
  return out;
}

// Splits into steps at: explicit "mark important step" events, a change of application, or
// navigation to a different screen once the current step already contains interactions.
export function segmentEvents(rawEvents) {
  const events = cleanEvents(rawEvents);
  const steps = [];
  let cur = null;
  let lastLoc = null; let lastApp = null;
  const open = (ev, reason) => {
    cur = { events: [], reason, startTs: ev.ts, location: ev, important: false, notes: [], markLabel: null };
    steps.push(cur);
  };

  // Recorded with screen sharing only (no extension or desktop agent): every meaningful screen change
  // becomes its own step, so the document shows each screen instead of only the first one.
  const screenOnly = !events.some((e) => INTERACTIONS.has(e.type));
  for (const ev of events) {
    if (['start', 'stop', 'heartbeat'].includes(ev.type)) continue;
    if (screenOnly && ev.type === 'screenshot' && ev.screenshotId) {
      if (!cur || cur.events.some((e) => e.screenshotId)) open(ev, 'screen');
      cur.events.push(ev);
      continue;
    }
    if (ev.type === 'note') { (cur ?? open(ev, 'note') ?? cur).notes.push(ev.text); continue; }
    if (ev.type === 'mark') {
      open(lastLocEvent(steps) || ev, 'mark');
      cur.important = true; cur.markLabel = ev.text || null;
      if (ev.screenshotId) cur.events.push(ev);
      continue;
    }
    const loc = ev.url || ev.windowTitle || ev.app ? locationKey(ev) : lastLoc;
    const app = ev.url || ev.app ? applicationName(ev) : lastApp;
    const hasInteraction = cur?.events.some((e) => INTERACTIONS.has(e.type));
    const appChanged = lastApp && app && app !== lastApp;
    const locChanged = lastLoc && loc && loc !== lastLoc;

    if (!cur) open(ev, 'start');
    else if (appChanged && (hasInteraction || ev.type === 'navigate' || ev.type === 'window_focus')) open(ev, 'application');
    else if (locChanged && hasInteraction && (ev.type === 'navigate' || ev.type === 'window_focus')) open(ev, 'navigation');
    else if (cur.reason === 'mark' && !cur.events.some((e) => e.type !== 'mark') && (ev.type === 'navigate' || ev.type === 'window_focus')) cur.location = ev;

    if (ev.type === 'navigate' || ev.type === 'window_focus') cur.location = cur.events.some((e) => INTERACTIONS.has(e.type)) ? cur.location : ev;
    cur.events.push(ev);
    if (loc) lastLoc = loc;
    if (app) lastApp = app;
  }
  // A step that only observed a screen and the next step happens there too is merged forward.
  const merged = [];
  for (const s of steps) {
    const prev = merged[merged.length - 1];
    const interactive = s.events.some((e) => INTERACTIONS.has(e.type) || e.type === 'feedback');
    if (prev && !prev.important && !prev.events.some((e) => INTERACTIONS.has(e.type)) && !prev.notes.length && s.reason !== 'application' && s.reason !== 'screen' && prev.reason !== 'screen') {
      s.events = [...prev.events, ...s.events];
      s.location = prev.location;
      merged[merged.length - 1] = s;
    } else if (interactive || s.important || s.notes.length || s.events.length) merged.push(s);
  }
  // A final step that only observed the result of the previous action (no interaction, no mark)
  // is the outcome of that action, not a step of its own.
  const tail = merged[merged.length - 1];
  if (merged.length > 1 && tail.reason !== 'screen' && !tail.important && !tail.notes.length && !tail.events.some((e) => INTERACTIONS.has(e.type)) && tail.events.every((e) => e.type !== 'navigate' || e.causedByAction)) {
    merged[merged.length - 2].events.push(...tail.events);
    merged.pop();
  }
  return merged;

  function lastLocEvent(all) {
    for (let i = all.length - 1; i >= 0; i--) {
      const e = [...all[i].events].reverse().find((x) => x.url || x.windowTitle);
      if (e) return e;
    }
    return null;
  }
}
