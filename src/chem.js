// Chemistry helpers on positions: guessing elements from bonding geometry, "atoms near X" masks
// for solvation shells, and hydrogen-bond detection. Pure functions (testable in Node).
import { inferBonds } from './model.js';
import { minImage } from './analysis.js';

// ---------------------------------------------------------------------------
// Uniform cell list over a subset of atoms (non-periodic: works on displayed coordinates).
// Counting sort into typed arrays: no per-cell allocations, so it is cheap to rebuild per frame.

function buildGrid(pos, idx, cell) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  // Keep the cell count bounded for sparse or huge systems.
  while (((x1 - x0) / cell + 1) * ((y1 - y0) / cell + 1) * ((z1 - z0) / cell + 1) > 4e6) cell *= 1.5;
  const nx = Math.floor((x1 - x0) / cell) + 1, ny = Math.floor((y1 - y0) / cell) + 1, nz = Math.floor((z1 - z0) / cell) + 1;
  const cellOf = new Int32Array(idx.length);
  const start = new Int32Array(nx * ny * nz + 1);
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const c = (Math.floor((pos[3 * i] - x0) / cell) * ny + Math.floor((pos[3 * i + 1] - y0) / cell)) * nz +
      Math.floor((pos[3 * i + 2] - z0) / cell);
    cellOf[k] = c;
    start[c + 1]++;
  }
  for (let c = 0; c < nx * ny * nz; c++) start[c + 1] += start[c];
  const fill = start.slice(0, nx * ny * nz);
  const items = new Int32Array(idx.length);
  for (let k = 0; k < idx.length; k++) items[fill[cellOf[k]]++] = idx[k];
  return { x0, y0, z0, cell, nx, ny, nz, start, items };
}

/** Calls fn(j) for grid atoms in the 27 cells around (x, y, z); stops early if fn returns true. */
function forNeighbors(g, x, y, z, fn) {
  const cx = Math.floor((x - g.x0) / g.cell), cy = Math.floor((y - g.y0) / g.cell), cz = Math.floor((z - g.z0) / g.cell);
  const xa = Math.max(cx - 1, 0), xb = Math.min(cx + 1, g.nx - 1);
  const ya = Math.max(cy - 1, 0), yb = Math.min(cy + 1, g.ny - 1);
  const za = Math.max(cz - 1, 0), zb = Math.min(cz + 1, g.nz - 1);
  const { start, items, ny, nz } = g;
  for (let a = xa; a <= xb; a++) for (let b = ya; b <= yb; b++) {
    const row = (a * ny + b) * nz;
    for (let k = start[row + za], end = start[row + zb + 1]; k < end; k++) if (fn(items[k])) return;
  }
}

/**
 * For each candidate atom, 1 if it lies within R of any reference atom (displayed coordinates).
 * Returns Uint8Array(n) with marks on candidates only.
 */
export function nearMask(pos, refIdx, candIdx, R, n) {
  const out = new Uint8Array(n);
  if (!refIdx.length) return out;
  const grid = buildGrid(pos, refIdx, R);
  const R2 = R * R;
  for (let k = 0; k < candIdx.length; k++) {
    const i = candIdx[k];
    const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
    forNeighbors(grid, x, y, z, (j) => {
      const dx = pos[3 * j] - x, dy = pos[3 * j + 1] - y, dz = pos[3 * j + 2] - z;
      if (dx * dx + dy * dy + dz * dz < R2) { out[i] = 1; return true; }
      return false;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hydrogen bonds

const POLAR = new Set(['N', 'O', 'F']);

/**
 * Donor hydrogens (H bonded to N/O/F) as pairs [h, donor], and acceptor atoms.
 *
 * O and F always accept. N accepts only if it has a lone pair free to take an H-bond:
 *  - 4 bonds (ammonium, e.g. glycine's NH3+): no lone pair, not an acceptor.
 *  - 3 bonds and planar (amide, aromatic or methylated ring N such as caffeine's N1/N3/N7): the
 *    lone pair is delocalized into the pi system, so it is at best a very weak acceptor; excluded.
 *  - 3 bonds and pyramidal (amine): acceptor.  1-2 bonds (imine/pyridine-like, caffeine's N9): acceptor.
 * Planarity needs coordinates: pass `frames` ([{pos, box}], a few are averaged). Without them,
 * 3-bonded N counts as an acceptor.
 */
export function hbondParticipants(elements, bonds, frames = null) {
  const n = elements.length;
  const hd = [];
  const deg = new Uint8Array(n);
  for (let b = 0; b < bonds.length; b += 2) {
    const i = bonds[b], j = bonds[b + 1];
    deg[i]++; deg[j]++;
    if (elements[i] === 'H' && POLAR.has(elements[j])) hd.push(i, j);
    else if (elements[j] === 'H' && POLAR.has(elements[i])) hd.push(j, i);
  }
  // Neighbors of 3-bonded nitrogens, for the planarity test.
  const nbr = new Map();
  for (let b = 0; b < bonds.length; b += 2) {
    const i = bonds[b], j = bonds[b + 1];
    for (const [x, y] of [[i, j], [j, i]]) {
      if (elements[x] === 'N' && deg[x] === 3) { if (!nbr.has(x)) nbr.set(x, []); nbr.get(x).push(y); }
    }
  }
  const acc = [];
  for (let i = 0; i < n; i++) {
    const e = elements[i];
    if (e === 'O' || e === 'F') acc.push(i);
    else if (e === 'N') {
      if (deg[i] >= 4) continue;
      if (deg[i] === 3 && frames && frames.length && nitrogenHeight(frames, i, nbr.get(i)) < N_PLANAR) continue;
      acc.push(i);
    }
  }
  return { hd: Int32Array.from(hd), acc: Int32Array.from(acc) };
}

/** Planar if N sits closer than this (Å) to the plane of its 3 neighbors (amines: ~0.35-0.45 Å). */
const N_PLANAR = 0.2;

/** Mean distance of atom i from the plane through its three neighbors, over the given frames. */
function nitrogenHeight(frames, i, nb) {
  let sum = 0;
  const v = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const { pos, box } of frames) {
    for (let k = 0; k < 3; k++) {
      const j = nb[k];
      minImage(box, pos[3 * j] - pos[3 * i], pos[3 * j + 1] - pos[3 * i + 1], pos[3 * j + 2] - pos[3 * i + 2], v[k]);
    }
    const [a, b, c] = v;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    // N is at the origin; the plane passes through a.
    sum += Math.abs(nx * a[0] + ny * a[1] + nz * a[2]) / nl;
  }
  return sum / frames.length;
}

/**
 * H-bonds D–H···A with H···A ≤ maxHA (Å) and angle D–H···A ≥ minAngle (degrees).
 * `keep(h, d, a)` filters candidates (visibility, solute-only...). Returns Int32Array of [h, a] pairs.
 */
export function findHBonds(pos, { hd, acc }, { maxHA = 2.5, minAngle = 120, keep = null } = {}) {
  if (!hd.length || !acc.length) return new Int32Array(0);
  const out = [];
  const grid = buildGrid(pos, acc, maxHA);
  const max2 = maxHA * maxHA;
  const cosMin = Math.cos((minAngle * Math.PI) / 180);
  for (let k = 0; k < hd.length; k += 2) {
    const h = hd[k], d = hd[k + 1];
    const hx = pos[3 * h], hy = pos[3 * h + 1], hz = pos[3 * h + 2];
    const ux = pos[3 * d] - hx, uy = pos[3 * d + 1] - hy, uz = pos[3 * d + 2] - hz;
    const ul = Math.hypot(ux, uy, uz) || 1;
    forNeighbors(grid, hx, hy, hz, (a) => {
      if (a === d) return false;
      const vx = pos[3 * a] - hx, vy = pos[3 * a + 1] - hy, vz = pos[3 * a + 2] - hz;
      const v2 = vx * vx + vy * vy + vz * vz;
      if (v2 > max2 || v2 < 0.25) return false;
      // Angle at H between D and A: cos ≤ cos(minAngle) means the angle is wide enough.
      const c = (ux * vx + uy * vy + uz * vz) / (ul * Math.sqrt(v2));
      if (c > cosMin) return false;
      if (keep && !keep(h, d, a)) return false;
      out.push(h, a);
      return false;
    });
  }
  return Int32Array.from(out);
}

// ---------------------------------------------------------------------------
// Element guessing from bonding geometry (for dumps whose types are bare numbers).

/**
 * Guess an element for each numeric type from bonding geometry: hydrogens from short X–H contacts,
 * heavy atoms from their H count, X–H length, coordination and bond lengths. Contacts come from the
 * middle frame; their lengths are averaged over several frames and over all atoms of a type, so
 * thermal noise doesn't flip borderline cases (e.g. N–CH3 1.45 Å vs C–CH3 1.51 Å).
 * Returns { map: {type: element}, confidence: {type: 'high'|'low'}, notes: {type: string} }.
 * Types that already have an element (in `known`) are skipped.
 */
export function guessElements(traj, known = {}) {
  const { n, types, frames } = traj;
  const nf = frames.length;
  const ref = frames[nf >> 1];
  const sampleFrames = [...new Set([nf >> 2, nf >> 1, (3 * nf) >> 2, nf - 1].filter((k) => k >= 0))].map((k) => frames[k]);
  // All contacts up to 1.9 Å in the middle frame (generic radii: 1.2667 * (0.75 + 0.75) = 1.9).
  const pairs = inferBonds(ref.pos, new Array(n).fill('X'), { tolerance: 1.9 / 1.5, box: ref.box });
  const nb = Array.from({ length: n }, () => []);
  const d = [0, 0, 0];
  for (let k = 0; k < pairs.length; k += 2) {
    const i = pairs[k], j = pairs[k + 1];
    let sum = 0;
    for (const f of sampleFrames) {
      const p = f.pos;
      minImage(f.box, p[3 * j] - p[3 * i], p[3 * j + 1] - p[3 * i + 1], p[3 * j + 2] - p[3 * i + 2], d);
      sum += Math.hypot(d[0], d[1], d[2]);
    }
    const r = sum / sampleFrames.length;
    nb[i].push([j, r]); nb[j].push([i, r]);
  }
  const SHORT = 1.15, HEAVY = 1.75;
  const short = nb.map((l) => l.filter(([, r]) => r < SHORT));
  const mid = nb.map((l) => l.filter(([, r]) => r >= SHORT && r < HEAVY).length);

  // 1. Hydrogens, per atom, then by type majority.
  const isHAtom = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (short[i].length !== 1) continue;
    const p = short[i][0][0];
    if (short[p].length >= 2) isHAtom[i] = 1;                // water H, CH3 hydrogens
    else if (mid[i] < mid[p]) isHAtom[i] = 1;                // hydroxyl: O also has a C neighbor
    else if (mid[i] === mid[p] && i > p) isHAtom[i] = 1;     // symmetric (H2, OH-): pick one
  }
  const byType = new Map();
  for (let i = 0; i < n; i++) {
    if (known[types[i]]) continue;
    let l = byType.get(types[i]);
    if (!l) byType.set(types[i], (l = []));
    l.push(i);
  }
  const typeIsH = new Map();
  for (const [t, atoms] of byType) typeIsH.set(t, atoms.filter((i) => isHAtom[i]).length > atoms.length / 2);
  const isH = (i) => (known[types[i]] ? known[types[i]] === 'H' : typeIsH.get(types[i]));

  // 2. Per-atom features, averaged per type.
  const heavyOf = (i) => nb[i].filter(([j, r]) => !isH(j) && r < HEAVY);
  const hOf = (i) => nb[i].filter(([j, r]) => isH(j) && r < 1.4);
  const mode = (arr) => {
    const c = new Map();
    for (const v of arr) c.set(v, (c.get(v) || 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1])[0];
  };
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);
  const feat = new Map();
  for (const [t, atoms] of byType) {
    if (typeIsH.get(t)) continue;
    const nHs = atoms.map((i) => hOf(i).length), ks = atoms.map((i) => heavyOf(i).length);
    const [nH, nHc] = mode(nHs), [k, kc] = mode(ks);
    const same = atoms.filter((_, a) => nHs[a] === nH && ks[a] === k);
    feat.set(t, {
      nH, k, agree: Math.min(nHc, kc) / atoms.length,
      dH: avg(same.flatMap((i) => hOf(i).map(([, r]) => r))),
      heavy: same.map((i) => heavyOf(i).map(([j, r]) => ({ j, r }))),
    });
  }
  // Methyl carbons (3 H at C–H length) are needed to tell N–CH3 from C–CH3.
  const methylType = new Set([...feat].filter(([, f]) => f.nH === 3 && f.dH >= 1.05).map(([t]) => t));

  const map = {}, confidence = {}, notes = {};
  const ambiguous = [];
  for (const [t, atoms] of byType) {
    if (typeIsH.get(t)) {
      map[t] = 'H';
      const agree = atoms.filter((i) => isHAtom[i]).length / atoms.length;
      confidence[t] = agree >= 0.9 ? 'high' : 'low';
      continue;
    }
    const f = feat.get(t);
    const { nH, k, dH } = f;
    const all = f.heavy.flat();
    const meanHeavy = avg(all.map((b) => b.r));
    const sorted = f.heavy.map((bs) => bs.map((b) => b.r).sort((a, b) => a - b));
    const shortest = avg(sorted.map((s) => s[0]).filter((x) => x != null));
    let e = 'C', c = 'low';
    if (nH > 0) {
      if (k === 0) {
        if (nH === 2) [e, c] = ['O', 'high'];                      // water
        else if (nH >= 3) [e, c] = [dH < 1.05 ? 'N' : 'C', nH === 4 ? 'high' : 'low'];
        else [e, c] = ['O', 'low'];                                // hydroxide
      } else if (dH > 1.25) [e, c] = ['S', 'low'];
      else if (dH < 0.985) [e, c] = ['O', 'high'];
      else if (dH < 1.05) [e, c] = ['N', 'high'];
      else [e, c] = ['C', 'high'];
    } else if (k === 0) {
      notes[t] = 'no bonded neighbors (ion?)';
      continue;
    } else if (k === 1) {
      if (meanHeavy < 1.19) [e, c] = ['N', 'low'];                 // nitrile N
      else if (meanHeavy < 1.40) [e, c] = ['O', 'high'];           // C=O, carboxylate
      else if (meanHeavy < 1.65) [e, c] = ['C', 'low'];            // united-atom CH3
      else { notes[t] = 'unusual bond length'; continue; }
    } else if (k === 2) {
      if (meanHeavy < 1.38) [e, c] = ['N', 'high'];                // aromatic N
      else if (meanHeavy < 1.48) [e, c] = ['O', 'low'];            // ether / ester O
      else if (meanHeavy < 1.70) [e, c] = ['C', 'low'];            // united-atom CH2
      else [e, c] = ['S', 'low'];
    } else if (k === 3) {
      const methylBonds = all.filter((b) => methylType.has(types[b.j])).map((b) => b.r);
      if (shortest < 1.30) [e, c] = ['C', 'high'];                 // carbonyl carbon
      else {
        // C (sp2) or N (3 single bonds): bond lengths overlap, so decide below by valence.
        ambiguous.push({ t, toMethyl: methylBonds.length > 0 });
        [e, c] = ['C', 'low'];
      }
    } else if (k === 4) {
      const terminal = f.heavy[0].filter(({ j }) => heavyOf(j).length === 1 && hOf(j).length === 0).length;
      [e, c] = terminal >= 3 && meanHeavy < 1.70 ? ['P', 'low'] : ['C', 'low'];
    } else { notes[t] = `${k} neighbors`; continue; }
    map[t] = e;
    confidence[t] = c === 'high' && f.agree >= 0.9 ? 'high' : 'low';
    if (f.agree < 0.9) notes[t] = `mixed environments (${Math.round(f.agree * 100)}% alike)`;
  }
  if (ambiguous.length) resolveByValence(ambiguous, map, confidence, notes, { n, types, nb, known, HEAVY });
  return { map, confidence, notes };
}

/**
 * Three-coordinate atoms without H are sp2 C (needs one double bond) or N (three single bonds).
 * Try each C/N assignment of the ambiguous types and keep those where every unsaturated atom
 * (C with 3 neighbors, N with 2, O with 1) can be paired with a bonded unsaturated partner,
 * i.e. a Kekulé structure exists. Among those, prefer N next to methyl groups and fewer N overall.
 */
function resolveByValence(ambiguous, map, confidence, notes, { n, types, nb, known, HEAVY }) {
  if (ambiguous.length > 10) return; // 2^10 combinations at most
  const elOf = (i) => known[types[i]] || map[types[i]] || 'X';
  const nbs = nb.map((l) => l.filter(([, r]) => r < HEAVY).map(([j]) => j));
  // Only atoms in molecules that contain an ambiguous atom matter; collect them once.
  const ambTypes = new Set(ambiguous.map((a) => a.t));
  const seen = new Uint8Array(n);
  const atoms = [];
  for (let i = 0; i < n; i++) {
    if (seen[i] || !ambTypes.has(types[i])) continue;
    const stack = [i]; seen[i] = 1;
    while (stack.length) {
      const a = stack.pop(); atoms.push(a);
      for (const b of nbs[a]) if (!seen[b]) { seen[b] = 1; stack.push(b); }
    }
    if (atoms.length > 20000) return;
  }
  const unsat = (i, el) => {
    const k = nbs[i].length;
    return (el === 'C' && k === 3) || (el === 'N' && k === 2) || (el === 'O' && k === 1);
  };
  const hasPerfectMatching = (assign) => {
    const el = (i) => assign.get(types[i]) || elOf(i);
    const U = atoms.filter((i) => unsat(i, el(i)));
    if (U.length % 2) return false;
    const inU = new Set(U);
    const mate = new Map();
    const tryAugment = (u, visited) => {
      for (const v of nbs[u]) {
        if (!inU.has(v) || visited.has(v)) continue;
        visited.add(v);
        if (!mate.has(v) || tryAugment(mate.get(v), visited)) { mate.set(v, u); mate.set(u, v); return true; }
      }
      return false;
    };
    for (const u of U) if (!mate.has(u) && !tryAugment(u, new Set([u]))) return false;
    return true;
  };
  let best = null, bestScore = -Infinity, valid = 0;
  for (let mask = 0; mask < 1 << ambiguous.length; mask++) {
    const assign = new Map(ambiguous.map((a, k) => [a.t, mask & (1 << k) ? 'N' : 'C']));
    if (!hasPerfectMatching(assign)) continue;
    valid++;
    let score = 0;
    ambiguous.forEach((a, k) => { if (mask & (1 << k)) score += a.toMethyl ? 1 : -0.5; });
    if (score > bestScore) { bestScore = score; best = assign; }
  }
  if (!best) return;
  for (const [t, e] of best) {
    map[t] = e;
    confidence[t] = valid === 1 ? 'high' : 'low';
    if (valid > 1) notes[t] = 'C or N: chosen by valence and methyl groups';
  }
}
