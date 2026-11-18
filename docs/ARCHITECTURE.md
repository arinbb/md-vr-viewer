# MD Trajectory VR Viewer: architecture and components

This document explains how the viewer is put together: the third-party technology it
relies on, what each source file does, how data flows from a LAMMPS dump to pixels in a
headset, and the algorithms that handle periodic boundaries. It is written for whoever
maintains or extends the viewer next (for example a student developer or the lab's
research software engineer).

For *using* the viewer, see the [README](../README.md). For *why* it's built on WebXR
rather than VMD, Unity, Godot or Unreal, see [SCOPING.md](../SCOPING.md). To brief a
programmer who has to build it again from scratch (the core, how each feature sits on it,
acceptance numbers and pitfalls), see [REBUILD_BRIEF.md](REBUILD_BRIEF.md).

---

## 1. At a glance

- **What it is:** a static web page (no build step, no server-side code) that reads
  LAMMPS trajectory files in the browser and renders them on a desktop or in a VR headset.
- **Language:** plain JavaScript ES modules (~3,400 lines), with no framework and no bundler.
- **Rendering:** [three.js](https://threejs.org) r169 on WebGL 2.
- **VR:** the browser's [WebXR Device API](https://immersive-web.github.io/webxr/), via
  three.js's WebXR support.
- **Runs on:** Chrome/Edge on a PC (desktop or PC VR via Quest Link, Virtual Desktop or
  SteamVR), and the Meta Quest browser (standalone).
- **Teaching layer:** element guessing for bare dumps, solvation shells, hydrogen bonds,
  coloring and arrows from any dump column, a measurement-over-time plot, and timed
  lesson stops (captions + saved views) shared as links, with a student mode.

```mermaid
flowchart LR
    subgraph Files["User's files or a share link"]
        D[dump: .lammpstrj / .xyz / .gz]
        DF[data file: .data]
        L[link params:<br/>map, settings, stops]
    end
    subgraph Worker["Web Worker (parse-worker.js)"]
        ST[stream + gunzip + decode] --> P[lammps.js parsers]
    end
    subgraph Main["Main thread (main.js)"]
        T[Trajectory model<br/>positions + extra columns] --> TOP[Topology<br/>model.js + analysis.js<br/>+ chem.js element guessing]
        TOP --> STY[Style: radii, colors, visibility<br/>props.js colormaps]
        T --> FR[Per-frame pipeline<br/>interpolate → wrap → bonds →<br/>shell → H-bonds → arrows]
        STY --> FR
        FR --> GPU[Instanced meshes<br/>three.js]
        FR --> LES[Lesson stops<br/>captions, pause]
    end
    L --> Main
    D --> ST
    DF --> P
    P -- transferable buffers --> T
    GPU --> Desk[Desktop canvas]
    GPU --> HMD[WebXR headset]
    In[Mouse / keyboard / controllers / hands] --> Main
```

---

## 2. Third-party components

All dependencies load at runtime from public CDNs, pinned to exact versions. There is
no `node_modules` and nothing to install.

| Component | Version | Loaded from | Used for |
|---|---|---|---|
| **three.js** core | 0.169.0 | jsDelivr, via the import map in `index.html` | Scene graph, WebGL 2 renderer, `InstancedMesh`, materials, math (vectors, quaternions, matrices), `Raycaster`, `CanvasTexture`, `Sprite` |
| `OrbitControls` (three addon) | 0.169.0 | same | Desktop mouse rotate / zoom / pan |
| `XRControllerModelFactory` (three addon) | 0.169.0 | same; it fetches controller 3D models from the WebXR Input Profiles CDN | Real-looking controller models that match the connected hardware |
| **IWER** (Immersive Web Emulation Runtime, by Meta) | 2.1.1 | jsDelivr `+esm`, only when the URL has `?emulate` | Emulates a Quest 3 (headset and both controllers) in a desktop browser for development and automated testing |

Changing the three.js version means editing the two URLs in the `<script type="importmap">`
block of `index.html`. Addons must always match the core version.

### Browser platform APIs

The viewer leans heavily on standard browser features instead of libraries:

| API | Where | Why |
|---|---|---|
| **WebXR Device API** | `main.js` (through three.js) | Headset pose, stereo rendering, `XRInputSource` controllers and hands, `local-floor` reference space |
| **Gamepad API** (inside WebXR input sources) | `pollGamepads()` | Thumbsticks and A/B/X/Y buttons on Quest/Index controllers, trackpads on Vive wands |
| **Web Workers** (module workers) | `parse-worker.js` | Parse files without freezing rendering |
| **Streams API** + `TextDecoderStream` | `parse-worker.js` | Read multi-GB files chunk by chunk; V8 cannot hold a string larger than ~0.5–1 GB |
| **`DecompressionStream('gzip')`** | `parse-worker.js`, `headText()` in `main.js` | Open `.gz` dumps (e.g. `dump custom/gz`) without a library |
| **Clipboard API**, `TextEncoder` + `btoa` | *Copy share link* | Put a link holding all lesson stops (UTF-8 JSON as base64url) on the clipboard |
| **Transferable ArrayBuffers** | worker → main | Hand over parsed coordinates with zero copying |
| **Canvas 2D** | labels, VR wrist menu | Draw text and UI, uploaded as `CanvasTexture` |
| **File / Blob / DataTransfer** | file picker, drag-and-drop, `?traj=` links | Getting data in |
| **`canvas.toBlob`** | `saveScreenshot()` | PNG export |
| **`localStorage`** | settings block at the top of `main.js` | Remember display preferences (wrapped in `try/catch`, so private windows still work) |

### Development-time tools

| Tool | Used for |
|---|---|
| Python 3 `http.server` | Local static server (`python -m http.server 8137`). WebXR needs `localhost` or HTTPS. |
| Python 3 (`tools/make_sample.py`) | Generates the synthetic parser fixture (trajectory + data file) |
| Node.js (`tools/test_parser.mjs`, `tools/test_features.mjs`) | Runs the parser, geometry and teaching-feature tests; the core modules have no DOM dependencies |

---

## 3. Source files

```
index.html             page layout, styles, control panel, import map
sw.js                  service worker: offline cache for the installed app
manifest.webmanifest   web app manifest (name, icons, standalone display)
icons/                 app icons, drawn by tools/make_icons.py
src/
  main.js              application: scene, loading, rendering loop, all interaction
  parse-worker.js      Web Worker: streams files into the parsers, memory guard
  lammps.js            LAMMPS dump / XYZ / data-file parsers (DOM-free)
  model.js             element resolution, bond inference, radii, box geometry (DOM-free)
  analysis.js          periodic wrapping, measurements, paths, water detection (DOM-free)
  chem.js              element guessing, solvation-shell masks, hydrogen bonds (DOM-free)
  props.js             extra dump columns: vectors, color ranges, colormaps (DOM-free)
  elements.js          element table: colors, radii, masses; color palettes (DOM-free)
  voice.js             voice clips: recorder, player; lesson files (file part DOM-free)
  tracks.js            gestures while narrating (pointer, picks, moves), subtitles (DOM-free)
  transcribe.js        automatic transcripts: audio prep and the worker client (opt-in)
  transcribe-worker.js Whisper (transformers.js) in a worker, loaded on first use
  gestures.js          hand tracking: fist (grab) and fingertip poke from joints (DOM-free)
tools/
  make_sample.py       synthetic test fixture generator
  make_icons.py        draws icons/icon-192.png and icon-512.png (Pillow)
  build_site.py        copies the hosted app into dist/ (git-ignored); --no-sample
  fixtures/            synthetic.lammpstrj + .data (parser fixture, not physical)
  test_parser.mjs      Node tests: parsers, bonds, wrapping
  test_features.mjs    Node tests: extra columns, gzip, element guessing, H-bonds, shell
samples/               caffeine_water.lammpstrj.gz (real student NPT run) + sample.lesson.json
                       (its guided tour); samples/big/ is git-ignored
```

The six DOM-free modules (`lammps.js`, `model.js`, `analysis.js`, `chem.js`, `props.js`, `elements.js`) are
pure functions over typed arrays. They run unchanged in the browser, the worker and Node,
which is what makes them testable without a browser.

### 3.1 `index.html`: the page

- **Import map**, which maps `three` and `three/addons/` to pinned CDN URLs.
- **Side panel** (`#ui`): header, status line (`#statusBox`), the Explore / Watch / Create switch
  (`#modeBox`), then collapsible `<details class="sec" data-sec=…>` sections: File (with a
  nested *Atom types and elements* table), Appearance, Water & H-bonds, Select & measure
  (with the plot canvas), Lesson (stop list; `.w-only` playback options; `.c-only` editor
  `#lessonEditor`), Advanced, and
  Controls & help. Open/closed state is saved under `md-vr-viewer-sections` in
  localStorage. In Watch and Create the Lesson section moves to the top (flex `order`). The `–`
  button collapses the panel. Elements with class `adv` are hidden in student mode
  (`body.student`): File, Advanced and the stop editor.
- **Playback bar** (`#bar`): step, play, frame slider, frame/time, speed, stop buttons
  (Watch and Create, with stops only), reset, screenshot, and our own Enter AR / Enter VR buttons
  (`makeXRButton('ar' | 'vr')` in `main.js`: checks `isSessionSupported`, plain-language
  states such as *No headset* with a tooltip on what to do, re-checks on `devicechange`,
  requests the session and hands it to `renderer.xr.setSession`; while one session runs the
  other button is disabled). The AR button stays hidden unless `immersive-ar` is supported.
- **Passthrough.** In an `immersive-ar` session (`arSession`), three.js clears to
  transparent whatever `scene.background` is (`alpha-blend` blend mode), so the room shows
  through. `updateBackdrop()` hides the floor grid then; with `S.passthrough` off it shows
  `backdrop`, a dark back-faced sphere (radius 40 m, drawn first) around the user, which
  looks like VR without ending the session.
- **Caption overlay** (`#caption`) for the active lesson stop.
- **Drop overlay** (`#drop`) for drag-and-drop.
- **CSS** uses a dark theme in custom properties (`--bg`, `--panel`, `--bar-h`, …) and a
  phone breakpoint at 700 px (full-width panel and caption, icon-only stop buttons).

Every control has an `id`, and `main.js` wires them up in its *UI wiring* section.
There is no other coupling between the two files.

### 3.2 `lammps.js`: parsers

Converts text into the **trajectory model** (section 4).

| Export | Purpose |
|---|---|
| `detectFormat(head)` | `'dump'` if the file starts with `ITEM:`, `'xyz'` if it starts with an atom count |
| `createTrajectoryParser(head, opts)` | Returns a **streaming** parser `{ push(line), finish() }` |
| `parseTrajectory(text, opts)` | Convenience wrapper for whole strings (tests, small files) |
| `parseDataFile(text)` | LAMMPS data files: `Masses`, `Atoms`, `Bonds`, type labels |

**`DumpParser`** is a line-driven state machine
(`item → timestep → natoms → box → atoms → item …`) that handles:

- **Coordinate columns**, chosen in order of preference: unwrapped `xu yu zu`, then
  wrapped `x y z` (unwrapped using image flags `ix iy iz` when present), then scaled
  `xs ys zs` / `xsu ysu zsu`, converted to Cartesian with the box matrix (`writePos`).
- **Triclinic boxes.** `ITEM: BOX BOUNDS xy xz yz` lines store the *bounding box*, which
  `parseBox` converts back to the parallelepiped's `lo/hi` and tilt factors (formulas from
  the LAMMPS *Howto triclinic* page).
- **Atom reordering.** LAMMPS doesn't guarantee row order. Frame 1 is sorted by `id`
  (`initAtoms`), and every later row is placed by an `id → index` map. Atoms missing
  from a frame keep their previous position; atoms not in frame 1 are counted in a
  warning.
- **Stride and the memory guard.** `stride` keeps every Nth frame. `onFirstFrame`
  lets the worker raise the stride once it knows atoms per frame and file size.
- **Truncated files.** A partial last frame is dropped with a warning.
- **Extra columns.** Every column that isn't an id, type, element, mol, coordinate or image
  flag (up to 24) is stored per frame as `frame.props[name]` (`Float32Array(n)`), and the
  names are listed in `traj.props`. Velocities, forces, charges and computes all arrive
  this way.

**`XYZParser`** reads `dump xyz` (count line, comment line, then `type x y z` rows). It
takes the timestep from the comment if present, and assumes a constant atom order and
no box.

**`parseDataFile`** walks sections by header name. Atom-style column layouts come from
the `Atoms # full` comment hint, or are guessed from the column count.

### 3.3 `parse-worker.js`: background loading

1. Receives `{ id, kind, file, stride }` from `main.js`.
2. For trajectories, streams the `File` (through `DecompressionStream('gzip')` when it starts
   with the gzip magic bytes) and `TextDecoderStream`, splits the chunks
   into lines (carrying partial lines over to the next chunk), and pushes them into the
   streaming parser.
3. **Memory guard.** After the first frame, it estimates
   `frames ≈ fileSize / charsPerFrame` and the memory needed
   (`frames × atoms × (12 + 4 × extra columns) bytes`, with the file size scaled by the
   compression ratio seen so far for `.gz`). If that exceeds the budget (2 GB desktop, 0.8 GB on
   the Quest browser), it raises the stride and adds a user-visible warning.
4. Posts progress every ~150 ms, then the finished trajectory, with all coordinate
   buffers in the transfer list (zero-copy).

Each request has an `id`, so overlapping loads can't be confused. `main.js` also uses a
`loadSeq` counter so a newer load always wins.

### 3.4 `model.js`: topology and styling helpers

| Export | Purpose |
|---|---|
| `parseTypeMap(str)` | `"1:C 2:H"` / `"1=C, 2 H"` → `{ '1': 'C', '2': 'H' }` |
| `resolveElements(traj, data, userMap)` | An element for every atom. Priority: user map > dump `element` column > data-file type label > data-file mass > type name that looks like an element > `X`. Also returns the per-type summary shown in the *Atom types* table. |
| `resolveMols(traj, data)` | Molecule-IDs from the dump `mol` column, else from the data file |
| `bondsFromData(traj, data)` | Data-file bonds (atom-IDs) → index pairs |
| `inferBonds(pos, elements, opts)` | Distance-based bonds, periodic-aware (section 6.3) |
| `inferStableBonds(frames, elements, opts)` | Runs `inferBonds` on the first, middle and last frames and keeps bonds found in at least 2 (both, with 2 frames), so contacts in an unequilibrated first frame are dropped |
| `atomRadius(el, rep)` | Display radius per representation |
| `boxCorners(box)` | 8 corners of a possibly triclinic box (for the wireframe) |

### 3.5 `analysis.js`: geometry that runs every frame

| Export | Purpose |
|---|---|
| `boxVectors(box)` | Box edge vectors **a**, **b**, **c** |
| `buildGroups(n, bonds, mols)` | Splits atoms into molecules and a BFS order over bonds (section 6.4) |
| `wrapGroups(pos, groups, box)` | Reassembles molecules split by the box edge, then wraps them into the box, in place |
| `minImage(box, dx, dy, dz)` | Minimum-image displacement (triclinic-aware) |
| `atomPath(frames, i)` | Continuous path of one atom across all frames |
| `distance`, `angle`, `dihedral` | Measurements (Å, degrees) |
| `waterGroups(groups, elements)` | Flags molecules that are exactly one O and two H |

### 3.6 `chem.js`: chemistry on positions

| Export | Purpose |
|---|---|
| `guessElements(traj, known)` | Elements for numeric types from bonding geometry (section 6.7) |
| `nearMask(pos, refIdx, candIdx, R, n, box)` | Marks candidate atoms within R of any reference atom (cell list, periodic with a box; grids whichever list is larger); used for the water shell |
| `hbondParticipants(elements, bonds, frames)` | Donor pairs `[h, d]` (H bonded to N/O/F) and acceptors: O, F, and N with a free lone pair (section 6.8) |
| `findHBonds(pos, participants, opts)` | `[h, a]` pairs with H···A ≤ 2.5 Å and D–H···A ≥ 120°, periodic with `opts.box` (section 6.8) |

### 3.7 `props.js`: extra dump columns

| Export | Purpose |
|---|---|
| `vectorFamilies(props)` | Finds 3-component columns: `vx/vy/vz`, `fx/fy/fz`, `mux…`, `omega…`, `angmom…`, `name[1..3]` |
| `propLabel`, `propValues` | Display name and per-frame values of a color key (`p:<column>` or `mag:<family>`) |
| `propRange(frames, key, families, n)` | 2nd–98th percentile range over a sample of all frames; symmetric and diverging for signed columns |
| `colormap(v, range, out, o)`, `gradientCSS` | Viridis (sequential) or blue–white–red (diverging), and the matching CSS legend |

### 3.8 `elements.js`: chemistry data

`ELEMENTS` maps 23 elements common in biomolecular and materials MD (plus the unknown
`X`) to:

- the **Jmol CPK color**;
- the **covalent radius**, used for bond inference;
- the **van der Waals radius**, used for space-filling;
- the **mass**, used to identify elements from data files.

`normalizeElement` accepts `"c"`, `"OW"`, `"HW"` and similar, using the first letter
for force-field type names. `elementFromMass` matches masses within 0.6 amu and treats
13–16 amu united-atom CH*n* groups as carbon. `paletteColor(i)` gives distinct colors
for types and molecules (a 12-color Tableau-style palette, then a golden-angle hue walk).

### 3.8b `voice.js`: narration and lesson files

| Export | Purpose |
|---|---|
| `createRecorder({ onTick, onAutoStop })` | `MediaRecorder` on the microphone (Opus in WebM where supported, else MP4 or Ogg; 32 kbit/s; echo cancellation, noise suppression, auto gain). `start()` asks for the mic the first time; the stream stays open for quick re-takes and is released after a minute idle. `stop()` resolves `{ blob, mime, dur }`, or `null` under 0.4 s; `cancel()` drops it. Segments stop at 3 minutes (`onAutoStop`). `level` is the input RMS from an `AnalyserNode` for the meters; `onTick` fires every 100 ms. `allow()` asks for the mic without recording. |
| `analyzeSamples(samples, rate)` | DOM-free. 20 ms RMS windows; noise floor = 10th percentile; speech = windows above max(3.5 × floor, 8 % of the loudest, 0.002). Returns `trim` (0.15 s before the first speech to 0.3 s after the last), `gain` (speech RMS → 0.08 ≈ −22 dBFS, clamped to ×0.25…×12), `rms`, `peak`, `speech`. |
| `analyzeClip(clip)` | Decodes the clip (cached) and stores `clip.gain` and `clip.trim`. |
| `createPlayer({ onEnd, onFail })` | Web Audio: `play(k, clips)` decodes and plays the segments in order, each from `trim[0]` to `trim[1]` at its `gain`, through a master `volume` and a limiter (`DynamicsCompressor`, −8 dB threshold, ratio 12). Clips without analysis (older files) are analysed first. `onEnd(k)` when the last segment ends; `stop()` cancels. |
| `audioContext()`, `unlockAudio()` | The page's one `AudioContext`; resumed on the first pointer or key press (and when recording starts). |
| `lessonToJSON(stops, meta)` | `{ format: 'md-vr-lesson', version: 2, trajectory, map, fs, stops }`; each stop's `clips` as `[{ mime, dur, gain, trim, data: base64 }]` (chunked `bytesToB64`); other stop fields (e.g. `over`) as they are. |
| `parseLesson(text)` | Version 2 (`clips`), version 1 (one `voice` per stop, read as one segment) or a plain array of stops; audio back to Blobs; `{ stops, meta, clips }` (segment count). |
| `clipsOf`, `hasVoice`, `clipLength`, `voiceLength` | A stop's segments, whether it has any, one segment's played length, a stop's total. |
| `looksLikeLesson(head)`, `stripVoice(stops)`, `fmtDur(s)` | File sniffing in `classify`; share links without audio (`hasVoice: true` marks where narration was); `m:ss`. |

In memory a stop's narration is `stop.clips = [{ blob, mime, dur, gain, trim, text, track }]`;
`stop.over` (true) means it is narrated over the motion. `text` is the segment's transcript;
`track` its gestures (below). The player's `position` getter gives the segment playing and the
time on its recording's clock (`{ key, k, i, clip, t, progress }`).

### 3.8c `tracks.js`: gestures while narrating

DOM-free. A track has up to three parts, all timed in seconds from the start of the recording:
`pointer` `[[t, atomId]]` (on change; -1 = none), `sel` `[[t, [atomIds]]]` (after each pick),
`motion` `[[t, qx, qy, qz, qw, px, py, pz, s]]` (≈10 Hz): the molecule's movement in the
viewer's eyes since the segment began, in model space (Å).

| Export | Purpose |
|---|---|
| `eventAt`, `eventIndexAt` | The event active at time t (binary search). |
| `motionAt(motion, t)` | Pose at t: position and scale linear, rotation by `slerp` (shortest arc). |
| `compactTrack(tr)` | Drops a pointer track that never hit an atom and motion under 1° / 0.2 Å / 1 %; rounds numbers. `null` if nothing is left. |
| `cleanTrack(tr)` | Validates a track read from a file. |
| `subtitleChunks`, `subtitleAt(text, progress)` | Splits a transcript into ≤ 90-character pieces at word boundaries (ending at sentences where possible) and picks the one for the playback progress. |

**Recording** (`beginTrack`, `sampleTrack` in the animation loop, `select` hook): pointer = the
atom under the ray of a hand not wearing the menu (`h.hoverAtom`, from `updateHover`) or under
the mouse (`mouseNdc`, picked ~12 times a second). Motion `D(t)`: in VR
`F⁻¹ · Root₀⁻¹ · Root(t) · F` (the teacher's grabs; `F` = `model.matrix`, the fit transform);
on the desktop `Cm₀ · Cm(t)⁻¹` with `Cm` = the camera in model space (orbiting the camera is
the molecule turning the other way). `finishVoice` stores `compactTrack(...)` on the clip.

**Replay** (`replayTrack`, every frame while narration plays, not in Explore): when a new
segment starts it remembers `root` (`rootStart`); then `root = rootStart · F · D(t) · F⁻¹`, so the
teacher's moves happen relative to wherever this viewer has the molecule. `grabbers` or the
orbit controls' `start` event set `userMoved`, which stops the moves for that segment. The
pointer halo (`pointerMark`, a child of `model`, so it rides on the atom) and selections follow
the events. Subtitles: `showSubtitle` sets `#subtitle` (desktop) and `subPanel`, a canvas panel
placed under the molecule (0.46 × its scale below the centre) and turned toward the head about
the vertical axis. `window.viewer.step()` runs one animation frame for automated tests.

### 3.8d `transcribe.js` / `transcribe-worker.js`: automatic transcripts

Opt-in; nothing is downloaded until the first transcription. `speechSamples(buf, trim)` crops a
decoded segment to its trim and resamples it to 16 kHz mono (`OfflineAudioContext`).
`createTranscriber()` starts the module worker on first `transcribe(samples, onProgress)`;
the worker imports transformers.js 3.8.1 (`dist/transformers.min.js`, jsDelivr) and runs
`automatic-speech-recognition` with `onnx-community/whisper-tiny.en`, `dtype: 'q8'`,
`device: 'wasm'`, 30 s chunks. First use downloads ≈ 65 MB (library 0.9 MB, ONNX Runtime
WebAssembly 21.6 MB, encoder 10 MB, decoder 31 MB, tokenizer 2.4 MB); transformers.js caches
the model in Cache Storage and the service worker caches the library cache-first (`SPEECH`).
`cleanTranscript` (DOM-free) drops Whisper's non-speech markers (`[BLANK_AUDIO]`, `(music)`).
In `main.js`, `tx` holds the engine and a queue (one segment at a time): `queueTranscribe`
(skips segments with text unless forced), `transcribeAll`, `S.autoTranscribe` (saved; queues
each new segment in `finishVoice`), status in `#transcribeInfo`. A result lands only if the
segment is still in the lesson; it never overwrites a text box the teacher is typing in.
`viewer.tx.engine` can be replaced with a stand-in for tests.

### 3.9 `main.js`: the application

`main.js` is organized in commented sections, in this order:

| Section | Key functions | Responsibility |
|---|---|---|
| State | `S` object | All mutable app state in one place (trajectory, topology, style, playback, selection) |
| Settings | `saveSettings()` | Load/save display settings in `localStorage` |
| Emulator | top-level `await import(iwer)` | Installs IWER when `?emulate` is present, **before** the VR button checks for XR support |
| Offline app | `navigator.serviceWorker.register('./sw.js')`, `beforeinstallprompt` | Registers the service worker (not for `file:`, `?emulate` or `?nosw`); shows an *Install* button where the browser offers one |
| VR start-up log | `xrLog`, `lastXRFroze`, `xrSafe` | Writes each Enter VR step to localStorage as it happens. If the last try never drew its first VR frame and didn't end or fail normally (a page frozen while starting), the next load says which step it reached and the next session asks only for `local-floor` and `hand-tracking` (safe mode; `?xrsafe` forces it). A session closed after it started drawing (tab closed, page reloaded) doesn't count. |
| Scene | renderer, camera, `OrbitControls`, `root` / `model` groups | three.js setup (section 5.1) |
| Loading | `classify`, `loadFiles`, `loadSample`, `setTrajectory`, `applyTopology`, `fitModel` | Files → trajectory → topology → meshes |
| View | `resetView`, `placeInFrontOfHead`, `focusAtom`, `simTime` | Camera and system placement; simulated-time formatting |
| Meshes | `buildMeshes`, `buildBondMesh`, `setBonds` | Allocate instanced meshes; grow the bond buffer for reactive mode |
| Styling | `computeStyle`, `updatePropColors`, `updateLegend`, `applyColors`, `setupProps`, `renderTypeTable`, `guessAndApply` | Per-atom radius, color and base visibility; data-column coloring; the element dropdowns and guessing |
| Per-frame geometry | `updatePositions`, `updateHBonds`, `updateArrows`, `onFrameChange`, `writeBondMatrix` | The frame pipeline (section 5.2); stop triggering on integer frame changes |
| Selection | `select`, `computeSeries`, `plotSeries`, `drawPlot`, `pickAction`, `measurementText`, `updateSelectionGeometry` | Up to 4 picked atoms, highlights, measurement lines, the measurement-over-time plot, paths, labels |
| Picking & labels | `pickAtom`, `makeLabel`, `updateLabelPosition` | Analytic ray–sphere picking; canvas-texture label sprite |
| Desktop input | pointer, double-click and key handlers; `saveScreenshot` | Mouse and keyboard |
| UI wiring | `on*` handlers, `setRep`, `setColorBy`, `setWater`, `setHBonds`, `setArrows`, `setShowPaths` | Panel controls ↔ state |
| Lesson stops | `captureStop`, `applyStop`, `setActiveStop`, `renderStops`, `gotoStop`, `shareLink`, `b64enc`/`b64dec` | Captions tied to frames with view + settings; share links (section 6.9) |
| VR input | controller setup, `rayHit`, `updateHover`, `beginGrab`/`updateGrab`, `pollGamepads`, `menu`, `placeWristPanel` | Everything headset-specific (section 7) |
| Loop | `renderer.setAnimationLoop` | Runs every display frame on desktop and in XR |
| Startup | `loadFromParams()` | `?sample`, `?traj=…&data=…&map=…&fs=…&stride=…`, view settings (`rep`, `color`, `water`, `shell`, `hb`, `arrows`), `stops`, `student` |

`window.viewer` exposes state and a few helpers (`select`, `resetView`, `screenOf`,
`menu`, `hands`) for debugging and automated browser tests.

### 3.10 `sw.js`: the offline app

A service worker plus `manifest.webmanifest` make the viewer an installable app that runs
offline (the Quest 3 standalone setup in the README).

- **Install:** downloads the app files (`APP`: page, modules, manifest, icons) as one set
  (`downloadSet`; install fails and is retried next visit if any is missing), the optional
  sample if the host has it, and the pinned CDN files: three.js core, the addons `main.js`
  imports and their dependencies (`GLTFLoader`, `BufferGeometryUtils`, `motion-controllers`),
  and the WebXR input-profile files for Quest 3 Touch Plus controllers plus the generic
  fallback.
- **Fetch:** app files are always served **from the cached set** (`fromSet`), so the page
  and its modules can never come from two versions (a mix would break the imports). Every
  page address (`?sample`, share links) is the cached page. Version-pinned CDN URLs are
  cache-first. Other same-origin files (e.g. trajectories behind share links) go straight to
  the network and are not cached; files opened from the device never touch it.
- **Updates:** the page asks for `updateSet()` (message `md-vr-check-update`) 3 s after its
  `load` event, so an update can never land while it is still fetching modules, and again
  when an installed app is resumed (`visibilitychange`); at most once a minute. It re-downloads
  the whole set with `cache: 'no-cache'` (ETag revalidation, cheap when unchanged) and only
  if every app file arrived writes them all into the cache. If the page or a main module
  changed, it posts `md-vr-updated` and the page shows *A new version … Reload*
  (`#updateNote`, a banner at the top, visible with the panel folded). So an upload reaches users on the launch after the next online one, or
  at once with Reload.
- **Versions:** `VERSION` names the cache; bump it when the file list changes, and old
  caches are deleted on activation.
- `tools/build_site.py` copies exactly the shell files into `dist/` for uploading, and
  with `--no-sample` leaves out the students' data and hides *Load sample*.

---

## 4. Data model

### Trajectory (produced by the parsers)

```js
{
  n:        300,                       // atom count
  ids:      Int32Array(n),             // LAMMPS atom-IDs, ascending; index i is THE atom key everywhere
  types:    ['1','2',…],               // type label per atom, as in the file
  elements: ['O', null, …],            // dump "element" column, if any
  mols:     Int32Array(n) | null,      // molecule-IDs, if any
  frames:   [{ timestep, box, pos: Float32Array(3n),
               props: { vx: Float32Array(n), … } }, …],   // extra columns, per frame
  columns:  ['id','mol','type','x',…], // first ATOMS header
  props:    ['vx','vy','vz','q'],      // names of the extra columns kept
  stride:   1,                         // every Nth frame was kept
  warnings: ['…'],
}
box = { lo:[x,y,z], hi:[x,y,z], tilt:[xy,xz,yz], periodic:[bool,bool,bool] }
```

Positions are stored once per frame as `Float32Array` (12 bytes per atom per frame), plus
4 bytes per extra column, so memory grows linearly with *atoms × kept frames × columns*.

### Derived state (`S` in `main.js`)

| Field | Built by | Rebuilt when |
|---|---|---|
| `elements`, `typeSummary` | `resolveElements` | new file, type-map edit |
| `mols` | `resolveMols` | new file |
| `staticBonds`, `bonds` | `bondsFromData` / `inferStableBonds` | new file, type map; `bonds` changes every frame in reactive mode |
| `groups`, `water` | `buildGroups`, `waterGroups` | with topology |
| `isWater`, `soluteIdx`, `waterIdx`, `hb` (donors/acceptors) | `applyTopology` | with topology (`hb` also per frame in reactive mode) |
| `radii`, `colors`, `baseVisible` | `computeStyle` | style, size, coloring, water mode; bumps `styleRev` |
| `visible` | `updatePositions` | `baseVisible` + the solvation shell, when the data frame or settings change |
| `colors` (data coloring) | `updatePropColors` | every new data frame when coloring by a column |
| `families`, `rangeCache` | `setupProps`, `getRange` | new file; ranges computed lazily per color key |
| `hbPairs`, `hbCount` | `updateHBonds` | when `contactKey` changes (data frame, water mode, shell radius, H-bond mode, style) |
| `cur` | `updatePositions` | every frame that changes (`S.dirty`) |
| `sel`, `paths`, `series` | `select`, `computeSeries` | picking, path toggle |
| `stops`, `activeStop` | lesson functions | adding/editing stops, frame changes, links |
| `guessed` | `guessAndApply` | new file with unknown types, *Guess elements* button |

---

## 5. Rendering

### 5.1 Scene graph

```
scene
├── HemisphereLight, DirectionalLight, GridHelper (floor)
├── root            ← what the user grabs; position/rotation/uniform scale (metres)
│   └── model       ← Å coordinates, scaled so the largest box extent = 0.8 m and centred
│       ├── atomMesh     InstancedMesh(Sphere, n)
│       ├── bondMesh     InstancedMesh(open Cylinder, 2 × capacity)
│       ├── boxLines     LineSegments (12 edges)
│       ├── hbMesh       InstancedMesh(open Cylinder, 3 dashes per H-bond), grows as needed
│       ├── arrowMesh    InstancedMesh(shaft + cone, n), only when arrows are on
│       ├── highlights   4 wireframe spheres (selection colors)
│       ├── measureLines LineSegments between selected atoms (always on top)
│       └── pathLines    4 Lines (one per selected atom)
├── label           Sprite (canvas text), follows the last selected atom
├── controller[0,1] ray Line; grip[0,1] controller model (+ wrist menu on the left)
└── hover dots      one small sphere per hand where its ray hits
```

Splitting **root** (user transform, in metres) from **model** (fixed fit transform) means
grabbing, scaling and resetting never touch atom coordinates.

### 5.2 Per-frame pipeline: `updatePositions()`

This only runs when something changed (`S.dirty`: playback, scrubbing or a style change).

1. **Interpolate** between frame ⌊f⌋ and ⌊f⌋+1 for smooth playback, unless a coordinate
   jumps by more than half the box (a periodic wrap), which would make atoms fly across
   the box.
2. **Wrap**: `wrapGroups(cur, groups, box)` (section 6.4). In smooth playback `box` is
   interpolated between the two data frames (`lerpBox`), like the atoms: under NPT the box
   changes size every frame, and a box that jumped at each data frame while the atoms glide
   looks like it pulses. Contacts (step 4) use the data frame's own box (`frameBox`). When the
   box size varies over the run (`boxVaries`), the frame readout shows the current edge.
3. **Reactive bonds** (optional): re-run `inferBonds` when the integer frame changes.
4. **Contacts**, only when `contactKey` (data frame, water mode, shell radius, H-bond mode,
   style revision, reactive bond frame) changes: the solvation-shell visibility mask
   (`nearMask`) and the H-bond list (`findHBonds`), computed from the data frame's own
   positions with the periodic box (so the result is the same however you arrive at a frame).
   During smooth playback the in-between frames reuse them, so these costs are paid once per
   data frame, not per display frame. The dashes themselves follow the displayed positions.
5. **Data coloring:** when coloring by a column, recolor on each new data frame.
6. **Write atom matrices** straight into `instanceMatrix.array` (scale = radius, or 0 when
   hidden; translation = position). This avoids `Matrix4.compose` and is several times faster
   for tens of thousands of atoms.
7. **Write bond matrices.** Each bond is **two half-cylinders**, one from each atom to
   the midpoint, colored like its atom (the classic VMD/PyMOL look with no shader work).
   The cylinder's local Y axis is aligned with the bond using a hand-built orthonormal
   basis. Bonds that are too long (still split by the box edge, or broken) and bonds to
   hidden atoms get zero scale.
8. **H-bond dashes and arrows**: H-bond endpoints follow the current positions (3
   cylinders covering 60% of each H···A distance); arrows read the frame's vector columns
   and are scaled so the 98th-percentile magnitude is 1.5 Å × the length slider.
9. Update the box wireframe, highlights, measurement lines, paths and label.
10. On an integer frame change, `onFrameChange` triggers lesson stops and redraws the
    measurement plot marker.

### 5.3 Performance techniques

- **GPU instancing:** one draw call for all atoms, one for all bonds.
- **Level of detail by system size:** sphere segments 24×16 (<5k atoms), 14×10 (<30k)
  or 8×6 (more) at High detail.
- **Draw lists** (`rebuildDrawLists`): only drawn atoms and bonds are packed to the front of
  the instanced meshes (`S.drawAtoms`, `S.drawBonds`) and `mesh.count` is set to them, so
  hidden water costs no GPU work. Colors are gathered through the same lists
  (`applyColors`, `applyBondColors`). The lists are rebuilt when visibility changes (the
  contact key) or `S.drawDirty` is set (new bonds, new meshes); picking walks the same list.
- **Detail levels** (`S.detail` setting → `S.level` 0/1/2; `setDetail`, `refreshLevel`):
  Medium uses 10×7 spheres and 6-sided bonds, skips in-between frames during VR playback
  (`smoothNow()`; only a new data frame sets `S.dirty`) and picks atoms for hover every 2nd
  frame. Low uses 7×5 spheres and 4-sided bonds, picks every 3rd frame, and draws each water
  as one bead at its oxygen (`drawRadius`): water hydrogens and bonds are left out of the
  draw lists only, so `S.visible`, the shell and H-bond searches are untouched. Changing level
  rebuilds the meshes.
- **Auto detail in VR** (`autoLevel`, `watchFrameRate`): at session start the level comes
  from the number of visible atoms (standalone headsets by user agent: Medium above 6k, Low
  above 20k; PC VR: 30k / 80k). Each XR frame feeds the raw frame interval into a moving
  average; if it stays above 1.3 × the session's frame period (`XRSession.frameRate`,
  default 72 Hz) for about 2 s, the level drops one step, the wrist menu shows a note
  (`S.vrNote`), and judging pauses 3 s. It never raises the level by itself.
- **`frustumCulled = false`** on instanced meshes. Their bounding volumes would be stale
  as atoms move, and the system is almost always in view anyway.
- **Dirty flag:** a paused, unchanged scene doesn't rebuild geometry each frame.
- **Analytic picking** (section 6.5) instead of triangle raycasting.
- **Typed-array cell lists** (counting sort, no per-cell objects) for bond inference, the
  water shell and H-bonds, so they are cheap to rebuild per data frame.
- **Contact caching** (step 4 above): shell and H-bond searches run once per data frame.
- Triangles on the caffeine sample (all water): 2.56 M at High, 1.25 M at Medium, 0.18 M at
  Low; with water near solute: 0.34 M / 0.17 M / 0.03 M. `updatePositions` with all water
  drops from ~3.1 ms (High, smooth playback) to ~1.4 ms (Low).
- Measured on an RTX 4070 Ti SUPER desktop: a 24k-atom system plays at 60 fps (vsync),
  and a 47 MB dump parses in 0.4 s. `updatePositions` costs ~3.5 ms at 24k atoms; with all
  8,160 water–water H-bonds on it costs ~8 ms on a new data frame and ~3.5 ms between
  frames. The 9,192-atom caffeine system with shell + solute H-bonds (periodic) costs ~4.0 ms per new frame
  and ~1.3 ms between frames.

---

## 6. Algorithms

### 6.1 Triclinic box math

LAMMPS boxes are parallelepipeds with edge vectors
**a** = (lx, 0, 0), **b** = (xy, ly, 0), **c** = (xz, yz, lz). Because this matrix is
upper-triangular, converting a displacement to fractional coordinates is a simple back
substitution (`frac()` in `analysis.js`):

```
fz = dz / lz
fy = (dy − fz·yz) / ly
fx = (dx − fy·xy − fz·xz) / lx
```

Every periodic operation below works in fractional coordinates, so orthogonal and
triclinic boxes share one code path.

### 6.2 Unwrapping on read

With image flags: `x_unwrapped = x + ix·a + iy·b + iz·c`. With scaled coordinates:
`x = lo + xs·a + ys·b + zs·c`. Both happen in `writePos` while parsing.

### 6.3 Bond inference with periodic ghosts: `inferBonds`

Two atoms are bonded if `d < 1.2 × (r_cov,i + r_cov,j)`, with an H–H cutoff of 0.85 Å
to stop water hydrogens bonding to each other.

1. **Ghost images.** If the box is periodic, every atom is wrapped into the box
   (`withGhosts`). Atoms within one cutoff of a periodic face get shifted copies (up to 7
   per atom near a corner), each remembering its original index. The margin is measured
   against the box's *perpendicular* widths (volume / |**b**×**c**|, etc.), so tilted
   boxes work.
2. **Cell list.** All points are counting-sorted into cubic cells one cutoff wide (flat
   integer cell keys; a `Map` is used instead for very sparse systems).
3. **Search.** Each *real* atom checks the 27 neighbouring cells. Pairs are stored once
   (`i < j` on original indices) and de-duplicated with a `Set` when ghosts are involved.

This is O(n), with 30k atoms in ~30 ms. Without ghosts, LAMMPS's default wrapped output
loses every bond that crosses the box edge (2.2% of bonds in the 24k-atom water test).

### 6.4 Making molecules whole, then wrapping: `buildGroups` + `wrapGroups`

Goal: never draw a molecule split across the box, but keep every molecule's centre in
the box (no drift with unwrapped coordinates).

- **`buildGroups`** (once per topology) assigns each atom to a group (its molecule-ID,
  or its bond-connected component) and records a **BFS order with a parent** for each
  atom, walking along bonds. Atoms in a molecule with no bonded path hang off the
  molecule's first atom.
- **`wrapGroups`** (every frame):
  1. In BFS order, move each atom to the periodic image closest to its parent (round its
     fractional displacement). Because parents are processed first, the molecule
     reassembles along its own bonds, which works even for polymers longer than half
     the box.
  2. Compute each group's centroid, then shift the whole group by whole box vectors so
     the centroid lies in `[0, 1)` fractional.

In reactive mode the topology isn't trusted, so each atom is wrapped on its own.

### 6.5 Picking: `pickAtom`

The ray (from the mouse via the camera, or from a controller) is moved into **model
space** with the inverse of `model.matrixWorld`. Then each visible atom gets an analytic
ray–sphere test (`t = tca − √(r² − d²)`), and the nearest hit wins. Atoms smaller than
0.35 Å get a 0.35 Å pick radius so hydrogens are easy to hit. This is O(n) per ray,
cheap enough to run for both controllers every VR frame (hover feedback).

### 6.6 Paths and measurements

- **`atomPath`** accumulates minimum-image steps between consecutive frames, so a path
  never jumps across the box. When drawn, the path is offset so it ends exactly at the
  atom's current, possibly wrapped, position. `setDrawRange` reveals it up to the
  current frame.
- **Angle:** `acos` of normalized dot product. **Dihedral:** `atan2` form (stable, signed
  −180°…180°) using the projection of the outer bonds onto the plane perpendicular to
  the central bond.

---

### 6.7 Guessing elements: `guessElements`

For dumps with bare numeric types and no data file (the common "just give me the dump"
case):

1. **Contacts.** Every pair within 1.9 Å in the middle frame (via `inferBonds` with
   generic radii, so periodic images are included). Each contact's length is then
   **averaged over four frames** (¼, ½, ¾ and last) with the minimum image, which cuts
   thermal noise.
2. **Hydrogens, per atom.** An atom with exactly one contact shorter than 1.15 Å is H if
   its partner has ≥ 2 such short contacts (water H, CH₃ H), or if the atom has fewer
   1.15–1.75 Å neighbors than its partner (hydroxyl: the O also bonds to a C). Then a
   majority vote per type.
3. **Heavy atoms, per type.** For each type: the most common H count and heavy-neighbor
   count, plus the type-averaged X–H and X–heavy lengths. Rules: two H and no heavy
   neighbor → water O; X–H < 0.985 Å → O, < 1.05 Å → N, else C (> 1.25 Å → S); no H
   and one neighbor → O (C=O) or N (nitrile, < 1.19 Å); two neighbors → aromatic N
   (< 1.38 Å) or ether O; three neighbors with a bond < 1.30 Å → carbonyl C; four with
   ≥ 3 terminal O → P.
4. **C or N in rings (`resolveByValence`).** Three-coordinate atoms without H can be sp2 C
   or N, and their bond lengths overlap. The function tries every C/N assignment of these
   types (up to 2¹⁰) and keeps those where the unsaturated atoms (C with 3 neighbors, N
   with 2, O with 1) have a **perfect matching** over bonds, i.e. a Kekulé structure exists
   (found with augmenting paths). Among valid assignments it prefers N next to methyl
   groups and fewer N overall. On caffeine this picks out exactly the three N–CH₃
   nitrogens.

Each guess gets a confidence: low when atoms of a type disagree, a fallback rule fired,
or several valence assignments were valid. The *Atom types* table shows *guessed* or
*guessed ?* with the reason as a tooltip.

### 6.8 Hydrogen bonds and the water shell

Both use a uniform cell list (`buildGrid` in `chem.js`: counting sort into typed arrays,
like `inferBonds`) periodically, on the data frame's positions:

- **Cell list** (`buildGrid`): with a periodic box, cells tile the box in fractional
  coordinates, as many per box vector as fit with a perpendicular width ≥ the cutoff, and
  neighbor cells wrap around (with fewer than 3 cells along a vector, all are visited once).
  Distances use the minimum image (`makeDelta`: inline for orthogonal boxes, `minImage` for
  triclinic). Without a box, cells cover the atoms' bounding box. Counting sort into typed
  arrays, preallocated neighbor spans: no allocations per query.
- **Shell:** a water molecule is shown if any of its atoms is within R of a solute atom.
  `nearMask` grids whichever list is larger and queries the smaller (192 caffeine atoms
  against 9,000 water atoms: grid the water). For pure water there is no solute, so the
  *Near solute* option is disabled.
- **H-bonds:** grid the acceptors with cell size 2.5 Å; for each donor hydrogen test
  H···A ≤ 2.5 Å and cos∠(D–H···A) ≤ cos 120°. `updateHBonds` narrows the candidates first:
  only shown atoms, and for *with solute* two searches (any donor → solute acceptors, solute
  donors → water acceptors) instead of filtering every water–water contact afterwards.
  Bonds across the box edge are drawn toward the acceptor's nearest image.
- **Acceptors** (`hbondParticipants`): every F, O with at most 2 bonds (3-bonded O such as
  H₃O⁺ is skipped), and N only when its lone pair is free. N with 4 bonds (ammonium, NH₃⁺) is skipped. N with 3 bonds is skipped when planar:
  its distance from the plane of its three neighbors, averaged over the first, middle and
  last frames (current frame in reactive mode), is under 0.2 Å. Amide, aromatic and
  methylated ring N (caffeine's N1/N3/N7) are planar, and amines are pyramidal (about 0.35–0.45 Å).
  N with 1–2 bonds (pyridine-like, caffeine's N9) accepts. Each H-bond is drawn as three short cylinders (an
  `InstancedMesh`), because one-pixel dashed lines nearly vanish in a headset.

Both searches run only when the data frame or a relevant setting changes (`contactKey`,
section 5.2); see section 5.3 for timings.

### 6.9 Lesson stops and share links

A stop is `{ f, cap, sel: [atom-IDs], v: { rep, color, water, shell, hb, arrows, paths }, cam }`.

**Modes.** `S.mode` is `'explore'`, `'watch'` or `'create'`, changed only by the user through
`setMode` (and to Watch by opening a lesson). `setMode` sets the `body.mode-*` classes that
show or hide the Lesson section, the caption, the stop buttons, `.w-only` (playback options)
and `.c-only` (the editor), stops any clip, and finishes a recording in progress when leaving
Create. In Explore and Create `onFrameChange` returns before any stop logic, so playback never
applies stops; in Create it only keeps `S.activeStop` on the stop exactly at this frame
(`refreshActiveStop`), which is the one *Update stop*, *delete* and the caption box act on.
Entering Watch applies the latest stop at or before the current frame (`applyStop(k,
{playback: true})`, no frame jump); entering Create keeps the view. `addStop`, the ✕ in the
list, *Update stop*, `startVoice` and `deleteStopHere` do nothing outside Create; `gotoStop`
does nothing in Explore and plays the clip only in Watch. Create is unavailable in student
mode (`isStudent()`). `voice.unsaved` is a setter that shows the *unsaved* badge.
The caption box (Create) is loaded from the stop being edited (`loadCaptionBox`, `editedStop`)
whenever that stop changes or the mode is entered, unless it holds typed text that differs
from that caption (`captionTyped`), which is kept until *Add* or *Update* applies it. One stop
per frame: *Add stop here* is disabled on a stop's frame (and `＋ add stop` in VR). *Update*
keeps the clip and, when done in VR, the desktop camera (`keepFromOld`). `applyLesson` asks
before replacing a lesson with unsaved changes and drops a recording in progress
(`voice.rec.cancel()`). Watch can't be entered without stops (`#modeWatch` starts disabled).
`cam` holds the camera position and orbit target in **model coordinates**, so it survives
a refit or window resize. Stops are kept sorted by frame.

- `onFrameChange` runs when the integer frame changes. While playing forward (or after
  playback wraps, tracked by `S.looped`) it finds a stop crossed since the previous frame,
  applies it and optionally pauses. The caption shown is always the latest stop at or
  before the current frame.
- `shareLink` writes the file URL(s), mapping, settings and `stops` (JSON →
  UTF-8 → base64url, so captions in any language survive) into the query string, without
  audio (`stripVoice`). `loadFromParams` reverses this; view settings are applied after the
  trajectory loads because coloring and arrow choices depend on its columns. `lesson=`
  loads a lesson file after the trajectory.

**Narration** (`voice` object near the top of `main.js`; functions after `copyLink`):

- **Recording:** `startVoice()` (Create only) pauses playback, saves the moment with
  `captureStop('')` (frame, view settings, selection; the camera too on the desktop) and
  starts the recorder. `finishVoice()` analyses the segment (`analyzeClip`) and **appends** it
  to the stop at the same frame, or inserts a new stop with it; recording never replaces.
  `removeClip(k, i)` removes one segment (`-1`: the last; the wrist menu's *↶ last segment*);
  the stop stays. The wrist menu's *● hold to talk* starts on `selectstart` (`menu.press`)
  and finishes on `selectend` (`menu.release`). `renderVoiceState` draws the desktop meter
  (`#micMeter`, warns after 2.5 s of near-silence) and the VR button's `meterText`;
  `renderNarration` lists the edited stop's segments (`#narrationList`, ▶ / ✕) and its
  pacing checkbox (`#stopOver` → `stop.over`). `buzz()` pulses the controllers.
- **Playback:** `onFrameChange` (Watch) plays a stop's narration when playback reaches it
  (`playVoice(k, { wait })`). A stop with `over` neither pauses (even with *Pause at each
  stop*) nor waits; otherwise, with *Wait for voice clips*, playback pauses and resumes in the
  player's `onEnd`. `gotoStop`, the stop list and *▶ hear stop* play narration too; any mode
  change stops it (`stopVoice`). `#voiceVolume` sets the player's master volume.
- **Files:** *Save lesson file* downloads `lessonToJSON(...)`. `classify` recognises lesson
  files (`.json` or `looksLikeLesson`); `loadFiles` applies one after its trajectory
  (`applyLesson`), or on its own to the current trajectory (`openLocal` then leaves the
  current setup alone). A lesson's `map` fills an empty type map before parsing. A
  `beforeunload` guard warns while changes are unsaved. The Lesson badge shows the total
  narration (`voiceLength`).

## 7. VR interaction layer

```mermaid
stateDiagram-v2
    [*] --> Desktop
    Desktop --> Immersive: Enter VR / Enter AR (makeXRButton)
    Immersive --> Placed: first XR frame → placeInFrontOfHead(viewerPose)
    Placed --> Placed: each frame: pollGamepads → updateGrab → menu.faceHead/draw → updatePositions → updateHover → render
    Placed --> Placed: thumbstick click / menu "reset view" → needPlace
    Immersive --> Desktop: session end → resetView()
```

| Piece | How it works |
|---|---|
| **Controllers** | `renderer.xr.getController(k)` (targetRay space: rays, select/squeeze events) and `getControllerGrip(k)` (grip space: 3D model, wrist menu). `connected` events give the `XRInputSource` (handedness, gamepad, hand). |
| **Placement** | On session start, reads the `XRViewerPose` directly from the `XRFrame` (reliable on the first frame) and puts `root` 0.75 m in front of the head along the horizontal look direction, 15 cm below eye level, rotated to face the user. |
| **Grab (one hand)** | On `squeezestart`, stores `offset = inverse(controller) × root`; each frame sets `root = controller × offset`. The system moves rigidly with the hand. |
| **Grab (two hands)** | Stores the initial hand distance, the hand-to-hand direction and the root point under the midpoint. Each frame, scale = s₀·d/d₀, rotation = (quaternion turning the old hand-to-hand direction into the new one) × q₀, and the position keeps the same root point under the midpoint. |
| **Wrist menu** (`menu`) | An 800×980 canvas on a 20×24.5 cm plane, attached to the left grip (or the only controller) and turned toward the head every frame (`faceHead` → `lookAt`). It's rendered double-sided so rays from either side register. Layout: title, status, selection, timeline (with yellow stop ticks), an info panel (in Watch and Create the active stop's caption at the largest of 26/23/20 px that fits, about 250–450 characters; otherwise the measurement plot, which also scrubs), a transport row (step, play, step, reset), the Explore | Watch | Create segmented switch with the detail button (narrower in AR sessions to fit the *room: on/off* passthrough toggle, `MODES_AR`; Watch is disabled without stops, Create in student mode), a 2×4 grid whose buttons depend on the mode (`GRID.explore` / `GRID.watch` / `GRID.create`), and a third row per mode (`ROW3`: none in Explore; hear stop and wait for voice in Watch; hold to talk, hear stop and delete stop (two presses) in Create). The info panel scrubs only while it shows the plot (`infoShowsPlot`). `visibleButtons()` feeds both drawing and `hitTest(uv)`, which maps the ray's UV hit to a button or timeline position; `press()` performs the action. Steppers such as atoms −/+ go through `nudge(id, d)`, which sets the page control and fires its `input` event, so desktop and VR stay in sync. The canvas is redrawn only when a key of the displayed state changes. |
| **Ray priority** | `updateHover` raycasts the menu first (three.js `Raycaster` against one plane), then atoms. While a ray is on the menu, the trigger never picks atoms behind it. Holding the trigger on the timeline scrubs. |
| **Gamepad shortcuts** | `pollGamepads` reads `gamepad.buttons` (xr-standard mapping: 0 trigger, 1 squeeze, 2 touchpad press, 3 thumbstick press, 4 A/X, 5 B/Y) and `axes[2..3]` (thumbstick). A/X toggles play; B on the right hand steps one frame forward and Y on the left one back, repeating every 0.125 s after a 0.4 s hold (`h.stepHold`). Controllers without a thumbstick (Vive wands: 3 buttons, 2 axes) use the touchpad `axes[0..1]` while it is touched, and its press for reset. Edges are detected against the previous frame. |
| **Hand tracking** | Requested as an optional feature (also in safe mode). Each hand gets a skinned model (`XRHandModelFactory`, `'mesh'` profile from the WebXR input-profiles CDN; hidden in AR passthrough) and a dimmer pointing ray. A pinch fires `select` like a trigger: on the menu it presses at once (with `uiClick()`, a short WebAudio click, since hands have no haptics); on atoms the pick waits for `selectend` and is dropped if a fist formed meanwhile (`pendingPick`, `fistDuringPinch`), so grabbing doesn't clear the selection. **Grab** comes from `updateHands()` each frame: `gestures.updateFist` compares each finger's tip-to-knuckle distance with its length along the bones (≈1 straight, ≈0.45 curled; closes when 3 of 4 fingers are below 0.6, opens when 3 are above 0.8), so it works for any hand size and doesn't flicker. A fist adds the hand to `grabbers` like a grip button; the browser's own `squeeze` is ignored for hands. Grabs follow `anchorOf(h)`, the **wrist joint** for hands (steadier than the hand's target ray). **Poke:** the other hand's index-finger tip is moved into the menu's local frame; `gestures.pokePanel` presses when it crosses the surface from the front (z ≤ 8 mm, previously above), hovers within 4 cm, and releases when pulled back past 2 cm or off the panel; hold-to-talk and timeline scrubbing work by poke too. The menu rides on the left **wrist joint** for hands (`placeWristPanel`, re-checked every 30 frames because joints appear after `connected`). `fistOverride` on a hand lets automated tests stand in for a fist. |
| **Emulation** | With `?emulate`, IWER replaces `navigator.xr`. Tests then drive `xrDevice.controllers.right.position / quaternion / updateButtonValue / updateAxes`, exactly like a real Quest. |

---

## 8. Loading pipeline in detail

```mermaid
sequenceDiagram
    participant U as User
    participant M as main.js
    participant W as parse-worker.js
    U->>M: pick / drop files, or ?traj= link
    M->>M: classify(): data file vs trajectory (name + first 4 KB, gunzipped if .gz)
    M->>W: {id, kind:'data', file}
    W-->>M: data file (masses, labels, atoms, bonds)
    M->>W: {id, kind:'traj', file, stride}
    loop chunks
        W->>W: [gunzip →] TextDecoderStream → lines → DumpParser.push()
        W-->>M: progress (every ~150 ms)
    end
    W->>W: memory guard may raise stride after frame 1
    W-->>M: trajectory (coordinate buffers transferred)
    M->>M: setTrajectory → setupProps → applyTopology
    M->>M: guessAndApply() if any type has no element
    M->>M: fitModel → buildMeshes
    M->>M: link only: apply view params (rep, color, water, hb, arrows) and show stop captions
    M->>M: animation loop renders
```

---

## 9. Testing


| Layer | How | Command |
|---|---|---|
| Parsers, topology, geometry | `tools/test_parser.mjs`: Node + `assert` on the synthetic fixture (`tools/fixtures/`) and hand-built edge cases. Covers frame/ID ordering, image-flag unwrapping, scaled and triclinic coordinates, XYZ, stride, streaming, the memory-guard stride, truncated files, groups and water detection, repairing 1,566 split bonds, continuous paths, triclinic minimum image, measurements, periodic and triclinic bond inference, and 30k-atom bond-inference speed. | `node tools/test_parser.mjs` |
| Desktop UI | Browser checks through `window.viewer` (`screenOf(i)` converts an atom to screen pixels for real clicks) | manual / scripted |
| Teaching features | `tools/test_features.mjs` (see below) | `node tools/test_features.mjs` |
| Hand tracking | Node (`tools/test_features.mjs`): synthetic hands for open, fist, half-curled (no flicker), pinch (not a fist), small and large hands, untracked joints; poke press/hover/release, no press from behind, release off the edge. Emulator (IWER in hand mode): hand models load, rays show, menu on the left wrist joint, fingertip poke on *H-bonds* and *play* (press and toggle back), one-fist grab moves the system exactly with the wrist, two fists scale by the hands' spread ratio, AR passthrough hides the hand models. IWER has no fist pose (tests use `fistOverride`) and doesn't apply pinch values, so pinch→select was driven by dispatching `selectstart`/`selectend` | `node tools/test_features.mjs`; scripted |
| Automatic transcripts | Node: `cleanTranscript`, the worker's pinned transformers.js version matches the service worker's cache prefix. Browser with a stand-in engine (`viewer.tx.engine`): *Transcribe segments without text* fills only the empty segment, with the audio cropped to its trim (1.2 s → 19 200 samples), keeps typed text, updates the text box and the lesson transcript, marks the lesson unsaved, shows download progress; *✎ auto* replaces after confirming; an engine error shows a message and stops the queue. The real Whisper download and recognition were not run here (the automated check blocked loading outside code) | `node tools/test_features.mjs`; scripted |
| Gestures and transcripts | Node: event lookup, motion interpolation (45° halfway through a 90° turn, shortest arc), compaction, file validation, subtitle chunking, transcripts and tracks through the lesson file. Browser (frames driven with `viewer.step()`): a desktop recording with mouse pointing, a 60° camera orbit and a pick records pointer events, 27 motion samples ending at 60° and the pick; replayed in Watch the molecule holds still, turns to exactly 60° in step with the recording, the pick and pointer halo appear on schedule, subtitles show and clear. VR recording (grab → motion, ray → pointer) and the VR subtitle panel were not run (the emulator needs a visible pane) | `node tools/test_features.mjs`; scripted |
| Voice lessons | Node: lesson-file round trip with audio bytes, sorting, metadata, the plain-array tour format, share-link stripping, file sniffing. Browser (real `MediaRecorder`, a 440 Hz tone standing in for the mic): desktop record, re-take keeps the caption, too-short rejected, save → reload → open restores the clip byte-for-byte and it decodes as audio, unsaved-clip warning; emulator VR: hold-to-talk, hear, two-press delete, wait toggle | `node tools/test_features.mjs`; manual / scripted |
| VR | IWER emulator with scripted controller poses and buttons. Verified: placement, the menu (play, step, timeline, style, color, water, paths, and after the lesson update: the third button row, next-stop, caption and plot panel; after the UI update: the Explore/Lesson switch both ways, next stop, atoms +, water, play/pause, all by aiming the controller and pulling the trigger), atom picking and occlusion, one-hand grab (exact translation), two-hand scale (exact ×2), A button, stick scrub, stick-click reset. | open `/?sample&emulate` |
| Lessons and links | Browser checks: stops pause playback at the right frame, a copied share link restores mapping, settings and stops in student mode | manual / scripted |
| Offline app | Browser check on a `dist/` build (launch config `viewer-dist`): the service worker caches all 26 files; with the server stopped, the page, three.js, the sample and its tour load; a gzipped dump (renamed, and without `.gz`), a plain dump with a data file, and XYZ all open from the file input | manual / scripted |
| Real headset | Not yet done | see README |

`tools/test_features.mjs` covers the teaching features on a hand-built water dimer: extra
columns and vector detection, diverging ranges, a gzip round-trip through
`DecompressionStream`, element guessing, exactly one H-bond in a linear dimer and none
when bent, the shell mask, and the acceptor rule (planar, pyramidal, 4-bonded and
2-bonded N). On the bundled caffeine sample, guessing gets all 26 types right (this map is
built into `loadSample`). The tour's numbers (box size and density, shell size, H-bonds per
acceptor) were computed from the data with these modules, periodically, over the
equilibrated frames 12–51 only; the viewer reproduces the per-frame counts exactly (333
shell waters at frame 21, 25 solute H-bonds at frame 26). Periodic contact tests cover
orthogonal and triclinic boxes, an image shifted by a lattice vector, boxes too small for
3 cells, and both search directions of `nearMask`.

`tools/make_sample.py` makes the synthetic fixture (`tools/fixtures/synthetic.*`): 90 waters and 3 glycines in an
18 Å box, 120 frames, with shuffled rows, wrapped coordinates and image flags, numeric
types and a data file with masses and bonds. It's built to exercise the parser, not to
be physically realistic.

---

## 10. Extending the viewer

| Task | Where to change |
|---|---|
| Use another per-atom dump column | Nothing to do: every unknown column is already kept (`frame.props`) and offered under *Color by*. New 3-component families go in `vectorFamilies` (`props.js`) to get arrows and a magnitude. |
| New fixed coloring mode (e.g. by residue) | Add an `<option>` to `#colorBy`, a branch in `computeStyle`, and a name in `COLOR_NAMES` (the VR menu and left stick cycle through all `#colorBy` options automatically) |
| New colormap | A stop table in `props.js` and a branch in `colormap` / `gradientCSS` |
| Another element-guessing rule | `guessElements` in `chem.js` (per-type features are in `feat`); add a case to `tools/test_features.mjs` |
| Something else saved in lesson stops | `captureStop` / `applyStop` in `main.js` (the `v` object), plus a link parameter in `shareLink` / `loadFromParams` if it should also be a top-level setting. Lesson files carry any stop field automatically (`lessonToJSON` copies the stop); binary data needs a branch like `voice`. |
| Hide another control in student mode | Add `class="adv"` to it in `index.html` |
| New representation | Option in `#rep`, a radius rule in `atomRadius`, a bond radius in `updatePositions`, and an entry in `REPS` / `REP_NAMES` |
| New VR menu button | Add `[id, labelFn]` to `GRID.explore` and/or `GRID.lesson` in `menu` (2×4 each; more needs a third row, so the canvas `H` and footer positions grow), a `case` in `menu.press`, and an `enabled` rule if it can be unavailable |
| New element | Add a row to `ELEMENTS` in `elements.js` (color, covalent and vdW radii, mass) |
| Another file format (e.g. PDB, DCD) | A new parser class with `push(line)` / `finish()` that returns the trajectory model; register it in `detectFormat` / `createTrajectoryParser`. Binary formats like DCD need a byte-level reader in the worker instead of the text-line path. |
| Very large trajectories | Replace "all frames in memory" with a preprocessed binary file plus on-demand frame loading; the per-frame pipeline only needs `frames[i].pos` for the current and next frame |

### Conventions

- **Atom index `i`** (sorted by atom-ID) is the only key used across modules. Convert to
  and from LAMMPS IDs only at the edges (parsing, display, data-file bonds).
- **Bonds** are a flat `Int32Array` `[i0, j0, i1, j1, …]`.
- **Positions** are flat `Float32Array` `[x0, y0, z0, x1, …]` in Å. Only `root` and the
  scene are in metres.
- Any state change that affects geometry sets `S.dirty = true`. The animation loop does
  the rest.
