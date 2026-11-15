// Parses trajectory files off the main thread, streaming them in chunks so multi-GB dumps
// never have to exist as one JS string (V8 caps strings at ~0.5–1 GB). Gzipped files
// (.gz, e.g. from `dump custom/gz`) are decompressed on the fly.
import { createTrajectoryParser, parseDataFile } from './lammps.js';

// Positions are stored as float32: 12 bytes per atom per frame, plus 4 per extra column. Stay well
// below what a browser tab can allocate. Quest standalone browsers have less memory than desktops.
const MEMORY_BUDGET = /OculusBrowser|Quest/.test(self.navigator.userAgent) ? 0.8e9 : 2.0e9;

/** True if the file starts with the gzip magic bytes. */
async function isGzip(file) {
  const b = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return b[0] === 0x1f && b[1] === 0x8b;
}

/** Text stream of the file, decompressing gzip. `counter.raw` tracks compressed bytes read. */
async function textStream(file, counter) {
  let bytes = file.stream().pipeThrough(new TransformStream({
    transform(chunk, ctl) { counter.raw += chunk.byteLength; ctl.enqueue(chunk); },
  }));
  if (await isGzip(file)) bytes = bytes.pipeThrough(new DecompressionStream('gzip'));
  return bytes.pipeThrough(new TextDecoderStream());
}

async function readAllText(file) {
  const reader = (await textStream(file, { raw: 0 })).getReader();
  let out = '';
  for (;;) { const { done, value } = await reader.read(); if (done) return out; out += value; }
}

self.onmessage = async (e) => {
  const { id, kind, file, text, stride } = e.data;
  const reply = (msg, transfer) => self.postMessage({ id, ...msg }, transfer || []);
  try {
    if (kind === 'data') {
      reply({ ok: true, kind, result: parseDataFile(text ?? (await readAllText(file))) });
      return;
    }
    const size = file ? file.size : text.length;
    const counter = { raw: 0 };
    let consumed = 0, lastReport = 0;
    let parser = null;
    let autoStride = null;
    const opts = {
      stride,
      onFirstFrame: ({ n, frameChars, bytesPerAtom }) => {
        // For compressed files, scale the file size by the compression ratio seen so far.
        const ratio = counter.raw > 0 ? consumed / counter.raw : 1;
        const framesInFile = Math.max(1, Math.round((size * Math.max(ratio, 1)) / Math.max(frameChars, 1)));
        const bytes = (framesInFile / stride) * n * bytesPerAtom;
        if (bytes > MEMORY_BUDGET) {
          autoStride = Math.ceil((framesInFile * n * bytesPerAtom) / MEMORY_BUDGET);
          return autoStride;
        }
        return null;
      },
    };

    const feed = (chunkText, final) => {
      // Called with text that ends on a line boundary (except possibly the final chunk).
      let start = 0;
      for (;;) {
        let end = chunkText.indexOf('\n', start);
        if (end === -1) { if (final && start < chunkText.length) end = chunkText.length; else break; }
        let line = chunkText.slice(start, end);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!parser) parser = createTrajectoryParser(chunkText.slice(start, start + 200), opts);
        parser.push(line);
        start = end + 1;
        if (start > chunkText.length) break;
      }
      return chunkText.slice(start);
    };

    if (text != null) {
      feed(text, true);
    } else {
      const reader = (await textStream(file, counter)).getReader();
      let carry = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumed += value.length;
        carry = feed(carry + value, false);
        const now = performance.now();
        if (now - lastReport > 150) {
          lastReport = now;
          reply({ progress: Math.min(counter.raw / size, 1), nframes: parser ? parser.traj.frames.length : 0 });
        }
      }
      if (carry) feed(carry + '\n', true);
    }
    if (!parser) throw new Error('File is empty.');
    const traj = parser.finish();
    if (autoStride) {
      traj.warnings.unshift(`This trajectory is too large to hold in memory, so only every ${traj.stride}th frame was loaded.`);
    }
    const transfer = [traj.ids.buffer];
    for (const f of traj.frames) {
      transfer.push(f.pos.buffer);
      for (const a of Object.values(f.props)) transfer.push(a.buffer);
    }
    if (traj.mols) transfer.push(traj.mols.buffer);
    reply({ ok: true, kind, result: traj }, transfer);
  } catch (err) {
    reply({ ok: false, kind, error: String((err && err.message) || err) });
  }
};
