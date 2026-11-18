// Tests for the teaching features: extra dump columns, gzip input, element guessing,
// water shells, hydrogen bonds and colormaps. Run: node tools/test_features.mjs
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { parseTrajectory } from '../src/lammps.js';
import { inferBonds } from '../src/model.js';
import { buildGroups, waterGroups } from '../src/analysis.js';
import { nearMask, hbondParticipants, findHBonds, guessElements } from '../src/chem.js';
import { vectorFamilies, propRange, propValues, colormap, propLabel } from '../src/props.js';
import { lessonToJSON, parseLesson, looksLikeLesson, stripVoice, bytesToB64, b64ToBytes, fmtDur, analyzeSamples, voiceLength, clipsOf } from '../src/voice.js';
import { readFileSync } from 'node:fs';
import { normalizeElement, elementFromMass } from '../src/elements.js';
import { parseDataFile } from '../src/lammps.js';
import { cleanTranscript } from '../src/transcribe.js';

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

// --- Which nitrogens accept H-bonds
{
  // Atoms: 0 N planar (3 C in its plane), 1-3 C;  4 N pyramidal (amine), 5-7 C;
  //        8 N with 4 bonds (ammonium), 9-12 H/C;  13 N with 2 bonds (pyridine-like), 14-15 C.
  const P = [];
  const put = (x, y, z) => P.push(x, y, z);
  put(0, 0, 0); put(1.45, 0, 0); put(-0.72, 1.26, 0); put(-0.72, -1.26, 0);                // planar
  put(10, 0, 0); put(11.37, 0, 0.48); put(9.32, 1.18, 0.48); put(9.32, -1.18, 0.48);         // pyramidal (~0.48 Å)
  put(20, 0, 0); put(21.0, 0, 0); put(19.67, 0.94, 0); put(19.67, -0.47, 0.82); put(19.5, -0.7, -1.2);
  put(30, 0, 0); put(31.34, 0, 0); put(29.33, 1.17, 0);
  const pos = Float32Array.from(P);
  const el = ['N', 'C', 'C', 'C', 'N', 'C', 'C', 'C', 'N', 'H', 'H', 'H', 'C', 'N', 'C', 'C'];
  const bonds = [0, 1, 0, 2, 0, 3, 4, 5, 4, 6, 4, 7, 8, 9, 8, 10, 8, 11, 8, 12, 13, 14, 13, 15];
  const frames = [{ pos, box: null }];
  const acc = [...hbondParticipants(el, bonds, frames).acc];
  assert.deepEqual(acc, [4, 13], 'only the amine and the 2-bonded N accept');
  assert.equal(hbondParticipants(el, bonds, frames).hd.length / 2, 3, 'ammonium H are donors');
  assert.deepEqual([...hbondParticipants(el, bonds).acc], [0, 4, 13], 'without coordinates, 3-bonded N accepts');
  console.log('acceptor rule tests passed');
}

// --- Contacts across the periodic boundary
{
  const L = 20;
  const ortho = { lo: [0, 0, 0], hi: [L, L, L], tilt: [0, 0, 0], periodic: [true, true, true] };
  // Water A near x = 0, water B near x = L: the H-bond O_A-H...O_B crosses the box face.
  // O_A at x=1.2 with H pointing toward -x (H at 0.24); O_B at x = 18.3 (1.9 Å from H through the face).
  const pos = Float32Array.from([
    1.2, 10, 10, 0.24, 10, 10, 1.44, 10.93, 10,      // water A: O, H (toward -x), H
    18.3, 10, 10, 18.06, 10.93, 10, 18.06, 9.53, 10.82, // water B
  ]);
  const el = ['O', 'H', 'H', 'O', 'H', 'H'];
  const bonds = [0, 1, 0, 2, 3, 4, 3, 5];
  const hb = hbondParticipants(el, bonds);
  assert.equal(findHBonds(pos, hb).length, 0, 'without the box, the contact across the face is missed');
  const pairs = findHBonds(pos, hb, { box: ortho });
  assert.deepEqual([...pairs], [1, 3], 'with the box, H1...O_B is found across the face');
  // Shell: water B is within 4 Å of atom 0 only through the boundary.
  assert.equal(nearMask(pos, [0], [3, 4, 5], 4, 6)[3], 0, 'no box: B is not near');
  assert.equal(nearMask(pos, [0], [3, 4, 5], 4, 6, ortho)[3], 1, 'box: B is near through the face');
  // The other search direction (more reference atoms than candidates) must agree.
  assert.equal(nearMask(pos, [3, 4, 5], [0], 4, 6, ortho)[0], 1, 'box, reversed roles: A is near B');
  assert.equal(nearMask(pos, [3, 4, 5], [0], 4, 6)[0], 0, 'no box, reversed roles: A is not near B');
  // Triclinic box (xy tilt): shift the whole picture by a lattice vector b and it must still match.
  const tri = { lo: [0, 0, 0], hi: [L, L, L], tilt: [5, 0, 0], periodic: [true, true, true] };
  assert.deepEqual([...findHBonds(pos, hb, { box: tri })], [1, 3], 'triclinic: found across the x face');
  const shifted = Float32Array.from(pos);
  for (let i = 3; i < 6; i++) { shifted[3 * i] += 5; shifted[3 * i + 1] += L; } // water B moved by +b
  assert.deepEqual([...findHBonds(shifted, hb, { box: tri })], [1, 3], 'triclinic: an image shifted by b is the same contact');
  // Small box (fewer than 3 cells per side) must not double-count.
  const small = { lo: [0, 0, 0], hi: [6, 6, 6], tilt: [0, 0, 0], periodic: [true, true, true] };
  const p2 = Float32Array.from([1, 3, 3, 0.04, 3, 3, 1.24, 3.93, 3, 4.1, 3, 3, 4.34, 3.93, 3, 4.34, 2.53, 3.82]);
  const r2 = findHBonds(p2, hb, { box: small });
  assert.equal(new Set(Array.from({ length: r2.length / 2 }, (_, k) => r2[2 * k] + ':' + r2[2 * k + 1])).size, r2.length / 2, 'no duplicate pairs in a small box');
  // 3-bonded O (hydronium) is not an acceptor.
  const h3o = hbondParticipants(['O', 'H', 'H', 'H'], [0, 1, 0, 2, 0, 3]);
  assert.equal(h3o.acc.length, 0, 'H3O+ oxygen does not accept');
  console.log('periodic contact tests passed');
}

// ---- Lesson files with voice clips
{
  // base64 round trip, including sizes past one 32 KB chunk
  const bytes = Uint8Array.from({ length: 100000 }, (_, i) => (i * 37) & 255);
  assert.deepEqual(b64ToBytes(bytesToB64(bytes)), bytes, 'base64 round trip');

  const audio = Uint8Array.from({ length: 5000 }, (_, i) => (i * 13) & 255);
  const audio2 = Uint8Array.from({ length: 1200 }, (_, i) => (i * 7) & 255);
  const mk = (bytes, dur, extra = {}) => ({ blob: new Blob([bytes], { type: 'audio/webm;codecs=opus' }), mime: 'audio/webm;codecs=opus', dur, ...extra });
  const stops = [
    { f: 30, cap: 'second', sel: [5], v: { rep: 'ballstick' } },
    { f: 3, cap: '', sel: [], v: {}, over: true, clips: [mk(audio, 4.567, { gain: 3.14159, trim: [0.21, 4.4] }), mk(audio2, 1.5)] },
  ];
  const text = await lessonToJSON(stops, { trajectory: 'run.lammpstrj', map: '1:O 2:H' });
  assert.ok(looksLikeLesson(text), 'a saved lesson is recognised');
  const back = parseLesson(text);
  assert.equal(back.stops.length, 2);
  assert.equal(back.clips, 2, 'two narration segments');
  assert.deepEqual(back.stops.map((s) => s.f), [3, 30], 'stops come back sorted by frame');
  assert.equal(back.meta.trajectory, 'run.lammpstrj');
  assert.equal(back.meta.map, '1:O 2:H');
  const [c1, c2] = back.stops[0].clips;
  assert.equal(c1.mime, 'audio/webm;codecs=opus');
  assert.equal(c1.dur, 4.57);
  assert.equal(c1.gain, 3.142, 'gain kept');
  assert.deepEqual(c1.trim, [0.21, 4.4], 'trim kept');
  assert.equal(back.stops[0].over, true, 'per-stop pacing kept');
  assert.deepEqual(new Uint8Array(await c1.blob.arrayBuffer()), audio, 'audio bytes survive the file');
  assert.deepEqual(new Uint8Array(await c2.blob.arrayBuffer()), audio2, 'second segment too');
  assert.equal(back.stops[1].clips, undefined);
  assert.ok(Math.abs(voiceLength(back.stops[0]) - (4.4 - 0.21 + 1.5)) < 1e-9, 'length as played: trimmed + untrimmed');
  // Version-1 files (one "voice" per stop) still open, as a single segment.
  const v1 = JSON.stringify({ format: 'md-vr-lesson', version: 1, stops: [{ f: 2, cap: 'old', voice: { mime: 'audio/webm', dur: 2, data: bytesToB64(audio2) } }] });
  const old = parseLesson(v1);
  assert.equal(old.clips, 1); assert.equal(clipsOf(old.stops[0]).length, 1); assert.equal(old.stops[0].voice, undefined);

  // share links: no audio, but they say a clip existed
  const lean = stripVoice(stops);
  assert.equal(lean[1].clips, undefined);
  assert.equal(lean[1].hasVoice, true);
  assert.ok(!JSON.stringify(lean).includes('blob'));

  // Loudness and silence analysis on synthetic "speech": 1 s silence (faint noise), 2 s of a
  // voiced tone, 1.5 s silence, at 16 kHz.
  const sr = 16000;
  const speech = (amp) => {
    const x = new Float32Array(Math.round(4.5 * sr));
    let seed = 1; const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.002;
    for (let i = 0; i < x.length; i++) {
      const t = i / sr;
      const on = t >= 1 && t < 3;
      x[i] = noise() + (on ? amp * Math.sin(2 * Math.PI * 180 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) : 0);
    }
    return x;
  };
  const quiet = analyzeSamples(speech(0.02), sr), loud = analyzeSamples(speech(0.5), sr);
  assert.ok(quiet.speech && loud.speech);
  assert.ok(Math.abs(quiet.trim[0] - 0.85) < 0.05 && Math.abs(quiet.trim[1] - 3.3) < 0.05, `trim ${quiet.trim}`);
  assert.ok(quiet.gain > 5, `a quiet talker is raised a lot (×${quiet.gain.toFixed(1)})`);
  assert.ok(loud.gain < 1, `a loud one lowered (×${loud.gain.toFixed(2)})`);
  // After the gain, both come out at about the same level.
  const q = quiet.rms * quiet.gain, l = loud.rms * loud.gain;
  assert.ok(Math.abs(q - l) / l < 0.1, `levels evened out: ${q.toFixed(3)} vs ${l.toFixed(3)}`);
  // Silence only: no speech, no gain, no trimming.
  const silent = analyzeSamples(speech(0), sr);
  assert.ok(!silent.speech && silent.gain === 1 && silent.trim[0] === 0);
  // Extremely quiet: capped at ×12 (amplifying room noise further would not help).
  assert.equal(analyzeSamples(speech(0.0035), sr).gain, 12);

  // the bundled tour (a plain array of stops) loads as a lesson file too
  const tourText = readFileSync(new URL('../samples/sample.lesson.json', import.meta.url), 'utf8');
  assert.ok(looksLikeLesson(tourText));
  assert.equal(parseLesson(tourText).stops.length, 7);

  // dumps and data files are not lessons
  assert.ok(!looksLikeLesson('ITEM: TIMESTEP\n0\n'));
  assert.ok(!looksLikeLesson('LAMMPS data file\n\n6 atoms\n'));
  assert.throws(() => parseLesson('{"format":"md-vr-lesson"}'), /no stops/);
  assert.equal(fmtDur(65.4), '1:05');
  console.log('lesson file tests passed');
}

// ---- Regressions from the bug sweep
{
  // Force-field atom types are not elements: AMBER/GAFF CA, NA; CHARMM ion names; charged names.
  const ff = (x) => normalizeElement(x, { forceField: true });
  assert.equal(ff('CA'), 'C'); assert.equal(ff('ca'), 'C'); assert.equal(ff('NA'), 'N'); assert.equal(ff('na'), 'N');
  assert.equal(ff('CL'), 'C'); assert.equal(ff('OW'), 'O'); assert.equal(ff('HW'), 'H');
  assert.equal(ff('Ca'), 'Ca'); assert.equal(ff('Na'), 'Na'); assert.equal(ff('Cl'), 'Cl');
  assert.equal(ff('NA+'), 'Na'); assert.equal(ff('Cl-'), 'Cl'); assert.equal(ff('Ca2+'), 'Ca');
  assert.equal(ff('SOD'), 'Na'); assert.equal(ff('CLA'), 'Cl'); assert.equal(ff('POT'), 'K'); assert.equal(ff('MG'), 'Mg');
  // A typed map or an element column means the element itself.
  assert.equal(normalizeElement('CL'), 'Cl'); assert.equal(normalizeElement('na'), 'Na'); assert.equal(normalizeElement('OW'), 'O');

  // United-atom groups are carbon; real N and O masses stay N and O.
  assert.equal(elementFromMass(14.027), 'C'); assert.equal(elementFromMass(16.043), 'C'); assert.equal(elementFromMass(15.035), 'C');
  assert.equal(elementFromMass(14.007), 'N'); assert.equal(elementFromMass(14.01), 'N'); assert.equal(elementFromMass(15.999), 'O');

  // Data-file atom styles: sphere, and charge without a style hint.
  const df = (style, row) => parseDataFile(`t\n\n1 atoms\n\nAtoms${style ? ' # ' + style : ''}\n\n${row}\n`).atoms.get(1);
  assert.deepEqual([df('sphere', '1 1 1.5 1.0 0 0 0').type, df('sphere', '1 1 1.5 1.0 0 0 0').mol], ['1', null]);
  assert.deepEqual([df('', '1 2 -0.8 0 0 0').type, df('', '1 2 -0.8 0 0 0').mol], ['2', null]);
  assert.deepEqual([df('', '1 7 2 0 0 0').type, df('', '1 7 2 0 0 0').mol], ['2', 7]); // molecular

  // A NaN coordinate must not knock a real neighbor out of the cell list.
  const P = new Float32Array([0, 0, 0, NaN, 0, 0, 5, 5, 5, 0.5, 0, 0, 9, 9, 9]);
  const near = nearMask(P, [0, 2], [1, 3, 4], 1, 5);
  assert.equal(near[3], 1, 'atom 0.5 Å from a reference is near despite a NaN atom');
  assert.equal(near[1], 0);

  // XYZ: a frame with fewer atoms keeps the missing atom's last position.
  const t = parseTrajectory('3\nf0\nO 1 1 1\nH 2 2 2\nH 3 3 3\n2\nf1\nO 1.1 1 1\nH 2.1 2 2\n');
  assert.deepEqual([...t.frames[1].pos.slice(6, 9)], [3, 3, 3]);

  // General triclinic boxes are refused with a clear message instead of a garbled box.
  assert.throws(() => parseTrajectory('ITEM: TIMESTEP\n0\nITEM: NUMBER OF ATOMS\n1\nITEM: BOX BOUNDS abc origin pp pp pp\n10 0 0 0\n2 10 0 0\n0 0 10 0\nITEM: ATOMS id type x y z\n1 1 0 0 0\n'), /general triclinic/);

  assert.equal(fmtDur(59.6), '1:00');
  console.log('bug sweep regression tests passed');
}

// ---- Hand gestures (src/gestures.js)
{
  const { fingerStraightness, updateFist, pokePanel } = await import('../src/gestures.js');
  // A synthetic hand: each finger's knuckle at x = k * 2 cm; bones 4, 2.5, 2 cm long. bend (rad)
  // per joint curls the finger toward the palm (-y); 0 = straight.
  const FINGERS = ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'];
  const handJoints = (bends, scale = 1) => {
    const J = { wrist: { x: 0, y: 0, z: 0.05 * scale } };
    FINGERS.forEach((f, k) => {
      let p = { x: 0.02 * k * scale, y: 0, z: -0.04 * scale }, a = 0;
      const names = ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'];
      const bones = [0.04, 0.025, 0.02].map((b) => b * scale * (k === 3 ? 0.8 : 1));
      J[`${f}-${names[0]}`] = p;
      bones.forEach((len, b) => {
        a += bends[k];
        p = { x: p.x, y: p.y - len * Math.sin(a), z: p.z - len * Math.cos(a) };
        J[`${f}-${names[b + 1]}`] = p;
      });
    });
    return (n) => J[n] || null;
  };
  const open = handJoints([0, 0, 0, 0]), fist = handJoints([1.45, 1.45, 1.45, 1.45]);
  assert.ok(fingerStraightness(open).every((r) => r > 0.99), 'straight fingers ≈ 1');
  assert.ok(fingerStraightness(fist).every((r) => r < 0.6), 'curled fingers well below 1');
  const st = {};
  assert.equal(updateFist(st, open), false); assert.equal(st.fist, false);
  assert.equal(updateFist(st, fist), true); assert.equal(st.fist, true, 'a fist closes');
  // Half-curled: neither opens nor closes (hysteresis), so the grab doesn't flicker.
  const half = handJoints([1.0, 1.0, 1.0, 1.0]);
  const hr = fingerStraightness(half);
  assert.ok(hr.every((r) => r > 0.6 && r < 0.8), `half-curled ratios ${hr.map((x) => x.toFixed(2))}`);
  assert.equal(updateFist(st, half), false); assert.equal(st.fist, true, 'stays closed in between');
  assert.equal(updateFist(st, open), true); assert.equal(st.fist, false, 'opens when straight');
  assert.equal(updateFist({}, half), false, 'half-curled does not close an open hand');
  // A pinch (index curled toward the thumb, other fingers straight) is not a fist.
  const pinch = {}; updateFist(pinch, handJoints([1.2, 0.1, 0.1, 0.1]));
  assert.ok(!pinch.fist, 'pinch is not a fist');
  // Small and large hands behave the same.
  const big = {}; updateFist(big, handJoints([1.45, 1.45, 1.45, 1.45], 1.3)); assert.ok(big.fist);
  const small = {}; updateFist(small, handJoints([1.45, 1.45, 1.45, 1.45], 0.75)); assert.ok(small.fist);
  // Untracked joints: keep the state.
  const keep = { fist: true }; assert.equal(updateFist(keep, () => null), false); assert.equal(keep.fist, true);

  // Fingertip poke on a 20 x 24.5 cm panel.
  const ps = {};
  const at = (x, y, z) => pokePanel(ps, { x, y, z }, 0.2, 0.245);
  assert.ok(!at(0, 0, 0.1).press && !at(0, 0, 0.1).hover, 'far away: nothing');
  assert.ok(at(0, 0, 0.03).hover, 'close: hover');
  const p = at(0.05, -0.1, 0.004);
  assert.ok(p.press, 'crossing the surface presses');
  assert.ok(Math.abs(p.uv.x - 0.75) < 1e-9 && Math.abs(p.uv.y - (-0.1 / 0.245 + 0.5)) < 1e-9, 'uv of the press point');
  assert.ok(!at(0.05, -0.1, 0.0).press, 'one press per poke');
  assert.ok(at(0.05, -0.1, 0.03).release, 'pulling back releases');
  // Coming from behind the panel does not press.
  const back = {}; pokePanel(back, { x: 0, y: 0, z: -0.02 }, 0.2, 0.245);
  assert.ok(!pokePanel(back, { x: 0, y: 0, z: 0.0 }, 0.2, 0.245).press, 'no press from behind');
  // Sliding off the edge releases.
  const edge = {}; pokePanel(edge, { x: 0, y: 0, z: 0.03 }, 0.2, 0.245); pokePanel(edge, { x: 0, y: 0, z: 0.0 }, 0.2, 0.245);
  assert.ok(pokePanel(edge, { x: 0.2, y: 0, z: 0.0 }, 0.2, 0.245).release, 'leaving the panel releases');
  console.log('hand gesture tests passed');
}

// ---- Gesture tracks and transcripts (src/tracks.js)
{
  const { eventAt, eventIndexAt, motionAt, slerp, compactTrack, cleanTrack, subtitleAt, subtitleChunks } = await import('../src/tracks.js');
  const ev = [[0.5, 1], [1.2, 7], [3, -1]];
  assert.equal(eventAt(ev, 0.2), null);
  assert.deepEqual(eventAt(ev, 1.2), [1.2, 7]);
  assert.deepEqual(eventAt(ev, 2.9), [1.2, 7]);
  assert.equal(eventIndexAt(ev, 10), 2);
  // Motion: halfway between identity and a 90° turn about z is 45°, position and scale halfway.
  const s = Math.SQRT1_2;
  const mo = [[0, 0, 0, 0, 1, 0, 0, 0, 1], [1, 0, 0, s, s, 2, 0, 0, 3]];
  const m = motionAt(mo, 0.5);
  const angle = 2 * Math.acos(m.q[3]) * 180 / Math.PI;
  assert.ok(Math.abs(angle - 45) < 1e-6, `slerp angle ${angle}`);
  assert.deepEqual(m.p, [1, 0, 0]); assert.equal(m.s, 2);
  assert.deepEqual(motionAt(mo, -1).p, [0, 0, 0]); assert.equal(motionAt(mo, 9).s, 3);
  // slerp takes the short way round (q and -q are the same rotation)
  const q = slerp([0, 0, 0, 1], [0, 0, -s, -s], 0.5);
  assert.ok(Math.abs(2 * Math.acos(Math.abs(q[3])) * 180 / Math.PI - 45) < 1e-6);
  // compactTrack drops what carries nothing, keeps what does
  assert.equal(compactTrack({ pointer: [[0, -1]], sel: [], motion: [[0, 0, 0, 0, 1, 0, 0, 0, 1], [0.1, 0, 0, 0.001, 1, 0.01, 0, 0, 1.001]] }), null);
  const kept = compactTrack({ pointer: [[0, -1], [0.333333, 42]], sel: [[1, [42]]], motion: mo });
  assert.deepEqual(kept.pointer, [[0, -1], [0.33, 42]]);
  assert.equal(kept.motion.length, 2); assert.deepEqual(kept.sel, [[1, [42]]]);
  // cleanTrack (from files) drops malformed parts
  assert.deepEqual(cleanTrack({ pointer: [[0, 5], ['x', 3]], motion: [[0, 1]] }), null);
  assert.deepEqual(cleanTrack({ pointer: [[0, 5]], sel: 'bad' }), { pointer: [[0, 5]] });
  // Subtitles: pieces of at most ~90 characters, at word boundaries, picked by progress
  const text = 'Watch the oxygen on the right. It accepts a hydrogen bond from this water, and then, about two frames later, the water turns away and the bond breaks.';
  const chunks = subtitleChunks(text);
  assert.ok(chunks.length >= 2 && chunks.every((c) => c.length <= 90), chunks.join(' | '));
  assert.equal(chunks.join(' '), text, 'nothing lost');
  assert.equal(subtitleAt(text, 0), chunks[0]);
  assert.equal(subtitleAt(text, 0.999), chunks[chunks.length - 1]);
  assert.equal(subtitleAt('', 0.5), '');
  // Transcripts and tracks survive the lesson file
  const st = [{ f: 1, cap: 'c', clips: [{ blob: new Blob([new Uint8Array([1, 2, 3])]), mime: 'audio/webm', dur: 1, text: 'Hello there.', track: kept }] }];
  const back = parseLesson(await lessonToJSON(st));
  assert.equal(back.stops[0].clips[0].text, 'Hello there.');
  assert.deepEqual(back.stops[0].clips[0].track, kept);
  console.log('gesture track and transcript tests passed');
}
{
  // Automatic transcripts: Whisper's non-speech markers are removed.
  assert.equal(cleanTranscript(' [BLANK_AUDIO]'), '');
  assert.equal(cleanTranscript(' (upbeat music) The water  moves in . '), 'The water moves in.');
  assert.equal(cleanTranscript(' Look at this oxygen ♪♪, it bonds.'), 'Look at this oxygen, it bonds.');
  assert.equal(cleanTranscript(undefined), '');
  // The worker pins the library version the service worker caches.
  const worker = readFileSync(new URL('../src/transcribe-worker.js', import.meta.url), 'utf8');
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  const ver = worker.match(/transformers@([\d.]+)/)[1];
  assert.ok(sw.includes(`transformers@${ver}/`), 'service worker caches the same transformers.js version');
  console.log('automatic transcript tests passed');
}
