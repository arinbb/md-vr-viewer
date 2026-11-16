// Service worker: lets the viewer run offline once installed (e.g. as an app on a Quest 3).
//
// - The app's own files are fetched network-first (so a new version is picked up as soon as
//   the headset is online) with the cached copy as the fallback when offline or slow.
// - three.js, its addons and the Quest controller models come from pinned CDN URLs that never
//   change, so they are served cache-first.
// - Trajectories the user opens from the device never touch the network or this cache.
//
// Bump VERSION when the list below changes; old caches are deleted on activation.

const VERSION = 'md-vr-v1';
const THREE = 'https://cdn.jsdelivr.net/npm/three@0.169.0/';
const PROFILES = 'https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/';

const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'src/main.js', 'src/parse-worker.js', 'src/lammps.js', 'src/model.js', 'src/analysis.js',
  'src/chem.js', 'src/props.js', 'src/elements.js',
  // The sample is optional: a hosted copy may leave it out (tools/build_site.py --no-sample).
  'samples/sample.lesson.json', 'samples/caffeine_water.lammpstrj.gz',
];
const CDN = [
  THREE + 'build/three.module.js',
  THREE + 'examples/jsm/controls/OrbitControls.js',
  THREE + 'examples/jsm/webxr/XRControllerModelFactory.js',
  THREE + 'examples/jsm/loaders/GLTFLoader.js',
  THREE + 'examples/jsm/utils/BufferGeometryUtils.js',
  THREE + 'examples/jsm/libs/motion-controllers.module.js',
  // Quest 3 (Touch Plus) controller models, plus the generic fallback profile.
  PROFILES + 'profilesList.json',
  PROFILES + 'meta-quest-touch-plus/profile.json',
  PROFILES + 'meta-quest-touch-plus/left.glb',
  PROFILES + 'meta-quest-touch-plus/right.glb',
  PROFILES + 'generic-trigger-squeeze-thumbstick/profile.json',
];
const shellURLs = new Set(SHELL.map((p) => new URL(p, self.registration.scope).href));

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // One missing file (e.g. no sample on this host) must not stop the install.
    await Promise.allSettled([...SHELL.map((p) => new URL(p, self.registration.scope).href), ...CDN]
      .map(async (u) => {
        const r = await fetch(u, { mode: 'cors', cache: 'no-cache' });
        if (r.ok) await cache.put(u, r);
      }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

/** Network first with a time limit, falling back to the cache (app files). */
async function networkFirst(req, key) {
  const cache = await caches.open(VERSION);
  try {
    const r = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ]);
    if (r.ok && r.status === 200) await cache.put(key, r.clone());
    return r;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
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
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, new URL('./', self.registration.scope).href));
    return;
  }
  const key = url.origin + url.pathname;
  if (shellURLs.has(key)) e.respondWith(networkFirst(req, key));
  // Anything else on the same server (e.g. trajectories behind share links) goes straight to
  // the network, so big files don't fill the cache.
});
