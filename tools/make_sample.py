"""Generate a small synthetic LAMMPS trajectory + data file for testing the viewer.

This is NOT a physical simulation: molecules do a smooth random walk and tumble while
their bonds vibrate a little. It deliberately exercises the parser:
  * `dump custom` with columns `id mol type x y z ix iy iz` (wrapped coords + image flags)
  * rows shuffled every frame (LAMMPS does not guarantee atom order)
  * numeric type-IDs only; elements come from the data file Masses section
  * a Bonds section in the data file

Usage:  python tools/make_sample.py [outdir]   (default: tools/fixtures/)

The bundled sample is now real MD data (samples/caffeine_water.lammpstrj.gz); this synthetic
box is only for exercising the parser (shuffled rows, image flags, data-file topology).
"""
import math
import os
import random
import sys

random.seed(7)
L = 18.0           # cubic box edge (Å)
NFRAMES = 120
DUMP_EVERY = 100   # timesteps between frames (cosmetic)

# Molecule templates: list of (type, x, y, z) and bond pairs. Types: 1=O 2=H 3=C 4=N
WATER = ([(1, 0, 0, 0), (2, 0.757, 0.586, 0), (2, -0.757, 0.586, 0)], [(0, 1), (0, 2)])
# Glycine (zwitterion-ish geometry, approximate), heavy atoms + H
GLYCINE = (
    [(4, -1.95, 0.35, 0), (3, -0.70, -0.40, 0), (3, 0.55, 0.45, 0), (1, 0.45, 1.68, 0), (1, 1.65, -0.15, 0),
     (2, -2.75, -0.28, 0), (2, -2.05, 0.98, 0.82), (2, -2.05, 0.98, -0.82),
     (2, -0.70, -1.05, 0.88), (2, -0.70, -1.05, -0.88)],
    [(0, 1), (1, 2), (2, 3), (2, 4), (0, 5), (0, 6), (0, 7), (1, 8), (1, 9)],
)


def rot_matrix(ax, ay, az):
    cx, sx, cy, sy, cz, sz = math.cos(ax), math.sin(ax), math.cos(ay), math.sin(ay), math.cos(az), math.sin(az)
    return [
        [cy * cz, cz * sx * sy - cx * sz, cx * cz * sy + sx * sz],
        [cy * sz, cx * cz + sx * sy * sz, cx * sy * sz - cz * sx],
        [-sy, cy * sx, cx * cy],
    ]


def apply(m, v):
    return [sum(m[r][c] * v[c] for c in range(3)) for r in range(3)]


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), 'fixtures')
    os.makedirs(outdir, exist_ok=True)

    molecules = []  # dict(template, center, angles, vel, spin)
    for k in range(3):
        molecules.append(dict(t=GLYCINE, c=[random.uniform(3, L - 3) for _ in range(3)]))
    for k in range(90):
        molecules.append(dict(t=WATER, c=[random.uniform(0, L) for _ in range(3)]))
    for m in molecules:
        m['a'] = [random.uniform(0, 6.28) for _ in range(3)]
        m['v'] = [random.gauss(0, 0.06) for _ in range(3)]
        m['w'] = [random.gauss(0, 0.05) for _ in range(3)]

    atoms = []  # (id, mol, type, molecule index, template atom index)
    bonds = []
    aid = 0
    for mi, m in enumerate(molecules):
        base = aid
        for ti, (typ, *_xyz) in enumerate(m['t'][0]):
            aid += 1
            atoms.append((aid, mi + 1, typ, mi, ti))
        for (i, j) in m['t'][1]:
            bonds.append((base + i + 1, base + j + 1))

    # --- data file
    with open(os.path.join(outdir, 'synthetic.data'), 'w', newline='\n') as f:
        f.write('Synthetic water + glycine box for bio-vr viewer testing\n\n')
        f.write(f'{len(atoms)} atoms\n{len(bonds)} bonds\n4 atom types\n1 bond types\n\n')
        f.write(f'0.0 {L} xlo xhi\n0.0 {L} ylo yhi\n0.0 {L} zlo zhi\n\n')
        f.write('Masses\n\n1 15.9994\n2 1.008\n3 12.011\n4 14.007\n\n')
        f.write('Atoms # full\n\n')
        for (i, mol, typ, mi, ti) in atoms:
            f.write(f'{i} {mol} {typ} 0.0 0.0 0.0 0.0\n')  # coordinates come from the dump
        f.write('\nBonds\n\n')
        for k, (a, b) in enumerate(bonds, 1):
            f.write(f'{k} 1 {a} {b}\n')

    # --- dump file
    with open(os.path.join(outdir, 'synthetic.lammpstrj'), 'w', newline='\n') as f:
        for frame in range(NFRAMES):
            rows = []
            for (i, mol, typ, mi, ti) in atoms:
                m = molecules[mi]
                rm = rot_matrix(*m['a'])
                local = list(m['t'][0][ti][1:])
                # small bond vibration
                s = 1.0 + 0.03 * math.sin(frame * 0.9 + i)
                local = [x * s for x in local]
                p = [c + d for c, d in zip(m['c'], apply(rm, local))]
                img = [math.floor(x / L) for x in p]
                w = [x - n * L for x, n in zip(p, img)]
                rows.append(f'{i} {mol} {typ} {w[0]:.4f} {w[1]:.4f} {w[2]:.4f} {img[0]} {img[1]} {img[2]}')
            random.shuffle(rows)
            f.write(f'ITEM: TIMESTEP\n{frame * DUMP_EVERY}\nITEM: NUMBER OF ATOMS\n{len(rows)}\n')
            f.write(f'ITEM: BOX BOUNDS pp pp pp\n0.0 {L}\n0.0 {L}\n0.0 {L}\n')
            f.write('ITEM: ATOMS id mol type x y z ix iy iz\n')
            f.write('\n'.join(rows) + '\n')
            # advance motion: smooth random walk + tumbling
            for m in molecules:
                for d in range(3):
                    m['v'][d] = 0.92 * m['v'][d] + random.gauss(0, 0.025)
                    m['c'][d] += m['v'][d]
                    m['w'][d] = 0.95 * m['w'][d] + random.gauss(0, 0.02)
                    m['a'][d] += m['w'][d]

    print(f'wrote {len(atoms)} atoms, {len(bonds)} bonds, {NFRAMES} frames to {os.path.abspath(outdir)}')


if __name__ == '__main__':
    main()
