// Narration for lesson stops: recording (microphone → compressed audio), loudness and silence
// analysis, playback, and the lesson file that carries stops together with their audio.
//
// A stop's narration is a list of segments, `stop.clips = [{ blob, mime, dur, gain, trim,
// text, track }]`, played one after another. `text` is the segment's transcript (subtitles) and
// `track` what the teacher did while speaking (pointing, picks, moving the molecule; see
// tracks.js). `gain` evens out loudness (quiet talkers are raised, a limiter
// keeps loud ones clean) and `trim = [start, end]` (seconds) skips silence at both ends. Both
// are applied at playback, so the recording itself is never altered. In a lesson file each blob
// becomes base64 text. Lesson files, `analyzeSamples` and the helpers don't touch the DOM, so
// they run in Node for the tests; recorder and player need a browser.

import { cleanTrack } from './tracks.js';

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

// --- narration helpers
/** The stop's narration segments (never undefined). */
export const clipsOf = (st) => (st && Array.isArray(st.clips) ? st.clips : []);
export const hasVoice = (st) => clipsOf(st).length > 0;
/** Length of one segment as played (after trimming silence). */
export const clipLength = (c) => (c.trim ? Math.max(0, c.trim[1] - c.trim[0]) : c.dur || 0);
/** Total narration of a stop as played. */
export const voiceLength = (st) => clipsOf(st).reduce((a, c) => a + clipLength(c), 0);

/** Stops without their audio (for share links, which can't carry it). */
export function stripVoice(stops) {
  return stops.map(({ clips, ...st }) => (clips && clips.length ? { ...st, hasVoice: true } : st));
}

/**
 * Lesson file text: metadata plus every stop, with narration segments embedded as base64.
 * meta: { trajectory, map, fs } (all optional).
 */
export async function lessonToJSON(stops, meta = {}) {
  const out = [];
  for (const st of stops) {
    const { clips, hasVoice: _h, voice: _v, ...rest } = st;
    if (clips && clips.length) {
      const enc = [];
      for (const c of clips) {
        enc.push({
          mime: c.mime, dur: +(+c.dur).toFixed(2), data: bytesToB64(new Uint8Array(await c.blob.arrayBuffer())),
          ...(c.gain ? { gain: +c.gain.toFixed(3) } : {}), ...(c.trim ? { trim: c.trim.map((x) => +x.toFixed(3)) } : {}),
          ...(c.text ? { text: c.text } : {}), ...(c.track ? { track: c.track } : {}),
        });
      }
      out.push({ ...rest, clips: enc });
    } else out.push(rest);
  }
  return JSON.stringify({ format: LESSON_FORMAT, version: 2, ...meta, stops: out }, null, 1);
}

/**
 * Reads a lesson file: our format (version 2 with `clips`, or version 1 with one `voice` per
 * stop), or a plain array of stops (like samples/sample.lesson.json). Returns
 * { stops, meta, clips } with audio turned back into Blobs; `clips` counts segments.
 */
export function parseLesson(text) {
  const j = JSON.parse(text);
  const raw = Array.isArray(j) ? j : j && Array.isArray(j.stops) ? j.stops : null;
  if (!raw) throw new Error('not a lesson file (no stops)');
  const meta = Array.isArray(j) ? {} : { trajectory: j.trajectory, map: j.map, fs: j.fs };
  let count = 0;
  const dec = (c) => {
    if (!c || typeof c.data !== 'string' || !c.data) return null;
    const mime = c.mime || 'audio/webm';
    const out = { blob: new Blob([b64ToBytes(c.data)], { type: mime }), mime, dur: +c.dur || 0 };
    if (+c.gain > 0) out.gain = +c.gain;
    if (Array.isArray(c.trim) && c.trim.length === 2) out.trim = [+c.trim[0], +c.trim[1]];
    if (typeof c.text === 'string' && c.text.trim()) out.text = c.text;
    const track = cleanTrack(c.track);
    if (track) out.track = track;
    return out;
  };
  const stops = raw.filter((s) => s && Number.isInteger(s.f) && s.f >= 0).map((s) => {
    const { voice, clips, hasVoice: _h, ...st } = s;
    const list = (Array.isArray(clips) ? clips : voice ? [voice] : []).map(dec).filter(Boolean);
    if (list.length) { st.clips = list; count += list.length; }
    return st;
  }).sort((a, b) => a.f - b.f);
  return { stops, meta, clips: count };
}

/** True if the text looks like a lesson file (checked before parsing trajectories). */
export function looksLikeLesson(head) {
  const t = head.trimStart();
  return (t.startsWith('{') && t.includes(LESSON_FORMAT)) || (t.startsWith('[') && /"f"\s*:/.test(t));
}

export const fmtDur = (s) => { const t = Math.round(s); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

/**
 * Loudness and silence analysis of a recording (mono samples, −1..1).
 * - Splits it into 20 ms windows and takes each window's RMS.
 * - Background noise is a low percentile of those; a window is speech when it is clearly above
 *   the noise (3.5×) and not negligible next to the loudest part.
 * - trim: from 0.15 s before the first speech to 0.3 s after the last (so no words are cut).
 * - gain: brings the speech's RMS to about −22 dBFS, between ×0.25 and ×12, so a quiet talker
 *   is raised a lot and a loud one lowered. A limiter at playback catches peaks.
 * Returns { trim: [start, end], gain, rms, peak, speech } (speech: false if none was found).
 */
export function analyzeSamples(samples, sampleRate) {
  const dur = samples.length / sampleRate;
  const win = Math.max(1, Math.round(0.02 * sampleRate));
  const n = Math.floor(samples.length / win);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
  if (!n) return { trim: [0, dur], gain: 1, rms: 0, peak, speech: false };
  const rms = new Float64Array(n);
  for (let w = 0; w < n; w++) {
    let s = 0;
    for (let i = w * win, e = i + win; i < e; i++) s += samples[i] * samples[i];
    rms[w] = Math.sqrt(s / win);
  }
  const sorted = Float64Array.from(rms).sort();
  const floor = sorted[Math.floor(0.1 * (n - 1))];
  const top = sorted[n - 1];
  const thr = Math.max(floor * 3.5, top * 0.08, 0.002);
  let first = -1, last = -1, sum = 0, voiced = 0;
  for (let w = 0; w < n; w++) {
    if (rms[w] > thr) { if (first < 0) first = w; last = w; sum += rms[w] * rms[w]; voiced++; }
  }
  if (first < 0) return { trim: [0, dur], gain: 1, rms: 0, peak, speech: false };
  const speechRms = Math.sqrt(sum / voiced);
  const TARGET = 0.08; // ≈ −22 dBFS RMS: clear speech level, with headroom for the limiter
  const gain = Math.min(12, Math.max(0.25, TARGET / speechRms));
  const start = Math.max(0, first * win / sampleRate - 0.15);
  const end = Math.min(dur, (last + 1) * win / sampleRate + 0.3);
  return { trim: [start, end], gain, rms: speechRms, peak, speech: true };
}

// ---------------------------------------------------------------------------
// Browser only: audio context, recorder, analysis of clips, player.

let actx = null;
/** The page's one AudioContext (created on first use; browsers start it suspended). */
export function audioContext() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  return actx;
}
/** Resume audio after a user gesture (call from click / keydown / Enter VR). */
export function unlockAudio() {
  try { const c = audioContext(); if (c.state === 'suspended') c.resume(); } catch { /* no audio */ }
}

/** Decoded audio of a clip, cached on the clip. */
export async function decodeClip(c) {
  if (!c._buf) c._buf = await audioContext().decodeAudioData(await c.blob.arrayBuffer());
  return c._buf;
}
/** Fills in clip.gain and clip.trim from the audio (for new recordings and older files). */
export async function analyzeClip(c) {
  const buf = await decodeClip(c);
  const ch = buf.getChannelData(0);
  const a = analyzeSamples(ch, buf.sampleRate);
  c.gain = a.gain;
  c.trim = a.trim;
  if (!c.dur) c.dur = buf.duration;
  return a;
}

/**
 * Microphone recorder. start() asks for the microphone the first time (the stream stays open
 * for quick re-takes and is released after a minute of not recording); stop() resolves with
 * { blob, mime, dur }, or null for a clip shorter than 0.4 s. `level` is the input level of
 * the last ~50 ms (RMS, 0..1) for a meter.
 */
export function createRecorder({ onTick, onAutoStop } = {}) {
  let stream = null, rec = null, chunks = [], t0 = 0, timer = 0, releaseTimer = 0, finish = null;
  let analyser = null, meterSrc = null, meterBuf = null;
  const supported = typeof window !== 'undefined' && !!(navigator.mediaDevices && window.MediaRecorder);
  const mime = supported ? ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m)) || '' : '';

  async function mic() {
    clearTimeout(releaseTimer);
    if (stream && stream.getAudioTracks().some((t) => t.readyState === 'live')) return stream;
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    try { // level meter (not connected to the speakers)
      const c = audioContext();
      meterSrc = c.createMediaStreamSource(stream);
      analyser = c.createAnalyser();
      analyser.fftSize = 2048;
      meterBuf = new Float32Array(analyser.fftSize);
      meterSrc.connect(analyser);
    } catch { analyser = null; }
    return stream;
  }
  function release() {
    if (meterSrc) { try { meterSrc.disconnect(); } catch { /* gone */ } }
    meterSrc = analyser = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  return {
    supported,
    get recording() { return !!rec; },
    get elapsed() { return rec ? (performance.now() - t0) / 1000 : 0; },
    get level() {
      if (!analyser || !rec) return 0;
      analyser.getFloatTimeDomainData(meterBuf);
      let s = 0;
      for (let i = 0; i < meterBuf.length; i++) s += meterBuf[i] * meterBuf[i];
      return Math.sqrt(s / meterBuf.length);
    },
    /** Asks for the microphone without recording (a button on the page, before entering VR). */
    async allow() { await mic(); releaseTimer = setTimeout(release, 60000); },
    async start() {
      if (rec) return;
      const s = await mic();
      unlockAudio();
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
      }, 100);
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

/**
 * Plays a stop's narration: its segments one after another, each trimmed and at its gain,
 * through a limiter (so raised quiet speech never clips). onEnd(k) when the last segment ends
 * by itself; onFail(k) if the audio can't be played.
 */
export function createPlayer({ onEnd, onFail } = {}) {
  let current = -1, src = null, token = 0, out = null, seg = null, segCount = 0;
  function chain() {
    if (out) return out;
    const c = audioContext();
    const limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -8; limiter.knee.value = 6; limiter.ratio.value = 12;
    limiter.attack.value = 0.003; limiter.release.value = 0.15;
    limiter.connect(c.destination);
    out = { c, limiter, volume: c.createGain() };
    out.volume.connect(limiter);
    return out;
  }
  const player = {
    get playing() { return current; },
    /**
     * The segment playing now: { key (new for every segment started), k (stop), i (segment),
     * clip, t (seconds into the recording), progress (0..1 through the played part) }, or null.
     */
    get position() {
      if (!seg || current < 0 || !out) return null;
      const t = Math.min(seg.to, seg.from + (out.c.currentTime - seg.at));
      return { key: seg.key, k: seg.k, i: seg.i, clip: seg.clip, t, progress: (t - seg.from) / Math.max(1e-6, seg.to - seg.from) };
    },
    /** Master voice volume (1 = as analysed). */
    set volume(v) { chain().volume.gain.value = v; },
    get volume() { return chain().volume.gain.value; },
    play(k, clips) {
      if (!clips || !clips.length || typeof window === 'undefined') return false;
      this.stop();
      const my = ++token;
      current = k;
      unlockAudio();
      (async () => {
        const { c, volume } = chain();
        for (const clip of clips) {
          if (my !== token) return;
          const buf = await decodeClip(clip);
          if (!clip.trim || !clip.gain) await analyzeClip(clip); // e.g. from an older lesson file
          if (my !== token) return;
          const g = c.createGain();
          g.gain.value = clip.gain || 1;
          src = c.createBufferSource();
          src.buffer = buf;
          src.connect(g).connect(volume);
          const [a, b] = clip.trim || [0, buf.duration];
          // Which segment is playing, and from where in its recording (for subtitles and
          // gesture replay, whose times are on the recording's clock).
          seg = { key: ++segCount, k, i: clips.indexOf(clip), clip, at: c.currentTime, from: a, to: b };
          await new Promise((resolve) => { src.onended = resolve; src.start(0, a, Math.max(0.05, b - a)); });
          g.disconnect();
          seg = null;
        }
        if (my !== token) return;
        const k0 = current; current = -1; src = null;
        if (onEnd) onEnd(k0);
      })().catch((e) => {
        console.warn('Voice clip could not play', e);
        if (my === token) { current = -1; if (onFail) onFail(k, e); }
      });
      return true;
    },
    stop() {
      token++;
      if (src) { // stop the segment and let the waiting loop see the new token and quit
        const done = src.onended;
        src.onended = null;
        try { src.stop(); } catch { /* already stopped */ }
        if (done) done();
        src = null;
      }
      current = -1;
      seg = null;
    },
  };
  return player;
}
