// Retention policy for raw capture data (events + screenshots). Generated drafts and published
// documents are not affected. Screenshots referenced by an unpublished draft are kept until the
// raw-capture retention period ends; after publishing they live in the repository.
const DAY = 86400_000;

export function applyRetention({ cfg, store, audit, now = Date.now() }) {
  const result = { purgedSessions: [], abandoned: [] };
  for (const s of store.list('sessions')) {
    const last = s.lastEventAt || s.startedAt;
    if (['recording', 'paused'].includes(s.status) && now - last > cfg.retention.abandonedSessionHours * 3600_000) {
      s.status = 'stopped'; s.stoppedAt = now; s.captureTokenHash = null; s.autoStopped = true;
      store.put('sessions', s); result.abandoned.push(s.id);
    }
    if (!s.rawPurgedAt && !['recording', 'paused'].includes(s.status) && now - (s.stoppedAt || last) > cfg.retention.rawCaptureDays * DAY) {
      const d = s.draftId ? store.get('drafts', s.draftId) : null;
      const doc = d?.publishedDoc || null;
      store.purgeRawCapture(s.id, new Set(doc ? doc.steps.flatMap((x) => x.screenshotIds) : []));
      s.rawPurgedAt = now; store.put('sessions', s); result.purgedSessions.push(s.id);
    }
  }
  if (result.purgedSessions.length || result.abandoned.length) audit.write(null, 'retention.applied', result);
  return result;
}
