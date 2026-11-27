// Reads a video in the browser, so the video itself is never uploaded: it finds the moments where
// the screen changes (a screenshot each, like screen sharing) and turns the sound track into a
// 16 kHz mono WAV for transcription.

const SIG_W = 32; const SIG_H = 18;
const once = (el, ev) => new Promise((resolve, reject) => {
  const ok = () => { el.removeEventListener('error', bad); resolve(); };
  const bad = () => { el.removeEventListener(ev, ok); reject(new Error('This video cannot be played in this browser. Convert it to MP4 (H.264) and try again.')); };
  el.addEventListener(ev, ok, { once: true }); el.addEventListener('error', bad, { once: true });
});

export async function openVideo(file) {
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = URL.createObjectURL(file);
  await once(v, 'loadedmetadata');
  // Recordings from a browser (WebM) often report no duration until the end was reached once.
  if (!Number.isFinite(v.duration)) { v.currentTime = 1e9; await once(v, 'durationchange').catch(() => {}); await seek(v, 0); }
  if (!v.videoWidth) throw new Error('This file has no picture. Upload the sound as a subtitle file instead, or choose a document.');
  return v;
}
export const closeVideo = (v) => { URL.revokeObjectURL(v.src); v.removeAttribute('src'); v.load(); };

function seek(v, t) {
  return new Promise((resolve) => {
    const done = () => { v.removeEventListener('seeked', done); resolve(); };
    v.addEventListener('seeked', done);
    v.currentTime = Math.max(0, Math.min(t, (v.duration || t) - 0.05));
    setTimeout(done, 4000); // a frame that cannot be decoded is skipped
  });
}

function signature(v, ctx) {
  ctx.drawImage(v, 0, 0, SIG_W, SIG_H);
  const px = ctx.getImageData(0, 0, SIG_W, SIG_H).data;
  const out = new Uint8Array(SIG_W * SIG_H);
  for (let i = 0; i < out.length; i++) out[i] = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000;
  return out;
}
// Share of the small picture that changed noticeably (0..1).
const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 24) n++; return n / a.length; };

// Picks the moments where the screen changed and stayed (not the middle of a transition),
// at most maxFrames, then sends each as a JPEG: send({ data, atMs }).
export async function captureFrames(v, { maxFrames = 60, onProgress = () => {}, send, signal }) {
  const tiny = document.createElement('canvas'); tiny.width = SIG_W; tiny.height = SIG_H;
  const ctx = tiny.getContext('2d', { willReadFrequently: true });
  const dur = v.duration;
  const step = Math.max(1, dur / 1200);
  const samples = [];
  for (let t = 0; t < dur; t += step) {
    if (signal?.aborted) throw new Error('Cancelled');
    await seek(v, t);
    samples.push({ t, sig: signature(v, ctx) });
    onProgress(Math.min(0.8, (t / dur) * 0.8));
  }
  const pick = (threshold) => {
    const kept = []; let last = null;
    samples.forEach((s, i) => {
      const next = samples[i + 1];
      const stable = !next || diff(s.sig, next.sig) < 0.02;
      if (!last || (diff(s.sig, last.sig) > threshold && stable && s.t - last.t >= 2)) { kept.push(s); last = s; }
    });
    return kept;
  };
  let threshold = 0.08; let kept = pick(threshold);
  while (kept.length > maxFrames && threshold < 0.9) { threshold *= 1.4; kept = pick(threshold); }
  kept = kept.slice(0, maxFrames);
  const scale = Math.min(1, 1600 / v.videoWidth);
  const c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
  for (let i = 0; i < kept.length; i++) {
    if (signal?.aborted) throw new Error('Cancelled');
    // A little after the change, so the new screen has finished drawing.
    await seek(v, Math.min(kept[i].t + Math.min(step, 0.5), dur));
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    await send({ data: c.toDataURL('image/jpeg', 0.82), atMs: Math.round(kept[i].t * 1000) });
    onProgress(0.8 + 0.2 * ((i + 1) / kept.length));
  }
  return kept.length;
}

// The sound track as 16 kHz mono 16-bit WAV, cut to maxBytes. Returns null when there is no sound.
export async function soundTrack(file, { maxBytes }) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx || !window.OfflineAudioContext) return null;
  const ctx = new Ctx();
  let decoded;
  try { decoded = await ctx.decodeAudioData(await file.arrayBuffer()); } catch { return null; } finally { ctx.close?.(); }
  const rate = 16000;
  const frames = Math.min(Math.ceil(decoded.duration * rate), Math.floor((maxBytes - 44) / 2));
  if (frames <= 0) return null;
  const off = new OfflineAudioContext(1, frames, rate);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true); out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, pcm.length * 2, true);
  let silent = true;
  for (let i = 0; i < pcm.length; i++) { const x = Math.max(-1, Math.min(1, pcm[i])); if (silent && Math.abs(x) > 0.01) silent = false; out.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
  if (silent) return null;
  return { blob: new Blob([out.buffer], { type: 'audio/wav' }), seconds: pcm.length / rate, cut: frames < Math.ceil(decoded.duration * rate) };
}
