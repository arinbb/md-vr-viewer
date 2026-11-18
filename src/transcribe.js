// Automatic transcripts for narration segments (opt-in), on this device.
//
// The page side: crops a segment's audio to its spoken part, resamples it to 16 kHz mono (what
// Whisper takes) and hands it to transcribe-worker.js. Importing this module costs nothing:
// the worker, and its download, start only on the first transcribe().
// cleanTranscript is DOM-free (tested in Node).

/** Whisper's non-speech markers ("[BLANK_AUDIO]", "(music)", "♪") removed, spaces tidied. */
export function cleanTranscript(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]|\([^)]*\)|♪+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .trim();
}

/**
 * The spoken part of a decoded clip (AudioBuffer) as 16 kHz mono samples. trim = [from, to]
 * in seconds (the clip's silence trim), or the whole clip.
 */
export async function speechSamples(buf, trim) {
  const rate = 16000;
  const [a, b] = trim || [0, buf.duration];
  const len = Math.max(1, Math.ceil((b - a) * rate));
  const ctx = new OfflineAudioContext(1, len, rate);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0, a, b - a);
  return (await ctx.startRendering()).getChannelData(0);
}

/**
 * The speech-to-text engine: transcribe(samples, onProgress) resolves the text (cleaned).
 * onProgress(0..1) reports the one-time download.
 */
export function createTranscriber() {
  let worker = null, seq = 0;
  const waiting = new Map();
  let progress = null;
  function start() {
    worker = new Worker(new URL('./transcribe-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.progress !== undefined) { if (progress) progress(m.progress); return; }
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.error) w.reject(new Error(m.error)); else w.resolve(cleanTranscript(m.text));
    };
    worker.onerror = (e) => {
      for (const w of waiting.values()) w.reject(new Error(e.message || 'the speech worker failed to start'));
      waiting.clear();
      worker.terminate();
      worker = null;
    };
  }
  return {
    transcribe(samples, onProgress) {
      if (!worker) start();
      progress = onProgress || null;
      const id = ++seq;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        worker.postMessage({ id, samples });
      });
    },
  };
}
