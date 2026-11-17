// Element table: CPK-ish colors (Jmol scheme), covalent radii (Å), van der Waals radii (Å), masses.
// Only the elements likely in biomolecular / materials MD are listed; unknowns fall back to "X".

export const ELEMENTS = {
  H:  { color: 0xffffff, cov: 0.31, vdw: 1.20, mass: 1.008 },
  He: { color: 0xd9ffff, cov: 0.28, vdw: 1.40, mass: 4.0026 },
  Li: { color: 0xcc80ff, cov: 1.28, vdw: 1.82, mass: 6.94 },
  B:  { color: 0xffb5b5, cov: 0.84, vdw: 1.92, mass: 10.81 },
  C:  { color: 0x909090, cov: 0.76, vdw: 1.70, mass: 12.011 },
  N:  { color: 0x3050f8, cov: 0.71, vdw: 1.55, mass: 14.007 },
  O:  { color: 0xff0d0d, cov: 0.66, vdw: 1.52, mass: 15.999 },
  F:  { color: 0x90e050, cov: 0.57, vdw: 1.47, mass: 18.998 },
  Na: { color: 0xab5cf2, cov: 1.66, vdw: 2.27, mass: 22.990 },
  Mg: { color: 0x8aff00, cov: 1.41, vdw: 1.73, mass: 24.305 },
  Al: { color: 0xbfa6a6, cov: 1.21, vdw: 1.84, mass: 26.982 },
  Si: { color: 0xf0c8a0, cov: 1.11, vdw: 2.10, mass: 28.085 },
  P:  { color: 0xff8000, cov: 1.07, vdw: 1.80, mass: 30.974 },
  S:  { color: 0xffff30, cov: 1.05, vdw: 1.80, mass: 32.06 },
  Cl: { color: 0x1ff01f, cov: 1.02, vdw: 1.75, mass: 35.45 },
  Ar: { color: 0x80d1e3, cov: 1.06, vdw: 1.88, mass: 39.948 },
  K:  { color: 0x8f40d4, cov: 2.03, vdw: 2.75, mass: 39.098 },
  Ca: { color: 0x3dff00, cov: 1.76, vdw: 2.31, mass: 40.078 },
  Fe: { color: 0xe06633, cov: 1.32, vdw: 2.04, mass: 55.845 },
  Cu: { color: 0xc88033, cov: 1.32, vdw: 1.40, mass: 63.546 },
  Zn: { color: 0x7d80b0, cov: 1.22, vdw: 1.39, mass: 65.38 },
  Br: { color: 0xa62929, cov: 1.20, vdw: 1.85, mass: 79.904 },
  Au: { color: 0xffd123, cov: 1.36, vdw: 1.66, mass: 196.97 },
  X:  { color: 0xff1493, cov: 0.75, vdw: 1.50, mass: 0 },
};

// Ion residue/atom names used by CHARMM and others that don't start with their element symbol.
const ION_NAMES = { SOD: 'Na', POT: 'K', CLA: 'Cl', CAL: 'Ca', CES: 'Cs', LIT: 'Li', RUB: 'Rb', ZN2: 'Zn', MG2: 'Mg' };

/**
 * Element symbol for a name. Returns a key of ELEMENTS or null.
 *
 * Plain mode (an element column, or a map the user typed): the name is read as an element
 * symbol in any case ("c", "CL" → Cl), else by its first letter ("OW" → O).
 *
 * Force-field mode ({ forceField: true }, for data-file type labels and type names): all-caps
 * or all-lowercase names are atom types, read by their first letter, so AMBER/GAFF "CA"/"ca"
 * (aromatic carbon) is C and "NA"/"na" is N, not calcium or sodium. A symbol in its proper case
 * ("Ca", "Na", "Cl"), a charged name ("NA+", "Cl-", "Ca2+") or a known ion name ("SOD", "CLA")
 * is the element.
 */
export function normalizeElement(s, { forceField = false } = {}) {
  if (s == null) return null;
  s = String(s).trim();
  if (!s || !/[A-Za-z]/.test(s[0])) return null;
  const cap = (x) => x[0].toUpperCase() + x.slice(1).toLowerCase();
  const first = s[0].toUpperCase();
  if (forceField) {
    const ion = /^([A-Za-z]{1,2})\d*[+-]+$/.exec(s);
    if (ion && ELEMENTS[cap(ion[1])]) return cap(ion[1]);
    if (ION_NAMES[s.toUpperCase()]) return ION_NAMES[s.toUpperCase()];
    if (/^[A-Z][a-z]$/.test(s) && ELEMENTS[s]) return s; // proper-case symbol
    if (ELEMENTS[first]) return first;                    // atom type: first letter
    return ELEMENTS[cap(s)] ? cap(s) : null;               // e.g. "MG" (no element "M")
  }
  if (ELEMENTS[cap(s)]) return cap(s);
  // Force-field type names like "CT", "OW", "HW", "C1": take first letter if it is an element.
  if (ELEMENTS[first]) return first;
  return null;
}

/** Guess an element from a mass (as in a LAMMPS data file "Masses" section). */
export function elementFromMass(m) {
  let best = null, bestDiff = Infinity;
  for (const [sym, e] of Object.entries(ELEMENTS)) {
    if (!e.mass) continue;
    const d = Math.abs(e.mass - m);
    if (d < bestDiff) { bestDiff = d; best = sym; }
  }
  // United-atom CH, CH2, CH3, CH4 (13.02, 14.03, 15.03, 16.04 amu) sit right next to N (14.007)
  // and O (15.999): a mass closer to one of them than to the nearest element is carbon.
  const ua = Math.min(...[13.019, 14.027, 15.035, 16.043].map((u) => Math.abs(u - m)));
  if (ua < bestDiff && ua <= 0.05) return 'C';
  if (bestDiff <= 0.6) return best;
  if (m > 12.5 && m < 16.2) return 'C';
  return null;
}

// Distinct colors for "color by type" / "color by molecule".
const PALETTE = [
  0x4e79a7, 0xf28e2b, 0xe15759, 0x76b7b2, 0x59a14f, 0xedc948,
  0xb07aa1, 0xff9da7, 0x9c755f, 0xbab0ac, 0x86bcb6, 0xd37295,
];
export function paletteColor(i) {
  i = Math.abs(i | 0);
  if (i < PALETTE.length) return PALETTE[i];
  // Golden-angle hue walk for many molecules.
  const h = (i * 137.508) % 360;
  return hslToHex(h / 360, 0.55, 0.55);
}

function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}
