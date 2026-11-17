// Turns a parsed trajectory (+ optional data file + user type map) into what the renderer needs:
// per-atom element, radius, and a bond list.

import { ELEMENTS, normalizeElement, elementFromMass } from './elements.js';

const FF = { forceField: true }; // type labels and type names are force-field atom types

/** "1:C 2:H 3=O, 4 N" -> { '1':'C', '2':'H', '3':'O', '4':'N' } */
export function parseTypeMap(str) {
  const map = {};
  for (const m of String(str || '').matchAll(/([^\s:=,;]+)\s*[:=\s]\s*([A-Za-z]{1,2})\b/g)) {
    const el = normalizeElement(m[2]);
    if (el) map[m[1]] = el;
  }
  return map;
}

/**
 * Element for every atom. Priority: user map > dump "element" column > data-file type label
 * > data-file mass > type string itself (if it looks like an element) > "X".
 */
export function resolveElements(traj, data, userMap = {}) {
  const typeToEl = {};
  const sources = {};
  const uniqueTypes = [...new Set(traj.types)];
  for (const t of uniqueTypes) {
    let el = null, src = null;
    if (userMap[t]) { el = userMap[t]; src = 'your mapping'; }
    else if (data && data.typeLabels[t] && normalizeElement(data.typeLabels[t], FF)) { el = normalizeElement(data.typeLabels[t], FF); src = 'data file label'; }
    else if (data && data.masses[t] != null && elementFromMass(data.masses[t])) { el = elementFromMass(data.masses[t]); src = `mass ${data.masses[t]}`; }
    else if (!/^\d+$/.test(t) && normalizeElement(t, FF)) { el = normalizeElement(t, FF); src = 'type name'; }
    typeToEl[t] = el;
    sources[t] = src;
  }
  const elements = new Array(traj.n);
  for (let i = 0; i < traj.n; i++) {
    const t = traj.types[i];
    const fromCol = traj.elements[i] ? normalizeElement(traj.elements[i]) : null;
    elements[i] = (userMap[t] || fromCol || typeToEl[t] || 'X');
    if (fromCol && !userMap[t] && !sources[t]) sources[t] = 'element column';
  }
  const summary = uniqueTypes
    .sort((a, b) => (+a - +b) || a.localeCompare(b))
    .map((t) => {
      const i = traj.types.indexOf(t);
      return { type: t, element: elements[i], source: sources[t] || 'unknown', count: traj.types.filter((x) => x === t).length };
    });
  return { elements, summary };
}

/** Molecule IDs: dump "mol" column, else from the data file, else null. */
export function resolveMols(traj, data) {
  if (traj.mols) return traj.mols;
  if (!data || !data.atoms.size) return null;
  const mols = new Int32Array(traj.n);
  let any = false;
  for (let i = 0; i < traj.n; i++) {
    const a = data.atoms.get(traj.ids[i]);
    if (a && a.mol != null) { mols[i] = a.mol; any = true; }
  }
  return any ? mols : null;
}

/** Bonds from a data file, as index pairs into the trajectory arrays. */
export function bondsFromData(traj, data) {
  const idx = new Map();
  for (let i = 0; i < traj.n; i++) idx.set(traj.ids[i], i);
  const out = [];
  for (const [a, b] of data.bonds) {
    const i = idx.get(a), j = idx.get(b);
    if (i !== undefined && j !== undefined) out.push(i, j);
  }
  return new Int32Array(out);
}

/**
 * Distance-based bonds on one frame: bond if d < tolerance * (cov_i + cov_j).
 * Uses a uniform grid so it is O(n). If `box` is given, bonds across periodic boundaries are
 * found too (atoms near a periodic face get ghost images). If `mols` is given, only atoms in
 * the same molecule are bonded.
 */
/** Cell index along one axis, clamped to [0, n-1]; NaN goes to 0. */
function cellCoord(v, lo, cell, n) {
  const k = Math.floor((v - lo) / cell);
  return k >= 0 ? (k < n ? k : n - 1) : 0;
}

export function inferBonds(pos, elements, { tolerance = 1.2, mols = null, box = null, maxBonds = 2_000_000 } = {}) {
  const n = elements.length;
  if (!n) return new Int32Array(0);
  const rad = new Float32Array(n);
  let maxR = 0;
  for (let i = 0; i < n; i++) {
    rad[i] = (ELEMENTS[elements[i]] || ELEMENTS.X).cov;
    if (rad[i] > maxR) maxR = rad[i];
  }
  const cell = 2 * maxR * tolerance;

  // Extended point set: real atoms (wrapped into the box) + ghost images near periodic faces.
  let P = pos, orig = null, m = n;
  if (box && box.periodic.some(Boolean)) ({ P, orig, m } = withGhosts(pos, n, box, cell));
  const origOf = (k) => (orig ? orig[k] : k);

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m; i++) for (let d = 0; d < 3; d++) {
    const v = P[3 * i + d];
    if (v < min[d]) min[d] = v;
    if (v > max[d]) max[d] = v;
  }
  const dim = [0, 1, 2].map((d) => Math.max(1, Math.floor((max[d] - min[d]) / cell) + 1));
  // Counting sort of points into cells (flat integer keys, no per-cell arrays).
  const cellOf = new Int32Array(3 * m);
  const keyOf = new Int32Array(m);
  const nCells = dim[0] * dim[1] * dim[2];
  const useMap = !Number.isSafeInteger(nCells) || nCells > 8 * m + 1024; // sparse systems
  const cellStart = useMap ? null : new Int32Array(nCells + 1);
  const map = useMap ? new Map() : null;
  for (let i = 0; i < m; i++) {
    // A NaN coordinate (e.g. "nan" in a dump) lands in cell 0 and never matches a distance test.
    const cx = cellCoord(P[3 * i], min[0], cell, dim[0]);
    const cy = cellCoord(P[3 * i + 1], min[1], cell, dim[1]);
    const cz = cellCoord(P[3 * i + 2], min[2], cell, dim[2]);
    cellOf[3 * i] = cx; cellOf[3 * i + 1] = cy; cellOf[3 * i + 2] = cz;
    const k = cx + dim[0] * (cy + dim[1] * cz);
    keyOf[i] = k;
    if (useMap) { let l = map.get(k); if (!l) map.set(k, (l = [])); l.push(i); } else cellStart[k + 1]++;
  }
  let sorted = null;
  if (!useMap) {
    for (let k = 0; k < nCells; k++) cellStart[k + 1] += cellStart[k];
    sorted = new Int32Array(m);
    const fill = cellStart.slice(0, nCells);
    for (let i = 0; i < m; i++) sorted[fill[keyOf[i]]++] = i;
  }
  const EMPTY = [];
  const cellAtoms = (k) => (useMap ? map.get(k) || EMPTY : sorted.subarray(cellStart[k], cellStart[k + 1]));
  const out = [];
  const seen = orig ? new Set() : null; // a pair can be found via several images
  // Only real atoms (i < n) start searches; partners may be real or ghosts.
  for (let i = 0; i < n; i++) {
    const cx = cellOf[3 * i], cy = cellOf[3 * i + 1], cz = cellOf[3 * i + 2];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const x = cx + dx, y = cy + dy, z = cz + dz;
      if (x < 0 || y < 0 || z < 0 || x >= dim[0] || y >= dim[1] || z >= dim[2]) continue;
      const list = cellAtoms(x + dim[0] * (y + dim[1] * z));
      for (const k of list) {
        const j = origOf(k);
        if (j <= i) continue;
        if (mols && mols[i] !== mols[j]) continue;
        const ex = P[3 * i] - P[3 * k], ey = P[3 * i + 1] - P[3 * k + 1], ez = P[3 * i + 2] - P[3 * k + 2];
        const d2 = ex * ex + ey * ey + ez * ez;
        // Never bond H-H unless very close (avoids water H's bonding each other).
        let lim = tolerance * (rad[i] + rad[j]);
        if (elements[i] === 'H' && elements[j] === 'H') lim = 0.85;
        if (d2 < lim * lim && d2 > 0.01) {
          if (seen) { const key = i * n + j; if (seen.has(key)) continue; seen.add(key); }
          out.push(i, j);
          if (out.length >= 2 * maxBonds) return new Int32Array(out);
        }
      }
    }
  }
  return new Int32Array(out);
}

/**
 * Bonds that hold across the trajectory. Bonds are inferred on the first, middle and last frames
 * and kept if found in at least 2 of them (both, when only 2 frames exist). This drops contacts
 * that exist in only one frame, such as overlapping atoms in an unequilibrated starting
 * structure, while a single stretched frame doesn't remove a real bond.
 */
export function inferStableBonds(frames, elements, { mols = null, tolerance } = {}) {
  const picks = [...new Set([0, frames.length >> 1, frames.length - 1])];
  if (picks.length === 1) return inferBonds(frames[0].pos, elements, { mols, box: frames[0].box, tolerance });
  const n = elements.length;
  const votes = new Map();
  for (const fi of picks) {
    const b = inferBonds(frames[fi].pos, elements, { mols, box: frames[fi].box, tolerance });
    for (let k = 0; k < b.length; k += 2) {
      const i = Math.min(b[k], b[k + 1]), j = Math.max(b[k], b[k + 1]);
      const key = i * n + j;
      votes.set(key, (votes.get(key) || 0) + 1);
    }
  }
  const out = [];
  for (const [key, v] of votes) if (v >= 2) out.push(Math.floor(key / n), key % n);
  return new Int32Array(out);
}

/** Wrap atoms into the box and append ghost copies of atoms within `margin` of a periodic face. */
function withGhosts(pos, n, box, margin) {
  const lx = box.hi[0] - box.lo[0], ly = box.hi[1] - box.lo[1], lz = box.hi[2] - box.lo[2];
  const [xy, xz, yz] = box.tilt;
  const A = [lx, 0, 0], B = [xy, ly, 0], C = [xz, yz, lz];
  const cr = (u, v) => Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
  const vol = lx * ly * lz;
  // Margin as a fraction of the perpendicular width in each direction (triclinic-safe).
  const w = [margin * cr(B, C) / vol, margin * cr(C, A) / vol, margin * cr(A, B) / vol];
  const per = box.periodic;
  const fr = new Float64Array(3 * n);
  const P = [];
  for (let i = 0; i < n; i++) {
    const dx = pos[3 * i] - box.lo[0], dy = pos[3 * i + 1] - box.lo[1], dz = pos[3 * i + 2] - box.lo[2];
    let fz = dz / lz, fy = (dy - fz * yz) / ly, fx = (dx - fy * xy - fz * xz) / lx;
    if (per[0]) fx -= Math.floor(fx);
    if (per[1]) fy -= Math.floor(fy);
    if (per[2]) fz -= Math.floor(fz);
    fr[3 * i] = fx; fr[3 * i + 1] = fy; fr[3 * i + 2] = fz;
    P.push(box.lo[0] + fx * lx + fy * xy + fz * xz, box.lo[1] + fy * ly + fz * yz, box.lo[2] + fz * lz);
  }
  const orig = Array.from({ length: n }, (_, i) => i);
  const opts = (f, d) => {
    if (!per[d] || w[d] >= 0.5) return per[d] ? [-1, 0, 1] : [0];
    const o = [0];
    if (f < w[d]) o.push(1);        // near low face: image shifted by +1 box vector
    if (f > 1 - w[d]) o.push(-1);   // near high face: image shifted by -1
    return o;
  };
  for (let i = 0; i < n; i++) {
    const ox = opts(fr[3 * i], 0), oy = opts(fr[3 * i + 1], 1), oz = opts(fr[3 * i + 2], 2);
    if (ox.length === 1 && oy.length === 1 && oz.length === 1) continue;
    for (const sx of ox) for (const sy of oy) for (const sz of oz) {
      if (!sx && !sy && !sz) continue;
      P.push(P[3 * i] + sx * A[0] + sy * B[0] + sz * C[0], P[3 * i + 1] + sy * B[1] + sz * C[1], P[3 * i + 2] + sz * C[2]);
      orig.push(i);
    }
  }
  return { P: new Float32Array(P), orig: Int32Array.from(orig), m: orig.length };
}

/** Display radius (Å) per representation. */
export function atomRadius(el, rep) {
  const e = ELEMENTS[el] || ELEMENTS.X;
  if (rep === 'spacefill') return e.vdw;
  if (rep === 'licorice') return 0.2;
  return 0.25 * e.vdw + 0.05; // ball & stick
}

/** Box corner vertices (8 x [x,y,z]) for a possibly triclinic box. */
export function boxCorners(box) {
  const [xlo, ylo, zlo] = box.lo;
  const a = [box.hi[0] - xlo, 0, 0];
  const b = [box.tilt[0], box.hi[1] - ylo, 0];
  const c = [box.tilt[1], box.tilt[2], box.hi[2] - zlo];
  const out = [];
  for (let k = 0; k < 8; k++) {
    const i = k & 1, j = (k >> 1) & 1, l = (k >> 2) & 1;
    out.push([xlo + i * a[0] + j * b[0] + l * c[0], ylo + i * a[1] + j * b[1] + l * c[1], zlo + i * a[2] + j * b[2] + l * c[2]]);
  }
  return out;
}
