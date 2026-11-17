// Hand-tracking gestures from WebXR hand joints. DOM-free (positions in, decisions out), so the
// rules can be tested in Node with synthetic hands.
//
// Joints use WebXR names ('wrist', 'index-finger-tip', 'middle-finger-phalanx-proximal', …).
// `joint(name)` returns {x, y, z} in metres, or null when the joint isn't tracked.

const FINGERS = ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'];
const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * How straight each finger is: fingertip-to-knuckle distance divided by the finger's length
 * along its bones (about 1 when straight, about 0.3–0.5 when curled into a fist). Measuring
 * against the finger's own length makes the test work for small and large hands alike.
 * Returns an array with one ratio per tracked finger (index, middle, ring, pinky).
 */
export function fingerStraightness(joint) {
  const out = [];
  for (const f of FINGERS) {
    const base = joint(`${f}-phalanx-proximal`), mid = joint(`${f}-phalanx-intermediate`);
    const dist = joint(`${f}-phalanx-distal`), tip = joint(`${f}-tip`);
    if (!base || !mid || !dist || !tip) continue;
    const length = d(base, mid) + d(mid, dist) + d(dist, tip);
    if (length > 1e-4) out.push(d(base, tip) / length);
  }
  return out;
}

// A fist closes when at least 3 of the 4 fingers are clearly curled, and opens again only when
// at least 3 are clearly straight, so a hand on the edge doesn't flicker between the two.
const CLOSE_BELOW = 0.6, OPEN_ABOVE = 0.8;

/** Updates state.fist from the joints (with hysteresis); returns true if it changed. */
export function updateFist(state, joint) {
  const r = fingerStraightness(joint);
  if (r.length < 3) return false; // hand not tracked well enough: keep the current state
  const was = !!state.fist;
  state.fist = was; // a new hand starts open
  if (!was && r.filter((x) => x < CLOSE_BELOW).length >= 3) state.fist = true;
  else if (was && r.filter((x) => x > OPEN_ABOVE).length >= 3) state.fist = false;
  return state.fist !== was;
}

/**
 * Fingertip "poke" on a flat panel. `local` is the fingertip in the panel's own coordinates
 * (metres; the panel lies in z = 0, its front facing +z), `w`/`h` the panel size. Presses when
 * the tip crosses the surface from the front, releases once it is pulled back or leaves the
 * panel. Returns { hover, press, release, uv } for this frame; `state` keeps the last depth.
 */
export function pokePanel(state, local, w, h) {
  const inside = Math.abs(local.x) <= w / 2 && Math.abs(local.y) <= h / 2;
  const uv = inside ? { x: local.x / w + 0.5, y: local.y / h + 0.5 } : null;
  const out = { hover: inside && local.z < 0.04 && local.z > -0.03, press: false, release: false, uv };
  const prevZ = state.z == null ? Infinity : state.z;
  if (!state.down && inside && prevZ > 0.008 && local.z <= 0.008 && local.z > -0.03) {
    state.down = true; out.press = true;
  } else if (state.down && (!inside || local.z > 0.02 || local.z < -0.05)) {
    state.down = false; out.release = true;
  }
  state.z = inside ? local.z : Infinity;
  return out;
}
