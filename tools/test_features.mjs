// Tests for the teaching features: extra dump columns, gzip input, element guessing,
// water shells, hydrogen bonds and colormaps. Run: node tools/test_features.mjs
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { parseTrajectory } from '../src/lammps.js';
import { inferBonds } from '../src/model.js';
import { buildGroups, waterGroups } from '../src/analysis.js';
import { nearMask, hbondParticipants, findHBonds, guessElements } from '../src/chem.js';
import { vectorFamilies, propRange, propValues, colormap, propLabel } from '../src/props.js';

// A small periodic box: one water dimer with a linear H-bond, plus a distant third water.
// Water A: O at origin-ish, H pointing at water B's O. Water B: 2.9 Å away along x.
const L = 20;
const atoms = [
  // id type x y z vx vy vz q
  [1, 1, 5.00, 5.00, 5.00, 0.1, 0, 0, -0.8],    // O_A
  [2, 2, 5.96, 5.00, 5.00, 0.2, 0, 0, 0.4],     // H_A1 -> points at O_B
  [3, 2, 4.76, 5.93, 5.00, 0, 0.3, 0, 0.4],     // H_A2
  [4, 1, 7.90, 5.00, 5.00, 0, 0, 0.1, -0.8],    // O_B
  [5, 2, 8.14, 5.93, 5.00, 0, 0, 0, 0.4],       // H_B1
  [6, 2, 8.14, 4.53, 5.82, 0, 0, 0, 0.4],       // H_B2
  [7, 1, 15.0, 15.0, 15.0, 0, 0, 0, -0.8],      // far water
  [8, 2, 15.96, 15.0, 15.0, 0, 0, 0, 0.4],
  [9, 2, 14.76, 15.93, 15.0, 0, 0, 0, 0.4],
];
function dump(nframes) {
  let s = '';
  for (let f = 0; f < nframes; f++) {
    s += `ITEM: TIMESTEP\n${f * 100}\nITEM: NUMBER OF ATOMS\n${atoms.length}\nITEM: BOX BOUNDS pp pp pp\n0 ${L}\n0 ${L}\n0 ${L}\n`;
    s += 'ITEM: ATOMS id type x y z vx vy vz q\n';
    for (const a of atoms) s += `${a[0]} ${a[1]} ${a.slice(2, 5).map((x) => x + 0.01 * f).join(' ')} ${a.slice(5).join(' ')}\n`;
  }
  return s;
}

// --- extra columns ---
const text = dump(3);
const traj = parseTrajectory(text);
assert.deepEqual(traj.props, ['vx', 'vy', 'vz', 'q'], 'extra columns are kept');
assert.equal(traj.frames[2].props.vx[1], Math.fround(0.2), 'per-atom value is stored');
assert.equal(traj.frames[0].props.q[0], Math.fround(-0.8));
const fams = vectorFamilies(traj.props);
assert.deepEqual(fams.map((f) => f.name), ['v'], 'velocity recognised as a vector');
assert.equal(propLabel('mag:v', fams), 'speed |v|');
assert.deepEqual(vectorFamilies(['c_f[1]', 'c_f[2]', 'c_f[3]', 'q']).map((f) => f.name), ['c_f'], 'compute vectors');
const speed = propValues(traj.frames[0], 'mag:v', fams, new Float32Array(traj.n));
assert.ok(Math.abs(speed[2] - 0.3) < 1e-6, 'speed magnitude');
const qr = propRange(traj.frames, 'p:q', fams, traj.n);
assert.ok(qr.diverging && qr.min === -qr.max, 'signed column gets a symmetric diverging range');
assert.ok(!propRange(traj.frames, 'mag:v', fams, traj.n).diverging, 'magnitudes are sequential');
const rgb = [0, 0, 0];
colormap(0, qr, rgb, 0);
assert.ok(rgb.every((c) => c > 0.8), 'zero is near-white on the diverging map');
console.log('extra column tests passed');

// --- gzip (the browser decompresses with DecompressionStream; check the same path works here) ---
{
  const gz = gzipSync(Buffer.from(text));
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream());
  let out = '';
  for await (const chunk of stream) out += chunk;
  assert.equal(out, text, 'gzip round-trip through DecompressionStream');
  assert.equal(parseTrajectory(out).frames.length, 3);
  console.log('gzip tests passed');
}

// --- element guessing ---
{
  const g = guessElements(traj);
  assert.equal(g.map['1'], 'O', 'water oxygen');
  assert.equal(g.map['2'], 'H', 'water hydrogen');
  console.log('element guessing tests passed');
}

// --- H-bonds and water shell ---
{
  const el = traj.types.map((t) => (t === '1' ? 'O' : 'H'));
  const pos = traj.frames[0].pos;
  const bonds = inferBonds(pos, el, { box: traj.frames[0].box });
  assert.equal(bonds.length / 2, 6, '3 waters x 2 O-H');
  const groups = buildGroups(traj.n, bonds, null);
  const water = waterGroups(groups, el);
  assert.equal(water.reduce((a, b) => a + b, 0), 3);
  const hb = hbondParticipants(el, bonds);
  assert.equal(hb.hd.length / 2, 6, 'six donor hydrogens');
  const pairs = findHBonds(pos, hb);
  assert.equal(pairs.length / 2, 1, 'exactly one H-bond in the dimer');
  assert.equal(traj.ids[pairs[0]], 2, 'donor H is H_A1');
  assert.equal(traj.ids[pairs[1]], 4, 'acceptor is O_B');
  // Bent geometry: rotate the acceptor off-axis so the D-H...A angle drops below 120 degrees.
  const bent = new Float32Array(pos);
  bent[3 * 3] = 6.3; bent[3 * 3 + 1] = 7.2; // O_B moved so the angle at H is ~100 degrees
  assert.equal(findHBonds(bent, hb, { maxHA: 2.5 }).length, 0, 'bent contact is not an H-bond');
  // Shell: atoms within 4 Å of water A's oxygen.
  const mask = nearMask(pos, [0], [3, 4, 5, 6, 7, 8], 4, traj.n);
  assert.deepEqual([3, 4, 5, 6, 7, 8].map((i) => mask[i]), [1, 1, 1, 0, 0, 0], 'only water B is within 4 Å');
  console.log('H-bond and shell tests passed');
}
