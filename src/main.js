import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { ELEMENTS, paletteColor } from './elements.js';
import {
  parseTypeMap, resolveElements, resolveMols, bondsFromData, inferBonds, inferStableBonds, atomRadius, boxCorners,
} from './model.js';
import { buildGroups, wrapGroups, atomPath, distance, angle, dihedral, waterGroups, minImage } from './analysis.js';
import { nearMask, hbondParticipants, findHBonds, guessElements } from './chem.js';
import { vectorFamilies, propLabel, propValues, propRange, colormap, gradientCSS, fmt } from './props.js';
import { updateFist, pokePanel } from './gestures.js';
import { createRecorder, createPlayer, lessonToJSON, parseLesson, looksLikeLesson, stripVoice, fmtDur } from './voice.js';

// ---------------------------------------------------------------------------
// State

const MAX_SEL = 4;
const SEL_COLORS = [0xffff66, 0x66e0ff, 0xff7af0, 0x9dff66];

const S = {
  traj: null, data: null, name: '',
  elements: null, mols: null, typeSummary: [],
  staticBonds: new Int32Array(0), bonds: new Int32Array(0), bondSource: '', bondHideLen: 4,
  groups: null, atomGroups: null, water: null, visible: null,
  rep: 'ballstick', colorBy: 'element', atomScale: 1,
  showBonds: true, showBox: true, smooth: true, wrap: true, dynBonds: false, showPaths: false,
  waterMode: 'all',              // 'all' | 'near' (solvation shell) | 'hide'
  shellR: 4,                     // Å, for water: 'near'
  hbonds: 'off',                 // 'off' | 'solute' | 'all'
  arrows: '',                    // vector family to draw as arrows ('' = none)
  arrowScale: 1,
  baseVisible: null,             // Uint8Array(n): visibility before the per-frame shell test
  isWater: null,                 // Uint8Array(n)
  soluteIdx: null, waterIdx: null,
  hb: null,                      // H-bond donors/acceptors
  families: [],                  // vector columns: [{ name, label, cols: [x, y, z] }]
  rangeCache: new Map(),         // color/arrow scale per property
  series: null,                  // measurement over time: { values: Float32Array(nf), label, unit }
  stops: [],                     // lesson stops, sorted by frame
  activeStop: -1, lastFrameInt: -1,
  mode: 'explore',               // 'explore' (free), 'watch' (the lesson plays) or 'create' (authoring)
  passthrough: true,             // in an AR session: show the room (false = dark backdrop, like VR)
  detail: 'auto',                // drawing detail: 'auto' | 'high' | 'medium' | 'low' (see setLevel)
  level: 0,                      // the detail in effect: 0 high, 1 medium, 2 low
  autoLevel: 0,                  // what 'auto' picked for the current VR session
  vrNote: '',                    // short note on the wrist menu (e.g. "detail lowered")
  drawDirty: true,               // draw lists (visible atoms/bonds packed to the front) need rebuilding
  voicePlaying: -1,              // stop whose voice clip is playing
  recTick: 0,                    // whole seconds recorded so far (redraws the wrist menu)
  guessed: null,                 // { confidence, notes } from "guess elements"
  frameF: 0, playing: false, fps: 12,
  sel: [],                       // selected atom indices (up to MAX_SEL)
  paths: [],                     // per selected atom: Float32Array path or null
  radii: null, colors: null,     // Float32Array(n), Float32Array(3n)
  cur: null,                     // current displayed positions Float32Array(3n)
  dirty: true, jump: 5, lastBondFrame: -1,
  fsPerStep: 0,                  // femtoseconds per LAMMPS timestep (0 = unknown)
  needPlace: false,              // VR: place the system in front of the head on the next frame
};

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------------------
// Settings remembered between visits (per browser; harmless if storage is unavailable)

const SETTINGS_KEY = 'md-vr-viewer-settings';
const SAVED = ['rep', 'colorBy', 'atomScale', 'showBonds', 'showBox', 'smooth', 'wrap', 'fps', 'fsPerStep', 'shellR', 'arrowScale', 'detail'];
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  for (const k of SAVED) if (k in saved && typeof saved[k] === typeof S[k]) S[k] = saved[k];
} catch { /* private window etc. */ }
let saveTimer = 0;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(Object.fromEntries(SAVED.map((k) => [k, S[k]])))); } catch { /* ignore */ }
  }, 300);
}

// Voice clips on lesson stops (src/voice.js). Defined early: setMode and the menu use it.
const voice = {
  rec: createRecorder({
    onTick: (t) => { if (Math.floor(t) !== S.recTick) { S.recTick = Math.floor(t); renderVoiceState(); } },
    onAutoStop: (clip) => finishVoice(clip, 'Reached the 3-minute limit. '),
  }),
  player: createPlayer({
    onFail: () => { voice.playingStop = null; S.voicePlaying = -1; voice.resume = false; renderVoiceState(); voiceMsg('This voice clip could not be played in this browser.'); },
    onEnd: () => {
      voice.playingStop = null;
      S.voicePlaying = -1;
      // Playback waited for this clip: carry on (unless the user did something else meanwhile).
      if (voice.resume && S.mode === 'watch' && !S.playing) setPlaying(true);
      voice.resume = false;
      renderVoiceState();
    },
  }),
  resume: false,      // playback was paused for a clip and continues when it ends
  // Lesson changed since the lesson file was last saved or opened (shown as "unsaved").
  _unsaved: false,
  get unsaved() { return this._unsaved; },
  set unsaved(v) { this._unsaved = !!v; const b = document.getElementById('unsavedBadge'); if (b) b.hidden = !v; },
  pending: null,      // the stop being recorded (the moment as it was when recording started)
  busy: false,        // the microphone is being opened
  stopWhenReady: false, // released before recording had started: stop as soon as it does
  playingStop: null,  // the stop whose clip is playing (S.voicePlaying is its index)
  deleteArmed: 0,     // time of the first press of "delete stop" in VR (a second press confirms)
  deleteTarget: null, // the stop that press announced
};

// ?emulate loads Meta's WebXR emulator (IWER) so VR can be tried without a headset.
if (params.has('emulate')) {
  try {
    const iwer = await import('https://cdn.jsdelivr.net/npm/iwer@2.1.1/+esm');
    const dev = new iwer.XRDevice(iwer.metaQuest3);
    dev.installRuntime();
    window.xrDevice = dev;
  } catch (e) { console.warn('Could not load the WebXR emulator', e); }
}

// ---------------------------------------------------------------------------
// Scene

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
$('viewport').appendChild(renderer.domElement);
// Offline app: the service worker caches the viewer so it runs without a network once
// installed (e.g. on a Quest 3). Not for file:// pages or the emulator; ?nosw turns it off.
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !params.has('emulate') && !params.has('nosw')) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Offline mode unavailable', e));
  // The worker downloaded a newer version in the background: offer to switch to it.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data !== 'md-vr-updated' || $('updateNote')) return;
    const note = document.createElement('div');
    note.id = 'updateNote';
    note.innerHTML = 'A new version of the viewer is ready. <button type="button">Reload</button>';
    note.querySelector('button').onclick = () => location.reload();
    $('statusBox').appendChild(note);
  });
}
// Browsers that offer installation (Chrome, Edge) get an Install button in the playback bar.
// The Quest browser installs from its own menu instead.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  if ($('installBtn')) return;
  const b = document.createElement('button');
  b.id = 'installBtn';
  b.textContent = 'Install';
  b.title = 'Install the viewer as an app that also works offline';
  b.onclick = async () => { e.prompt(); await e.userChoice; b.remove(); };
  document.getElementById('barRight').prepend(b);
});

let xrSession = null;   // the running immersive session, if any

// VR start-up log: each step is written to localStorage as it happens, so if the page
// freezes while entering VR, the next load can say which step it got stuck on, and starts the
// next session in safe mode (no optional features). ?xrsafe forces safe mode.
const XR_LOG_KEY = 'md-vr-viewer-xrlog';
let xrFrames = 0;
function xrLog(step, extra = {}) {
  try {
    const log = step === 'click' ? { t0: Date.now(), steps: [] } : JSON.parse(localStorage.getItem(XR_LOG_KEY) || '{"t0":0,"steps":[]}');
    log.steps.push(`${step} +${((Date.now() - log.t0) / 1000).toFixed(1)}s`);
    Object.assign(log, extra);
    localStorage.setItem(XR_LOG_KEY, JSON.stringify(log));
  } catch { /* storage unavailable */ }
  console.info('[VR]', step);
}
const lastXR = (() => { try { return JSON.parse(localStorage.getItem(XR_LOG_KEY) || 'null'); } catch { return null; } })();
// A try that never drew its first VR frame (and didn't fail with an error) froze the page while
// starting. One that got as far as drawing and was then closed (tab closed, page reloaded) did not.
const lastXRFroze = !!lastXR && !lastXR.ok && !lastXR.error && !lastXR.steps.some((st) => st.startsWith('first VR frame'));
const xrSafe = params.has('xrsafe') || lastXRFroze;
if (lastXRFroze) {
  // Shown under the status line until the next VR try; the steps say where it stopped.
  const note = document.createElement('div');
  note.id = 'xrNote';
  note.textContent = `The last Enter VR froze after: ${lastXR.steps.at(-1).replace(/ \+.*$/, '')}. ` +
    'The next try starts in safe mode (fewer VR features). Steps: ' + lastXR.steps.join(' → ');
  $('statusBox').appendChild(note);
}
let arSession = false;  // true when it is 'immersive-ar' (passthrough possible)
const xrButtons = [];
const barRight = document.getElementById('barRight');
barRight.appendChild(makeXRButton('ar'));
barRight.appendChild(makeXRButton('vr'));

/**
 * Our own Enter VR / Enter AR buttons (in the playback bar), with plain-language states instead
 * of three.js's VRButton: they check for a headset, say what to do when there is none, and
 * re-check when a headset is connected later. The AR button (passthrough: the molecules in your
 * room) only appears where the browser supports 'immersive-ar', e.g. the Quest browser.
 */
function makeXRButton(kind) {
  const ar = kind === 'ar';
  const mode = ar ? 'immersive-ar' : 'immersive-vr';
  const NAME = ar ? 'AR' : 'VR';
  const b = document.createElement('button');
  b.id = ar ? 'arBtn' : 'vrBtn';
  let supported = false;
  const set = (text, enabled, title = '') => { b.textContent = text; b.disabled = !enabled; b.title = title; b.classList.toggle('primary', enabled && !ar); };
  const NO_HEADSET = 'No headset found. Connect one (Quest Link, Air Link, Virtual Desktop or SteamVR) and reload, ' +
    'or use the Quest browser. To try VR without a headset, add ?emulate to the address.';
  const AR_TIP = 'Passthrough: see the molecules in your room (Quest browser). Toggle it in the wrist menu.';
  if (!navigator.xr) {
    if (ar) { b.hidden = true; return b; }
    set(window.isSecureContext ? 'VR unavailable' : 'VR needs https', false,
      window.isSecureContext ? 'This browser has no WebXR. Use Chrome or Edge on a PC, or the Quest browser.'
        : 'WebXR only works on https:// pages or localhost.');
    return b;
  }
  const refresh = () => {
    if (xrSession) {
      const mine = arSession === ar;
      set(mine ? `Exit ${NAME}` : `Enter ${NAME}`, mine);
      return;
    }
    if (ar) { b.hidden = !supported; set('Enter AR', supported, AR_TIP); return; }
    set(supported ? 'Enter VR' : 'No headset', supported, supported ? 'Put on the headset and click' : NO_HEADSET);
  };
  const check = () => navigator.xr.isSessionSupported(mode)
    .then((ok) => { supported = ok; refresh(); })
    .catch(() => { supported = false; refresh(); });
  b.refresh = refresh;
  xrButtons.push(b);
  if (ar) b.hidden = true; else set('Checking VR…', false);
  check();
  navigator.xr.addEventListener?.('devicechange', check);
  b.onclick = async () => {
    if (xrSession) { xrSession.end(); return; }
    if (b.dataset.busy) return;
    b.dataset.busy = '1'; b.disabled = true; // until the session starts or fails
    let granted = null;
    try {
      xrLog('click', { mode, safe: xrSafe, ua: navigator.userAgent });
      // Safe mode drops the features most likely to upset a runtime (composition layers, bounded
      // floor) but keeps hand tracking, which hand users can't do without.
      const optionalFeatures = xrSafe ? ['local-floor', 'hand-tracking'] : ['local-floor', 'bounded-floor', 'layers', 'hand-tracking'];
      xrLog(`requestSession (${optionalFeatures.join(', ')})`);
      const s = await navigator.xr.requestSession(mode, { optionalFeatures });
      granted = s;
      xrLog('session granted');
      xrFrames = 0;
      xrSession = s;
      arSession = ar;
      s.addEventListener('end', () => { xrLog('session ended', { ok: true }); xrSession = null; arSession = false; updateBackdrop(); xrButtons.forEach((x) => x.refresh()); });
      updateBackdrop();
      await renderer.xr.setSession(s);
      xrLog('renderer attached');
      delete b.dataset.busy;
      xrButtons.forEach((x) => x.refresh());
    } catch (e) {
      delete b.dataset.busy;
      xrLog(`error: ${e.message}`, { error: e.message });
      if (granted) granted.end().catch(() => {});
      xrSession = null; arSession = false; updateBackdrop();
      xrButtons.forEach((x) => x.refresh());
      setStatus(`Could not start ${NAME}: ${e.message}`);
    }
  };
  return b;
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);
scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(1, 3, 2);
scene.add(sun);

const floor = new THREE.GridHelper(6, 24, 0x30363d, 0x1c2128);
scene.add(floor);

// In an AR session three.js always clears to transparent (the room shows through), so
// "passthrough off" draws a dark sphere around the user instead of a background color.
const backdrop = new THREE.Mesh(new THREE.SphereGeometry(40, 32, 16),
  new THREE.MeshBasicMaterial({ color: 0x0d1117, side: THREE.BackSide, depthWrite: false }));
backdrop.renderOrder = -1;
backdrop.visible = false;
scene.add(backdrop);
/** Passthrough on: no floor grid or backdrop, just molecules in the room. Off: looks like VR. */
function updateBackdrop() {
  backdrop.visible = arSession && !S.passthrough;
  floor.visible = !(arSession && S.passthrough);
  // In passthrough you see your real hands; drawn ones would sit on top of them.
  for (const h of hands) h.handModel.visible = !(arSession && S.passthrough);
}
function setPassthrough(on) { S.passthrough = on; updateBackdrop(); }

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 100);
const HOME = new THREE.Vector3(0, 1.3, -0.7); // where the system floats, ~ in front of a standing user
const CAM_HOME = new THREE.Vector3(0.25, 1.55, 0.75);
camera.position.copy(CAM_HOME);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(HOME);
controls.enableDamping = true;
controls.update();

// root: what the user grabs/moves. model: Å coordinates, centered and scaled to ~0.8 m.
const root = new THREE.Group();
root.position.copy(HOME);
scene.add(root);
const model = new THREE.Group();
root.add(model);

let atomMesh = null, bondMesh = null, boxLines = null;

const highlights = SEL_COLORS.map((color) => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14),
    new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.85 }));
  m.visible = false;
  model.add(m);
  return m;
});

const measureLines = new THREE.LineSegments(
  new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6 * 3), 3)),
  new THREE.LineBasicMaterial({ color: 0xffff66, depthTest: false, transparent: true }),
);
measureLines.renderOrder = 5;
measureLines.frustumCulled = false;
model.add(measureLines);

const pathLines = SEL_COLORS.map((color) => {
  const l = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
  l.frustumCulled = false;
  l.visible = false;
  model.add(l);
  return l;
});

// Hydrogen bonds: H···A drawn as 3 short cylinders ("dashes"), so they stay visible in a headset
// (1-pixel lines nearly disappear in VR). Instanced; capacity grows as needed.
const HB_DASHES = 3;
let hbMesh = null;
function ensureHBMesh(nBonds) {
  if (hbMesh && hbMesh.userData.capacity >= nBonds) return;
  if (hbMesh) disposeMesh(hbMesh);
  const capacity = Math.max(64, Math.ceil(nBonds * 1.5));
  const geo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  geo.translate(0, 0.5, 0);
  hbMesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0x7ee0ff }), capacity * HB_DASHES);
  hbMesh.userData.capacity = capacity;
  hbMesh.frustumCulled = false;
  hbMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  hbMesh.count = 0;
  model.add(hbMesh);
}

let arrowMesh = null; // instanced arrows for a vector column (velocity, force...)

const label = makeLabel();
scene.add(label.sprite);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Loading

const worker = new Worker(new URL('./parse-worker.js', import.meta.url), { type: 'module' });
const pendingJobs = new Map();
let jobSeq = 0;
worker.onmessage = (e) => {
  const d = e.data;
  const job = pendingJobs.get(d.id);
  if (!job) return;
  if (d.progress != null) { job.onProgress && job.onProgress(d); return; }
  pendingJobs.delete(d.id);
  if (d.ok) job.resolve(d.result); else job.reject(new Error(d.error));
};

function parseInWorker(msg, onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++jobSeq;
    pendingJobs.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, ...msg });
  });
}

/** Decide whether a file is a data file or a trajectory from its name and first bytes. */
async function classify(file) {
  const name = file.name.toLowerCase().replace(/\.gz$/, '');
  const head = (await headText(file)).trimStart();
  if (head.startsWith('ITEM:')) return 'traj'; // a dump, whatever its name (e.g. run.dat)
  if (/\.json$/.test(name) || looksLikeLesson(head)) return 'lesson';
  if (/\.(data|lmp|dat)$/.test(name) || name.startsWith('data.')) return 'data';
  if (head.startsWith('ITEM:') || /^\d+\s*\r?\n/.test(head)) return 'traj';
  if (/^\s*\d+\s+atoms\s*$/m.test(head)) return 'data';
  return 'traj';
}

/** First few KB of a file as text, decompressing gzip if needed. */
async function headText(file) {
  const magic = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (!(magic[0] === 0x1f && magic[1] === 0x8b)) return file.slice(0, 4096).text();
  const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream()).getReader();
  let out = '';
  try {
    while (out.length < 4096) { const { done, value } = await reader.read(); if (done) break; out += value; }
  } finally { reader.cancel().catch(() => {}); }
  return out;
}

let loadSeq = 0;
async function loadFiles(files) {
  const mySeq = ++loadSeq; // a newer load supersedes this one
  files = [...files];
  const stride = Math.max(1, parseInt($('stride').value, 10) || 1);
  try {
    const kinds = await Promise.all(files.map(classify)); // throws for e.g. a corrupt .gz
    const trajFile = files.find((_, i) => kinds[i] === 'traj');
    const dataFile = files.find((_, i) => kinds[i] === 'data');
    const lessonFile = files.find((_, i) => kinds[i] === 'lesson');
    let lesson = null;
    if (lessonFile) {
      lesson = parseLesson(await lessonFile.text());
      // The lesson remembers its element map; use it unless one is typed in already.
      if (lesson.meta.map && !$('typeMap').value.trim()) $('typeMap').value = lesson.meta.map;
      if (!trajFile && !dataFile) { applyLesson(lesson, lessonFile.name); return; }
    }
    let data = S.data;
    if (dataFile) {
      setStatus(`Reading data file ${dataFile.name}…`);
      data = await parseInWorker({ kind: 'data', file: dataFile });
      S.dataName = dataFile.name;
      S.dataWaiting = !trajFile && !S.traj; // opened first; its trajectory comes next
    } else if (trajFile && !S.dataWaiting) {
      data = null; // a new trajectory without a data file: drop old topology
      S.dataName = null;
    }
    if (trajFile) {
      setStatus(`Reading ${trajFile.name}…`);
      const t0 = performance.now();
      const traj = await parseInWorker({ kind: 'traj', file: trajFile, stride },
        (d) => { if (mySeq === loadSeq) setStatus(`Reading ${trajFile.name}… ${(100 * d.progress).toFixed(0)}% (${d.nframes} frames)`); });
      if (mySeq !== loadSeq) return;
      S.data = data;
      S.name = trajFile.name;
      if (traj.stride !== stride) $('stride').value = String(traj.stride);
      S.dataWaiting = false;
      setTrajectory(traj, ((performance.now() - t0) / 1000).toFixed(1));
      if (lesson) applyLesson(lesson, lessonFile.name);
    } else if (S.traj) {
      if (mySeq !== loadSeq) return;
      S.data = data;
      setTrajectory(S.traj); // re-apply topology to the current trajectory
    } else {
      if (mySeq !== loadSeq) return;
      S.data = data;
      setStatus('Data file loaded. Now open a trajectory (dump) file.');
    }
    if (lesson && !trajFile) applyLesson(lesson, lessonFile.name); // a lesson opened with a data file
  } catch (err) {
    console.error(err);
    if (mySeq === loadSeq) setStatus(`Error: ${err.message}`);
  }
}

/** First, middle and last frames: enough to average out thermal noise in geometric tests. */
function sampleFrames(traj) {
  const f = traj.frames, k = f.length - 1;
  return [...new Set([0, k >> 1, k])].map((i) => f[i]);
}

// The bundled sample: caffeine in water from a student NPT run (LAMMPS dump custom with scaled
// coordinates and numeric types only). The element map below was checked by hand against
// caffeine's structure; it is the same map *Guess elements* produces.
const SAMPLE = {
  traj: 'samples/caffeine_water.lammpstrj.gz',
  map: '1:C 2:N 3:C 4:N 5:C 6:C 7:C 8:O 9:N 10:C 11:C 12:O 13:N 14:C 15:H 16:H 17:H 18:H 19:H 20:H ' +
    '21:H 22:H 23:H 24:H 25:O 26:H',
  lesson: 'samples/sample.lesson.json',
};

async function loadSample() {
  const get = async (p) => {
    const r = await fetch(p);
    if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
    return new File([await r.blob()], p.split('/').pop());
  };
  try {
    source.traj = SAMPLE.traj; source.data = null;
    $('typeMap').value = SAMPLE.map;
    await loadFiles([await get(SAMPLE.traj)]);
    // The sample comes with a short guided tour, unless a link brought its own stops.
    if (!S.stops.length) {
      try {
        const r = await fetch(SAMPLE.lesson);
        if (r.ok) {
          S.stops = (await r.json()).filter((s) => Number.isInteger(s.f)).sort((a, b) => a.f - b.f);
          S.sampleTour = true;
          renderStops();
          setMode('watch');
          S.lastFrameInt = -1; S.dirty = true; // show the first caption
        }
      } catch { /* the sample still works without its tour */ }
    }
  } catch (err) {
    setStatus(`Could not fetch the sample (${err.message}). Serve this folder over HTTP; see README.`);
  }
}

function setTrajectory(traj, seconds) {
  S.traj = traj;
  S.frameF = 0;
  S.sel = [];
  S.paths = [];
  S.series = null;
  S.cur = new Float32Array(traj.frames[0].pos);
  S.atomGroups = null;
  S.lastBondFrame = -1;
  S.lastFrameInt = -1;
  S.guessed = null;
  S.rangeCache.clear();
  const box = traj.frames[0].box;
  S.jump = box ? 0.5 * Math.min(...[0, 1, 2].map((d) => box.hi[d] - box.lo[d])) : 5;
  $('wrap').disabled = !box;
  setupProps();

  applyTopology();
  // Numeric types with no element anywhere: guess from bonding geometry rather than draw pink blobs.
  let guessNote = '';
  if (S.typeSummary.some((t) => t.element === 'X')) {
    guessNote = `${guessAndApply(false)} Check them in the Atom types table.`;
  }
  fitModel();
  buildMeshes();
  select([]);

  $('frame').max = String(traj.frames.length - 1);
  $('bar').classList.add('loaded');
  // On a phone the panel would cover most of the molecule: fold it to its header (tap + to open).
  if (window.matchMedia('(max-width: 700px)').matches) setPanelCollapsed(true);
  // Loaded: fold the File section away unless the atom types need checking.
  if (!$('typesSub').open) document.querySelector('details[data-sec="file"]').open = false;
  $('warnings').textContent = [guessNote, ...traj.warnings].filter(Boolean).join(' ');
  const memMB = (traj.frames.length * traj.n * 12) / 1e6;
  setStatus(`${S.name}: ${traj.n.toLocaleString()} atoms, ${traj.frames.length} frames` +
    (traj.stride > 1 ? ` (every ${traj.stride}th)` : '') +
    (S.data ? ', with data file' : '') +
    ` · ${memMB < 10 ? memMB.toFixed(1) + ' MB' : memMB < 1000 ? memMB.toFixed(0) + ' MB' : (memMB / 1000).toFixed(1) + ' GB'} in memory` +
    (seconds ? ` · read in ${seconds} s` : '') + `. Columns: ${traj.columns.join(' ')}`);
  S.dirty = true;
}

/** Elements, molecules, bonds, groups: re-run when the type map or data file changes. */
function applyTopology() {
  const traj = S.traj;
  const { elements, summary } = resolveElements(traj, S.data, parseTypeMap($('typeMap').value));
  S.elements = elements;
  S.typeSummary = summary;
  S.mols = resolveMols(traj, S.data);

  if (S.data && S.data.bonds.length) {
    S.staticBonds = bondsFromData(traj, S.data);
    S.bondSource = 'from data file';
  } else {
    S.staticBonds = inferStableBonds(traj.frames, elements, { mols: S.mols });
    S.bondSource = 'inferred from distances';
  }
  S.bonds = S.staticBonds;
  S.lastBondFrame = -1;
  S.groups = buildGroups(traj.n, S.staticBonds, S.mols);
  S.water = waterGroups(S.groups, elements);

  // Bonds stretched beyond this length are drawn hidden (periodic wrap or broken bond).
  const lens = [];
  const p = traj.frames[0].pos;
  for (let b = 0; b < S.bonds.length && lens.length < 5000; b += 2) {
    const i = S.bonds[b], j = S.bonds[b + 1];
    lens.push(Math.hypot(p[3 * i] - p[3 * j], p[3 * i + 1] - p[3 * j + 1], p[3 * i + 2] - p[3 * j + 2]));
  }
  lens.sort((a, b) => a - b);
  const median = lens.length ? lens[lens.length >> 1] : 1.5;
  S.bondHideLen = Math.min(Math.max(2.5 * median, 2.2), S.jump || Infinity);

  const n = traj.n;
  S.isWater = new Uint8Array(n);
  const sol = [], wat = [];
  for (let i = 0; i < n; i++) {
    S.isWater[i] = S.water[S.groups.group[i]];
    (S.isWater[i] ? wat : sol).push(i);
  }
  S.soluteIdx = Int32Array.from(sol);
  S.waterIdx = Int32Array.from(wat);
  S.hb = hbondParticipants(elements, S.staticBonds, sampleFrames(traj));

  const nWater = S.water.reduce((a, b) => a + b, 0);
  $('hideWaterInfo').textContent = nWater ? `${nWater.toLocaleString()} water molecules` : 'No water found.';
  $('water').disabled = !nWater;
  $('water').querySelector('option[value="near"]').disabled = !S.soluteIdx.length; // pure water: nothing to be near
  // Reset water modes that make no sense for this file: nothing to be near, or (pure water)
  // hiding the water would hide everything.
  if ((!nWater && S.waterMode !== 'all') || (S.waterMode !== 'all' && !S.soluteIdx.length)) setWater('all');
  $('hbonds').disabled = !S.hb.hd.length;
  updateBondInfo();
  renderTypeTable();
  computeStyle();
}

/** Guess elements of still-unknown types from bonding geometry and write them into the type map. */
function guessAndApply(rebuild = true) {
  const known = {};
  for (const t of S.typeSummary) if (t.element !== 'X') known[t.type] = t.element;
  const g = guessElements(S.traj, known);
  const map = parseTypeMap($('typeMap').value);
  Object.assign(map, g.map);
  $('typeMap').value = Object.entries(map).sort((a, b) => (+a[0] - +b[0]) || a[0].localeCompare(b[0]))
    .map(([t, e]) => `${t}:${e}`).join(' ');
  S.guessed = { map: g.map, confidence: g.confidence, notes: g.notes };
  applyTopology();
  if (rebuild) { const sel = S.sel; buildMeshes(); select(sel); }
  const low = Object.values(g.confidence).filter((c) => c === 'low').length;
  const n = Object.keys(g.map).length;
  return `Guessed ${n} type${n === 1 ? '' : 's'} from bond geometry${low ? `, ${low} uncertain (marked ?)` : ''}.`;
}

function updateBondInfo() {
  const src = S.dynBonds ? 'recomputed each frame' : S.bondSource;
  $('bondInfo').textContent = `(${(S.bonds.length / 2).toLocaleString()} ${src})`;
}

function fitModel() {
  const f = S.traj.frames[0];
  let lo, hi;
  if (f.box) {
    const c = boxCorners(f.box);
    lo = [0, 1, 2].map((d) => Math.min(...c.map((v) => v[d])));
    hi = [0, 1, 2].map((d) => Math.max(...c.map((v) => v[d])));
  } else {
    lo = [Infinity, Infinity, Infinity]; hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < S.traj.n; i++) for (let d = 0; d < 3; d++) {
      lo[d] = Math.min(lo[d], f.pos[3 * i + d]); hi[d] = Math.max(hi[d], f.pos[3 * i + d]);
    }
  }
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1);
  const k = 0.8 / size; // largest extent -> 0.8 m
  model.scale.setScalar(k);
  model.position.set(-(lo[0] + hi[0]) / 2 * k, -(lo[1] + hi[1]) / 2 * k, -(lo[2] + hi[2]) / 2 * k);
  resetView();
}

function resetView() {
  root.position.copy(HOME);
  root.quaternion.identity();
  root.scale.setScalar(1);
  grabbers.clear();
  if (renderer.xr.isPresenting) {
    S.needPlace = true; // re-center in front of wherever the user is now looking
  } else {
    camera.position.copy(CAM_HOME);
    controls.target.copy(HOME);
    controls.update();
  }
}

/** VR: put the system ~0.75 m in front of the head, slightly below eye level, facing the user. */
function placeInFrontOfHead(frame) {
  const pose = frame && frame.getViewerPose(renderer.xr.getReferenceSpace());
  if (!pose) return false;
  const { position: p, orientation: o } = pose.transform;
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(o.x, o.y, o.z, o.w));
  dir.y = 0;
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
  dir.normalize();
  root.position.set(p.x + 0.75 * dir.x, Math.max(0.5, p.y - 0.15), p.z + 0.75 * dir.z);
  root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-dir.x, -dir.z));
  root.scale.setScalar(1);
  return true;
}

/** Desktop: orbit around atom i (keeps the current viewing direction and distance). */
function focusAtom(i) {
  if (i == null || i < 0 || renderer.xr.isPresenting) return;
  const p = new THREE.Vector3().fromArray(S.cur, 3 * i);
  model.localToWorld(p);
  const delta = p.clone().sub(controls.target);
  controls.target.copy(p);
  camera.position.add(delta);
  controls.update();
}

/** Simulated time for a timestep, if the timestep size is known. */
function simTime(step) {
  if (!S.fsPerStep) return '';
  const fs = step * S.fsPerStep;
  if (fs < 1000) return `${fs.toFixed(0)} fs`;
  if (fs < 1e6) return `${(fs / 1000).toFixed(fs < 1e4 ? 2 : 1)} ps`;
  return `${(fs / 1e6).toFixed(fs < 1e7 ? 3 : 2)} ns`;
}

function disposeMesh(m) {
  if (!m) return;
  model.remove(m); m.geometry.dispose(); m.material.dispose();
  if (m.dispose) m.dispose(); // InstancedMesh: frees the per-instance matrix/color GPU buffers
}

function buildMeshes() {
  disposeMesh(atomMesh); disposeMesh(boxLines);
  const n = S.traj.n;
  // Sphere detail: by system size at High; fixed low-poly spheres at Medium / Low.
  const detail = S.level === 2 ? [7, 5] : S.level === 1 ? [10, 7] : n < 5000 ? [24, 16] : n < 30000 ? [14, 10] : [8, 6];
  atomMesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, ...detail),
    new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.05 }),
    n,
  );
  atomMesh.frustumCulled = false;
  atomMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  atomMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3 * n), 3);
  atomMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  model.add(atomMesh);

  buildBondMesh(S.bonds.length / 2);
  S.drawDirty = true; S.nDraw = 0; S.nDrawBonds = 0; // lists are rebuilt on the next update

  boxLines = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(24 * 3), 3)),
    new THREE.LineBasicMaterial({ color: 0x58a6ff, transparent: true, opacity: 0.6 }),
  );
  boxLines.frustumCulled = false;
  model.add(boxLines);

  buildArrowMesh();
  applyColors();
  S.dirty = true;
}

/** Arrows (shaft + head along +Y, length 1) instanced per atom; only built when a vector is shown. */
function buildArrowMesh() {
  disposeMesh(arrowMesh);
  arrowMesh = null;
  if (!S.traj || !S.arrows) return;
  const shaft = new THREE.CylinderGeometry(0.05, 0.05, 0.75, 6, 1, true);
  shaft.translate(0, 0.375, 0);
  const head = new THREE.ConeGeometry(0.14, 0.25, 8);
  head.translate(0, 0.875, 0);
  const geo = mergeGeometries([shaft, head]);
  arrowMesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xff7b1c, roughness: 0.4 }), S.traj.n);
  arrowMesh.frustumCulled = false;
  arrowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  model.add(arrowMesh);
}

/** Minimal merge of non-indexed/indexed BufferGeometries with position+normal (avoids another addon). */
function mergeGeometries(geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const count = parts.reduce((a, g) => a + g.attributes.position.count, 0);
  const pos = new Float32Array(3 * count), nor = new Float32Array(3 * count);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, 3 * o);
    nor.set(g.attributes.normal.array, 3 * o);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

/** (Re)create the bond mesh with room for at least `nb` bonds. */
function buildBondMesh(nb) {
  disposeMesh(bondMesh);
  const capacity = Math.max(16, Math.ceil(nb * (S.dynBonds ? 1.5 : 1)));
  const radial = S.level === 2 ? 4 : S.level === 1 ? 6 : S.traj.n < 30000 ? 10 : 6;
  const cyl = new THREE.CylinderGeometry(1, 1, 1, radial, 1, true);
  cyl.translate(0, 0.5, 0);
  bondMesh = new THREE.InstancedMesh(cyl, new THREE.MeshStandardMaterial({ roughness: 0.5 }), 2 * capacity);
  bondMesh.userData.capacity = capacity;
  bondMesh.count = 0; // set by rebuildDrawLists
  bondMesh.frustumCulled = false;
  S.drawDirty = true;
  bondMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bondMesh.setColorAt(0, new THREE.Color()); // allocate instanceColor
  model.add(bondMesh);
}

function setBonds(bonds) {
  S.bonds = bonds;
  const nb = bonds.length / 2;
  if (nb > bondMesh.userData.capacity) buildBondMesh(nb);
  S.drawDirty = true;
  updateBondInfo();
}

// ---------------------------------------------------------------------------
// Styling

const isPropColoring = () => S.colorBy.startsWith('p:') || S.colorBy.startsWith('mag:');

function computeStyle() {
  const n = S.traj.n;
  S.styleRev = (S.styleRev || 0) + 1; // invalidates cached contacts (shell, H-bonds)
  S.baseVisible = new Uint8Array(n);
  S.visible = new Uint8Array(n);
  S.radii = new Float32Array(n);
  const hide = S.waterMode === 'hide';
  for (let i = 0; i < n; i++) {
    S.baseVisible[i] = hide && S.isWater[i] ? 0 : 1;
    S.visible[i] = S.baseVisible[i];
    S.radii[i] = atomRadius(S.elements[i], S.rep) * S.atomScale;
  }
  S.colors = new Float32Array(3 * n);
  if (isPropColoring()) {
    updatePropColors(Math.floor(S.frameF));
  } else {
    const typeIndex = new Map(S.typeSummary.map((t, k) => [t.type, k]));
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      let hex;
      if (S.colorBy === 'type') hex = paletteColor(typeIndex.get(S.traj.types[i]));
      else if (S.colorBy === 'mol') hex = paletteColor(S.mols ? S.mols[i] - 1 : S.groups.group[i]);
      else hex = (ELEMENTS[S.elements[i]] || ELEMENTS.X).color;
      c.setHex(hex);
      S.colors[3 * i] = c.r; S.colors[3 * i + 1] = c.g; S.colors[3 * i + 2] = c.b;
    }
  }
  if (S.sel.some((i) => !S.baseVisible[i])) select(S.sel.filter((i) => S.baseVisible[i]));
  updateLegend();
  if (atomMesh) applyColors();
  S.dirty = true;
}

/** Color atoms by a data column for frame f (colors change every frame). */
let propTmp = null, propColorFrame = -1;
function updatePropColors(f) {
  const n = S.traj.n;
  const range = getRange(S.colorBy);
  if (!propTmp || propTmp.length !== n) propTmp = new Float32Array(n);
  propValues(S.traj.frames[f], S.colorBy, S.families, propTmp);
  const c = new THREE.Color();
  const rgb = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    colormap(propTmp[i], range, rgb, 0);
    c.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
    S.colors[3 * i] = c.r; S.colors[3 * i + 1] = c.g; S.colors[3 * i + 2] = c.b;
  }
  propColorFrame = f;
}

function getRange(key) {
  if (!S.rangeCache.has(key)) S.rangeCache.set(key, propRange(S.traj.frames, key, S.families, S.traj.n));
  return S.rangeCache.get(key);
}

function updateLegend() {
  const on = !!S.traj && isPropColoring();
  $('legendWrap').style.display = on ? '' : 'none';
  if (!on) return;
  const r = getRange(S.colorBy);
  $('legend').style.background = gradientCSS(r.diverging);
  $('legendMin').textContent = fmt(r.min);
  $('legendMax').textContent = fmt(r.max);
  $('legendName').textContent = propLabel(S.colorBy, S.families);
}

function applyColors() {
  if (!S.drawAtoms) return; // written when the draw lists are first built
  const a = atomMesh.instanceColor.array, C = S.colors, A = S.drawAtoms;
  for (let k = 0; k < S.nDraw; k++) {
    const i = A[k];
    a[3 * k] = C[3 * i]; a[3 * k + 1] = C[3 * i + 1]; a[3 * k + 2] = C[3 * i + 2];
  }
  atomMesh.instanceColor.needsUpdate = true;
  applyBondColors();
}
function applyBondColors() {
  if (!S.drawBonds) return;
  const a = bondMesh.instanceColor.array, C = S.colors, B = S.bonds, D = S.drawBonds;
  for (let k = 0; k < S.nDrawBonds; k++) {
    const b = D[k], i = B[2 * b], j = B[2 * b + 1], o = 6 * k;
    a[o] = C[3 * i]; a[o + 1] = C[3 * i + 1]; a[o + 2] = C[3 * i + 2];
    a[o + 3] = C[3 * j]; a[o + 4] = C[3 * j + 1]; a[o + 5] = C[3 * j + 2];
  }
  bondMesh.instanceColor.needsUpdate = true;
}

/**
 * Packs the atoms and bonds that are actually drawn to the front of the instanced meshes and
 * sets their counts, so hidden atoms (e.g. water outside the shell) cost nothing on the GPU.
 * At Low detail each water molecule is drawn as one bead at its oxygen: water hydrogens and
 * water bonds are left out of the draw lists only, so H-bond and shell results don't change.
 */
function rebuildDrawLists() {
  const n = S.traj.n, V = S.visible, W = S.isWater, el = S.elements, B = S.bonds;
  const bead = S.level >= 2;
  if (!S.drawAtoms || S.drawAtoms.length < n) S.drawAtoms = new Int32Array(n);
  const A = S.drawAtoms;
  let m = 0;
  for (let i = 0; i < n; i++) if (V[i] && !(bead && W[i] && el[i] === 'H')) A[m++] = i;
  S.nDraw = m;
  atomMesh.count = m;
  const nb = B.length / 2;
  if (!S.drawBonds || S.drawBonds.length < nb) S.drawBonds = new Int32Array(Math.max(nb, 16));
  const D = S.drawBonds;
  let mb = 0;
  for (let b = 0; b < nb; b++) {
    const i = B[2 * b], j = B[2 * b + 1];
    if (V[i] && V[j] && !(bead && (W[i] || W[j]))) D[mb++] = b;
  }
  S.nDrawBonds = mb;
  bondMesh.count = 2 * mb;
  S.drawDirty = false;
  applyColors();
}
/** Radius an atom is drawn (and picked) with: a water oxygen becomes a bead at Low detail. */
function drawRadius(i) {
  if (S.level >= 2 && S.isWater[i]) return (S.rep === 'spacefill' ? 1.6 : S.rep === 'licorice' ? 0.45 : 0.65) * S.atomScale;
  return S.radii[i];
}


/** Color options and arrow options for the loaded trajectory's extra columns. */
function setupProps() {
  const traj = S.traj;
  S.families = vectorFamilies(traj.props || []);
  const sel = $('colorBy');
  [...sel.querySelectorAll('option[data-prop]')].forEach((o) => o.remove());
  const keys = [...S.families.map((f) => `mag:${f.name}`), ...(traj.props || []).map((p) => `p:${p}`)];
  for (const k of keys) {
    const o = document.createElement('option');
    o.value = k; o.dataset.prop = '1';
    o.textContent = `${propLabel(k, S.families)}`;
    sel.appendChild(o);
  }
  if (!COLORINGS().includes(S.colorBy)) S.colorBy = 'element';
  sel.value = S.colorBy;
  const ar = $('arrows');
  ar.innerHTML = '<option value="">None</option>' +
    S.families.map((f) => `<option value="${esc(f.name)}">${esc(f.label)}</option>`).join('');
  if (!S.families.some((f) => f.name === S.arrows)) S.arrows = '';
  ar.value = S.arrows;
  $('arrowsRow').style.display = S.families.length ? '' : 'none';
  $('arrowScaleRow').style.display = S.arrows ? '' : 'none';
}


const ELEMENT_CHOICES = ['H', 'C', 'N', 'O', 'S', 'P', 'F', 'Cl', 'Br', 'Na', 'K', 'Mg', 'Ca', 'Zn', 'Fe', 'Cu',
  'Si', 'Al', 'Li', 'B', 'He', 'Ar', 'Au', 'X'];

function renderTypeTable() {
  const g = S.guessed;
  const rows = S.typeSummary.map((t) => {
    const col = '#' + (ELEMENTS[t.element] || ELEMENTS.X).color.toString(16).padStart(6, '0');
    const opts = ELEMENT_CHOICES.map((e) => `<option${e === t.element ? ' selected' : ''}>${e}</option>`).join('');
    let src = t.source;
    let tip = '';
    if (g && g.map[t.type] === t.element && src === 'your mapping') {
      const low = g.confidence[t.type] === 'low';
      src = low ? 'guessed ?' : 'guessed';
      tip = g.notes[t.type] || (low ? 'uncertain: please check' : 'from bond geometry');
    }
    return `<tr><td>${esc(t.type)}</td><td><span class="swatch" style="background:${col}"></span>` +
      `<select data-type="${esc(t.type)}" title="Set the element for type ${esc(t.type)}">${opts}</select></td>` +
      `<td class="muted"${tip ? ` title="${esc(tip)}"` : ''}${src === 'guessed ?' ? ' style="color:var(--warn)"' : ''}>${esc(src)}</td>` +
      `<td>${t.count.toLocaleString()}</td></tr>`;
  });
  const unknown = S.typeSummary.filter((t) => t.element === 'X').length;
  if (unknown) {
    rows.push(`<tr><td colspan="4" style="color:var(--warn)">${unknown} of ${S.typeSummary.length} types have no element, ` +
      'so colors are generic and bonds may be wrong. Pick elements above, load the LAMMPS data file, or add an ' +
      '<code>element</code> column to the dump.</td></tr>');
  } else if (g && Object.keys(g.map).length) {
    rows.push('<tr><td colspan="4" class="muted">Elements marked <i>guessed</i> were inferred from bond geometry. ' +
      'Check them (hover for details) and fix any with the dropdowns.</td></tr>');
  }
  $('typeTable').innerHTML = `<tr><th>type</th><th>element</th><th>from</th><th>atoms</th></tr>${rows.join('')}`;
  const nGuess = g ? Object.keys(g.map).length : 0;
  const nLow = g ? Object.values(g.confidence).filter((c) => c === 'low').length : 0;
  $('typesBadge').textContent = `(${S.typeSummary.length}${unknown ? `, ${unknown} unknown` : nLow ? `, ${nLow} to check` : nGuess ? ', guessed' : ''})`;
  $('typesBadge').style.color = unknown || nLow ? 'var(--warn)' : '';
  if (unknown || nLow) $('typesSub').open = true; // something needs the user's eye
}

$('typeTable').addEventListener('change', (e) => {
  const t = e.target.dataset && e.target.dataset.type;
  if (!t) return;
  const map = parseTypeMap($('typeMap').value);
  map[t] = e.target.value;
  if (S.guessed) delete S.guessed.map[t]; // now the user's choice
  $('typeMap').value = Object.entries(map).sort((a, b) => (+a[0] - +b[0]) || a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}:${v}`).join(' ');
  $('typeMap').onchange();
});

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// ---------------------------------------------------------------------------
// Per-frame geometry update

function currentGroups() {
  if (!S.dynBonds) return S.groups;
  // Reactive mode: topology changes, so wrap atoms individually rather than by molecule.
  if (!S.atomGroups) S.atomGroups = buildGroups(S.traj.n, new Int32Array(0), null);
  return S.atomGroups;
}

/** Box between two data frames (edges and tilts linear in t), reusing one scratch object. */
const _lbox = { lo: [0, 0, 0], hi: [0, 0, 0], tilt: [0, 0, 0], periodic: [true, true, true] };
function lerpBox(a, b, t) {
  for (let d = 0; d < 3; d++) {
    _lbox.lo[d] = a.lo[d] + t * (b.lo[d] - a.lo[d]);
    _lbox.hi[d] = a.hi[d] + t * (b.hi[d] - a.hi[d]);
    _lbox.tilt[d] = a.tilt[d] + t * (b.tilt[d] - a.tilt[d]);
    _lbox.periodic[d] = a.periodic[d];
  }
  return _lbox;
}
/** True if the box changes size during the run (e.g. NPT); cached on the trajectory. */
function boxVaries(traj) {
  if (traj._boxVaries === undefined) {
    const b0 = traj.frames[0].box;
    traj._boxVaries = !!b0 && traj.frames.some((f) => f.box && [0, 1, 2].some((d) =>
      Math.abs((f.box.hi[d] - f.box.lo[d]) - (b0.hi[d] - b0.lo[d])) > 0.01));
  }
  return traj._boxVaries;
}

function updatePositions() {
  const { traj } = S;
  const nf = traj.frames.length;
  const i0 = Math.min(Math.floor(S.frameF), nf - 1);
  const t = smoothNow() ? S.frameF - i0 : 0;
  const p0 = traj.frames[i0].pos;
  const cur = S.cur;
  if (t > 1e-4 && i0 + 1 < nf) {
    const p1 = traj.frames[i0 + 1].pos;
    const J = S.jump;
    for (let k = 0; k < cur.length; k++) {
      const d = p1[k] - p0[k];
      cur[k] = d > J || d < -J ? p0[k] : p0[k] + t * d; // don't fly across the periodic box
    }
  } else {
    cur.set(p0);
  }
  // The data frame's own box (contacts use it, so counts don't depend on playback), and the box
  // for display: in smooth playback it is interpolated like the atoms. Under NPT the box changes
  // size every frame; without this it would jump at each data frame while the atoms glide,
  // and seem to pulse.
  const frameBox = traj.frames[i0].box;
  const box = t > 1e-4 && i0 + 1 < nf && frameBox && traj.frames[i0 + 1].box
    ? lerpBox(frameBox, traj.frames[i0 + 1].box, t) : frameBox;
  if (S.wrap && box) wrapGroups(cur, currentGroups(), box);

  if (S.dynBonds && i0 !== S.lastBondFrame) {
    S.lastBondFrame = i0;
    setBonds(inferBonds(cur, S.elements, { mols: null, box }));
    S.hb = hbondParticipants(S.elements, S.bonds, [{ pos: cur, box }]);
  }

  // Contacts (solvation shell, H-bonds) depend on the data frame and settings, not on the
  // in-between positions of smooth playback, so they are recomputed only when this key changes.
  const contactKey = `${i0}|${S.waterMode}|${S.shellR}|${S.hbonds}|${S.styleRev}|${S.lastBondFrame}|${S.wrap}`;
  const newContacts = contactKey !== S.contactKey;
  S.contactKey = contactKey;

  // Visibility: the solvation shell follows the solute.
  const V = S.visible;
  if (newContacts) {
    V.set(S.baseVisible);
    if (S.waterMode === 'near' && S.waterIdx.length && S.soluteIdx.length) {
      // The data frame's own positions (not the in-between ones of smooth playback), so the shell
      // is the same however you arrive at a frame. Periodic: contacts across the box edge count.
      const near = nearMask(traj.frames[i0].pos, S.soluteIdx, S.waterIdx, S.shellR, traj.n, frameBox);
      const g = S.groups.group;
      const keepGroup = new Uint8Array(S.groups.count);
      for (const i of S.waterIdx) if (near[i]) keepGroup[g[i]] = 1;
      for (const i of S.waterIdx) V[i] = keepGroup[g[i]];
    }
  }

  if (isPropColoring() && i0 !== propColorFrame) { updatePropColors(i0); applyColors(); }

  if (newContacts || S.drawDirty) rebuildDrawLists();

  // Atoms: write scale+translation matrices directly, visible atoms only (packed).
  const am = atomMesh.instanceMatrix.array;
  const A = S.drawAtoms, bead = S.level >= 2;
  for (let k = 0, o = 0; k < S.nDraw; k++, o += 16) {
    const i = A[k];
    const r = bead ? drawRadius(i) : S.radii[i];
    am[o] = r; am[o + 1] = 0; am[o + 2] = 0; am[o + 3] = 0;
    am[o + 4] = 0; am[o + 5] = r; am[o + 6] = 0; am[o + 7] = 0;
    am[o + 8] = 0; am[o + 9] = 0; am[o + 10] = r; am[o + 11] = 0;
    am[o + 12] = cur[3 * i]; am[o + 13] = cur[3 * i + 1]; am[o + 14] = cur[3 * i + 2]; am[o + 15] = 1;
  }
  atomMesh.instanceMatrix.needsUpdate = true;

  // Bonds: two half-cylinders per drawn bond, each colored like its atom.
  bondMesh.visible = S.showBonds && S.nDrawBonds > 0 && S.rep !== 'spacefill';
  if (bondMesh.visible) {
    const bm = bondMesh.instanceMatrix.array;
    const B = S.bonds, D = S.drawBonds;
    const rb = (S.rep === 'licorice' ? 0.2 : 0.12) * S.atomScale;
    const hide = S.bondHideLen;
    for (let k = 0; k < S.nDrawBonds; k++) {
      const b = 2 * D[k];
      const i = B[b], j = B[b + 1];
      const ax = cur[3 * i], ay = cur[3 * i + 1], az = cur[3 * i + 2];
      let dx = cur[3 * j] - ax, dy = cur[3 * j + 1] - ay, dz = cur[3 * j + 2] - az;
      const len = Math.hypot(dx, dy, dz);
      const o = k * 32;
      if (len > hide || len < 1e-6) { // still split by the box edge, or broken
        bm.fill(0, o, o + 32);
        continue;
      }
      dx /= len; dy /= len; dz /= len;
      // Orthonormal basis (u, d, w) with d along the bond.
      let ux, uy, uz;
      if (Math.abs(dy) < 0.9) { ux = dz; uy = 0; uz = -dx; } else { ux = 0; uy = -dz; uz = dy; }
      const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
      const wx = dy * uz - dz * uy, wy = dz * ux - dx * uz, wz = dx * uy - dy * ux;
      const h = len / 2;
      writeBondMatrix(bm, o, ux * rb, uy * rb, uz * rb, dx * h, dy * h, dz * h, wx * rb, wy * rb, wz * rb, ax, ay, az);
      writeBondMatrix(bm, o + 16, ux * rb, uy * rb, uz * rb, -dx * h, -dy * h, -dz * h, -wx * rb, -wy * rb, -wz * rb,
        cur[3 * j], cur[3 * j + 1], cur[3 * j + 2]);
    }
    bondMesh.instanceMatrix.needsUpdate = true;
  }

  updateHBonds(cur, newContacts, frameBox, traj.frames[i0].pos);
  updateArrows(cur, i0);

  // Box.
  boxLines.visible = S.showBox && !!box;
  if (boxLines.visible) {
    const c = boxCorners(box);
    const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const a = boxLines.geometry.attributes.position.array;
    E.forEach(([p, q], k) => { a.set(c[p], 6 * k); a.set(c[q], 6 * k + 3); });
    boxLines.geometry.attributes.position.needsUpdate = true;
  }

  updateSelectionGeometry(i0, t);

  const fr = traj.frames[i0];
  $('frame').value = String(i0);
  const tm = simTime(fr.timestep);
  // Box size, when it changes over the run (NPT), so its breathing reads as physics, not a glitch.
  const boxText = box && boxVaries(traj) ? ` · box ${(box.hi[0] - box.lo[0]).toFixed(1)} Å` : '';
  $('frameInfo').textContent = `frame ${i0 + 1} / ${nf} · timestep ${fr.timestep.toLocaleString()}${tm ? ` · t = ${tm}` : ''}${boxText}`;
  if (i0 !== S.lastFrameInt) onFrameChange(i0);
}

/** Integer frame changed: lesson stops (narration, pause), plot marker. */
function onFrameChange(i0) {
  const prev = S.lastFrameInt;
  S.lastFrameInt = i0;
  if (S.mode !== 'watch') { // exploring or creating: stops never take over the view
    S.looped = false;
    if (S.mode === 'create') refreshActiveStop();
    drawPlot();
    return;
  }
  // Playing forward past a stop: apply it (and pause, if asked).
  const looped = S.looped;
  S.looped = false;
  if (S.playing && S.stops.length && (looped || i0 > prev)) {
    const from = looped ? -1 : prev; // playback wrapped around to the start
    const k = S.stops.findIndex((s) => s.f > from && s.f <= i0);
    if (k >= 0) {
      applyStop(k, { playback: true });
      if ($('pauseAtStops').checked) { setPlaying(false); S.frameF = S.stops[k].f; S.dirty = true; }
      if (S.stops[k].voice) playVoice(k, { wait: $('waitVoice').checked && S.playing });
    }
  }
  // Caption: the latest stop at or before this frame.
  let active = -1;
  for (let k = 0; k < S.stops.length; k++) if (S.stops[k].f <= i0) active = k;
  if (prev === -2 && S.stops[S.activeStop] && S.stops[S.activeStop].f === i0) active = S.activeStop; // just jumped here
  setActiveStop(active);
  drawPlot();
}

/** H···A dashes for the current positions; the bond list itself is recomputed per data frame. */
const _hbd = [0, 0, 0];
function updateHBonds(cur, recompute, box, framePos) {
  const on = S.hbonds !== 'off' && !!S.hb && S.hb.hd.length > 0;
  if (!on) {
    if (hbMesh) hbMesh.visible = false;
    $('hbInfo').textContent = '';
    S.hbPairs = null; S.hbCount = 0;
    return;
  }
  if (recompute || !S.hbPairs) {
    // Narrow the candidates before the geometric search: only shown atoms, and in solute mode
    // only pairs with a solute donor or a solute acceptor. Same result as filtering afterwards,
    // but with water hidden or in shell mode most of the 2 H per water drop out up front.
    const V = S.visible, W = S.isWater, { hd, acc } = S.hb;
    const hdShown = [], hdSolute = [], accSolute = [], accWater = [];
    for (let k = 0; k < hd.length; k += 2) {
      if (!V[hd[k]]) continue;
      hdShown.push(hd[k], hd[k + 1]);
      if (!W[hd[k + 1]]) hdSolute.push(hd[k], hd[k + 1]);
    }
    for (const a of acc) if (V[a]) (W[a] ? accWater : accSolute).push(a);
    const I = (x) => Int32Array.from(x);
    if (S.hbonds === 'solute') {
      const toSolute = findHBonds(framePos, { hd: I(hdShown), acc: I(accSolute) }, { box });   // any donor -> solute
      const fromSolute = findHBonds(framePos, { hd: I(hdSolute), acc: I(accWater) }, { box }); // solute donor -> water
      S.hbPairs = new Int32Array(toSolute.length + fromSolute.length);
      S.hbPairs.set(toSolute); S.hbPairs.set(fromSolute, toSolute.length);
    } else {
      S.hbPairs = findHBonds(framePos, { hd: I(hdShown), acc: I([...accSolute, ...accWater]) }, { box });
    }
  }
  const pairs = S.hbPairs;
  const m = pairs.length / 2;
  ensureHBMesh(m);
  hbMesh.visible = true;
  const M = hbMesh.instanceMatrix.array;
  const r = 0.07 * S.atomScale;
  for (let k = 0; k < m; k++) {
    const h = pairs[2 * k], x = pairs[2 * k + 1];
    const ax = cur[3 * h], ay = cur[3 * h + 1], az = cur[3 * h + 2];
    // Toward the nearest periodic image of the acceptor: an H-bond across the box edge is drawn
    // as a short dash poking out of the box, not a line spanning it.
    minImage(box, cur[3 * x] - ax, cur[3 * x + 1] - ay, cur[3 * x + 2] - az, _hbd);
    let dx = _hbd[0], dy = _hbd[1], dz = _hbd[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    let ux, uy, uz;
    if (Math.abs(dy) < 0.9) { ux = dz; uy = 0; uz = -dx; } else { ux = 0; uy = -dz; uz = dy; }
    const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
    const wx = dy * uz - dz * uy, wy = dz * ux - dx * uz, wz = dx * uy - dy * ux;
    // Dashes cover 60% of the H···A distance, spread evenly between the two atoms.
    const dash = (0.6 * len) / HB_DASHES, gap = (0.4 * len) / (HB_DASHES + 1);
    for (let q = 0; q < HB_DASHES; q++) {
      const t = gap + q * (dash + gap);
      writeBondMatrix(M, 16 * (k * HB_DASHES + q), ux * r, uy * r, uz * r, dx * dash, dy * dash, dz * dash,
        wx * r, wy * r, wz * r, ax + dx * t, ay + dy * t, az + dz * t);
    }
  }
  hbMesh.count = m * HB_DASHES;
  hbMesh.instanceMatrix.needsUpdate = true;
  S.hbCount = m;
  $('hbInfo').textContent = `${m} H-bond${m === 1 ? '' : 's'}`;
}

/** Arrows for a vector column at frame i0, scaled so the 98th-percentile vector is ~1.5 Å (× the slider). */
function updateArrows(cur, i0) {
  if (!arrowMesh) return;
  const fam = S.families.find((f) => f.name === S.arrows);
  if (!fam) { arrowMesh.visible = false; return; }
  arrowMesh.visible = true;
  const range = getRange(`mag:${fam.name}`);
  const k = (1.5 / (range.max || 1)) * S.arrowScale;
  const [ax, ay, az] = fam.cols.map((c) => S.traj.frames[i0].props[c]);
  const m = arrowMesh.instanceMatrix.array, V = S.visible;
  const w = 1.6 * S.atomScale;
  for (let i = 0, o = 0; i < S.traj.n; i++, o += 16) {
    let dx = ax[i], dy = ay[i], dz = az[i];
    const mag = Math.hypot(dx, dy, dz);
    const len = Math.min(mag * k, 6);
    if (!V[i] || !(len >= 0.05)) { m.fill(0, o, o + 16); continue; } // hidden, tiny or NaN
    dx /= mag; dy /= mag; dz /= mag;
    let ux, uy, uz;
    if (Math.abs(dy) < 0.9) { ux = dz; uy = 0; uz = -dx; } else { ux = 0; uy = -dz; uz = dy; }
    const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
    const wx = dy * uz - dz * uy, wy = dz * ux - dx * uz, wz = dx * uy - dy * ux;
    writeBondMatrix(m, o, ux * w, uy * w, uz * w, dx * len, dy * len, dz * len, wx * w, wy * w, wz * w,
      cur[3 * i], cur[3 * i + 1], cur[3 * i + 2]);
  }
  arrowMesh.instanceMatrix.needsUpdate = true;
}

function writeBondMatrix(m, o, c0x, c0y, c0z, c1x, c1y, c1z, c2x, c2y, c2z, tx, ty, tz) {
  m[o] = c0x; m[o + 1] = c0y; m[o + 2] = c0z; m[o + 3] = 0;
  m[o + 4] = c1x; m[o + 5] = c1y; m[o + 6] = c1z; m[o + 7] = 0;
  m[o + 8] = c2x; m[o + 9] = c2y; m[o + 10] = c2z; m[o + 11] = 0;
  m[o + 12] = tx; m[o + 13] = ty; m[o + 14] = tz; m[o + 15] = 1;
}

// ---------------------------------------------------------------------------
// Selection, measurements, paths

const atomPos = (i) => [S.cur[3 * i], S.cur[3 * i + 1], S.cur[3 * i + 2]];

/**
 * Positions of the selected atoms for measuring: the first as drawn, the others at their nearest
 * periodic image to it (as in computeSeries), so the label, the lines and the plot agree even
 * when the atoms are drawn on opposite sides of the box.
 */
function measurePoints() {
  const s = S.sel;
  const P0 = atomPos(s[0]);
  const box = S.traj.frames[Math.min(Math.floor(S.frameF), S.traj.frames.length - 1)].box;
  const d = [0, 0, 0];
  return s.map((i, k) => {
    const p = atomPos(i);
    if (!k || !box) return p;
    minImage(box, p[0] - P0[0], p[1] - P0[1], p[2] - P0[2], d);
    return [P0[0] + d[0], P0[1] + d[1], P0[2] + d[2]];
  });
}
function measurementText() {
  const s = S.sel;
  const P = measurePoints();
  const name = (i) => `${S.elements[i]}${S.traj.ids[i]}`;
  if (s.length === 2) return `distance ${name(s[0])}–${name(s[1])}: ${distance(P[0], P[1]).toFixed(2)} Å`;
  if (s.length === 3) return `angle ${s.map(name).join('–')}: ${angle(P[0], P[1], P[2]).toFixed(1)}°`;
  if (s.length === 4) return `dihedral ${s.map(name).join('–')}: ${dihedral(P[0], P[1], P[2], P[3]).toFixed(1)}°`;
  return '';
}

function atomLines(i) {
  const { traj } = S;
  const el = S.elements[i];
  const lines = [
    `${el}  ${ELEMENT_NAMES[el] || ''}`,
    `atom-ID ${traj.ids[i]} · type ${traj.types[i]}` + (S.mols ? ` · mol ${S.mols[i]}` : ''),
  ];
  const nbrs = [];
  for (let b = 0; b < S.bonds.length; b += 2) {
    if (S.bonds[b] === i) nbrs.push(S.bonds[b + 1]);
    else if (S.bonds[b + 1] === i) nbrs.push(S.bonds[b]);
  }
  if (nbrs.length) lines.push(`bonded to ${nbrs.map((j) => `${S.elements[j]}${traj.ids[j]}`).join(', ')}`);
  return lines;
}

/**
 * The current measurement (distance / angle / dihedral of the selection) for every frame. Positions
 * are taken relative to the first atom with the minimum image, so periodic wrapping doesn't matter.
 */
function computeSeries() {
  const s = S.sel;
  if (!S.traj || s.length < 2 || S.traj.frames.length < 2) return null;
  const nf = S.traj.frames.length;
  const values = new Float32Array(nf);
  const d = [0, 0, 0];
  for (let f = 0; f < nf; f++) {
    const { pos, box } = S.traj.frames[f];
    const P = s.map((i) => {
      minImage(box, pos[3 * i] - pos[3 * s[0]], pos[3 * i + 1] - pos[3 * s[0] + 1], pos[3 * i + 2] - pos[3 * s[0] + 2], d);
      return [d[0], d[1], d[2]];
    });
    values[f] = s.length === 2 ? distance(P[0], P[1]) : s.length === 3 ? angle(P[0], P[1], P[2]) : dihedral(...P);
  }
  const name = (i) => `${S.elements[i]}${S.traj.ids[i]}`;
  const kind = s.length === 2 ? 'distance' : s.length === 3 ? 'angle' : 'dihedral';
  return { values, label: `${kind} ${s.map(name).join('–')}`, unit: s.length === 2 ? 'Å' : '°' };
}

/** Line plot of the measurement over time with a marker at the current frame (panel or VR menu). */
function plotSeries(ctx, x0, y0, w, h, big) {
  const ser = S.series;
  const v = ser.values, nf = v.length;
  let lo = Infinity, hi = -Infinity;
  for (const x of v) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const X = (f) => x0 + (f / (nf - 1)) * w, Y = (y) => y0 + h - ((y - lo) / (hi - lo)) * h;
  ctx.save();
  ctx.fillStyle = '#0d1117'; ctx.fillRect(x0, y0, w, h);
  ctx.strokeStyle = '#30363d'; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
  ctx.strokeStyle = '#ffff66'; ctx.lineWidth = big ? 3 : 2;
  ctx.beginPath();
  for (let f = 0; f < nf; f++) (f ? ctx.lineTo : ctx.moveTo).call(ctx, X(f), Y(v[f]));
  ctx.stroke();
  // Stops as ticks along the bottom.
  ctx.fillStyle = '#58a6ff';
  for (const st of S.stops) ctx.fillRect(X(st.f) - 1.5, y0 + h - (big ? 12 : 8), 3, big ? 12 : 8);
  const f = Math.min(nf - 1, Math.floor(S.frameF));
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = big ? 2 : 1.5;
  ctx.beginPath(); ctx.moveTo(X(f), y0); ctx.lineTo(X(f), y0 + h); ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(X(f), Y(v[f]), big ? 7 : 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#8b949e';
  ctx.font = `${big ? 22 : 20}px system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillText(`${fmtVal(hi - pad)} ${ser.unit}`, x0 + 6, y0 + 4);
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${fmtVal(lo + pad)} ${ser.unit}`, x0 + 6, y0 + h - 4);
  ctx.restore();
}
const fmtVal = (x) => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2));

function drawPlot() {
  const on = !!S.series;
  $('plotWrap').style.display = on ? 'block' : 'none';
  if (!on) return;
  const c = $('plot');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  plotSeries(ctx, 0, 0, c.width, c.height, false);
  const f = Math.min(S.series.values.length - 1, Math.floor(S.frameF));
  $('plotTitle').textContent = `${S.series.label} over time · now ${fmtVal(S.series.values[f])} ${S.series.unit} (click to jump)`;
}

$('plot').addEventListener('click', (e) => {
  if (!S.series) return;
  const r = e.target.getBoundingClientRect();
  const nf = S.series.values.length;
  setPlaying(false);
  S.frameF = Math.round(THREE.MathUtils.clamp((e.clientX - r.left) / r.width, 0, 1) * (nf - 1));
  S.dirty = true;
});

function select(list) {
  S.sel = list.slice(0, MAX_SEL);
  S.series = computeSeries();
  drawPlot();
  S.paths = S.sel.map((i) => (S.showPaths ? atomPath(S.traj.frames, i) : null));
  pathLines.forEach((l, k) => {
    const p = S.paths[k];
    l.visible = !!p;
    if (p) {
      l.geometry.dispose();
      l.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(p, 3));
    }
  });
  if (!S.sel.length) {
    highlights.forEach((h) => (h.visible = false));
    measureLines.visible = false;
    label.sprite.visible = false;
    $('atomInfo').textContent = 'Click an atom. Shift-click up to 4 atoms to measure.';
    $('atomInfo').className = 'muted';
    lastInfo = '';
    return;
  }
  label.sprite.visible = true;
  S.dirty = true;
  refreshSelectionText(true);
}

let lastInfo = '';
function refreshSelectionText(force) {
  if (!S.sel.length) return;
  const last = S.sel[S.sel.length - 1];
  const meas = measurementText();
  const key = meas + '|' + S.sel.join(',');
  if (!force && key === lastInfo) return;
  lastInfo = key;
  const lines = atomLines(last);
  const labelLines = meas ? [meas, ...lines.slice(0, 2)] : lines;
  label.set(labelLines);
  const html = S.sel.length > 1
    ? [meas, '', ...S.sel.map((i, k) => `${'①②③④'[k]} ${S.elements[i]}${S.traj.ids[i]}` +
      ` (type ${S.traj.types[i]}${S.mols ? `, mol ${S.mols[i]}` : ''})`)]
    : lines;
  $('atomInfo').textContent = html.join('\n');
  $('atomInfo').className = '';
}

function updateSelectionGeometry(i0, t) {
  const R = S.radii;
  highlights.forEach((h, k) => {
    const i = S.sel[k];
    h.visible = i !== undefined;
    if (!h.visible) return;
    h.position.fromArray(S.cur, 3 * i);
    h.scale.setScalar(Math.max(drawRadius(i), 0.3) * 1.25 + 0.15); // fits a water bead at Low detail
  });
  measureLines.visible = S.sel.length > 1;
  if (measureLines.visible) {
    const a = measureLines.geometry.attributes.position.array;
    a.fill(0);
    const P = measurePoints();
    for (let k = 0; k + 1 < P.length; k++) {
      a.set(P[k], 6 * k);
      a.set(P[k + 1], 6 * k + 3);
    }
    measureLines.geometry.attributes.position.needsUpdate = true;
  }
  // Paths: drawn up to the current frame, shifted so they end at the (possibly wrapped) atom.
  pathLines.forEach((l, k) => {
    const p = S.paths[k];
    if (!p) return;
    const i = S.sel[k];
    const nf = p.length / 3;
    const j1 = Math.min(i0 + 1, nf - 1);
    const px = p[3 * i0] + t * (p[3 * j1] - p[3 * i0]);
    const py = p[3 * i0 + 1] + t * (p[3 * j1 + 1] - p[3 * i0 + 1]);
    const pz = p[3 * i0 + 2] + t * (p[3 * j1 + 2] - p[3 * i0 + 2]);
    l.position.set(S.cur[3 * i] - px, S.cur[3 * i + 1] - py, S.cur[3 * i + 2] - pz);
    l.geometry.setDrawRange(0, i0 + 1);
  });
  refreshSelectionText(false);
  updateLabelPosition();
}

/** Add/remove an atom (desktop shift-click, VR trigger); `replace` starts a new selection. */
function pickAction(i, replace, clearOnMiss = true) {
  if (i < 0) { if (clearOnMiss) select([]); return; }
  if (replace) { select([i]); return; }
  const k = S.sel.indexOf(i);
  if (k >= 0) select(S.sel.filter((j) => j !== i));
  else if (S.sel.length >= MAX_SEL) select([i]);
  else select([...S.sel, i]);
}

const ELEMENT_NAMES = { H: 'hydrogen', C: 'carbon', N: 'nitrogen', O: 'oxygen', S: 'sulfur', P: 'phosphorus',
  Na: 'sodium', Cl: 'chlorine', K: 'potassium', Ca: 'calcium', Mg: 'magnesium', Fe: 'iron', Zn: 'zinc',
  F: 'fluorine', Si: 'silicon', Au: 'gold', Cu: 'copper', X: '(unknown element)' };

// ---------------------------------------------------------------------------
// Picking & labels

const _inv = new THREE.Matrix4();
const _o = new THREE.Vector3(), _e = new THREE.Vector3();

/** Analytic ray–sphere test against every visible atom. Returns { index, point (world) } or null. */
function pickAtom(originWorld, dirWorld) {
  if (!S.traj) return null;
  model.updateWorldMatrix(true, false);
  _inv.copy(model.matrixWorld).invert();
  _o.copy(originWorld).applyMatrix4(_inv);
  _e.copy(originWorld).add(dirWorld).applyMatrix4(_inv).sub(_o).normalize();
  const cur = S.cur, A = S.drawAtoms, bead = S.level >= 2;
  if (!A) return null;
  let best = -1, bestT = Infinity;
  for (let k = 0; k < S.nDraw; k++) {
    const i = A[k];
    const cx = cur[3 * i] - _o.x, cy = cur[3 * i + 1] - _o.y, cz = cur[3 * i + 2] - _o.z;
    const tca = cx * _e.x + cy * _e.y + cz * _e.z;
    if (tca < 0) continue;
    const d2 = cx * cx + cy * cy + cz * cz - tca * tca;
    const r = Math.max(bead ? drawRadius(i) : S.radii[i], 0.35);
    if (d2 > r * r) continue;
    const t = tca - Math.sqrt(r * r - d2);
    if (t < bestT) { bestT = t; best = i; }
  }
  if (best < 0) return null;
  const point = _o.clone().addScaledVector(_e, bestT).applyMatrix4(model.matrixWorld);
  return { index: best, point };
}

function makeLabel() {
  const W = 560, LH = 40;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = 200;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.renderOrder = 10;
  sprite.visible = false;
  const obj = {
    sprite, width: 0.26, aspect: 200 / W,
    setWidth(w) { obj.width = w; sprite.scale.set(w, w * obj.aspect, 1); },
    set(lines) {
      const H = 34 + 50 + LH * (lines.length - 1);
      if (canvas.height !== H) { canvas.height = H; tex.dispose(); } // GPU texture must be reallocated
      obj.aspect = H / W;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(13,17,23,0.88)';
      ctx.beginPath(); ctx.roundRect(2, 2, W - 4, H - 4, 18); ctx.fill();
      ctx.strokeStyle = '#ffff66'; ctx.lineWidth = 3; ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 38px system-ui, sans-serif';
      ctx.fillText(clip(ctx, lines[0], W - 40), 22, 54);
      ctx.font = '28px system-ui, sans-serif';
      ctx.fillStyle = '#c9d1d9';
      lines.slice(1).forEach((l, k) => ctx.fillText(clip(ctx, l, W - 40), 22, 54 + LH * (k + 1)));
      tex.needsUpdate = true;
      obj.setWidth(obj.width);
    },
  };
  obj.setWidth(0.26);
  return obj;
}

function clip(ctx, s, maxW) {
  if (ctx.measureText(s).width <= maxW) return s;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

const _p = new THREE.Vector3();
function updateLabelPosition() {
  if (!S.sel.length) return;
  _p.fromArray(S.cur, 3 * S.sel[S.sel.length - 1]);
  model.localToWorld(_p);
  label.sprite.position.copy(_p);
  label.sprite.position.y += label.sprite.scale.y * 0.5 + 0.03;
}

// ---------------------------------------------------------------------------
// Desktop input

const raycaster = new THREE.Raycaster();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = pickAtom(raycaster.ray.origin, raycaster.ray.direction);
  pickAction(hit ? hit.index : -1, !e.shiftKey, !e.shiftKey); // a shift-click that misses keeps the selection
});
renderer.domElement.addEventListener('dblclick', () => focusAtom(S.sel[S.sel.length - 1]));

// Mouse clicks shouldn't leave buttons focused (Space would then press them as well as toggling play).
document.addEventListener('pointerup', (e) => { const b = e.target.closest && e.target.closest('button'); if (b) b.blur(); });

window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+R, Ctrl+P etc. stay the browser's
  if (!S.traj) return;
  if (e.code === 'Space') { e.preventDefault(); setPlaying(!S.playing); }
  else if (e.code === 'ArrowRight') { setPlaying(false); stepFrame(1); }
  else if (e.code === 'ArrowLeft') { setPlaying(false); stepFrame(-1); }
  else if (e.code === 'Escape') select([]);
  else if (e.key === 'r') resetView();
  else if (e.key === 'f') focusAtom(S.sel[S.sel.length - 1]);
  else if (e.key === 'p') screenshotRequested = true;
  else if (e.key === 'n' || e.key === ']') gotoStop(1);
  else if (e.key === 'b' || e.key === '[') gotoStop(-1);
});

// Screenshot: captured right after the next render, while the drawing buffer is still valid.
let screenshotRequested = false;
function saveScreenshot() {
  screenshotRequested = false;
  const f = S.traj ? S.traj.frames[Math.floor(S.frameF)].timestep : 0;
  const base = (S.name || 'view').replace(/\.[^.]+$/, '');
  renderer.domElement.toBlob((blob) => {
    if (!blob) { setStatus('Screenshot failed.'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${base}_step${f}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
}

function stepFrame(d) {
  const nf = S.traj.frames.length;
  S.frameF = (Math.floor(S.frameF) + d + nf) % nf;
  S.dirty = true;
}

function setPlaying(p) {
  S.playing = p && !!S.traj;
  $('playBtn').textContent = S.playing ? 'Pause' : 'Play';
}

// ---------------------------------------------------------------------------
// UI wiring

function setStatus(s) { $('status').textContent = s; }

// Panel sections remember whether they are open (per browser).
const UI_KEY = 'md-vr-viewer-sections';
try {
  const open = JSON.parse(localStorage.getItem(UI_KEY) || 'null');
  if (open) document.querySelectorAll('details.sec').forEach((d) => { if (d.dataset.sec in open) d.open = open[d.dataset.sec]; });
} catch { /* ignore */ }
document.querySelectorAll('details.sec').forEach((d) => d.addEventListener('toggle', () => {
  const open = {};
  document.querySelectorAll('details.sec').forEach((x) => { open[x.dataset.sec] = x.open; });
  try { localStorage.setItem(UI_KEY, JSON.stringify(open)); } catch { /* ignore */ }
}));

$('openBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => { if (e.target.files.length) openLocal(e.target.files); e.target.value = ''; };
$('sampleBtn').onclick = loadSample;
function setPanelCollapsed(c) {
  $('ui').classList.toggle('collapsed', c);
  $('collapse').textContent = c ? '+' : '–';
  $('collapse').title = c ? 'Show the controls' : 'Hide the controls';
}
$('collapse').onclick = () => setPanelCollapsed(!$('ui').classList.contains('collapsed'));
$('typeMap').onchange = () => {
  if (!S.traj) return;
  const sel = S.sel;
  applyTopology(); buildMeshes(); select(sel);
};
$('rep').onchange = (e) => setRep(e.target.value);
$('colorBy').onchange = (e) => setColorBy(e.target.value);
$('atomScale').oninput = (e) => { S.atomScale = +e.target.value; saveSettings(); if (S.traj) computeStyle(); };
$('showBonds').onchange = (e) => { S.showBonds = e.target.checked; saveSettings(); S.dirty = true; };
$('showBox').onchange = (e) => { S.showBox = e.target.checked; saveSettings(); S.dirty = true; };
$('smooth').onchange = (e) => { S.smooth = e.target.checked; saveSettings(); S.dirty = true; };
$('detail').value = S.detail;
$('detail').onchange = (e) => setDetail(e.target.value);
$('wrap').onchange = (e) => { S.wrap = e.target.checked; saveSettings(); S.dirty = true; };
$('fsPerStep').onchange = (e) => { S.fsPerStep = Math.max(0, +e.target.value || 0); saveSettings(); S.dirty = true; };
$('shotBtn').onclick = () => { screenshotRequested = true; };
$('water').onchange = (e) => setWater(e.target.value);
$('shellR').onchange = (e) => { S.shellR = THREE.MathUtils.clamp(+e.target.value || 4, 1, 15); saveSettings(); S.dirty = true; };
$('hbonds').onchange = (e) => setHBonds(e.target.value);
$('arrows').onchange = (e) => setArrows(e.target.value);
$('arrowScale').oninput = (e) => { S.arrowScale = +e.target.value; saveSettings(); S.dirty = true; };
$('guessBtn').onclick = () => { if (S.traj) setStatus(guessAndApply(true)); };
$('dynBonds').onchange = (e) => {
  S.dynBonds = e.target.checked;
  if (!S.traj) return;
  S.lastBondFrame = -1;
  if (!S.dynBonds) { buildBondMesh(S.staticBonds.length / 2); setBonds(S.staticBonds); S.hb = hbondParticipants(S.elements, S.bonds, sampleFrames(S.traj)); }
  S.dirty = true;
};
$('showPaths').onchange = (e) => { S.showPaths = e.target.checked; if (S.traj) select(S.sel); };
$('clearSel').onclick = () => select([]);
$('resetView').onclick = resetView;
$('findAtom').onchange = (e) => {
  if (!S.traj) return;
  const id = parseInt(e.target.value, 10);
  const i = S.traj.ids.indexOf(id);
  if (i < 0) { setStatus(`No atom with atom-ID ${e.target.value}.`); return; }
  if (!S.visible[i]) setWater('all');
  select([i]);
};
$('playBtn').onclick = () => setPlaying(!S.playing);
$('stepBack').onclick = () => { if (S.traj) { setPlaying(false); stepFrame(-1); } };
$('stepFwd').onclick = () => { if (S.traj) { setPlaying(false); stepFrame(1); } };
$('frame').oninput = (e) => { setPlaying(false); S.frameF = +e.target.value; S.dirty = true; };
$('fps').oninput = (e) => { S.fps = +e.target.value; saveSettings(); };

const REPS = ['ballstick', 'spacefill', 'licorice'];
const REP_NAMES = { ballstick: 'ball & stick', spacefill: 'space-filling', licorice: 'licorice' };
/** Color-by choices: the fixed ones plus any data columns in this trajectory. */
const COLORINGS = () => [...$('colorBy').options].map((o) => o.value);
const COLOR_NAMES = { element: 'element', type: 'type', mol: 'molecule' };
const colorName = (k) => COLOR_NAMES[k] || propLabel(k, S.families);
const WATER_MODES = ['all', 'near', 'hide'];
/** Water modes that make sense for this system ("near" needs a solute). */
const waterModes = () => WATER_MODES.filter((m) => m !== 'near' || (S.soluteIdx && S.soluteIdx.length));
const HB_MODES = ['off', 'solute', 'all'];
function setRep(r) { S.rep = r; $('rep').value = r; saveSettings(); if (S.traj) computeStyle(); }
function setColorBy(c) {
  if (!COLORINGS().includes(c)) c = 'element';
  S.colorBy = c; $('colorBy').value = c; saveSettings(); if (S.traj) computeStyle();
}
function setWater(m) {
  if (!WATER_MODES.includes(m)) m = 'all';
  if (m !== 'all' && $('water').disabled) m = 'all';
  if (m === 'near' && S.soluteIdx && !S.soluteIdx.length) m = 'all';
  S.waterMode = m; $('water').value = m;
  $('shellRow').style.display = m === 'near' ? '' : 'none';
  if (S.traj) computeStyle();
}
function setHBonds(m) {
  if (!HB_MODES.includes(m) || $('hbonds').disabled) m = 'off';
  S.hbonds = m; $('hbonds').value = m; S.dirty = true;
}
function setArrows(name) {
  if (!S.families.some((f) => f.name === name)) name = '';
  S.arrows = name; $('arrows').value = name;
  $('arrowScaleRow').style.display = name ? '' : 'none';
  if (S.traj) { buildArrowMesh(); S.dirty = true; }
}
function setShowPaths(on) { S.showPaths = on; $('showPaths').checked = on; if (S.traj) select(S.sel); }

// Reflect saved settings in the controls.
$('rep').value = S.rep; $('colorBy').value = S.colorBy; $('atomScale').value = String(S.atomScale);
$('showBonds').checked = S.showBonds; $('showBox').checked = S.showBox; $('smooth').checked = S.smooth;
$('wrap').checked = S.wrap; $('fps').value = String(S.fps); $('fsPerStep').value = S.fsPerStep ? String(S.fsPerStep) : '';
$('shellR').value = String(S.shellR); $('arrowScale').value = String(S.arrowScale);

// ---------------------------------------------------------------------------
// Lesson stops: a caption tied to a frame, with the view and display settings at that moment.

/** Snapshot of the current moment. Camera is stored in model coordinates so it survives refits. */
function captureStop(caption) {
  const st = {
    f: Math.min(Math.floor(S.frameF), S.traj.frames.length - 1),
    cap: caption,
    sel: S.sel.map((i) => S.traj.ids[i]),
    v: { rep: S.rep, color: S.colorBy, water: S.waterMode, shell: S.shellR, hb: S.hbonds, arrows: S.arrows, paths: S.showPaths },
  };
  if (!renderer.xr.isPresenting) {
    const p = model.worldToLocal(camera.position.clone()), t = model.worldToLocal(controls.target.clone());
    st.cam = [...p.toArray(), ...t.toArray()].map((x) => +x.toFixed(2));
  }
  return st;
}

function applyStop(k, { playback = false } = {}) {
  const st = S.stops[k];
  if (!st || !S.traj) return;
  const v = st.v || {};
  if (v.rep) setRep(v.rep);
  if (v.color) setColorBy(v.color);
  if (v.shell) { S.shellR = THREE.MathUtils.clamp(+v.shell || 4, 1, 15); $('shellR').value = String(S.shellR); }
  if (v.water) setWater(v.water);
  if (v.hb) setHBonds(v.hb);
  if (v.arrows != null) setArrows(v.arrows);
  if (v.paths != null) { S.showPaths = !!v.paths; $('showPaths').checked = S.showPaths; }
  const idx = (st.sel || []).map((id) => S.traj.ids.indexOf(id)).filter((i) => i >= 0);
  select(idx);
  if (!playback) { setPlaying(false); S.frameF = Math.min(st.f, S.traj.frames.length - 1); }
  if (st.cam && !renderer.xr.isPresenting) {
    camera.position.copy(model.localToWorld(new THREE.Vector3(st.cam[0], st.cam[1], st.cam[2])));
    controls.target.copy(model.localToWorld(new THREE.Vector3(st.cam[3], st.cam[4], st.cam[5])));
    controls.update();
  }
  if (!playback) S.lastFrameInt = -2; // refresh caption and plot on the next update, without re-triggering
  setActiveStop(k);
  S.dirty = true;
}

/**
 * The active stop for the frame shown: in Watch the latest stop at or before it (its caption
 * stays up until the next stop); in Create only a stop exactly on this frame (the one you would
 * edit); in Explore none.
 */
function refreshActiveStop() {
  if (S.mode === 'explore' || !S.traj) { setActiveStop(-1); return; }
  const f = Math.floor(S.frameF);
  let a = -1;
  if (S.mode === 'create') a = S.stops.findIndex((st) => st.f === f);
  else for (let k = 0; k < S.stops.length; k++) if (S.stops[k].f <= f) a = k;
  if (a !== S.activeStop) setActiveStop(a);
}

let editedStop = null; // the stop object the caption box shows (Create)
function setActiveStop(k) {
  S.activeStop = k;
  const st = S.stops[k];
  const changed = (st || null) !== editedStop;
  editedStop = st || null;
  const cap = $('caption');
  if (st && (st.cap || st.voice || S.mode === 'create')) {
    const v = st.voice ? ` · voice ${fmtDur(st.voice.dur)}` : '';
    const head = S.mode === 'create' ? `Editing stop ${k + 1} of ${S.stops.length}` : `Stop ${k + 1} of ${S.stops.length}`;
    const body = st.cap ? esc(st.cap) : st.voice ? '<i>Voice note</i>' : '<i>No caption yet</i>';
    cap.innerHTML = `<span class="n">${head}${v}</span>${body}`;
    cap.classList.add('show');
  } else {
    cap.classList.remove('show');
  }
  [...$('stopList').children].forEach((li, j) => li.classList.toggle('active', j === k));
  $('updateStop').disabled = k < 0;
  $('addStop').textContent = k >= 0 && S.mode === 'create' ? 'Add another stop here' : 'Add stop here';
  // Creating: the caption box follows the stop being edited.
  if (S.mode === 'create' && changed) $('stopCaption').value = st ? st.cap || '' : '';
}

function renderStops() {
  if (voice.playingStop) S.voicePlaying = S.stops.indexOf(voice.playingStop); // indices move on insert/delete
  $('stopList').innerHTML = S.stops.map((st, k) =>
    `<li data-k="${k}"><span class="f">fr ${st.f + 1}</span><span class="t" title="${esc(st.cap || '')}">${esc(st.cap || (st.voice ? '(voice note)' : '(no caption)'))}</span>` +
    (st.voice ? `<span class="v" title="Play or stop the voice clip">${S.voicePlaying === k ? '■' : '▶'} ${fmtDur(st.voice.dur)}</span>` : '') +
    '<span class="x adv" title="Delete this stop">✕</span></li>').join('');
  setActiveStop(Math.min(S.activeStop, S.stops.length - 1));
  $('stopsBadge').textContent = S.stops.length ? `${S.stops.length} stop${S.stops.length === 1 ? '' : 's'}` : '';
  $('bar').classList.toggle('has-stops', S.stops.length > 0);
  $('modeWatchN').textContent = S.stops.length ? ` (${S.stops.length})` : '';
  $('modeWatch').disabled = !S.stops.length;
  $('modeWatch').title = S.stops.length ? 'Play the lesson: stops set the view, show captions and play voice clips'
    : 'No lesson yet: open a lesson file, or make one in Create';
  $('watchEmpty').hidden = S.stops.length > 0;
  drawPlot();
}

const MODE_NAMES = ['explore', 'watch', 'create'];
const isStudent = () => document.body.classList.contains('student');
/**
 * Three deliberate modes, changed only by the user (or by opening a lesson, which opens in Watch):
 * - Explore: free; stops never fire, no captions, no lesson tools.
 * - Watch: the lesson plays; stops set the view, show captions, play voice and can pause. Nothing
 *   here edits the lesson. Entering Watch restores the stop for the current frame, so a student
 *   who wandered off in Explore is put back on track.
 * - Create: authoring. Playback and scrubbing are free (stops never take over); going to a stop
 *   loads it for editing; adding, updating, deleting, recording and saving live here only.
 *   Not available in student mode.
 */
function setMode(mode, { restore = true } = {}) {
  if (!MODE_NAMES.includes(mode)) mode = 'explore';
  if (mode === 'create' && isStudent()) mode = 'watch';
  if (mode === S.mode && document.body.classList.contains(`mode-${mode}`)) return;
  if (S.mode === 'create' && (voice.rec.recording || voice.busy)) finishVoice(); // keep a clip in progress
  stopVoice();
  S.mode = mode;
  for (const m of MODE_NAMES) {
    document.body.classList.toggle(`mode-${m}`, S.mode === m);
    const b = $(`mode${m[0].toUpperCase()}${m.slice(1)}`);
    b.classList.toggle('on', S.mode === m);
    b.setAttribute('aria-pressed', String(S.mode === m));
  }
  S.activeStop = -2; // forces the caption and stop list to refresh for the new mode
  if (S.mode === 'explore') setActiveStop(-1);
  else {
    const sec = document.querySelector('details[data-sec="lesson"]');
    if (sec) sec.open = true;
    const f = Math.floor(S.frameF);
    let k = -1;
    for (let j = 0; j < S.stops.length; j++) if (S.stops[j].f <= f) k = j;
    if (S.mode === 'watch' && restore && S.traj && k >= 0) applyStop(k, { playback: true });
    else refreshActiveStop();
  }
  S.dirty = true;
}
$('modeExplore').onclick = () => setMode('explore');
$('modeWatch').onclick = () => setMode('watch');
$('modeCreate').onclick = () => setMode('create');

function addStop(st) {
  if (S.mode !== 'create') return;
  S.sampleTour = false; // edited stops are the user's own lesson now
  voice.unsaved = true;
  S.stops.push(st);
  S.stops.sort((a, b) => a.f - b.f);
  renderStops();
  setActiveStop(S.stops.indexOf(st));
}

$('stopList').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const k = +li.dataset.k;
  if (e.target.classList.contains('x')) {
    if (S.mode !== 'create') return;
    if (!confirm(`Delete stop ${k + 1}${S.stops[k].cap ? ` ("${S.stops[k].cap.slice(0, 40)}")` : ''}${S.stops[k].voice ? ' and its voice clip' : ''}?`)) return;
    voice.unsaved = true;
    stopVoice();
    S.stops.splice(k, 1);
    renderStops();
    refreshActiveStop();
    return;
  }
  if (e.target.classList.contains('v')) {
    if (S.voicePlaying === k) stopVoice(); else playVoice(k);
    return;
  }
  applyStop(k);
  if (S.mode === 'watch') playVoice(k); // creating: silent; ▶ in the row plays it
});
$('addStop').onclick = () => {
  if (!S.traj || S.mode !== 'create') return;
  addStop(captureStop($('stopCaption').value.trim())); // the box now shows the new stop's caption
};
$('updateStop').onclick = () => {
  const k = S.activeStop;
  if (k < 0 || !S.traj || S.mode !== 'create') return;
  const old = S.stops.splice(k, 1)[0];
  // An empty caption box keeps the stop's caption (the box is cleared after Add stop).
  const st = captureStop($('stopCaption').value.trim() || old.cap || '');
  if (old.voice) st.voice = old.voice; // updating the view or caption keeps the clip
  addStop(st);
};
function gotoStop(dir) {
  if (!S.stops.length || !S.traj || S.mode === 'explore') return; // Explore has no lesson
  const f = Math.floor(S.frameF);
  let k;
  if (dir > 0) {
    k = S.stops.findIndex((s, j) => s.f > f || (s.f === f && j > S.activeStop));
    if (k < 0) k = 0;
  } else {
    k = -1;
    for (let j = S.stops.length - 1; j >= 0; j--) {
      if (S.stops[j].f < f || (S.stops[j].f === f && j < S.activeStop)) { k = j; break; }
    }
    if (k < 0) k = S.stops.length - 1;
  }
  applyStop(k);
  if (S.mode === 'watch') playVoice(k);
}
$('prevStop').onclick = () => gotoStop(-1);
$('nextStop').onclick = () => gotoStop(1);

// Share links carry the stops as base64url JSON.
const b64enc = (obj) => {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64dec = (str) => {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0))));
};

/** Where the current files came from (URL when opened from a link, else just the file name). */
const source = { traj: params.get('traj'), data: params.get('data'), lesson: params.get('lesson') };
/** User-picked files: they have no URL for share links, and the sample's tour does not apply to them. */
function openLocal(files) {
  if ([...files].every((f) => /\.json$/i.test(f.name))) { loadFiles(files); return; } // just a lesson file
  source.traj = source.data = null;
  if (S.sampleTour) { S.stops = []; S.activeStop = -1; S.sampleTour = false; renderStops(); setMode('explore'); }
  if ($('typeMap').value === SAMPLE.map) $('typeMap').value = ''; // the sample's map is not for this file
  loadFiles(files);
}

function shareLink() {
  const q = [];
  const add = (k, v) => q.push(v === '' ? k : `${k}=${encodeURIComponent(v).replace(/%3A/gi, ':').replace(/%2F/gi, '/').replace(/%20/g, '+')}`);
  const local = !source.traj;
  add('traj', source.traj || S.name);
  if (source.data || S.dataName) add('data', source.data || S.dataName);
  const map = $('typeMap').value.trim();
  if (map) add('map', map.replace(/\s+/g, ' '));
  if (S.fsPerStep) add('fs', String(S.fsPerStep));
  const stride = +$('stride').value;
  if (stride > 1) add('stride', String(stride));
  add('rep', S.rep);
  add('color', S.colorBy);
  if (S.waterMode !== 'all') add('water', S.waterMode);
  if (S.waterMode === 'near') add('shell', String(S.shellR));
  if (S.hbonds !== 'off') add('hb', S.hbonds);
  if (S.arrows) add('arrows', S.arrows);
  if (S.stops.length) add('stops', b64enc(stripVoice(S.stops)));
  if (source.lesson && !voice.unsaved) add('lesson', source.lesson); // unchanged lesson from a link: keep its voice
  if ($('linkStudent').checked) add('student', '');
  return { url: `${location.origin}${location.pathname}?${q.join('&')}`, local };
}
$('copyLink').onclick = async () => {
  if (!S.traj) return;
  const { url, local } = shareLink();
  let copied = false;
  try { await navigator.clipboard.writeText(url); copied = true; } catch { /* insecure context etc. */ }
  if (!S.stops.some((st) => st.voice)) voice.unsaved = false; // the link holds the whole lesson
  $('linkInfo').innerHTML = (copied ? 'Link copied. ' : 'Copy this link: ') +
    (local ? `It expects <code>${esc(S.name)}</code>${S.dataName ? ` and <code>${esc(S.dataName)}</code>` : ''} next to <code>index.html</code> on the server. ` : '') +
    (S.stops.some((st) => st.voice) ? 'Voice clips are not in links: use <b>Save lesson file</b> and share that file too (or host it and add <code>&amp;lesson=</code> its address). ' : '') +
    `<br><input type="text" readonly value="${esc(url)}" onclick="this.select()">`;
};

// ---------------------------------------------------------------------------
// Voice clips: recording, playback, lesson files.

/** The stop at the current frame, else (in Lesson mode) the active one; -1 if none. */
function stopIndexHere() {
  if (!S.traj) return -1;
  const f = Math.floor(S.frameF);
  const k = S.stops.findIndex((st) => st.f === f);
  return k >= 0 ? k : S.mode === 'watch' ? S.activeStop : -1; // Create: only a stop on this frame
}
function voiceMsg(text) {
  $('voiceInfo').textContent = text;
  if (renderer.xr.isPresenting) vrNote(text);
}
/** A short vibration on every controller (start and end of a recording). */
function buzz() {
  for (const h of hands) {
    const act = h.source && h.source.gamepad && h.source.gamepad.hapticActuators && h.source.gamepad.hapticActuators[0];
    if (act && act.pulse) act.pulse(0.6, 60).catch(() => {});
  }
}
function renderVoiceState() {
  const b = $('recVoice');
  b.textContent = voice.rec.recording ? `■ Stop recording (${fmtDur(S.recTick)})` : '● Record voice';
  b.classList.toggle('rec', voice.rec.recording);
  [...$('stopList').querySelectorAll('.v')].forEach((el) => {
    const k = +el.parentElement.dataset.k;
    if (S.stops[k] && S.stops[k].voice) el.textContent = `${S.voicePlaying === k ? '■' : '▶'} ${fmtDur(S.stops[k].voice.dur)}`;
  });
}
/** Starts recording. The moment (frame, view, selection) is saved now, the clip when you stop. */
async function startVoice() {
  if (!S.traj || voice.rec.recording || voice.busy) return;
  if (S.mode !== 'create') { voiceMsg('Switch to Create to record.'); return; }
  if (!voice.rec.supported) { voiceMsg('This browser cannot record audio.'); return; }
  voice.busy = true;
  setPlaying(false);
  stopVoice();
  voice.pending = captureStop('');
  voice.stopWhenReady = false;
  try {
    await voice.rec.start();
    S.recTick = 0;
    buzz();
    voiceMsg('Recording… release (or click Stop) when you are done.');
    if (voice.stopWhenReady) { voice.busy = false; finishVoice(); return; } // released while the mic was opening
  } catch (e) {
    voice.pending = null;
    voiceMsg(e && e.name === 'NotAllowedError'
      ? 'Microphone blocked. Allow it for this page (in VR: take off the headset and press Allow microphone in the Lesson panel).'
      : `Could not record: ${e.message}`);
  }
  voice.busy = false;
  renderVoiceState();
}
/**
 * Stops recording and puts the clip on the stop at that frame: a re-take replaces only the clip
 * (the stop keeps its caption, camera and settings); otherwise a new stop is made from the moment
 * saved when recording started. autoClip: the recorder stopped by itself (3-minute limit).
 */
async function finishVoice(autoClip, prefix = '') {
  let clip;
  if (autoClip === undefined) {
    if (!voice.rec.recording) { if (voice.busy) voice.stopWhenReady = true; return; }
    clip = await voice.rec.stop();
  } else clip = autoClip;
  buzz();
  const st = voice.pending;
  voice.pending = null;
  renderVoiceState();
  if (!clip || !st) { voiceMsg('Too short: hold the button for as long as you talk.'); return; }
  const k = S.stops.findIndex((x) => x.f === st.f);
  let target;
  if (k >= 0) { target = S.stops[k]; target.voice = clip; } else {
    target = st; target.voice = clip;
    S.stops.push(target); S.stops.sort((a, b) => a.f - b.f);
  }
  S.sampleTour = false; // it's the user's own lesson now
  voice.unsaved = true;
  renderStops();
  setActiveStop(S.stops.indexOf(target));
  voiceMsg(`${prefix}Voice clip on stop ${S.stops.indexOf(target) + 1} (${fmtDur(clip.dur)}). Save the lesson file to keep it.`);
}
/** Plays stop k's clip. wait: pause playback until it ends, then carry on. */
function playVoice(k, { wait = false } = {}) {
  const st = S.stops[k];
  if (!st || !st.voice || voice.rec.recording || S.mode === 'explore') return;
  if (!voice.player.play(k, st.voice)) return;
  S.voicePlaying = k;
  voice.playingStop = st;
  voice.resume = false; // a new clip cancels any "carry on after the clip" of an earlier one
  if (wait && S.playing) { setPlaying(false); voice.resume = true; }
  renderVoiceState();
}
function stopVoice() {
  voice.player.stop();
  voice.playingStop = null;
  S.voicePlaying = -1;
  voice.resume = false;
  renderVoiceState();
}
/** VR: delete the stop here; the first press arms it, a second press within 3 s deletes. */
function deleteStopHere() {
  if (S.mode !== 'create') return;
  // The second press deletes the stop the first press announced, even if playback moved on.
  const armed = performance.now() - voice.deleteArmed <= 3000 && S.stops.includes(voice.deleteTarget);
  if (!armed) {
    const k = stopIndexHere();
    if (k < 0) return;
    const stamp = performance.now();
    voice.deleteArmed = stamp;
    voice.deleteTarget = S.stops[k];
    vrNote(`Press delete again to remove stop ${k + 1}${S.stops[k].voice ? ' and its voice clip' : ''}`);
    setTimeout(() => { if (voice.deleteArmed === stamp) voice.deleteArmed = 0; }, 3100);
    return;
  }
  const k = S.stops.indexOf(voice.deleteTarget);
  voice.deleteArmed = 0; voice.deleteTarget = null;
  voice.unsaved = true;
  stopVoice();
  S.stops.splice(k, 1);
  renderStops();
  refreshActiveStop();
  vrNote(`Stop ${k + 1} deleted`);
}
/** Replaces the stops with a lesson file's (after its trajectory, if both were opened). */
function applyLesson(lesson, name) {
  stopVoice();
  S.stops = lesson.stops;
  S.activeStop = -1;
  S.sampleTour = false;
  voice.unsaved = false;
  source.lesson = null; // set again by lessonFromLink when it came from a link
  if (lesson.meta.fs && !S.fsPerStep) { S.fsPerStep = +lesson.meta.fs || 0; $('fsPerStep').value = String(S.fsPerStep || ''); }
  renderStops();
  setMode('watch');
  S.lastFrameInt = -1; S.dirty = true; // show the caption for this frame
  const other = lesson.meta.trajectory && S.name && lesson.meta.trajectory !== S.name ? ` It was made for ${lesson.meta.trajectory}.` : '';
  const msg = `Lesson ${name}: ${lesson.stops.length} stops, ${lesson.clips} voice clip${lesson.clips === 1 ? '' : 's'}.${other}`;
  $('voiceInfo').textContent = msg;
  setStatus(S.traj ? `${$('status').textContent} · ${msg}` : `${msg} Now open its trajectory.`);
}
$('recVoice').onclick = () => (voice.rec.recording ? finishVoice() : startVoice());
$('allowMic').onclick = async () => {
  try { await voice.rec.allow(); voiceMsg('Microphone allowed. In VR, hold “● hold to talk” on the wrist menu.'); }
  catch (e) { voiceMsg(`Microphone not available: ${e.message}`); }
};
$('saveLesson').onclick = async () => {
  if (!S.stops.length) { voiceMsg('No stops to save yet.'); return; }
  const text = await lessonToJSON(S.stops, {
    trajectory: S.name || undefined, map: $('typeMap').value.trim() || undefined, fs: S.fsPerStep || undefined,
  });
  const base = (S.name || 'lesson').replace(/\.gz$/i, '').replace(/\.[^.]+$/, '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = `${base}.lesson.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  voice.unsaved = false;
  voiceMsg(`Saved ${a.download} (${(text.length / 1e6).toFixed(2)} MB). Open it together with the trajectory to play the lesson.`);
};
if (!voice.rec.supported) { $('recVoice').disabled = true; $('allowMic').disabled = true; $('recVoice').title = 'This browser cannot record audio'; }
// Edited stops and recorded clips live only in this page until the lesson file is saved
// (or, without clips, a share link is copied).
window.addEventListener('beforeunload', (e) => {
  if (voice.unsaved && S.stops.length) { e.preventDefault(); e.returnValue = ''; }
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').classList.add('show'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').classList.remove('show'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('drop').classList.remove('show');
  if (e.dataTransfer.files.length) openLocal(e.dataTransfer.files);
});

// ---------------------------------------------------------------------------
// VR input

const controllerFactory = new XRControllerModelFactory();
const handFactory = new XRHandModelFactory();
const hands = [];
for (let k = 0; k < 2; k++) {
  const ctrl = renderer.xr.getController(k);
  const ray = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0x58a6ff, transparent: true, opacity: 0.7 }),
  );
  ray.scale.z = 2;
  ray.visible = false;
  ctrl.add(ray);
  scene.add(ctrl);
  const grip = renderer.xr.getControllerGrip(k);
  grip.add(controllerFactory.createControllerModel(grip));
  scene.add(grip);
  // Tracked hands: a skinned hand model (loaded from the WebXR input-profiles CDN) and joints.
  const hand = renderer.xr.getHand(k);
  const handModel = handFactory.createHandModel(hand, 'mesh');
  hand.add(handModel);
  scene.add(hand);
  const hover = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 8), new THREE.MeshBasicMaterial({ color: 0x58a6ff }));
  hover.visible = false;
  scene.add(hover);
  const h = {
    ctrl, grip, ray, hover, hand, handModel, source: null, prevButtons: [], hit: null, flicked: false,
    fist: false, poke: {}, pokeHit: null, pendingPick: undefined, fistDuringPinch: false,
  };
  hands.push(h);
  ctrl.addEventListener('connected', (e) => {
    h.source = e.data;
    ray.visible = true; // hands get a pointing ray too: without it you can't tell where a pinch lands
    ray.material.opacity = e.data.hand ? 0.45 : 0.7;
    h.fist = false; h.poke = {};
    placeWristPanel();
  });
  ctrl.addEventListener('disconnected', () => {
    h.source = null; ray.visible = false; hover.visible = false;
    grabbers.delete(h); beginGrab(); placeWristPanel();
  });
  ctrl.addEventListener('selectstart', () => {
    if (h.menuHit) { // the ray is on the wrist menu: press a button / grab the timeline, never pick behind it
      h.menuDown = h.menuHit.id;
      if (h.menuHit.id) { menu.press(h.menuHit); if (h.source && h.source.hand) uiClick(); }
      return;
    }
    const hit = rayHit(h);
    if (h.source && h.source.hand) {
      // Hands: closing a fist can brush thumb and index together (a pinch). Pick on release
      // instead, and only if no fist was made meanwhile, so grabbing doesn't clear the selection.
      h.pendingPick = hit ? hit.index : -1;
      h.fistDuringPinch = h.fist;
      return;
    }
    pickAction(hit ? hit.index : -1, false);
  });
  ctrl.addEventListener('selectend', () => {
    if (h.menuDown) menu.release(h.menuDown);
    h.menuDown = null;
    if (h.pendingPick !== undefined) {
      if (!h.fistDuringPinch && !h.fist) pickAction(h.pendingPick, false);
      h.pendingPick = undefined;
    }
  });
  // Controllers grab with the grip button. Hands grab with a closed fist (updateHands), not with
  // the browser's squeeze, which hands may or may not send.
  ctrl.addEventListener('squeezestart', () => { if (h.source && h.source.hand) return; grabbers.add(h); beginGrab(); });
  ctrl.addEventListener('squeezeend', () => { if (h.source && h.source.hand) return; grabbers.delete(h); beginGrab(); });
}

const _ro = new THREE.Vector3(), _rd = new THREE.Vector3(), _rq = new THREE.Quaternion();
function rayHit(h) {
  h.ctrl.getWorldPosition(_ro);
  _rd.set(0, 0, -1).applyQuaternion(h.ctrl.getWorldQuaternion(_rq));
  return pickAtom(_ro, _rd);
}

const menuRay = new THREE.Raycaster();
function updateHover() {
  for (const h of hands) {
    h.menuHit = null;
    if (!h.source || grabbers.has(h)) { h.hover.visible = false; h.ray.scale.z = 2; continue; }
    h.ctrl.getWorldPosition(_ro);
    _rd.set(0, 0, -1).applyQuaternion(h.ctrl.getWorldQuaternion(_rq));
    // 1. The wrist menu (on the other hand) takes priority over atoms.
    if (menu.mesh.parent && menu.mesh.parent !== h.grip) {
      menuRay.set(_ro, _rd);
      const mh = menuRay.intersectObject(menu.mesh, false)[0];
      if (mh && mh.uv) {
        h.menuHit = menu.hitTest(mh.uv);
        h.hover.visible = true;
        h.hover.scale.setScalar(0.35); // small dot so it doesn't cover button labels
        h.hover.position.copy(mh.point);
        h.ray.scale.z = Math.max(0.02, mh.distance);
        if (h.menuDown === 'timeline' && h.menuHit.id === 'timeline') menu.press(h.menuHit); // drag to scrub
        continue;
      }
    }
    // 2. Atoms (every 2nd frame at Medium, every 3rd at Low: picking is O(atoms) per hand).
    if (S.level > 0 && xrFrames % (S.level + 1) !== 0) continue;
    const hit = pickAtom(_ro, _rd);
    h.hover.visible = !!hit;
    h.hover.scale.setScalar(1);
    if (hit) {
      h.hover.position.copy(hit.point);
      h.ray.scale.z = Math.max(0.05, _ro.distanceTo(hit.point));
    } else {
      h.ray.scale.z = 2;
    }
  }
  menu.setHover([...hands.map((h) => h.menuHit && h.menuHit.id), ...hands.map((h) => h.pokeHit)].filter(Boolean));
}

// Grab: one hand moves/rotates the system rigidly; two hands also scale it.
const grabbers = new Set();
const G = { offset: new THREE.Matrix4(), q0: new THREE.Quaternion(), s0: 1, d0: 1,
  dir0: new THREE.Vector3(), localMid: new THREE.Vector3() };
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _m4 = new THREE.Matrix4();

/** What a grab follows: the controller, or the wrist of a tracked hand (steadier than its ray). */
function anchorOf(h) {
  const w = h.source && h.source.hand && h.hand.joints && h.hand.joints.wrist;
  return w && w.visible ? w : h.ctrl;
}
function beginGrab() {
  const g = [...grabbers];
  root.updateMatrix();
  if (g.length === 1) {
    anchorOf(g[0]).updateWorldMatrix(true, false);
    G.offset.copy(anchorOf(g[0]).matrixWorld).invert().multiply(root.matrix);
  } else if (g.length >= 2) {
    anchorOf(g[0]).getWorldPosition(_a); anchorOf(g[1]).getWorldPosition(_b);
    G.d0 = Math.max(_a.distanceTo(_b), 1e-3);
    G.dir0.subVectors(_b, _a).normalize();
    G.q0.copy(root.quaternion);
    G.s0 = root.scale.x;
    const mid = _a.clone().add(_b).multiplyScalar(0.5);
    G.localMid.copy(mid).applyMatrix4(_m4.copy(root.matrix).invert());
  }
}

function updateGrab() {
  const g = [...grabbers];
  if (g.length === 1) {
    _m4.multiplyMatrices(anchorOf(g[0]).matrixWorld, G.offset);
    _m4.decompose(root.position, root.quaternion, _a);
  } else if (g.length >= 2) {
    anchorOf(g[0]).getWorldPosition(_a); anchorOf(g[1]).getWorldPosition(_b);
    const d = Math.max(_a.distanceTo(_b), 1e-3);
    const dir = new THREE.Vector3().subVectors(_b, _a).normalize();
    const s = THREE.MathUtils.clamp(G.s0 * d / G.d0, 0.05, 40);
    const q = new THREE.Quaternion().setFromUnitVectors(G.dir0, dir).multiply(G.q0);
    const mid = _a.add(_b).multiplyScalar(0.5);
    root.quaternion.copy(q);
    root.scale.setScalar(s);
    root.position.copy(mid).sub(G.localMid.clone().multiplyScalar(s).applyQuaternion(q));
  }
}

// ---------------------------------------------------------------------------
// Hand tracking: fists grab (like grip buttons), a fingertip pokes wrist-menu buttons, and a
// short click confirms presses (hands have no vibration).

let clickCtx = null;
/** A short click for button presses made with hands. */
function uiClick(freq = 1500) {
  try {
    clickCtx = clickCtx || new AudioContext();
    if (clickCtx.state === 'suspended') clickCtx.resume();
    const t = clickCtx.currentTime, o = clickCtx.createOscillator(), g = clickCtx.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    o.connect(g).connect(clickCtx.destination);
    o.start(t); o.stop(t + 0.06);
  } catch { /* no audio: presses still work */ }
}

const _tip = new THREE.Vector3();
function updateHands() {
  for (const h of hands) {
    if (!h.source || !h.source.hand) continue;
    const J = h.hand.joints || {};
    const joint = (name) => (J[name] && J[name].visible ? J[name].position : null);
    // Fist → grab. fistOverride lets automated tests stand in for a real fist.
    const changed = h.fistOverride !== undefined
      ? (h.fist !== h.fistOverride && ((h.fist = h.fistOverride), true))
      : updateFist(h, joint);
    if (changed) {
      if (h.fist) { grabbers.add(h); if (h.pendingPick !== undefined) h.fistDuringPinch = true; uiClick(700); }
      else grabbers.delete(h);
      beginGrab();
    }
    // Fingertip poke on the wrist menu (not with the hand wearing it).
    h.pokeHit = null;
    const tip = J['index-finger-tip'];
    if (!menu.mesh.parent || isMenuHolder(h) || !tip || !tip.visible) { if (h.poke.down) endPoke(h); continue; }
    tip.getWorldPosition(_tip);
    menu.mesh.worldToLocal(_tip);
    const { width, height } = menu.mesh.geometry.parameters;
    const p = pokePanel(h.poke, _tip, width, height);
    const hit = p.uv ? menu.hitTest(p.uv) : null;
    if (p.hover && hit && hit.id) h.pokeHit = hit.id;
    if (p.press && hit && hit.id) { h.pokeDown = hit.id; menu.press(hit); uiClick(); }
    else if (h.poke.down && h.pokeDown === 'timeline' && hit && hit.id === 'timeline') menu.press(hit); // slide to scrub
    if (p.release) endPoke(h);
  }
}
function endPoke(h) {
  h.poke.down = false;
  if (h.pokeDown) menu.release(h.pokeDown);
  h.pokeDown = null;
}
function isMenuHolder(h) {
  const parent = menu.mesh.parent;
  return parent === h.grip || (h.hand && parent && parent.parent === h.hand);
}

function pollGamepads(dt) {
  for (const h of hands) {
    const gp = h.source && h.source.gamepad;
    if (!gp || h.source.hand) continue;
    const pressed = gp.buttons.map((b) => b.pressed);
    const edge = (i) => pressed[i] && !h.prevButtons[i];
    const right = h.source.handedness !== 'left';
    if (edge(4)) setPlaying(!S.playing);                                   // A / X
    // B (right hand) steps one frame forward, Y (left hand) one back. Holding repeats, like a
    // keyboard key: after 0.4 s, about 8 frames per second.
    if (pressed[5] && S.traj) {
      const dir = right ? 1 : -1;
      if (edge(5)) { setPlaying(false); stepFrame(dir); h.stepHold = 0; }
      else {
        h.stepHold = (h.stepHold || 0) + dt;
        if (h.stepHold > 0.4) { stepFrame(dir); h.stepHold -= 0.125; }
      }
    }
    // xr-standard mapping: thumbstick on axes 2/3 (button 3); touchpad on axes 0/1 (button 2).
    // Controllers with only a touchpad (HTC Vive wands) use it as the stick, read only while touched
    // so a resting thumb does nothing; pressing the pad resets the view.
    // Profiles name the hardware: 'generic-trigger-squeeze-touchpad' (Vive wands) has no stick;
    // '...-thumbstick' variants (Quest, Index) do. Without profiles, fall back to the layout.
    const prof = h.source.profiles || [];
    const touchpadOnly = prof.some((p) => p.includes('touchpad')) && !prof.some((p) => p.includes('thumbstick'));
    const hasStick = !touchpadOnly && gp.axes.length >= 4 && gp.buttons.length > 3;
    if (edge(hasStick ? 3 : 2)) resetView();                               // stick / pad click
    const padOn = !hasStick && gp.buttons[2] && gp.buttons[2].touched;
    const ax = hasStick ? gp.axes[2] || 0 : padOn ? gp.axes[0] || 0 : 0;
    const ay = hasStick ? gp.axes[3] || 0 : padOn ? gp.axes[1] || 0 : 0;
    if (right && S.traj) {
      if (Math.abs(ax) > 0.25) {
        setPlaying(false);
        const nf = S.traj.frames.length;
        // Quadratic response: gentle near the center for single frames, fast at full tilt.
        S.frameF = THREE.MathUtils.clamp(S.frameF + Math.sign(ax) * ax * ax * dt * 30, 0, nf - 1);
        S.dirty = true;
      }
      if (Math.abs(ay) > 0.5) {
        S.fps = THREE.MathUtils.clamp(S.fps - ay * dt * 15, 1, 60);
        $('fps').value = String(Math.round(S.fps));
      }
    } else if (!right) {
      const flick = ax > 0.7 ? 1 : ax < -0.7 ? -1 : 0;
      const C = COLORINGS();
      if (flick && !h.flicked) setColorBy(C[(C.indexOf(S.colorBy) + flick + C.length) % C.length]);
      // Up/down: next/previous lesson stop if there are any, else cycle the water display.
      const flickY = ay > 0.7 ? 1 : ay < -0.7 ? -1 : 0;
      if (flickY && !h.flicked && S.traj) {
        if (S.stops.length && S.mode !== 'explore') gotoStop(-flickY); // stick up (negative y) = next
        else { const M = waterModes(); setWater(M[(M.indexOf(S.waterMode) + 1) % M.length]); }
      }
      h.flicked = flick !== 0 || flickY !== 0;
    }
    h.prevButtons = pressed;
  }
}

// Wrist menu: on the left controller (or the only one). Point at it with the other hand's ray.
const menu = (() => {
  const W = 800, H = 980;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2 * H / W),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide })); // rays from either side
  mesh.position.set(0, 0.125, 0.03); // just above the controller; turned to face the head every frame (faceHead)
  const TL = { x: 30, y: 160, w: 740, h: 46 };
  const INFO = { x: 30, y: 228, w: 740, h: 212 }; // measurement plot, or the lesson caption
  const nextIn = (list, cur) => list[(list.indexOf(cur) + 1) % list.length];
  const WATER_LABEL = { all: 'water: all', near: 'water: near', hide: 'water: off' };
  const HB_LABEL = { off: 'H-bonds: off', solute: 'H-bonds: solute', all: 'H-bonds: all' };
  // Layout (canvas px): transport row, Explore/Lesson switch, then a 2x4 grid whose buttons
  // depend on the mode. `modes` limits a button to one mode.
  const ROW = (k) => ({ x: 30 + (k % 4) * 188, w: 176 });
  const TRANSPORT = [['back', () => '◀  step'], ['play', () => (S.playing ? '❚❚  pause' : '▶  play')],
    ['fwd', () => 'step  ▶'], ['reset', () => 'reset view']]
    .map(([id, label], k) => ({ id, label, ...ROW(k), y: 456, h: 80 }));
  const MODES = [['modeExplore', () => 'Explore'], ['modeWatch', () => `Watch${S.stops.length ? ` (${S.stops.length})` : ''}`],
    ['modeCreate', () => 'Create']]
    .map(([id, label], k) => ({ id, label, x: 30 + k * 182, w: 182, y: 548, h: 56, seg: true }));
  // The mode switch shares its row with the detail button (and, in AR, the passthrough toggle).
  const SHORT = ['high', 'med', 'low'];
  const detailLabel = () => (S.detail === 'auto' ? `auto: ${SHORT[S.level]}` : `detail: ${SHORT[S.level]}`);
  const MODES_VR = [...MODES, { id: 'detail', label: detailLabel, x: 582, w: 188, y: 548, h: 56 }];
  const MODES_AR = [...MODES.map((b, k) => ({ ...b, x: 30 + k * 148, w: 148 })),
    { id: 'detail', label: detailLabel, x: 478, w: 142, y: 548, h: 56 },
    { id: 'passthrough', label: () => (S.passthrough ? 'room: on' : 'room: off'), x: 626, w: 144, y: 548, h: 56 }];
  const GRID = {
    explore: [['style', () => REP_NAMES[S.rep]], ['color', () => `by ${colorName(S.colorBy)}`],
      ['water', () => WATER_LABEL[S.waterMode]], ['hb', () => HB_LABEL[S.hbonds]],
      ['paths', () => (S.showPaths ? 'paths: on' : 'paths: off')],
      ['arrows', () => (S.arrows ? `arrows: ${S.arrows}` : 'arrows: off')],
      ['smaller', () => 'atoms −'], ['bigger', () => 'atoms +']],
    watch: [['prevStop', () => '◀  stop'], ['nextStop', () => 'stop  ▶'], ['firstStop', () => '⏮  restart'],
      ['pauseStops', () => ($('pauseAtStops').checked ? 'pause at stops' : 'no pausing')],
      ['style', () => REP_NAMES[S.rep]], ['color', () => `by ${colorName(S.colorBy)}`],
      ['water', () => WATER_LABEL[S.waterMode]], ['hb', () => HB_LABEL[S.hbonds]]],
    create: [['prevStop', () => '◀  stop'], ['nextStop', () => 'stop  ▶'],
      ['addStop', () => '＋ add stop'], ['updStop', () => '⟳ update stop'],
      ['style', () => REP_NAMES[S.rep]], ['color', () => `by ${colorName(S.colorBy)}`],
      ['water', () => WATER_LABEL[S.waterMode]], ['hb', () => HB_LABEL[S.hbonds]]],
  };
  const grid = (mode) => GRID[mode].map(([id, label], k) =>
    ({ id, label, ...ROW(k), y: 616 + Math.floor(k / 4) * 96, h: 84 }));
  const GRIDS = { explore: grid('explore'), watch: grid('watch'), create: grid('create') };
  // Third row: voice. Watch hears clips; Create records them (hold "talk" while speaking) and
  // deletes stops. Explore has no lesson tools.
  const HEAR = ['hear', () => (S.voicePlaying >= 0 ? '■ stop voice' : '▶ hear stop')];
  const row3 = (items) => items.map(([id, label], k) => ({ id, label, ...ROW(k), y: 808, h: 84 }));
  const ROW3 = {
    explore: [],
    watch: row3([HEAR, ['waitVoice', () => ($('waitVoice').checked ? 'wait for voice' : "don't wait")]]),
    create: row3([['rec', () => (voice.rec.recording ? `■ ${fmtDur(S.recTick)} release` : '● hold to talk')], HEAR,
      ['delStop', () => (voice.deleteArmed ? 'press again' : '✕ delete stop')]]),
  };
  const student = () => document.body.classList.contains('student');
  const visibleButtons = () => [...TRANSPORT, ...(arSession ? MODES_AR : MODES_VR), ...GRIDS[S.mode], ...ROW3[S.mode]];
  let infoShowsPlot = false; // the info panel currently shows the measurement plot (it scrubs)
  /** Sets a page control and fires its handler, so desktop and VR stay in sync. */
  const nudge = (id, d) => {
    const el = $(id);
    el.value = String(THREE.MathUtils.clamp(+el.value + d, +el.min, +el.max));
    el.dispatchEvent(new Event('input'));
  };
  const enabled = (id) => {
    if (id === 'reset' || id === 'modeExplore' || id === 'passthrough' || id === 'detail' || id === 'waitVoice') return true;
    if (id === 'modeWatch') return S.stops.length > 0;
    if (id === 'modeCreate') return !student();
    if (!S.traj) return false;
    if (id === 'rec') return voice.rec.supported && S.mode === 'create';
    if (id === 'addStop') return S.mode === 'create' && !S.stops.some((st) => st.f === Math.floor(S.frameF));
    if (id === 'updStop') return S.mode === 'create' && stopIndexHere() >= 0;
    if (id === 'hear') { const k = stopIndexHere(); return S.voicePlaying >= 0 || (k >= 0 && !!S.stops[k].voice); }
    if (id === 'delStop') return S.mode === 'create' && stopIndexHere() >= 0;
    if (id === 'water') return !$('water').disabled;
    if (id === 'hb') return !$('hbonds').disabled;
    if (id === 'arrows') return S.families.length > 0;
    if (id === 'prevStop' || id === 'nextStop' || id === 'firstStop') return S.stops.length > 0;
    if (id === 'smaller') return S.atomScale > +$('atomScale').min + 1e-6;
    if (id === 'bigger') return S.atomScale < +$('atomScale').max - 1e-6;
    return true;
  };
  let hover = new Set();
  let last = '';

  function hitTest(uv) {
    const x = uv.x * W, y = (1 - uv.y) * H;
    if (y >= TL.y - 16 && y <= TL.y + TL.h + 16 && x >= TL.x - 12 && x <= TL.x + TL.w + 12) {
      return { id: 'timeline', frac: THREE.MathUtils.clamp((x - TL.x) / TL.w, 0, 1) };
    }
    if (infoShowsPlot && y >= INFO.y && y <= INFO.y + INFO.h && x >= INFO.x && x <= INFO.x + INFO.w) {
      return { id: 'timeline', frac: THREE.MathUtils.clamp((x - INFO.x) / INFO.w, 0, 1) }; // the plot scrubs too
    }
    for (const b of visibleButtons()) if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return { id: b.id };
    return { id: null }; // on the panel, but not on a control
  }

  function press(hit) {
    if (hit.id === 'reset') { resetView(); return; }
    if (hit.id === 'modeExplore') { setMode('explore'); return; }
    if (hit.id === 'modeWatch') { if (enabled('modeWatch')) setMode('watch'); return; }
    if (hit.id === 'modeCreate') { if (enabled('modeCreate')) setMode('create'); return; }
    if (hit.id === 'passthrough') { setPassthrough(!S.passthrough); return; }
    if (hit.id === 'waitVoice') { $('waitVoice').checked = !$('waitVoice').checked; return; }
    if (hit.id === 'detail') { setDetail(DETAILS[(DETAILS.indexOf(S.detail) + 1) % DETAILS.length]); vrNote(''); return; }
    if (!S.traj || (hit.id !== 'timeline' && !enabled(hit.id))) return;
    switch (hit.id) {
      case 'timeline':
        setPlaying(false);
        S.frameF = Math.round(hit.frac * (S.traj.frames.length - 1));
        S.dirty = true;
        break;
      case 'back': setPlaying(false); stepFrame(-1); break;
      case 'fwd': setPlaying(false); stepFrame(1); break;
      case 'play': setPlaying(!S.playing); break;
      case 'style': setRep(nextIn(REPS, S.rep)); break;
      case 'color': setColorBy(nextIn(COLORINGS(), S.colorBy)); break;
      case 'water': setWater(nextIn(waterModes(), S.waterMode)); break;
      case 'paths': setShowPaths(!S.showPaths); break;
      case 'hb': setHBonds(nextIn(HB_MODES, S.hbonds)); break;
      case 'arrows': setArrows(nextIn(['', ...S.families.map((f) => f.name)], S.arrows)); break;
      case 'prevStop': gotoStop(-1); break;
      case 'nextStop': gotoStop(1); break;
      case 'firstStop': applyStop(0); playVoice(0); break;
      case 'rec': startVoice(); break;
      case 'hear': if (S.voicePlaying >= 0) stopVoice(); else playVoice(stopIndexHere()); break;
      case 'addStop': addStop(captureStop('')); vrNote(`Stop ${S.activeStop + 1} added at frame ${Math.floor(S.frameF) + 1}: hold to talk to give it a voice`); break;
      case 'updStop': {
        const k = stopIndexHere(), old = S.stops[k];
        const st = captureStop(old.cap || '');
        if (old.voice) st.voice = old.voice;
        S.stops.splice(k, 1); addStop(st);
        vrNote(`Stop ${S.activeStop + 1} updated to this view`);
        break;
      }
      case 'delStop': deleteStopHere(); break;
      case 'pauseStops': $('pauseAtStops').checked = !$('pauseAtStops').checked; break;
      case 'smaller': nudge('atomScale', -0.1); break;
      case 'bigger': nudge('atomScale', 0.1); break;
    }
  }

  /** Word-wrap `text` into at most `maxLines` lines of width `w`. */
  function wrap(text, w, maxLines) {
    const words = text.split(/\s+/);
    const lines = [];
    let line = '';
    for (const word of words) {
      const t = line ? `${line} ${word}` : word;
      if (ctx.measureText(t).width > w && line) { lines.push(line); line = word; } else line = t;
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = clip(ctx, lines[maxLines - 1] + ' …', w); }
    return lines;
  }

  function draw() {
    const f = S.traj ? Math.floor(S.frameF) : 0;
    const nf = S.traj ? S.traj.frames.length : 1;
    const step = S.traj ? S.traj.frames[f].timestep : 0;
    const tm = simTime(step);
    const sel = !S.traj ? '' : S.sel.length > 1 ? measurementText()
      : S.sel.length ? `selected ${S.elements[S.sel[0]]}${S.traj.ids[S.sel[0]]} · trigger more atoms to measure` : 'trigger an atom to inspect it';
    const stop = S.stops[S.activeStop];
    const key = [S.name, f, nf, S.playing, Math.round(S.fps), S.rep, S.colorBy, S.waterMode, S.showPaths, S.hbonds,
      S.arrows, S.hbCount, sel, tm, S.activeStop, stop && stop.cap, S.stops.length, !!S.series,
      [...hover].join(), $('water').disabled, S.mode, S.atomScale, $('pauseAtStops').checked, arSession, S.passthrough, S.detail, S.level, S.vrNote,
      voice.rec.recording, S.recTick, S.voicePlaying, voice.deleteArmed, $('waitVoice').checked, stop && stop.voice && stop.voice.dur,
      inputKind()].join('|');
    if (key === last) return;
    last = key;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(13,17,23,0.92)';
    ctx.beginPath(); ctx.roundRect(4, 4, W - 8, H - 8, 26); ctx.fill();
    ctx.strokeStyle = '#30363d'; ctx.lineWidth = 3; ctx.stroke();

    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#e6edf3';
    ctx.font = 'bold 34px system-ui, sans-serif';
    ctx.fillText(clip(ctx, S.traj ? S.name : 'No trajectory loaded', W - 60), 30, 56);
    ctx.font = '28px system-ui, sans-serif';
    ctx.fillStyle = '#c9d1d9';
    const status = S.traj
      ? `${S.playing ? '▶ playing' : '❚❚ paused'} · ${Math.round(S.fps)} fps · frame ${f + 1}/${nf}${tm ? ' · ' + tm : ` · step ${step}`}`
      : 'Take off the headset and load a file on the page.';
    ctx.fillText(clip(ctx, status, W - 60), 30, 98);
    ctx.fillStyle = S.vrNote ? '#f0b429' : '#ffff66';
    ctx.font = '26px system-ui, sans-serif';
    ctx.fillText(clip(ctx, S.vrNote || sel, W - 60), 30, 138);

    // Timeline: track, progress, stop ticks, playhead
    const tHover = hover.has('timeline');
    ctx.fillStyle = tHover ? '#2d333b' : '#21262d';
    ctx.beginPath(); ctx.roundRect(TL.x, TL.y, TL.w, TL.h, 23); ctx.fill();
    const fr = nf > 1 ? f / (nf - 1) : 0;
    const headX = TL.x + TL.h / 2 + (TL.w - TL.h) * fr;
    ctx.fillStyle = '#1f6feb';
    ctx.beginPath(); ctx.roundRect(TL.x, TL.y, headX - TL.x + TL.h / 2, TL.h, 23); ctx.fill();
    ctx.fillStyle = '#ffc94d';
    for (const st of S.stops) {
      const x = TL.x + TL.h / 2 + (TL.w - TL.h) * (nf > 1 ? st.f / (nf - 1) : 0);
      ctx.fillRect(x - 2, TL.y + 4, 4, TL.h - 8);
    }
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(headX, TL.y + TL.h / 2, tHover ? 20 : 16, 0, Math.PI * 2); ctx.fill();

    // Info area: lesson caption takes priority, then the measurement plot, then a hint.
    infoShowsPlot = false;
    if (S.mode !== 'explore' && stop && (stop.cap || stop.voice || S.mode === 'create')) {
      ctx.fillStyle = '#10243d';
      ctx.beginPath(); ctx.roundRect(INFO.x, INFO.y, INFO.w, INFO.h, 14); ctx.fill();
      ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#8b949e'; ctx.font = '20px system-ui, sans-serif';
      ctx.fillText(`${S.mode === 'create' ? 'editing stop' : 'stop'} ${S.activeStop + 1} of ${S.stops.length}${stop.voice ? ` · voice ${fmtDur(stop.voice.dur)}` : ''}`, INFO.x + 16, INFO.y + 26);
      const capText = stop.cap || (S.voicePlaying === S.activeStop ? 'Playing the voice note…'
        : stop.voice ? 'Voice note: press ▶ hear stop to listen.' : 'No caption or voice yet: hold to talk to record one.');
      ctx.fillStyle = '#e6edf3';
      // Largest font at which the whole caption fits (5-7 lines); the last size clips if it must.
      for (const [px, lh] of [[26, 31], [23, 27], [20, 24]]) {
        ctx.font = `${px}px system-ui, sans-serif`;
        const maxLines = Math.floor((INFO.h - 46) / lh);
        const lines = wrap(capText, INFO.w - 32, 99);
        if (lines.length <= maxLines || px === 20) {
          wrap(capText, INFO.w - 32, maxLines).forEach((l, k) => ctx.fillText(l, INFO.x + 16, INFO.y + 62 + lh * k));
          break;
        }
      }
    } else if (S.series) {
      infoShowsPlot = true;
      plotSeries(ctx, INFO.x, INFO.y, INFO.w, INFO.h, true);
    } else {
      ctx.fillStyle = '#8b949e'; ctx.font = '22px system-ui, sans-serif';
      const hint = !S.traj ? '' : S.mode === 'watch'
        ? (S.stops.length ? 'press stop ▶ or play to start the lesson' : 'no lesson in this file: use Explore or Create')
        : S.mode === 'create' ? 'creating: find a moment, then ＋ add stop or hold to talk'
        : S.hbonds !== 'off' ? `${S.hbCount || 0} hydrogen bonds shown` : 'trigger 2–4 atoms to plot a distance or angle over time';
      ctx.fillText(clip(ctx, hint, INFO.w - 20), INFO.x + 4, INFO.y + 60);
    }

    // Buttons
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const b of visibleButtons()) {
      const on = enabled(b.id);
      const hv = hover.has(b.id) && on;
      const active = (b.id === 'play' && S.playing) || (b.id === 'water' && S.waterMode !== 'all') ||
        (b.id === 'paths' && S.showPaths) || (b.id === 'hb' && S.hbonds !== 'off') || (b.id === 'arrows' && !!S.arrows) ||
        (b.id === 'pauseStops' && $('pauseAtStops').checked) || (b.id === 'passthrough' && S.passthrough) ||
        (b.id === 'waitVoice' && $('waitVoice').checked) || (b.id === 'hear' && S.voicePlaying >= 0) ||
        (b.id === 'modeExplore' && S.mode === 'explore') || (b.id === 'modeWatch' && S.mode === 'watch') ||
        (b.id === 'modeCreate' && S.mode === 'create');
      ctx.fillStyle = b.id === 'rec' && voice.rec.recording ? '#a40e26'
        : b.id === 'modeCreate' && S.mode === 'create' ? '#5a3d0c'
        : hv ? '#1f6feb' : active ? (b.seg ? '#2b5a91' : '#1c3a5e') : (b.seg ? '#161b22' : '#21262d');
      ctx.beginPath(); ctx.roundRect(b.x, b.y, b.w, b.h, b.seg ? 12 : 16); ctx.fill();
      ctx.strokeStyle = hv ? '#58a6ff' : '#30363d'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = on ? '#e6edf3' : '#484f58';
      const text = b.label();
      ctx.font = b.seg ? `${active ? 'bold ' : ''}26px system-ui, sans-serif` : '25px system-ui, sans-serif';
      if (ctx.measureText(text).width > b.w - 14) ctx.font = '21px system-ui, sans-serif'; // shrink long labels first
      ctx.fillText(clip(ctx, text, b.w - 14), b.x + b.w / 2, b.y + b.h / 2 + 1);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#8b949e';
    ctx.font = '23px system-ui, sans-serif';
    const [hint1, hint2] = INPUT_HINTS[inputKind()];
    ctx.fillText(hint1, 30, 924);
    ctx.fillText(hint2, 30, 958);
    tex.needsUpdate = true;
  }

  const _head = new THREE.Vector3();
  function faceHead() {
    if (!mesh.parent) return;
    renderer.xr.getCamera().getWorldPosition(_head);
    mesh.parent.updateWorldMatrix(true, false);
    mesh.lookAt(_head); // +Z (the readable side) toward the eyes, whatever the wrist angle
  }

  /** What is in the user's hands, for the hint lines at the bottom. */
  function inputKind() {
    const src = hands.map((h) => h.source).filter(Boolean);
    if (src.some((x) => x.hand)) return 'hands';
    if (src.some((x) => (x.profiles || []).some((p) => p.includes('touchpad')) && !(x.profiles || []).some((p) => p.includes('thumbstick')))) return 'touchpad';
    return 'sticks';
  }
  const INPUT_HINTS = {
    sticks: ['grip: grab & move · both grips: scale/rotate · trigger: pick atoms',
      'A/X play · B frame ▶ · Y frame ◀ · R stick: scrub · click: reset'],
    touchpad: ['grip: grab & move · both grips: scale/rotate · trigger: pick atoms',
      'R trackpad: touch to scrub, press to reset · play and stops: this menu'],
    hands: ['pinch: pick atoms and press buttons · fist: grab · two fists: scale/turn',
      'or poke a button with your fingertip · play, step and stops: this menu'],
  };
  /** Trigger released while it was held on a button (hold-to-talk ends here). */
  function release(id) { if (id === 'rec') finishVoice(); }
  return { mesh, canvas, hitTest, press, release, draw, faceHead, setHover(ids) { hover = new Set(ids); } };
})();

function placeWristPanel() {
  const live = hands.filter((h) => h.source);
  const target = live.find((h) => h.source.handedness === 'left') || live[0];
  if (!target) { if (menu.mesh.parent) menu.mesh.parent.remove(menu.mesh); return; }
  // A tracked hand wears the menu on its wrist joint; a controller on its grip.
  const wrist = target.source.hand && target.hand.joints && target.hand.joints.wrist;
  const parent = wrist || target.grip;
  if (menu.mesh.parent !== parent) parent.add(menu.mesh);
}

renderer.xr.addEventListener('sessionstart', () => {
  label.setWidth(0.16); grabbers.clear(); S.needPlace = true;
  S.autoLevel = autoLevel();
  perf.slow = 0; perf.ema = 0; perf.cool = 2; // the first seconds (controller models loading) don't count
  refreshLevel();
});
renderer.xr.addEventListener('sessionend', () => {
  label.setWidth(0.26); grabbers.clear(); S.vrNote = ''; refreshLevel(); resetView();
  if (voice.rec.recording || voice.busy) finishVoice(); // the clip is kept if long enough
  if (voice.resume) stopVoice();
});

// ---------------------------------------------------------------------------
// Detail levels: keep VR smooth on big systems. They only change how things are drawn, never
// what is computed (H-bond and shell results are the same at every level).
//   High   : as before (sphere detail by system size, smooth in-between frames).
//   Medium : low-poly spheres and bonds; in VR, playback moves atoms on whole data frames only;
//            hover picking every 2nd frame.
//   Low    : Medium, plus each water molecule drawn as one bead; picking every 3rd frame.
// 'auto' uses High on the desktop. In VR it starts from the number of drawn atoms and the device,
// then steps down by itself (with a note on the wrist menu) if frames keep arriving late.

const DETAIL_NAMES = ['high', 'medium', 'low'];
const DETAILS = ['auto', 'high', 'medium', 'low'];
const perf = { ema: 0, slow: 0, cool: 0, noteUntil: 0 };

/** Starting level for a VR session in auto mode. */
function autoLevel() {
  if (!S.traj) return 0;
  let v = 0;
  for (let i = 0; i < S.traj.n; i++) v += S.visible[i];
  const standalone = /OculusBrowser|Quest|Pico|Wolvic/.test(navigator.userAgent);
  const [medium, low] = standalone ? [6000, 20000] : [30000, 80000];
  return v > low ? 2 : v > medium ? 1 : 0;
}
function effectiveLevel() {
  if (S.detail !== 'auto') return DETAIL_NAMES.indexOf(S.detail);
  return renderer.xr.isPresenting ? S.autoLevel : 0;
}
function refreshLevel() {
  const lv = effectiveLevel();
  if (lv === S.level) return;
  S.level = lv;
  if (S.traj) buildMeshes(); // new sphere/bond geometry; draw lists are rebuilt on the next frame
  S.dirty = true;
}
function setDetail(d) {
  S.detail = DETAILS.includes(d) ? d : 'auto';
  $('detail').value = S.detail;
  saveSettings();
  refreshLevel();
}
function smoothNow() { return S.smooth && !(renderer.xr.isPresenting && S.level >= 1); }
function vrNote(text) { S.vrNote = text; perf.noteUntil = performance.now() + 6000; }

refreshLevel(); // a level chosen last time applies now (Auto stays High on the desktop)

/** In auto mode, steps detail down when VR frames keep missing the headset's frame rate. */
function watchFrameRate(raw) {
  if (S.vrNote && performance.now() > perf.noteUntil) S.vrNote = '';
  if (S.detail !== 'auto' || !S.traj || S.autoLevel >= 2) return;
  if (perf.cool > 0) { perf.cool -= raw; return; }
  const target = 1 / ((xrSession && xrSession.frameRate) || 72);
  perf.ema = perf.ema ? perf.ema * 0.9 + raw * 0.1 : raw;
  perf.slow = perf.ema > target * 1.3 ? perf.slow + raw : Math.max(0, perf.slow - raw);
  if (perf.slow > 2) { // about 2 s of late frames
    S.autoLevel++;
    refreshLevel();
    perf.slow = 0; perf.ema = 0; perf.cool = 3; // let the new level settle before judging again
    vrNote(`Detail lowered to ${DETAIL_NAMES[S.level]} to keep VR smooth (menu: detail)`);
  }
}

// ---------------------------------------------------------------------------
// Loop

const clock = new THREE.Clock();
renderer.setAnimationLoop((time, frame) => {
  const raw = clock.getDelta();
  const dt = Math.min(raw, 0.1);
  if (renderer.xr.isPresenting) {
    xrFrames++;
    watchFrameRate(raw);
    if (xrFrames === 1) xrLog('first VR frame');
    else if (xrFrames === 90) { xrLog('running (90 frames)', { ok: true }); $('xrNote')?.remove(); }
    if (S.needPlace && placeInFrontOfHead(frame)) { S.needPlace = false; if (xrFrames < 90) xrLog('placed'); }
    if (xrFrames % 30 === 0) placeWristPanel(); // hand joints appear after 'connected'
    updateHands();
    pollGamepads(dt);
    updateGrab();
    menu.faceHead();
    menu.draw();
  } else {
    controls.update();
  }
  if (S.traj) {
    if (S.playing) {
      const nf = S.traj.frames.length;
      const before = Math.floor(S.frameF);
      S.frameF += dt * S.fps;
      if (S.frameF >= nf) { S.frameF = 0; S.looped = true; } // the last frame gets its turn too
      // Without in-between frames, only a new data frame needs new geometry.
      if (smoothNow() || Math.floor(S.frameF) !== before) S.dirty = true;
    }
    if (S.dirty) { updatePositions(); S.dirty = false; }
    else if (S.sel.length) updateLabelPosition(); // root may have been grabbed
  }
  if (renderer.xr.isPresenting) updateHover();
  renderer.render(scene, camera);
  if (screenshotRequested && !renderer.xr.isPresenting) saveScreenshot();
});

// Auto-load the sample when opened with ?sample
// ?sample, or ?traj=<url>&data=<url>&map=1:C+2:H&stride=N&fs=2 to open a trajectory from a link.
// Display settings: rep, color, water=all|near|hide, shell=Å, hb=off|solute|all, arrows=v|f|...
// Lessons: stops=<base64url JSON>. student hides the loading and expert controls.
async function loadFromParams() {
  if (params.has('student')) document.body.classList.add('student');
  if (params.get('map')) $('typeMap').value = params.get('map');
  if (params.get('stride')) $('stride').value = params.get('stride');
  if (params.get('fs')) { S.fsPerStep = +params.get('fs') || 0; $('fsPerStep').value = params.get('fs'); }
  if (params.get('shell')) { S.shellR = THREE.MathUtils.clamp(+params.get('shell') || 4, 1, 15); $('shellR').value = String(S.shellR); }
  if (params.get('stops')) {
    try { S.stops = b64dec(params.get('stops')).filter((s) => Number.isInteger(s.f)).sort((a, b) => a.f - b.f); renderStops(); setMode('watch'); }
    catch { setStatus('Could not read the lesson stops in this link.'); }
  }
  const applyViewParams = () => {
    if (params.get('rep')) setRep(params.get('rep'));
    if (params.get('color')) setColorBy(params.get('color'));
    if (params.get('water')) setWater(params.get('water'));
    if (params.get('hb')) setHBonds(params.get('hb'));
    if (params.get('arrows')) setArrows(params.get('arrows'));
    if (S.stops.length && S.traj) { S.lastFrameInt = -1; S.dirty = true; } // show a caption at frame 0
  };
  const lessonFromLink = async () => {
    if (!params.get('lesson')) return;
    try {
      const r = await fetch(params.get('lesson'));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      applyLesson(parseLesson(await r.text()), decodeURIComponent(params.get('lesson').split('/').pop()));
      source.lesson = params.get('lesson');
    } catch (err) { setStatus(`Could not open the lesson file in this link (${err.message}).`); }
  };
  if (params.has('sample')) { await loadSample(); applyViewParams(); await lessonFromLink(); return; }
  const urls = ['traj', 'data'].map((k) => params.get(k)).filter(Boolean);
  if (!urls.length) return;
  try {
    setStatus(`Downloading ${urls.join(', ')}…`);
    const files = await Promise.all(urls.map(async (u) => {
      const r = await fetch(u.replace(/#/g, '%23')); // a '#' in a file name is not a fragment
      if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
      const name = decodeURIComponent(new URL(u, location.href).pathname.split('/').pop()) || 'trajectory';
      return new File([await r.blob()], name);
    }));
    await loadFiles(files);
    applyViewParams();
    await lessonFromLink();
  } catch (err) {
    setStatus(`Could not open the linked files (${err.message}).`);
  }
}
loadFromParams();

// For debugging in the console.
window.viewer = {
  S, select, resetView, menu, hands, updatePositions, renderer, setDetail, voice, measurementText, root,
  /** Screen position (CSS px) of atom i, for automated tests. */
  screenOf(i) {
    const v = new THREE.Vector3().fromArray(S.cur, 3 * i);
    model.localToWorld(v).project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
  },
};
