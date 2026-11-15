// Geometry helpers that run every frame: periodic wrapping that keeps molecules whole,
// measurements, and per-atom paths. Pure functions over Float32Arrays (testable in Node).

/** Box vectors a, b, c for a LAMMPS (possibly triclinic) box. */
export function boxVectors(box) {
  return {
    a: [box.hi[0] - box.lo[0], 0, 0],
    b: [box.tilt[0], box.hi[1] - box.lo[1], 0],
    c: [box.tilt[1], box.tilt[2], box.hi[2] - box.lo[2]],
  };
}

/** Fractional coordinates of a displacement (dx,dy,dz) in the box (upper-triangular h). */
function frac(box, dx, dy, dz, out) {
  const lx = box.hi[0] - box.lo[0], ly = box.hi[1] - box.lo[1], lz = box.hi[2] - box.lo[2];
  const [xy, xz, yz] = box.tilt;
  const fz = dz / lz;
  const fy = (dy - fz * yz) / ly;
  const fx = (dx - fy * xy - fz * xz) / lx;
  out[0] = fx; out[1] = fy; out[2] = fz;
  return out;
}

/**
 * Connected groups for wrapping: molecule-IDs if available, else bond-connected components.
 * Returns { group: Int32Array(n) group index per atom, count, parent: Int32Array(n), order: Int32Array(n) }
 * `order` lists atoms so that each atom comes after its `parent` (BFS over bonds within a group;
 * atoms with no bonded path get the group's first atom as parent). parent = -1 for group roots.
 */
export function buildGroups(n, bonds, mols) {
  const adjStart = new Int32Array(n + 1);
  for (let b = 0; b < bonds.length; b++) adjStart[bonds[b] + 1]++;
  for (let i = 0; i < n; i++) adjStart[i + 1] += adjStart[i];
  const adj = new Int32Array(bonds.length);
  const fill = adjStart.slice(0, n);
  for (let b = 0; b < bonds.length; b += 2) {
    const i = bonds[b], j = bonds[b + 1];
    adj[fill[i]++] = j; adj[fill[j]++] = i;
  }

  const group = new Int32Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1);
  const order = new Int32Array(n);
  let count = 0, w = 0;
  const molRoot = new Map(); // mol id -> {g, root}

  const bfs = (start, g, root) => {
    group[start] = g;
    parent[start] = start === root ? -1 : root;
    order[w++] = start;
    for (let r = w - 1; r < w; r++) {
      const i = order[r];
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const j = adj[k];
        if (group[j] !== -1) continue;
        if (mols && mols[j] !== mols[start]) continue;
        group[j] = g; parent[j] = i; order[w++] = j;
      }
    }
  };

  for (let i = 0; i < n; i++) {
    if (group[i] !== -1) continue;
    if (mols) {
      const m = molRoot.get(mols[i]);
      if (m) { bfs(i, m.g, m.root); continue; } // same molecule, not bond-connected: hang off the root
      molRoot.set(mols[i], { g: count, root: i });
    }
    bfs(i, count, i);
    count++;
  }
  return { group, count, parent, order };
}

/**
 * In place: make every group whole (minimum image relative to its parent atom) and then shift the
 * whole group so its centroid lies inside the box. Only periodic dimensions are touched.
 */
export function wrapGroups(pos, groups, box) {
  const { a, b, c } = boxVectors(box);
  const per = box.periodic;
  const f = [0, 0, 0];
  const { order, parent, group, count } = groups;
  const n = order.length;
  // 1. make whole
  for (let k = 0; k < n; k++) {
    const i = order[k], p = parent[i];
    if (p < 0) continue;
    let dx = pos[3 * i] - pos[3 * p], dy = pos[3 * i + 1] - pos[3 * p + 1], dz = pos[3 * i + 2] - pos[3 * p + 2];
    frac(box, dx, dy, dz, f);
    const nx = per[0] ? Math.round(f[0]) : 0, ny = per[1] ? Math.round(f[1]) : 0, nz = per[2] ? Math.round(f[2]) : 0;
    if (nx || ny || nz) {
      pos[3 * i] -= nx * a[0] + ny * b[0] + nz * c[0];
      pos[3 * i + 1] -= ny * b[1] + nz * c[1];
      pos[3 * i + 2] -= nz * c[2];
    }
  }
  // 2. centroid of each group into the box
  const sum = new Float64Array(3 * count);
  const cnt = new Int32Array(count);
  for (let i = 0; i < n; i++) {
    const g = group[i];
    sum[3 * g] += pos[3 * i]; sum[3 * g + 1] += pos[3 * i + 1]; sum[3 * g + 2] += pos[3 * i + 2];
    cnt[g]++;
  }
  const shift = new Float32Array(3 * count);
  for (let g = 0; g < count; g++) {
    const k = cnt[g] || 1;
    frac(box, sum[3 * g] / k - box.lo[0], sum[3 * g + 1] / k - box.lo[1], sum[3 * g + 2] / k - box.lo[2], f);
    const nx = per[0] ? Math.floor(f[0]) : 0, ny = per[1] ? Math.floor(f[1]) : 0, nz = per[2] ? Math.floor(f[2]) : 0;
    shift[3 * g] = -(nx * a[0] + ny * b[0] + nz * c[0]);
    shift[3 * g + 1] = -(ny * b[1] + nz * c[1]);
    shift[3 * g + 2] = -(nz * c[2]);
  }
  for (let i = 0; i < n; i++) {
    const g = group[i];
    pos[3 * i] += shift[3 * g]; pos[3 * i + 1] += shift[3 * g + 1]; pos[3 * i + 2] += shift[3 * g + 2];
  }
}

/** Minimum-image displacement j - i (for paths through wrapped coordinates). */
export function minImage(box, dx, dy, dz, out) {
  if (!box) { out[0] = dx; out[1] = dy; out[2] = dz; return out; }
  const { a, b, c } = boxVectors(box);
  const f = frac(box, dx, dy, dz, [0, 0, 0]);
  const p = box.periodic;
  const nx = p[0] ? Math.round(f[0]) : 0, ny = p[1] ? Math.round(f[1]) : 0, nz = p[2] ? Math.round(f[2]) : 0;
  out[0] = dx - (nx * a[0] + ny * b[0] + nz * c[0]);
  out[1] = dy - (ny * b[1] + nz * c[1]);
  out[2] = dz - nz * c[2];
  return out;
}

/** Continuous path of atom i over all frames (unwrapping jumps between consecutive frames). */
export function atomPath(frames, i) {
  const out = new Float32Array(3 * frames.length);
  const d = [0, 0, 0];
  out[0] = frames[0].pos[3 * i]; out[1] = frames[0].pos[3 * i + 1]; out[2] = frames[0].pos[3 * i + 2];
  for (let k = 1; k < frames.length; k++) {
    const p = frames[k].pos, q = frames[k - 1].pos;
    minImage(frames[k].box, p[3 * i] - q[3 * i], p[3 * i + 1] - q[3 * i + 1], p[3 * i + 2] - q[3 * i + 2], d);
    out[3 * k] = out[3 * k - 3] + d[0];
    out[3 * k + 1] = out[3 * k - 2] + d[1];
    out[3 * k + 2] = out[3 * k - 1] + d[2];
  }
  return out;
}

// --- measurements (positions as [x,y,z] arrays) ---

const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const norm = (u) => Math.hypot(u[0], u[1], u[2]);

export const distance = (p, q) => norm(sub(p, q));

/** Angle p-q-r at q, degrees. */
export function angle(p, q, r) {
  const u = sub(p, q), v = sub(r, q);
  const c = dot(u, v) / (norm(u) * norm(v) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}

/** Dihedral p-q-r-s, degrees in (-180, 180]. */
export function dihedral(p, q, r, s) {
  const b0 = sub(p, q), b1 = sub(r, q), b2 = sub(s, r);
  const n1 = norm(b1) || 1;
  const b1n = [b1[0] / n1, b1[1] / n1, b1[2] / n1];
  const v = sub(b0, b1n.map((x) => x * dot(b0, b1n)));
  const w = sub(b2, b1n.map((x) => x * dot(b2, b1n)));
  const x = dot(v, w);
  const y = dot(cross(b1n, v), w);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** Group indices that are water (exactly one O and two H). */
export function waterGroups(groups, elements) {
  const nO = new Int32Array(groups.count), nH = new Int32Array(groups.count), nAll = new Int32Array(groups.count);
  for (let i = 0; i < elements.length; i++) {
    const g = groups.group[i];
    nAll[g]++;
    if (elements[i] === 'O') nO[g]++;
    else if (elements[i] === 'H') nH[g]++;
  }
  const water = new Uint8Array(groups.count);
  for (let g = 0; g < groups.count; g++) water[g] = nAll[g] === 3 && nO[g] === 1 && nH[g] === 2 ? 1 : 0;
  return water;
}
