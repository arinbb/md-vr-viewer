// Parsers for LAMMPS output, usable in the browser (main thread or worker) and in Node.
//
//  parseTrajectory(text)   whole-string convenience wrapper (tests, small files)
//  createTrajectoryParser(head, opts) -> { push(line), finish() }   streaming, line by line
//  parseDataFile(text)     LAMMPS data files (read_data format): masses, atoms, bonds
//
// Output trajectory model:
// {
//   n:        number of atoms
//   ids:      Int32Array(n)   atom-IDs, ascending; index i is used everywhere else
//   types:    string[n]       type label as it appeared ("1", "2", "C", "OW", ...)
//   elements: (string|null)[n]   element column from the dump if present
//   mols:     Int32Array(n) | null
//   frames:   [{ timestep, box, pos: Float32Array(3n), props: { name: Float32Array(n) } }]
//   columns:  string[]        column names from the first ATOMS header
//   props:    string[]        extra numeric per-atom columns kept per frame (vx, fx, q, c_pe, ...)
//   stride:   number          every Nth frame was kept
//   warnings: string[]
// }
// box = { lo:[x,y,z], hi:[x,y,z], tilt:[xy,xz,yz], periodic: bool[3] }

export function* lines(text) {
  let start = 0;
  const len = text.length;
  while (start < len) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = len;
    let line = text.slice(start, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    yield line;
    start = end + 1;
  }
}

const WS = /\s+/;
const tok = (line) => line.trim().split(WS);

export function detectFormat(head) {
  head = head.trimStart();
  if (head.startsWith('ITEM:')) return 'dump';
  if (/^\d+\s*\r?\n/.test(head)) return 'xyz';
  throw new Error('Unrecognized trajectory format: expected a LAMMPS dump (ITEM: lines) or XYZ file.');
}

/** Streaming parser. `opts.stride` keeps every Nth frame (may be raised later via parser.stride). */
export function createTrajectoryParser(head, opts = {}) {
  return detectFormat(head) === 'dump' ? new DumpParser(opts) : new XYZParser(opts);
}

export function parseTrajectory(text, opts = {}) {
  const p = createTrajectoryParser(text.slice(0, 200), opts);
  for (const l of lines(text)) p.push(l);
  return p.finish();
}

// Back-compat names.
export const parseDump = (text, opts) => { const p = new DumpParser(opts); for (const l of lines(text)) p.push(l); return p.finish(); };
export const parseXYZ = (text, opts) => { const p = new XYZParser(opts); for (const l of lines(text)) p.push(l); return p.finish(); };

function newTraj() {
  return { n: 0, ids: null, types: null, elements: null, mols: null, frames: [], columns: [], props: [], stride: 1, warnings: [] };
}

class DumpParser {
  constructor({ stride = 1, maxFrames = Infinity, onFirstFrame } = {}) {
    this.stride = Math.max(1, stride | 0);
    this.maxFrames = maxFrames;
    this.onFirstFrame = onFirstFrame;
    this.traj = newTraj();
    this.state = 'item';
    this.pending = {};
    this.frameCount = 0;     // frames seen in the file (kept or not)
    this.idToIndex = null;
    this.firstRows = null;   // token rows of the first frame (needed to sort atoms by id)
    this.firstFrameChars = 0;
    this.chars = 0;
  }

  push(line) {
    this.chars += line.length + 1;
    switch (this.state) {
      case 'item': {
        if (!line.startsWith('ITEM:')) return;
        const item = line.slice(5).trim();
        if (item.startsWith('TIMESTEP')) this.state = 'timestep';
        else if (item.startsWith('NUMBER OF ATOMS')) this.state = 'natoms';
        else if (item.startsWith('BOX BOUNDS')) { this.boxItem = item; this.boxLines = []; this.state = 'box'; }
        else if (item.startsWith('ATOMS')) this.beginAtoms(item.slice(5).trim().split(WS));
        return;
      }
      case 'timestep': this.pending = { timestep: parseInt(line, 10), box: null }; this.state = 'item'; return;
      case 'natoms': this.pending.natoms = parseInt(line, 10); this.state = 'item'; return;
      case 'box':
        this.boxLines.push(line);
        if (this.boxLines.length === 3) { this.pending.box = parseBox(this.boxItem, ...this.boxLines); this.state = 'item'; }
        return;
      case 'atoms': {
        if (this.keep) {
          if (this.firstRows) this.firstRows.push(tok(line));
          else this.readRow(line);
        }
        if (--this.rowsLeft <= 0) this.endFrame();
        return;
      }
    }
  }

  beginAtoms(cols) {
    const traj = this.traj;
    this.keep = this.frameCount % this.stride === 0 && traj.frames.length < this.maxFrames;
    this.rowsLeft = this.pending.natoms || 0;
    if (this.keep) {
      this.map = columnMap(cols);
      if (!this.idToIndex) {
        traj.columns = cols;
        traj.props = this.map.props.map((p) => p.name);
        if (this.map.id < 0) traj.warnings.push('No "id" column: using row order as atom-ID (atoms must not be reordered between frames).');
        if (this.map.type < 0 && this.map.element < 0) traj.warnings.push('No "type" or "element" column: all atoms get type 1.');
        this.firstRows = [];
      } else {
        this.beginFrame();
      }
    }
    this.state = 'atoms';
    if (this.rowsLeft === 0) this.endFrame();
  }

  beginFrame() {
    const traj = this.traj;
    this.pos = new Float32Array(3 * traj.n);
    const prev = traj.frames.length ? traj.frames[traj.frames.length - 1].pos : null;
    if (prev) this.pos.set(prev); // atoms missing from this frame keep their last position
    this.props = {};
    for (const name of traj.props) {
      this.props[name] = new Float32Array(traj.n);
      if (prev) this.props[name].set(traj.frames[traj.frames.length - 1].props[name]);
    }
    this.rowIndex = 0;
    this.unknown = 0;
    const box = this.pending.box || { lo: [0, 0, 0], hi: [1, 1, 1], tilt: [0, 0, 0], periodic: [false, false, false] };
    this.boxFrame = box;
  }

  readRow(line) {
    const r = tok(line);
    const m = this.map;
    const k = this.rowIndex++;
    const id = m.id >= 0 ? parseInt(r[m.id], 10) : k + 1;
    const i = this.idToIndex.get(id);
    if (i === undefined) { this.unknown++; return; }
    writePos(this.pos, i, r, m, this.boxFrame);
    this.writeProps(i, r);
  }

  writeProps(i, r) {
    for (const p of this.map.props) {
      const arr = this.props[p.name];
      if (arr) arr[i] = +r[p.col];
    }
  }

  endFrame() {
    const traj = this.traj;
    if (this.keep) {
      if (this.firstRows) {
        this.idToIndex = initAtoms(traj, this.firstRows, this.map);
        this.beginFrame();
        this.firstRows.forEach((r, k) => {
          const id = this.map.id >= 0 ? parseInt(r[this.map.id], 10) : k + 1;
          const i = this.idToIndex.get(id);
          writePos(this.pos, i, r, this.map, this.boxFrame);
          this.writeProps(i, r);
        });
        this.firstRows = null;
        this.firstFrameChars = this.chars;
      }
      if (this.unknown && traj.warnings.length < 20) {
        traj.warnings.push(`Frame ${traj.frames.length}: ${this.unknown} atoms not present in the first frame were ignored.`);
      }
      traj.frames.push({ timestep: this.pending.timestep, box: this.pending.box, pos: this.pos, props: this.props });
      this.pos = null;
      if (traj.frames.length === 1 && this.onFirstFrame) {
        const s = this.onFirstFrame({ n: traj.n, frameChars: this.firstFrameChars, bytesPerAtom: 12 + 4 * traj.props.length });
        if (s && s > this.stride) this.stride = s;
      }
    }
    this.frameCount++;
    this.state = 'item';
  }

  finish() {
    if (!this.traj.frames.length) throw new Error('No complete frames found in dump file.');
    if (this.state === 'atoms') this.traj.warnings.push('Last frame was truncated and has been dropped.');
    this.traj.stride = this.stride;
    return this.traj;
  }
}

function writePos(pos, i, r, m, box) {
  let x = +r[m.coord.c[0]], y = +r[m.coord.c[1]], z = +r[m.coord.c[2]];
  const lx = box.hi[0] - box.lo[0], ly = box.hi[1] - box.lo[1], lz = box.hi[2] - box.lo[2];
  const [xy, xz, yz] = box.tilt;
  if (m.coord.kind === 'scaled') {
    const sx = x, sy = y, sz = z;
    x = box.lo[0] + sx * lx + sy * xy + sz * xz;
    y = box.lo[1] + sy * ly + sz * yz;
    z = box.lo[2] + sz * lz;
  }
  if (m.image) {
    const ix = +r[m.image[0]], iy = +r[m.image[1]], iz = +r[m.image[2]];
    x += ix * lx + iy * xy + iz * xz;
    y += iy * ly + iz * yz;
    z += iz * lz;
  }
  pos[3 * i] = x; pos[3 * i + 1] = y; pos[3 * i + 2] = z;
}

function parseBox(item, l1, l2, l3) {
  // "BOX BOUNDS xy xz yz pp pp pp" (triclinic) or "BOX BOUNDS pp pp pp" or bare "BOX BOUNDS"
  const words = item.slice('BOX BOUNDS'.length).trim().split(WS).filter(Boolean);
  if (words[0] === 'abc') {
    // LAMMPS 2023+ "general triclinic" output (dump_modify triclinic/general yes): arbitrary
    // box vectors, which this viewer's box model (LAMMPS's restricted triclinic) can't hold.
    throw new Error('This dump uses a "general triclinic" box (BOX BOUNDS abc origin). Write it without ' +
      'dump_modify triclinic/general (the default) and try again.');
  }
  const triclinic = words[0] === 'xy';
  const flags = triclinic ? words.slice(3) : words;
  const periodic = [0, 1, 2].map((d) => (flags[d] ? flags[d].startsWith('p') : true));
  const a = tok(l1).map(Number), b = tok(l2).map(Number), c = tok(l3).map(Number);
  if (!triclinic) {
    return { lo: [a[0], b[0], c[0]], hi: [a[1], b[1], c[1]], tilt: [0, 0, 0], periodic };
  }
  // Triclinic: the file stores bounding-box extents; convert to lo/hi of the parallelepiped.
  const [xy, xz, yz] = [a[2], b[2], c[2]];
  const xlo = a[0] - Math.min(0, xy, xz, xy + xz);
  const xhi = a[1] - Math.max(0, xy, xz, xy + xz);
  const ylo = b[0] - Math.min(0, yz);
  const yhi = b[1] - Math.max(0, yz);
  return { lo: [xlo, ylo, c[0]], hi: [xhi, yhi, c[1]], tilt: [xy, xz, yz], periodic };
}

function columnMap(cols) {
  const f = (...names) => {
    for (const n of names) { const i = cols.indexOf(n); if (i >= 0) return i; }
    return -1;
  };
  // Prefer unwrapped > wrapped (+image flags) > scaled.
  let coord = null;
  if (f('xu') >= 0) coord = { kind: 'cart', c: [f('xu'), f('yu'), f('zu')] };
  else if (f('x') >= 0) coord = { kind: 'cart', c: [f('x'), f('y'), f('z')] };
  else if (f('xsu') >= 0) coord = { kind: 'scaled', c: [f('xsu'), f('ysu'), f('zsu')] };
  else if (f('xs') >= 0) coord = { kind: 'scaled', c: [f('xs'), f('ys'), f('zs')] };
  if (!coord || coord.c.some((i) => i < 0)) {
    throw new Error(`Dump has no complete coordinate columns (x y z / xu yu zu / xs ys zs). Columns: ${cols.join(' ')}`);
  }
  const unwrapped = cols.includes('xu') || cols.includes('xsu');
  const img = [f('ix'), f('iy'), f('iz')];
  const image = !unwrapped && img.every((i) => i >= 0) ? img : null;
  // Everything else is kept as a per-atom property (velocities, forces, charge, computes...).
  const used = new Set(['id', 'type', 'element', 'mol', 'x', 'y', 'z', 'xu', 'yu', 'zu', 'xs', 'ys', 'zs',
    'xsu', 'ysu', 'zsu', 'ix', 'iy', 'iz', 'proc', 'procp1']);
  const props = cols.map((name, col) => ({ name, col })).filter((p) => !used.has(p.name)).slice(0, 24);
  return { id: f('id'), type: f('type'), element: f('element'), mol: f('mol'), coord, image, props };
}

function initAtoms(traj, rows, map) {
  const n = rows.length;
  const order = rows.map((r, k) => ({ id: map.id >= 0 ? parseInt(r[map.id], 10) : k + 1, k }));
  order.sort((a, b) => a.id - b.id);
  traj.n = n;
  traj.ids = new Int32Array(n);
  traj.types = new Array(n);
  traj.elements = new Array(n).fill(null);
  traj.mols = map.mol >= 0 ? new Int32Array(n) : null;
  const idToIndex = new Map();
  order.forEach(({ id, k }, i) => {
    const r = rows[k];
    traj.ids[i] = id;
    idToIndex.set(id, i);
    traj.types[i] = map.type >= 0 ? r[map.type] : map.element >= 0 ? r[map.element] : '1';
    if (map.element >= 0) traj.elements[i] = r[map.element];
    if (traj.mols) traj.mols[i] = parseInt(r[map.mol], 10);
  });
  return idToIndex;
}

/** `dump xyz` output: N / comment / "type x y z" lines, repeated. */
class XYZParser {
  constructor({ stride = 1, maxFrames = Infinity, onFirstFrame } = {}) {
    this.stride = Math.max(1, stride | 0);
    this.maxFrames = maxFrames;
    this.onFirstFrame = onFirstFrame;
    this.traj = newTraj();
    this.traj.columns = ['type', 'x', 'y', 'z'];
    this.state = 'count';
    this.frameCount = 0;
    this.chars = 0;
  }

  push(line) {
    this.chars += line.length + 1;
    const traj = this.traj;
    if (this.state === 'count') {
      if (!line.trim()) return;
      this.nat = parseInt(line, 10);
      if (!Number.isFinite(this.nat)) throw new Error(`Bad XYZ atom count line: "${line}"`);
      this.state = 'comment';
    } else if (this.state === 'comment') {
      const m = /Timestep:\s*(\d+)/i.exec(line);
      this.timestep = m ? +m[1] : this.frameCount;
      this.keep = this.frameCount % this.stride === 0 && traj.frames.length < this.maxFrames;
      if (this.keep) {
        if (!traj.n) {
          traj.n = this.nat;
          traj.ids = Int32Array.from({ length: this.nat }, (_, k) => k + 1);
          traj.types = new Array(this.nat);
          traj.elements = new Array(this.nat).fill(null);
          traj.warnings.push('XYZ format has no atom-IDs or box: assuming constant atom order, no periodic box.');
        }
        // Atoms missing from a shorter frame keep their previous position (as for dumps).
        const prev = traj.frames.length ? traj.frames[traj.frames.length - 1].pos : null;
        this.pos = prev ? new Float32Array(prev) : new Float32Array(3 * traj.n);
      }
      this.row = 0;
      this.state = this.nat > 0 ? 'atoms' : 'count';
    } else {
      if (this.keep && this.row < this.traj.n) {
        const t = tok(line);
        const k = this.row;
        if (!this.traj.frames.length) {
          traj.types[k] = t[0];
          traj.elements[k] = /^\d+$/.test(t[0]) ? null : t[0];
        }
        this.pos[3 * k] = +t[1]; this.pos[3 * k + 1] = +t[2]; this.pos[3 * k + 2] = +t[3];
      }
      if (++this.row >= this.nat) {
        if (this.keep) {
          traj.frames.push({ timestep: this.timestep, box: null, pos: this.pos, props: {} });
          if (traj.frames.length === 1 && this.onFirstFrame) {
            const s = this.onFirstFrame({ n: traj.n, frameChars: this.chars, bytesPerAtom: 12 });
            if (s && s > this.stride) this.stride = s;
          }
        }
        this.frameCount++;
        this.state = 'count';
      }
    }
  }

  finish() {
    if (!this.traj.frames.length) throw new Error('No frames found in XYZ file.');
    this.traj.stride = this.stride;
    return this.traj;
  }
}

// ---------------------------------------------------------------------------
// Data files (read_data / write_data format)

const ATOM_STYLE_COLUMNS = {
  // column index of [id, mol, type, x] for common atom styles (0-based; -1 = absent)
  atomic: [0, -1, 1, 2],
  charge: [0, -1, 1, 3],
  bond: [0, 1, 2, 3],
  angle: [0, 1, 2, 3],
  molecular: [0, 1, 2, 3],
  full: [0, 1, 2, 4],
  sphere: [0, -1, 1, 4],     // id type diameter density x y z
  dipole: [0, -1, 1, 3],     // id type q x y z mux muy muz
  ellipsoid: [0, -1, 1, 4],  // id type ellipsoidflag density x y z
  body: [0, -1, 1, 4],       // id type bodyflag mass x y z
  line: [0, 1, 2, 5],        // id mol type lineflag density x y z
  tri: [0, 1, 2, 5],         // id mol type triangleflag density x y z
  peri: [0, -1, 1, 4],       // id type volume density x y z
};

const SECTION_NAMES = new Set([
  'Masses', 'Atoms', 'Velocities', 'Bonds', 'Angles', 'Dihedrals', 'Impropers',
  'Pair Coeffs', 'PairIJ Coeffs', 'Bond Coeffs', 'Angle Coeffs', 'Dihedral Coeffs', 'Improper Coeffs',
  'BondBond Coeffs', 'BondAngle Coeffs', 'MiddleBondTorsion Coeffs', 'EndBondTorsion Coeffs',
  'AngleTorsion Coeffs', 'AngleAngleTorsion Coeffs', 'BondBond13 Coeffs', 'AngleAngle Coeffs',
  'Ellipsoids', 'Lines', 'Triangles', 'Bodies',
]);

/**
 * Returns { masses: {type: mass}, typeLabels: {type: label}, atoms: Map(id -> {mol, type}),
 *           bonds: [[id1, id2], ...], atomStyle }
 */
export function parseDataFile(text) {
  const out = { masses: {}, typeLabels: {}, atoms: new Map(), bonds: [], atomStyle: null };
  let section = null;
  let first = true;
  for (const raw of lines(text)) {
    if (first) { first = false; continue; } // first line is always a title
    const hashAt = raw.indexOf('#');
    const line = (hashAt >= 0 ? raw.slice(0, hashAt) : raw).trim();
    const comment = hashAt >= 0 ? raw.slice(hashAt + 1).trim() : '';
    if (!line) continue;

    const head = line.replace(/\s+/g, ' ');
    if (SECTION_NAMES.has(head) || /^[A-Z][A-Za-z]* Type Labels$/.test(head)) {
      section = head;
      if (section === 'Atoms') out.atomStyle = comment.split(WS)[0] || null;
      continue;
    }
    if (!section) continue; // header counts / box lines are not needed here

    const t = line.split(WS);
    if (section === 'Masses') {
      out.masses[t[0]] = parseFloat(t[1]);
      if (comment) out.typeLabels[t[0]] = comment.split(WS)[0];
    } else if (section === 'Atom Type Labels') {
      out.typeLabels[t[0]] = t[1];
    } else if (section === 'Atoms') {
      const cols = ATOM_STYLE_COLUMNS[out.atomStyle] || guessAtomColumns(t);
      out.atoms.set(parseInt(t[cols[0]], 10), {
        mol: cols[1] >= 0 ? parseInt(t[cols[1]], 10) : null,
        type: t[cols[2]],
      });
    } else if (section === 'Bonds') {
      out.bonds.push([parseInt(t[2], 10), parseInt(t[3], 10)]);
    }
  }
  return out;
}

function guessAtomColumns(t) {
  // Without a style hint: 7 or 10 columns usually means "full" (id mol type q x y z [ix iy iz]).
  if (t.length >= 10 || t.length === 7) return ATOM_STYLE_COLUMNS.full;
  // 6 or 9 columns: "molecular" (id mol type x y z) or "charge" (id type q x y z). A charge
  // with a decimal point or exponent in column 3 means "charge"; mol and type are integers.
  if (t.length === 6 || t.length === 9) return /^-?\d+$/.test(t[2]) ? ATOM_STYLE_COLUMNS.molecular : ATOM_STYLE_COLUMNS.charge;
  return ATOM_STYLE_COLUMNS.atomic;
}
