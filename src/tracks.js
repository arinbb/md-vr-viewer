// Gesture tracks: what a teacher does while recording a narration segment, replayed in sync
// with it. DOM-free (plain arrays in, numbers out), so it runs in Node for the tests.
//
// A track belongs to one segment; times are seconds from the start of that recording (the
// same clock as the audio, so trimming the silence doesn't shift them):
//   pointer: [[t, atomId], …]   the atom the teacher's ray or mouse was on (-1 = none), on change
//   sel:     [[t, [atomIds]], …] the selection after each pick
//   motion:  [[t, qx, qy, qz, qw, px, py, pz, s], …] about 10 times a second: how the molecule
//            had moved in the viewer's eyes since the segment began, as a rotation (quaternion),
//            translation (in the molecule's own units, Å) and uniform scale. Replayed relative
//            to wherever the student has the molecule, so it turns as the teacher turned it.

/** The last event at or before time t (events sorted by time), or null. */
export function eventAt(events, t) {
  if (!events || !events.length || t < events[0][0]) return null;
  let lo = 0, hi = events.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (events[mid][0] <= t) lo = mid; else hi = mid - 1; }
  return events[lo];
}

/** Index of eventAt(events, t) (-1 if none): a cheap way to see when the active event changes. */
export function eventIndexAt(events, t) {
  const e = eventAt(events, t);
  return e ? events.indexOf(e) : -1;
}

/**
 * Motion at time t, interpolated between samples (position and scale linearly, rotation along
 * the shortest arc). Returns { q: [x, y, z, w], p: [x, y, z], s } or null without samples.
 */
export function motionAt(motion, t) {
  if (!motion || !motion.length) return null;
  const toPose = (m) => ({ q: [m[1], m[2], m[3], m[4]], p: [m[5], m[6], m[7]], s: m[8] });
  if (t <= motion[0][0]) return toPose(motion[0]);
  if (t >= motion[motion.length - 1][0]) return toPose(motion[motion.length - 1]);
  const i = eventIndexAt(motion, t);
  const a = motion[i], b = motion[i + 1];
  const u = (t - a[0]) / Math.max(1e-9, b[0] - a[0]);
  return {
    q: slerp([a[1], a[2], a[3], a[4]], [b[1], b[2], b[3], b[4]], u),
    p: [0, 1, 2].map((d) => a[5 + d] + u * (b[5 + d] - a[5 + d])),
    s: a[8] + u * (b[8] - a[8]),
  };
}

/** Spherical interpolation between unit quaternions [x, y, z, w]. */
export function slerp(a, b, u) {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; } // shortest way round
  let ka = 1 - u, kb = u;
  if (cos < 0.9995) {
    const th = Math.acos(cos), sn = Math.sin(th);
    ka = Math.sin((1 - u) * th) / sn; kb = Math.sin(u * th) / sn;
  }
  const q = [ka * a[0] + kb * bx, ka * a[1] + kb * by, ka * a[2] + kb * bz, ka * a[3] + kb * bw];
  const n = Math.hypot(...q) || 1;
  return q.map((x) => x / n);
}

/**
 * Keeps only what carries information: no pointer track if it never pointed at an atom, no
 * motion if the molecule never moved noticeably (< 1°, < 0.2 Å, < 1 % scale). Numbers are
 * rounded to keep lesson files small. Returns null if nothing is left.
 */
export function compactTrack(tr) {
  if (!tr) return null;
  const r = (x, d) => +x.toFixed(d);
  const out = {};
  if (tr.pointer && tr.pointer.some(([, id]) => id >= 0)) out.pointer = tr.pointer.map(([t, id]) => [r(t, 2), id]);
  if (tr.sel && tr.sel.length) out.sel = tr.sel.map(([t, ids]) => [r(t, 2), ids.slice()]);
  if (tr.motion && tr.motion.length) {
    const moved = tr.motion.some((m) => Math.abs(m[4]) < Math.cos(0.5 * Math.PI / 180) ||
      Math.hypot(m[5], m[6], m[7]) > 0.2 || Math.abs(m[8] - 1) > 0.01);
    if (moved) out.motion = tr.motion.map((m) => [r(m[0], 2), ...m.slice(1, 5).map((x) => r(x, 4)), ...m.slice(5, 8).map((x) => r(x, 2)), r(m[8], 4)]);
  }
  return Object.keys(out).length ? out : null;
}

/** A track read from a lesson file, with anything malformed dropped. */
export function cleanTrack(tr) {
  if (!tr || typeof tr !== 'object') return null;
  const ok = (a, n) => Array.isArray(a) && a.every((e) => Array.isArray(e) && e.length >= n && Number.isFinite(e[0]));
  const out = {};
  if (ok(tr.pointer, 2)) out.pointer = tr.pointer.filter((e) => Number.isInteger(e[1]));
  if (ok(tr.sel, 2)) out.sel = tr.sel.filter((e) => Array.isArray(e[1]));
  if (ok(tr.motion, 9)) out.motion = tr.motion.filter((e) => e.slice(0, 9).every(Number.isFinite));
  for (const k of Object.keys(out)) if (!out[k].length) delete out[k];
  return Object.keys(out).length ? out : null;
}

/**
 * Splits a transcript into subtitle-sized pieces (at most `max` characters, broken at word
 * boundaries, preferring sentence ends) and picks the piece for `progress` (0..1) through the
 * segment. Returns '' for no text.
 */
export function subtitleAt(text, progress, max = 90) {
  const chunks = subtitleChunks(text, max);
  if (!chunks.length) return '';
  const k = Math.min(chunks.length - 1, Math.max(0, Math.floor(progress * chunks.length)));
  return chunks[k];
}
export function subtitleChunks(text, max = 90) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (t.length > max && cur) { chunks.push(cur); cur = w; } else cur = t;
    if (/[.!?]$/.test(cur) && cur.length > max * 0.5) { chunks.push(cur); cur = ''; } // end at sentences
  }
  if (cur) chunks.push(cur);
  return chunks;
}
