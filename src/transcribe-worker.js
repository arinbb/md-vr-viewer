// Speech-to-text worker for narration transcripts (opt-in; see transcribe.js).
//
// Runs Whisper (tiny, English, 8-bit) with transformers.js on this device, in a worker so the
// page and VR keep rendering while it works. The library, its WebAssembly engine and the model
// are downloaded the first time (about 65 MB) and cached by the browser: transformers.js keeps
// the model in Cache Storage, the service worker keeps the library. The audio never leaves
// the device.
//
// Messages in:  { id, samples: Float32Array (16 kHz mono) }
// Messages out: { progress: 0..1 } while downloading; { id, text } or { id, error }.

export const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';
const MODEL = 'onnx-community/whisper-tiny.en';

let asrP = null;
function load() {
  if (!asrP) {
    asrP = import(LIB).then(({ pipeline, env }) => {
      env.allowLocalModels = false;
      const files = new Map();
      return pipeline('automatic-speech-recognition', MODEL, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: (p) => {
          if (p.status !== 'progress' || !p.total) return;
          files.set(p.file, [p.loaded, p.total]);
          let a = 0, b = 0;
          for (const [l, t] of files.values()) { a += l; b += t; }
          self.postMessage({ progress: a / b });
        },
      });
    });
    asrP.catch(() => { asrP = null; }); // try again next time (e.g. offline the first time)
  }
  return asrP;
}

self.onmessage = async (e) => {
  const { id, samples } = e.data || {};
  try {
    const asr = await load();
    const out = await asr(samples, { chunk_length_s: 30, stride_length_s: 5 });
    self.postMessage({ id, text: (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text) || '' });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
