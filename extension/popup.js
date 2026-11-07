const $ = (id) => document.getElementById(id);
async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'status' });
  const el = $('status');
  el.className = 'st' + (s.status === 'recording' ? ' rec' : s.status === 'paused' ? ' pau' : '');
  el.textContent = s.status === 'recording' ? `● RECORDING – ${s.title}` : s.status === 'paused' ? `❚❚ Paused – ${s.title}` : 'Not recording';
  if (s.queued) el.textContent += ` (${s.queued} events waiting to upload)`;
  $('pairBox').hidden = s.paired; $('unpair').hidden = !s.paired;
}
$('pair').onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: 'pair', code: $('code').value.trim(), apiBase: $('api').value.trim().replace(/\/$/, '') });
  if (!r.ok) $('status').textContent = `Could not connect: ${r.error}`; else refresh();
};
$('unpair').onclick = async () => { await chrome.runtime.sendMessage({ type: 'unpair' }); refresh(); };
refresh();
chrome.runtime.sendMessage({ type: 'managed' }).then((m) => { if (m?.serverUrl && !$('api').value) $('api').value = m.serverUrl; }).catch(() => {});
