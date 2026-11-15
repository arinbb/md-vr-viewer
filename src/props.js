// Extra per-atom dump columns (velocities, forces, charge, computes...): vector detection,
// robust value ranges and colormaps. Pure functions (testable in Node).

/** Vector columns among the props: vx/vy/vz, fx/fy/fz, mux/muy/muz, c_name[1..3] ... */
export function vectorFamilies(props) {
  const has = new Set(props);
  const out = [];
  const named = { v: 'velocity', f: 'force', mu: 'dipole', omega: 'angular velocity', angmom: 'angular momentum' };
  for (const [base, label] of Object.entries(named)) {
    const cols = ['x', 'y', 'z'].map((c) => base + c);
    if (cols.every((c) => has.has(c))) out.push({ name: base, label, cols });
  }
  for (const p of props) {
    const m = /^(.+)\[1\]$/.exec(p);
    if (!m) continue;
    const cols = [1, 2, 3].map((k) => `${m[1]}[${k}]`);
    if (cols.every((c) => has.has(c))) out.push({ name: m[1], label: m[1], cols });
  }
  return out;
}

/** Display names for color-by keys: 'p:<column>' or 'mag:<family>'. */
export function propLabel(key, families) {
  if (key.startsWith('mag:')) {
    const f = families.find((x) => x.name === key.slice(4));
    if (!f) return key;
    return f.name === 'v' ? 'speed |v|' : f.name === 'f' ? 'force |f|' : `|${f.label}|`;
  }
  return key.slice(2);
}

/** Values of a color-by key for one frame into `out` (Float32Array(n)). */
export function propValues(frame, key, families, out) {
  if (key.startsWith('mag:')) {
    const f = families.find((x) => x.name === key.slice(4));
    const [a, b, c] = f.cols.map((col) => frame.props[col]);
    for (let i = 0; i < out.length; i++) out[i] = Math.hypot(a[i], b[i], c[i]);
  } else {
    out.set(frame.props[key.slice(2)]);
  }
  return out;
}

/**
 * Robust color range over the trajectory (2nd–98th percentile of a sample of values).
 * Signed quantities that straddle zero get a symmetric diverging range.
 */
export function propRange(frames, key, families, n) {
  const sample = [];
  const tmp = new Float32Array(n);
  const step = Math.max(1, Math.floor((frames.length * n) / 400000));
  let k = 0;
  for (const f of frames) {
    propValues(f, key, families, tmp);
    for (let i = 0; i < n; i++, k++) if (k % step === 0 && Number.isFinite(tmp[i])) sample.push(tmp[i]);
  }
  if (!sample.length) return { min: 0, max: 1, diverging: false };
  sample.sort((a, b) => a - b);
  const q = (p) => sample[Math.min(sample.length - 1, Math.floor(p * sample.length))];
  let min = q(0.02), max = q(0.98);
  if (min === max) { min = sample[0]; max = sample[sample.length - 1]; }
  if (min === max) max = min + 1;
  const diverging = !key.startsWith('mag:') && min < 0 && max > 0;
  if (diverging) { const m = Math.max(-min, max); min = -m; max = m; }
  return { min, max, diverging };
}

// Viridis (sequential) and a blue–white–red (diverging) ramp, as RGB 0..1 stops.
const VIRIDIS = [[0.267, 0.005, 0.329], [0.283, 0.141, 0.458], [0.254, 0.265, 0.530], [0.207, 0.372, 0.553],
  [0.164, 0.471, 0.558], [0.128, 0.567, 0.551], [0.135, 0.659, 0.518], [0.267, 0.749, 0.441],
  [0.478, 0.821, 0.318], [0.741, 0.873, 0.150], [0.993, 0.906, 0.144]];
const DIVERGING = [[0.230, 0.299, 0.754], [0.552, 0.690, 0.996], [0.866, 0.866, 0.866], [0.957, 0.604, 0.482], [0.706, 0.016, 0.150]];

/** Color for value v in [min, max] into out[o..o+2]. */
export function colormap(v, range, out, o) {
  const stops = range.diverging ? DIVERGING : VIRIDIS;
  let t = (v - range.min) / (range.max - range.min);
  t = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  const x = t * (stops.length - 1);
  const k = Math.min(stops.length - 2, Math.floor(x));
  const u = x - k;
  for (let c = 0; c < 3; c++) out[o + c] = stops[k][c] + u * (stops[k + 1][c] - stops[k][c]);
}

export function gradientCSS(diverging) {
  const stops = diverging ? DIVERGING : VIRIDIS;
  return `linear-gradient(90deg, ${stops.map((s) => `rgb(${s.map((c) => Math.round(c * 255)).join(',')})`).join(', ')})`;
}

/** Short number formatting for legends. */
export function fmt(v) {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000 || a < 0.01) return v.toExponential(1);
  return v.toPrecision(3).replace(/\.?0+$/, '');
}
