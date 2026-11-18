// Service worker: lets the viewer run offline once installed (e.g. as an app on a Quest 3).
//
// - The app's own files are always served together from one cached set, so the page and its
//   modules can never come from two different versions (a mix breaks the module imports).
// - Each time the app opens, the whole set is re-downloaded in the background (revalidated
//   against the server, so unchanged files cost little). Only if every app file arrives does
//   the new set replace the old one; the page is then told so and offers "Reload".
// - three.js, its addons and the Quest controller models come from pinned CDN URLs that never
//   change, so they are served cache-first.
// - Trajectories the user opens from the device never touch the network or this cache.
//
// Bump VERSION when the file lists change; old caches are deleted on activation.

const VERSION = 'md-vr-v5';
const THREE = 'https://cdn.jsdelivr.net/npm/three@0.169.0/';
const PROFILES = 'https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/';

const APP = [
  './', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'src/main.js', 'src/parse-worker.js', 'src/lammps.js', 'src/model.js', 'src/analysis.js',
  'src/chem.js', 'src/props.js', 'src/elements.js', 'src/voice.js', 'src/gestures.js',
];
// Optional: a hosted copy may leave the sample out (tools/build_site.py --no-sample).
const OPTIONAL = ['samples/sample.lesson.json', 'samples/caffeine_water.lammpstrj.gz'];
const CDN = [
  THREE + 'build/three.module.js',
  THREE + 'examples/jsm/controls/OrbitControls.js',
  THREE + 'examples/jsm/webxr/XRControllerModelFactory.js',
  THREE + 'examples/jsm/loaders/GLTFLoader.js',
  THREE + 'examples/jsm/utils/BufferGeometryUtils.js',
  THREE + 'examples/jsm/libs/motion-controllers.module.js',
  THREE + 'examples/jsm/webxr/XRHandModelFactory.js',
  THREE + 'examples/jsm/webxr/XRHandMeshModel.js',
  THREE + 'examples/jsm/webxr/XRHandPrimitiveModel.js',
  // Quest 3 (Touch Plus) controller models, plus the generic fallback profile.
  PROFILES + 'profilesList.json',
  PROFILES + 'meta-quest-touch-plus/profile.json',
  PROFILES + 'meta-quest-touch-plus/left.glb',
  PROFILES + 'meta-quest-touch-plus/right.glb',
  PROFILES + 'generic-trigger-squeeze-thumbstick/profile.json',
  // Tracked hands
  PROFILES + 'generic-hand/left.glb',
  PROFILES + 'generic-hand/right.glb',
];
const abs = (p) => new URL(p, self.registration.scope).href;
const appURLs = new Set([...APP, ...OPTIONAL].map(abs));
const PAGE = abs('./');

/** Fetches from the server, bypassing the browser's HTTP cache (revalidates with ETags). */
const fresh = (u) => fetch(u, { cache: 'no-cache', mode: 'cors' }).then((r) => {
  if (!r.ok || r.status !== 200) throw new Error(`${u}: HTTP ${r.status}`);
  return r;
});

/**
 * Downloads a complete set of app files. Returns the responses only if every required file
 * arrived (optional ones may be missing); otherwise null, and the cached set stays as it is.
 */
async function downloadSet() {
  const got = await Promise.all([...APP.map((p) => [abs(p), true]), ...OPTIONAL.map((p) => [abs(p), false])]
    .map(async ([u, required]) => {
      try { return [u, await fresh(u)]; } catch { return required ? null : [u, undefined]; }
    }));
  if (got.some((x) => x === null)) return null;
  return got.filter(([, r]) => r);
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const set = await downloadSet();
    if (!set) throw new Error('could not download the app files'); // try again next visit
    const cache = await caches.open(VERSION);
    for (const [u, r] of set) await cache.put(u, r);
    await Promise.allSettled(CDN.map(async (u) => { const r = await fetch(u, { mode: 'cors' }); if (r.ok) await cache.put(u, r); }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

/** Background update of the whole app set, at most once a minute. */
let lastCheck = 0;
async function updateSet() {
  if (Date.now() - lastCheck < 60000) return;
  lastCheck = Date.now();
  const set = await downloadSet();
  if (!set) return; // offline or incomplete: keep the current set
  const cache = await caches.open(VERSION);
  // Did anything change? Compare the page and the main module.
  let changed = false;
  for (const u of [PAGE, abs('src/main.js'), abs('src/voice.js')]) {
    const [old, neu] = [await cache.match(u), set.find(([x]) => x === u)];
    if (!old || !neu) { changed = true; break; }
    if (await old.clone().text() !== await neu[1].clone().text()) { changed = true; break; }
  }
  for (const [u, r] of set) await cache.put(u, r);
  if (changed) for (const c of await self.clients.matchAll()) c.postMessage('md-vr-updated');
}

// The page asks once it has loaded all its files (and when an installed app is resumed), so
// an update never lands while a page is still fetching its modules.
self.addEventListener('message', (e) => {
  if (e.data === 'md-vr-check-update') e.waitUntil(updateSet().catch(() => {}));
});

/** The cached copy; the network only if this file was never cached. */
async function fromSet(req, key) {
  const hit = await (await caches.open(VERSION)).match(key);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok && r.status === 200) await (await caches.open(VERSION)).put(key, r.clone());
  return r;
}

/** Cache first (immutable, version-pinned CDN files). */
async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok && r.status === 200) await cache.put(req.url, r.clone());
  return r;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.href.startsWith(THREE) || url.href.startsWith(PROFILES)) { e.respondWith(cacheFirst(req)); return; }
  if (url.origin !== self.location.origin) return;
  // Any page address (?sample, share links with ?traj=…) is the same app page.
  if (req.mode === 'navigate') { e.respondWith(fromSet(req, PAGE)); return; }
  const key = url.origin + url.pathname;
  if (appURLs.has(key)) e.respondWith(fromSet(req, key));
  // Anything else on the same server (e.g. trajectories behind share links) goes straight to
  // the network, so big files don't fill the cache.
});
