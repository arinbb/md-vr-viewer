// Node test for the parsers: node tools/test_parser.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { parseTrajectory, parseDataFile } from '../src/lammps.js';
import { resolveElements, resolveMols, bondsFromData, inferBonds, inferStableBonds, parseTypeMap, boxCorners } from '../src/model.js';

const here = new URL('../samples/', import.meta.url);
const traj = parseTrajectory(readFileSync(new URL('sample.lammpstrj', here), 'utf8'));
const data = parseDataFile(readFileSync(new URL('sample.data', here), 'utf8'));

assert.equal(traj.n, 300);
assert.equal(traj.frames.length, 120);
assert.deepEqual([...traj.ids.slice(0, 3)], [1, 2, 3]);
assert.equal(traj.frames[5].timestep, 500);
assert.equal(data.atomStyle, 'full');
assert.equal(data.bonds.length, 207);

const { elements, summary } = resolveElements(traj, data);
assert.deepEqual(summary.map((s) => s.element), ['O', 'H', 'C', 'N']);
const mols = resolveMols(traj, data);
assert.ok(mols && mols[0] === 1);

// Unwrapping with image flags must keep every bond short in every frame, despite row shuffling.
const bonds = bondsFromData(traj, data);
assert.equal(bonds.length, 2 * 207);
let maxLen = 0;
for (const f of traj.frames) {
  for (let b = 0; b < bonds.length; b += 2) {
    const i = bonds[b], j = bonds[b + 1];
    const d = Math.hypot(f.pos[3 * i] - f.pos[3 * j], f.pos[3 * i + 1] - f.pos[3 * j + 1], f.pos[3 * i + 2] - f.pos[3 * j + 2]);
    maxLen = Math.max(maxLen, d);
  }
}
assert.ok(maxLen < 1.7, `max bond length ${maxLen}`);

// Distance-inferred bonds should recover the topology on frame 0.
const inferred = inferBonds(traj.frames[0].pos, elements, { mols });
assert.equal(inferred.length / 2, 207, `inferred ${inferred.length / 2} bonds`);

// Scaled coords + triclinic box.
const tri = `ITEM: TIMESTEP
10
ITEM: NUMBER OF ATOMS
2
ITEM: BOX BOUNDS xy xz yz pp pp pp
-1 11 1
0 10 -1
0 10 0
ITEM: ATOMS id element xs ys zs
2 O 0.5 0.5 0.5
1 C 0 0 0
`;
const t2 = parseTrajectory(tri);
assert.deepEqual(t2.frames[0].box.lo, [0, 0, 0]);
assert.deepEqual(t2.frames[0].box.hi, [10, 10, 10]);
assert.deepEqual([...t2.frames[0].pos], [0, 0, 0, 5, 5, 5]);
assert.equal(resolveElements(t2, null).elements[1], 'O');
assert.equal(boxCorners(t2.frames[0].box)[7][0], 10 + 1 - 1);

// XYZ dump.
const xyz = `3
 Atoms. Timestep: 0
1 0 0 0
2 0.96 0 0
2 -0.24 0.93 0
3
 Atoms. Timestep: 50
1 0 0 0.1
2 0.96 0 0.1
2 -0.24 0.93 0.1
`;
const t3 = parseTrajectory(xyz);
assert.equal(t3.frames.length, 2);
assert.equal(t3.frames[1].timestep, 50);
const e3 = resolveElements(t3, null, parseTypeMap('1:O 2:H')).elements;
assert.deepEqual(e3, ['O', 'H', 'H']);

// stride
assert.equal(parseTrajectory(readFileSync(new URL('sample.lammpstrj', here), 'utf8'), { stride: 10 }).frames.length, 12);

console.log('all parser tests passed; max bond length', maxLen.toFixed(3));

// ---------------------------------------------------------------------------
// Second pass: streaming, wrapping, measurements
import { createTrajectoryParser } from '../src/lammps.js';
import { buildGroups, wrapGroups, atomPath, distance, angle, dihedral, waterGroups, minImage } from '../src/analysis.js';

const dumpText = readFileSync(new URL('sample.lammpstrj', here), 'utf8');

// Streaming parser fed line by line gives the same result as the string parser.
{
  const p = createTrajectoryParser(dumpText.slice(0, 200));
  for (const l of dumpText.split('\n')) p.push(l);
  const t = p.finish();
  assert.equal(t.frames.length, 120);
  assert.deepEqual([...t.frames[77].pos.slice(0, 9)], [...traj.frames[77].pos.slice(0, 9)]);
}

// onFirstFrame can raise the stride mid-parse (memory guard).
{
  const p = createTrajectoryParser(dumpText.slice(0, 200), { onFirstFrame: ({ n, frameChars }) => {
    assert.equal(n, 300); assert.ok(frameChars > 1000); return 7;
  } });
  for (const l of dumpText.split('\n')) p.push(l);
  const t = p.finish();
  assert.equal(t.stride, 7);
  assert.equal(t.frames.length, 1 + Math.floor(119 / 7)); // frame 0 kept, then 7, 14, ...
  assert.equal(t.frames[1].timestep, 700);
}

// Truncated final frame is dropped with a warning, not a crash.
{
  const cut = dumpText.slice(0, dumpText.lastIndexOf('ITEM: ATOMS') + 400);
  const t = parseTrajectory(cut);
  assert.equal(t.frames.length, 119);
  assert.ok(t.warnings.some((w) => /truncated/.test(w)));
}

// Groups follow molecule-IDs; water detected.
const groups = buildGroups(traj.n, bonds, mols);
assert.equal(groups.count, 93);
const water = waterGroups(groups, elements);
assert.equal(water.reduce((a, b) => a + b, 0), 90);

// Wrapping: with image-flag-free *wrapped* coordinates, molecules are split across the box;
// wrapGroups must make them whole again and put every centroid inside the box.
{
  const wrappedText = dumpText.replace(/ITEM: ATOMS id mol type x y z ix iy iz/g, 'ITEM: ATOMS id mol type x y z')
    .replace(/^(\d+ \d+ \d+ \S+ \S+ \S+) -?\d+ -?\d+ -?\d+$/gm, '$1');
  const tw = parseTrajectory(wrappedText);
  let brokenBefore = 0, maxAfter = 0;
  for (const f of tw.frames) {
    const pos = new Float32Array(f.pos);
    for (let b = 0; b < bonds.length; b += 2) {
      const i = bonds[b], j = bonds[b + 1];
      if (Math.hypot(pos[3 * i] - pos[3 * j], pos[3 * i + 1] - pos[3 * j + 1], pos[3 * i + 2] - pos[3 * j + 2]) > 3) brokenBefore++;
    }
    wrapGroups(pos, groups, f.box);
    for (let b = 0; b < bonds.length; b += 2) {
      const i = bonds[b], j = bonds[b + 1];
      maxAfter = Math.max(maxAfter, Math.hypot(pos[3 * i] - pos[3 * j], pos[3 * i + 1] - pos[3 * j + 1], pos[3 * i + 2] - pos[3 * j + 2]));
    }
    const sums = new Map();
    for (let i = 0; i < tw.n; i++) {
      const g = groups.group[i]; const s = sums.get(g) || [0, 0, 0, 0];
      s[0] += pos[3 * i]; s[1] += pos[3 * i + 1]; s[2] += pos[3 * i + 2]; s[3]++; sums.set(g, s);
    }
    for (const s of sums.values()) for (let d = 0; d < 3; d++) {
      const c = s[d] / s[3];
      assert.ok(c >= f.box.lo[d] - 1e-4 && c < f.box.hi[d] + 1e-4, `centroid ${c} outside box`);
    }
  }
  assert.ok(brokenBefore > 0, 'test data should contain molecules split by the boundary');
  assert.ok(maxAfter < 1.7, `bond after wrap ${maxAfter}`);
  console.log(`wrap: ${brokenBefore} split bonds repaired over ${tw.frames.length} frames`);

  // Paths through wrapped coordinates are continuous (no box-length jumps).
  const path = atomPath(tw.frames, 0);
  for (let k = 1; k < tw.frames.length; k++) {
    const step = Math.hypot(path[3 * k] - path[3 * k - 3], path[3 * k + 1] - path[3 * k - 2], path[3 * k + 2] - path[3 * k - 1]);
    assert.ok(step < 3, `path jump ${step}`);
  }
}

// Triclinic minimum image.
{
  const box = { lo: [0, 0, 0], hi: [10, 10, 10], tilt: [2, 0, 0], periodic: [true, true, true] };
  const d = minImage(box, 1, 9, 0, [0, 0, 0]); // one cell over in b = (2,10,0)
  assert.deepEqual(d.map((x) => +x.toFixed(6)), [-1, -1, 0]);
}

// Measurements.
assert.equal(+distance([0, 0, 0], [3, 4, 0]).toFixed(6), 5);
assert.equal(+angle([1, 0, 0], [0, 0, 0], [0, 1, 0]).toFixed(6), 90);
assert.equal(+dihedral([1, 0, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]).toFixed(6), 90);
assert.equal(+Math.abs(dihedral([1, 0, 0], [0, 0, 0], [0, 0, 1], [-1, 0, 1])).toFixed(6), 180);

// Bond inference scales: 30k atoms in well under a second.
{
  const n = 30000, L = 70;
  const pos = new Float32Array(3 * n);
  for (let k = 0; k < 3 * n; k++) pos[k] = Math.random() * L;
  const t0 = performance.now();
  inferBonds(pos, new Array(n).fill('C'));
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `inferBonds took ${ms} ms`);
  console.log(`inferBonds 30k atoms: ${ms.toFixed(0)} ms`);
}

console.log('second-pass tests passed');

// Periodic bond inference: wrapped water box where many molecules straddle the boundary.
{
  const L = 10, n = 3 * 20, pos = new Float32Array(3 * n), el = [];
  const box = { lo: [0, 0, 0], hi: [L, L, L], tilt: [0, 0, 0], periodic: [true, true, true] };
  for (let m = 0; m < 20; m++) {
    const c = [(m * 2.5) % L, Math.floor(m / 4) * 2, 9.7]; // all near the top z face
    const g = [[0, 0, 0], [0.757, 0.586, 0.3], [-0.757, 0.586, 0.3]];
    g.forEach((d, k) => { for (let q = 0; q < 3; q++) pos[3 * (3 * m + k) + q] = ((c[q] + d[q]) % L + L) % L; el.push(k ? 'H' : 'O'); });
  }
  assert.equal(inferBonds(pos, el, { box }).length / 2, 40, 'all O-H bonds found across the boundary');
  assert.ok(inferBonds(pos, el).length / 2 < 40, 'without the box some bonds are missed (sanity)');
  // Triclinic box with a large tilt.
  const tbox = { lo: [0, 0, 0], hi: [10, 10, 10], tilt: [4, 0, 0], periodic: [true, true, true] };
  const tp = new Float32Array([0.3, 9.8, 5, /* O near top y face */ 0.3 + 4 - 10 + 10, 0.4, 5 /* H across y face shifted by b=(4,10,0) */]);
  // O at (0.3,9.8); its partner image at (0.3,9.8)+(0.9,0.6)=(1.2,10.4) -> wrapped by -b: (-2.8,0.4) -> +a: (7.2,0.4)
  tp[3] = 7.2; tp[4] = 0.4;
  assert.equal(inferBonds(tp, ['O', 'H'], { box: tbox }).length / 2, 1, 'triclinic periodic bond');
}
console.log('periodic bond tests passed');

// Bonds from several frames: a contact present only in an unequilibrated first frame is dropped.
{
  const box = { lo: [0, 0, 0], hi: [20, 20, 20], tilt: [0, 0, 0], periodic: [true, true, true] };
  const el = ['O', 'H', 'H', 'O', 'H', 'H'];
  const water = (o, x) => [x, 5, 5, x + 0.757, 5.586, 5, x - 0.757, 5.586, 5];
  const f0 = new Float32Array([...water(0, 5), ...water(0, 6.2)]); // two waters overlapping
  const f1 = new Float32Array([...water(0, 5), ...water(0, 12)]);
  const frames = [f0, f1, f1].map((pos) => ({ pos, box }));
  assert.ok(inferBonds(f0, el, { box }).length / 2 > 4, 'overlap creates extra bonds in frame 0');
  assert.equal(inferStableBonds(frames, el).length / 2, 4, 'only the 4 real O-H bonds survive');
  assert.equal(inferStableBonds([frames[1]], el).length / 2, 4, 'single frame works');
}
console.log('multi-frame bond tests passed');
