// Voice clips for lesson stops: recording (microphone → compressed audio), playback, and the
// lesson file that carries stops together with their audio.
//
// A stop with a clip has `stop.voice = { blob, mime, dur }` in memory. In a lesson file the blob
// becomes base64 text: { voice: { mime, dur, data } }. The lesson-file functions don't touch the
// DOM, so they run in Node for the tests; the recorder and player need a browser.

export const LESSON_FORMAT = 'md-vr-lesson';
export const MAX_CLIP_S = 180;

// --- base64 for binary data (chunked: String.fromCharCode can't take a whole MB at once)
export function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Stops without their audio (for share links, which can't carry it). */
export function stripVoice(stops) {
  return stops.map(({ voice, ...st }) => (voice ? { ...st, hasVoice: true } : st));
}

/**
 * Lesson file text: metadata plus every stop, with voice clips embedded as base64.
 * meta: { trajectory, map, fs } (all optional).
 */
export async function lessonToJSON(stops, meta = {}) {
  const out = [];
  for (const st of stops) {
    const { voice, hasVoice, ...rest } = st;
    if (voice && voice.blob) {
      const data = bytesToB64(new Uint8Array(await voice.blob.arrayBuffer()));
      out.push({ ...rest, voice: { mime: voice.mime, dur: +voice.dur.toFixed(2), data } });
    } else out.push(rest);
  }
  return JSON.stringify({ format: LESSON_FORMAT, version: 1, ...meta, stops: out }, null, 1);
}

/**
 * Reads a lesson file: our format, or a plain array of stops (like samples/sample.lesson.json).
 * Returns { stops, meta, clips } with voice data turned back into Blobs.
 */
export function parseLesson(text) {
  const j = JSON.parse(text);
  const raw = Array.isArray(j) ? j : j && Array.isArray(j.stops) ? j.stops : null;
  if (!raw) throw new Error('not a lesson file (no stops)');
  const meta = Array.isArray(j) ? {} : { trajectory: j.trajectory, map: j.map, fs: j.fs };
  let clips = 0;
  const stops = raw.filter((s) => s && Number.isInteger(s.f) && s.f >= 0).map((s) => {
    const { voice, hasVoice, ...st } = s;
    if (voice && typeof voice.data === 'string' && voice.data) {
      clips++;
      st.voice = { blob: new Blob([b64ToBytes(voice.data)], { type: voice.mime || 'audio/webm' }), mime: voice.mime || 'audio/webm', dur: +voice.dur || 0 };
    }
    return st;
  }).sort((a, b) => a.f - b.f);
  return { stops, meta, clips };
}

/** True if the text looks like a lesson file (checked before parsing trajectories). */
export function looksLikeLesson(head) {
  const t = head.trimStart();
  return (t.startsWith('{') && t.includes(LESSON_FORMAT)) || (t.startsWith('[') && /"f"\s*:/.test(t));
}

export const fmtDur = (s) => { const t = Math.round(s); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

// ---------------------------------------------------------------------------
// Browser only: recorder and player.

/**
 * Microphone recorder. start() asks for the microphone the first time (the stream stays open
 * for quick re-takes and is released after a minute of not recording); stop() resolves with
 * { blob, mime, dur }, or null for a clip shorter than 0.4 s.
 */
export function createRecorder({ onTick, onAutoStop } = {}) {
  let stream = null, rec = null, chunks = [], t0 = 0, timer = 0, releaseTimer = 0, finish = null;
  const supported = typeof window !== 'undefined' && !!(navigator.mediaDevices && window.MediaRecorder);
  const mime = supported ? ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m)) || '' : '';

  async function mic() {
    clearTimeout(releaseTimer);
    if (stream && stream.getAudioTracks().some((t) => t.readyState === 'live')) return stream;
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    return stream;
  }
  function release() { if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; }

  return {
    supported,
    get recording() { return !!rec; },
    get elapsed() { return rec ? (performance.now() - t0) / 1000 : 0; },
    /** Asks for the microphone without recording (a button on the page, before entering VR). */
    async allow() { await mic(); releaseTimer = setTimeout(release, 60000); },
    async start() {
      if (rec) return;
      const s = await mic();
      chunks = [];
      rec = new MediaRecorder(s, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 });
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        const dur = (performance.now() - t0) / 1000;
        const type = rec.mimeType || mime || 'audio/webm';
        rec = null;
        clearInterval(timer);
        releaseTimer = setTimeout(release, 60000);
        const blob = new Blob(chunks, { type });
        const clip = dur < 0.4 || !blob.size ? null : { blob, mime: type, dur };
        if (finish) finish(clip);
        else if (onAutoStop) onAutoStop(clip); // the 3-minute limit stopped it
        finish = null;
      };
      t0 = performance.now();
      rec.start(250);
      timer = setInterval(() => {
        if (onTick) onTick((performance.now() - t0) / 1000);
        if (performance.now() - t0 > MAX_CLIP_S * 1000) rec && rec.stop();
      }, 250);
    },
    stop() {
      if (!rec) return Promise.resolve(null);
      return new Promise((resolve) => { finish = resolve; rec.stop(); });
    },
    /** Stops and throws the recording away (no clip, no auto-stop callback). */
    cancel() { if (rec) { finish = () => {}; rec.stop(); } },
    release,
  };
}

/** One clip at a time; onEnd(k) is called when clip k finishes on its own. */
export function createPlayer({ onEnd, onFail } = {}) {
  const audio = typeof Audio !== 'undefined' ? new Audio() : null;
  let url = '', current = -1;
  if (audio) audio.addEventListener('ended', () => { const k = current; current = -1; if (onEnd) onEnd(k); });
  return {
    get playing() { return current; },
    play(k, voice) {
      if (!audio || !voice || !voice.blob) return false;
      this.stop();
      url = URL.createObjectURL(voice.blob);
      audio.src = url;
      current = k;
      audio.play().catch((e) => {
        console.warn('Voice clip could not play', e);
        if (current === k) { current = -1; if (onFail) onFail(k, e); }
      });
      return true;
    },
    stop() {
      if (!audio) return;
      audio.pause();
      if (url) { URL.revokeObjectURL(url); url = ''; }
      current = -1;
    },
  };
}
