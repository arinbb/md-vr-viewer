# MD Trajectory VR Viewer (prototype)

A browser-based viewer for **LAMMPS** trajectories that works on a laptop *and* in VR
headsets (WebXR). Load a dump file (plus an optional data file), then play, rotate,
grab and inspect atoms. See [SCOPING.md](SCOPING.md) for why WebXR, how it compares to
VMD/Godot/Unity/Unreal, and questions for the lab.

**Live:** https://arinbb.github.io/md-vr-viewer/?sample (the app; opens the caffeine sample
and its tour). On a Quest 3, open that address in the Quest browser to view in VR or install
it as an app (see *Quest 3 app* below).

## Run it

You need any static web server; nothing to install or build.

```bash
python -m http.server 8137
```

Then open http://localhost:8137 and click **Load sample** (or open
`http://localhost:8137/?sample`). The sample is real MD data from the course's students:
8 caffeine molecules in 3,000 waters, a 51-frame NPT run (`samples/caffeine_water.lammpstrj.gz`,
a `dump custom` with scaled coordinates and numeric types; the element map is built in). It
opens with a seven-stop guided tour (equilibration of the box, the hydration shell, which
caffeine atoms accept H-bonds, a distance plot); use **Next stop** or press play. The tour
lives in `samples/sample.lesson.json` and is a good template for your own lessons. Its
numbers were checked against the data.

### In a headset

WebXR only runs on `https://` pages or `localhost`.

- **PC VR (Quest Link / SteamVR):** open the localhost URL in Chrome or Edge on the PC
  and click **Enter VR**. Chrome and Edge talk to whichever **OpenXR runtime** is active,
  so any headset SteamVR drives works the same way:
  - **HTC Vive / Index / other SteamVR headsets:** start SteamVR and make it the OpenXR
    runtime (SteamVR settings → OpenXR → *Set SteamVR as OpenXR runtime*). Vive wands have a
    trackpad instead of a thumbstick and no A/B buttons: the trigger, grips and the wrist
    menu do everything, the right trackpad scrubs while touched, and pressing it resets the
    view. Play/pause and style are on the menu.
  - **Quest through SteamVR** (Quest Link, Air Link, Steam Link or Virtual Desktop with
    SteamVR): same as above; the Quest controllers keep all their shortcuts.
  - Mixed classrooms are fine: each PC drives its own headset, and the same page works on
    all of them. (Neither has been tried on real hardware yet; see limitations.)
- **Quest via Virtual Desktop (wireless PC VR, the setup on the dev machine):**
  1. Start the server on the PC (above) and keep it running.
  2. In Virtual Desktop's streamer settings, set the OpenXR runtime to **VDXR**. Chrome
     and Edge use whatever OpenXR runtime is active.
  3. Put on the Quest, open Virtual Desktop and connect to the PC.
  4. From the streamed desktop, open `http://localhost:8137/?sample` in Chrome. If the
     button says *No headset*, reload the page now that the headset is connected (hover
     the button for tips).
  5. Click **Enter VR**. The system appears floating about 0.7 m in front of you at
     chest height; grip with a controller to grab it.

  If Chrome still reports VR as unsupported, try Edge, or switch the runtime to SteamVR
  (with SteamVR running) as a fallback.

  **If the page freezes** ("This page isn't responding") after *Enter VR*: close the tab,
  open the page again and look under the status line. It says which start-up step the frozen
  try reached (the steps are saved as they happen), and the next *Enter VR* starts in **safe
  mode**, asking only for `local-floor` and hand tracking (no layers or bounded floor). Add
  `?xrsafe` to the address to force safe mode. If the official WebXR samples
  (immersive-web.github.io/webxr-samples) freeze too, the problem is the browser and runtime
  combination, not the viewer: try Edge, or SteamVR as the OpenXR runtime.
- **Quest standalone, during development:** connect the headset by USB with developer
  mode on, then run the command below and open `http://localhost:8137` in the Quest
  browser:

  ```bash
  adb reverse tcp:8137 tcp:8137
  ```

- **Passthrough (AR):** where the browser supports it (the Quest browser on Quest 2, 3,
  3S and Pro), an **Enter AR** button appears next to *Enter VR*. The molecules then float
  in your real room, with no floor grid. The wrist menu's **room: on/off** button switches
  between seeing the room and a dark VR-style backdrop without leaving the session. PC
  browsers over Quest Link or SteamVR usually don't offer AR, so the button stays hidden
  there.

- **Classroom:** host the folder on any HTTPS static host (GitHub Pages, university
  web space). Students just open the URL. See the next section for a Quest app that works
  without a PC.

### Quest 3 app (standalone, works offline)

The viewer can be installed on a Quest 3 as an app with its own icon. Once installed it
runs without a PC and without a network; students' files open from the headset's
Downloads folder and never leave it.

1. **Build the upload folder** on the PC:

   ```bash
   python tools/build_site.py --no-sample
   ```

   This writes `dist/` with only the files the app needs. `--no-sample` leaves out the
   students' caffeine run and hides *Load sample*. Anyone with the address can download what
   you upload, so include the sample (no flag) only if the data may be shared.
2. **Host `dist/` on an HTTPS address.** Any static host works, for example university web
   space, a GitHub Pages site, or Netlify (drag the folder onto app.netlify.com/drop). The
   address can be unlisted. WebXR refuses plain `http://` on a headset.
3. **On the Quest 3:** open the address in the Meta Quest browser, wait for the page to
   finish loading, then choose **Install** / *Add to library* from the browser's menu (the
   ⋮ or address-bar icon). The viewer appears in the app library.
4. **Go offline once to check:** with Wi-Fi off, open the app. It should start, and *Enter
   VR* should work. The app, three.js and the Quest 3 controller models are cached on
   install.

**Students' files on the headset:** download them in the Quest browser (Google Drive,
OneDrive, Dropbox or email), then in the app use **Open files…** and pick them from
*Downloads*. Select the dump and its `.data` file together if there is one. Supported:
`dump custom` / `dump atom` (`.lammpstrj`, `.dump`, any name), gzipped dumps (`.gz`, even if
the download renamed them), LAMMPS data files and `dump xyz`. The Quest budget is about
0.8 GB of coordinates; bigger runs load every Nth frame automatically and say so.

**Updating the app:** rebuild `dist/` and upload it again. The app always starts from its
complete offline copy (so it never runs a mix of old and new files). When it is opened online
it downloads the new version in the background and shows *A new version of the viewer is
ready. Reload*; the next start uses it. If you change which files the app needs, bump
`VERSION` in `sw.js`.

**No headset?** Open `http://localhost:8137/?sample&emulate`. This loads Meta's WebXR emulator
(IWER) into the page, so *Enter VR* works in any desktop browser with a simulated Quest 3.

### Open a trajectory from a link

Put the files next to `index.html` (or anywhere the page can fetch them) and share a URL:

```
index.html?traj=runs/peptide.lammpstrj&data=runs/peptide.data&map=1:C+2:H+3:O+4:N&fs=2&stride=5
```

`traj` and `data` are file URLs, `map` is the type→element mapping, `fs` is the LAMMPS
timestep size in femtoseconds (shows simulated time), and `stride` loads every Nth frame.
This is the easiest way to hand students a ready-to-go scene.

You don't have to write these by hand: set up the view, add lesson stops, and click
**Copy share link** (see *Lessons* below). Other link options:

| Parameter | Values |
|---|---|
| `rep` | `ballstick`, `spacefill`, `licorice` |
| `color` | `element`, `type`, `mol`, `mag:v` (speed), `mag:f` (force magnitude), `p:<column>` (e.g. `p:q`) |
| `water` / `shell` | `all`, `near` (solvation shell), `hide` / shell radius in Å |
| `hb` | `off`, `solute`, `all` (hydrogen bonds) |
| `arrows` | a vector column family: `v`, `f`, `mu`, or a compute name like `c_myforce` |
| `stops` | lesson stops (written by *Copy share link*) |
| `lesson` | address of a lesson file (`.lesson.json`, with voice clips) to load after the trajectory |
| `student` | no value; hides loading, atom-type and expert controls |

## Supported input

| File | Notes |
|---|---|
| `dump custom` / `dump atom` (`.lammpstrj`, `.dump`, any name) | Needs `id`, `type` or `element`, and coordinates. Uses `xu yu zu` > `x y z` (+ `ix iy iz` image flags, unwrapped automatically) > `xs ys zs` / `xsu ysu zsu`. Optional `mol`, `element`. Any other columns (`vx vy vz`, `fx fy fz`, `q`, `c_pe`, `c_name[1]`…) are kept per frame for coloring and arrows. Orthogonal and triclinic boxes. Atoms may be reordered between frames (matched by `id`). |
| Gzipped versions of any of these (`.gz`, e.g. `dump custom/gz`) | Decompressed in the browser while streaming. |
| `dump xyz` | Constant atom order assumed; no box. |
| LAMMPS data file (`.data`, `.lmp`, `data.*`) | Optional. Provides **Bonds**, **Masses** (used to guess elements from numeric types), type labels and molecule-IDs. |

Recommended dump command for best results:

```
dump 1 all custom 1000 traj.lammpstrj id mol type element xu yu zu vx vy vz
dump_modify 1 sort id element C H O N   # element names per type, if you use them
```

**Elements** are picked in this order: the "Map numeric types" box (e.g. `1:C 2:H 3:O`)
> the dump's `element` column > data-file type labels > data-file masses > a type name
that looks like an element. Type labels and names are read as force-field atom types:
AMBER/GAFF `CA`/`ca` is carbon and `NA` nitrogen, while `Ca`, `Na+`, `Cl-` and CHARMM ion
names (`SOD`, `POT`, `CLA`) are the ions. United-atom masses (CH, CH2, CH3, CH4) count as
carbon. If types are still unknown (a bare dump with numbered types),
the viewer **guesses them from bond geometry**: hydrogens from short X–H contacts, O/N/C
from their X–H lengths, coordination and bond lengths, and C vs N in rings by checking
which choice gives every sp2 atom a double-bond partner. Guesses are marked *guessed* in the
*Atom types* table (uncertain ones with *?*, hover for the reason), and a note under the
status line says how many were guessed. Each type has a dropdown to correct it, and the
mapping goes into share links. **Guess elements from structure** re-runs it on demand. On the caffeine-in-water test file all 26 types come out
right.

**Bonds** come from the data file if it has a `Bonds` section; otherwise they are
inferred from covalent radii on the first, middle and last frames. A bond is kept if it shows
up in at least two of them, so overlaps in an unequilibrated starting structure don't create
fake bonds. Bonds that cross periodic boundaries are found too (within the same molecule when
molecule-IDs are known). For reactive force
fields (ReaxFF) tick **Recompute bonds every frame**. This costs ~30 ms per frame change
at 24k atoms, which is fine on desktop but can stutter in VR on big systems.

**Keep molecules whole, inside box** (on by default) undoes periodic splitting every frame:
each molecule is reassembled along its bonds (or around its first atom when only
molecule-IDs are known), then shifted so its center lies in the box. It works for wrapped,
unwrapped and image-flag dumps alike.

**Large files** are streamed in chunks, so files bigger than a browser string are fine. If
the frames won't fit in memory (≈2 GB desktop, 0.8 GB Quest browser at 12 bytes/atom/frame),
the viewer automatically loads every Nth frame and says so. You can also set **Load every
Nth frame** yourself. Measured: a 47 MB, 24k-atom, 60-frame dump loads in 0.4 s and plays
at 60 fps on desktop. Extra columns cost 4 bytes/atom/frame each and count toward the same
budget. The water shell and H-bond searches run once per data frame (not per display
frame), costing a few ms even with thousands of H-bonds.

**Big systems in VR: the Detail setting** (*Appearance* panel, and the *detail* button on
the wrist menu). A headset draws everything twice at 72–90 frames per second, so large
systems can lag. Detail changes only how atoms are **drawn**; H-bond counts, the water shell
and measurements are identical at every level.

| Detail | What changes | Caffeine sample, all water |
|---|---|---|
| **High** | Full-quality spheres, smooth in-between frames | 2.6 M triangles |
| **Medium** | Simpler spheres and bonds; in VR, playback moves atoms on whole data frames only | 1.3 M |
| **Low** | Medium, plus each water molecule drawn as one red bead (caffeine keeps full detail) | 0.2 M |
| **Auto** (default) | High on the desktop. In VR it starts from the number of shown atoms and the device (stricter on a standalone Quest), then lowers itself if frames keep arriving late, with a note on the wrist menu | |

Hidden atoms cost nothing to draw: showing water *near solute* draws about 1,200 of the
sample's 9,200 atoms. For very large systems in VR, combine *Low* with *Water: near solute*.
Auto never raises the detail by itself during a session; use the menu's *detail* button.

## Teaching tools

- **Measure:** click an atom, then shift-click up to 3 more for a live distance, angle or
  dihedral. In VR, trigger successive atoms. Values update as the trajectory plays.
- **Paths:** tick *Show paths of selected atoms* to trace where they have been. This is
  good for showing diffusion, and paths stay continuous across periodic boundaries.
- **Water:** *Show all*, *Near solute only* (the solvation shell: water molecules with any
  atom within the shell radius of a non-water atom, recomputed as molecules move), or
  *Hide*. (*Near solute* is disabled for pure water, where there is nothing to be near.)
- **Hydrogen bonds:** dashed lines for D–H···A where H···A ≤ 2.5 Å and the D–H···A angle
  ≥ 120°, including across the periodic box edge. Donors are H on N/O/F. Acceptors are F,
  O with up to two bonds (not H₃O⁺), and N with a free lone pair: N with
  four bonds (e.g. NH₃⁺) and planar N with three bonds (amide, aromatic or methylated ring N,
  like caffeine's N1/N3/N7) are not counted, since their lone pair is tied up. *With solute* shows only H-bonds that involve a
  non-water molecule; *All shown atoms* includes water–water ones. The count is shown.
  They are drawn as short cyan dashes (3D cylinders, so they stay visible in a headset).
- **Color by data:** any extra dump column (charge, per-atom energy...) or a vector's
  magnitude (speed, force) on a viridis scale, or a blue–white–red scale for signed values,
  with a legend. Ranges use the 2nd–98th percentile over the whole trajectory, so one
  outlier doesn't wash out the colors.
- **Arrows:** velocity, force or any 3-component column as arrows on each shown atom,
  auto-scaled so a typical vector is ~1.5 Å long, with a length slider.
- **Measurement plot:** with 2–4 atoms selected, a graph of the distance, angle or dihedral
  over the whole trajectory with a marker at the current frame. Click it to jump (in VR
  the plot on the wrist menu works as a timeline too).
- **Find atom-ID:** type an ID from a LAMMPS input or log to jump to that atom.
- **Simulated time:** enter the timestep size (fs) to show t = … ps/ns next to the frame.
- **Screenshot** button (or <kbd>P</kbd>) saves the current view as a PNG for slides
  or handouts.
- Display settings (style, colors, sizes, speed, timestep size) are remembered per browser.

## The screen

- **Side panel** (top left, ▾/▸ to fold any section; folding is remembered): the status line,
  the **Explore / Lesson** switch, then *File* (open, stride, atom types), *Appearance*,
  *Water & H-bonds*, *Select & measure*, *Lesson*, *Advanced* and *Controls & help*. The
  File section folds itself away after a file loads, unless atom types need checking.
  The – button hides the whole panel; on a phone it folds itself after loading.
- **Playback bar** (bottom, like a video player): step, play, the frame slider, frame and
  time, speed, previous/next lesson stop (Lesson mode), reset view, screenshot,
  **Enter AR** (passthrough headsets only) and **Enter VR**.

### Two modes: Explore and Lesson

- **Explore** is free use. Change anything, play, measure; lesson stops never fire and no
  caption is shown. Files without stops open in Explore.
- **Lesson** plays the stops: when playback reaches one, it sets the view and settings and
  shows its caption (and pauses, if *Pause at each stop* is on). Stops are authored in this
  mode too. The sample and share links with stops open in Lesson.
- Found a good moment while exploring? **＋ Save this moment as a lesson stop** switches
  to Lesson without touching the view and opens the caption box.
- Switching back to Lesson restores the stop for the current frame, so a student who
  wandered off in Explore is put back on track. <kbd>N</kbd>/<kbd>B</kbd> (or the stop
  buttons) switch to Lesson automatically.
- The same switch is on the VR wrist menu, and the menu's buttons follow the mode.

## Lessons (narration over time)

A **stop** ties a caption to a frame, together with the camera, the selected atoms and the
display settings (style, coloring, water, H-bonds, arrows, paths) at that moment.

- **Make one:** in Lesson mode, open *Edit stops and share*, go to the moment, set up the
  view, type a caption and click **Add stop here**. **Update stop** overwrites the highlighted one; ✕ deletes. Stops are kept in
  frame order.
- **During playback** (Lesson mode) the latest caption at or before the current frame is shown on screen
  and in the VR wrist menu. When playback reaches a stop, its settings and selection are
  applied, and with *Pause at stops* on, playback pauses so a student can read and look
  around.
- **Navigate:** the ⏮ / ⏭ stop buttons in the playback bar, a click in the stop list, <kbd>B</kbd>/<kbd>N</kbd> on the keyboard, the stop buttons
  on the VR menu, or left stick up/down in VR. Stops show as yellow ticks on the VR timeline.
- **Share:** **Copy share link** produces a URL with the file, element mapping, display
  settings and all stops. With *student mode* ticked, the link hides the loading,
  atom-type and editing controls. If you opened a local file, put it next to `index.html` on
  the server under the same name.

### Voice lessons (record in the headset)

Any stop can carry a **voice clip**, so you can build a narrated lesson without typing.

- **In VR:** go to a moment (play, pause, step with B/Y), set up what you want to show, then
  point at **● hold to talk** on the wrist menu and **hold the trigger while you talk**.
  The button turns red with a timer, and the controllers buzz at the start and end.
  Letting go puts the clip on the stop at that frame, or makes a new stop with the frame,
  view settings and selected atoms as they were when you started talking. Recording again at
  the same frame replaces the clip and keeps the caption. **▶ hear stop** plays it back;
  **✕ delete stop** removes the stop (press twice). Clips can be up to 3 minutes.
- **On the desktop:** *Lesson → Edit stops and share → ● Record voice* (click again to stop).
  In the stop list, ▶ 0:12 plays a clip.
- **Microphone:** the browser asks once. If you plan to record in the headset, press
  **Allow microphone** on the page before entering VR, because a permission prompt may not
  show inside VR.
- **Students** hear each clip when playback reaches its stop. With *Wait for voice clips*
  on (default), playback pauses for the clip and carries on when it ends. ⏮ / ⏭ and the
  stop list play the clip too. Stops with only a voice show *Voice note* as their caption.
- **Saving and sharing:** clips live in the page until you click **Save lesson file**. It
  downloads `<trajectory>.lesson.json` with every stop and clip inside (about 4 KB per
  second of voice). The page warns before closing with unsaved clips. Students open the
  lesson file **together with the trajectory** (*Open files…*, select both), or on its own
  once the trajectory is open. Hosted: put it next to the data and add `&lesson=` with its
  address to a share link. Share links themselves can't hold audio.

## Controls

- **Desktop:** drag to rotate, scroll to zoom, right-drag to pan, click an atom to
  inspect it, shift-click to measure, double-click (or <kbd>F</kbd>) to orbit around it.
  <kbd>Space</kbd> play/pause, <kbd>←</kbd>/<kbd>→</kbd> step, <kbd>Esc</kbd> clear selection,
  <kbd>R</kbd> reset view, <kbd>P</kbd> screenshot, <kbd>N</kbd>/<kbd>B</kbd> next/previous stop.
- **VR:** on entering, the system appears about 0.75 m in front of you, just below eye
  level, wherever you are standing or sitting.
  - **Wrist menu** (on the left controller, always turned toward your eyes): point with the
    right controller and pull the trigger. Top to bottom: status, the timeline (drag to
    scrub; yellow ticks are stops), an info panel (the stop's caption in Lesson mode, else
    the measurement plot), a step / play / step / reset row, the **Explore | Lesson** switch
    (in AR with a **room: on/off** passthrough toggle beside it),
    and eight buttons for the current mode:
    - *Explore:* style, coloring, water, H-bonds, paths, arrows, atoms −, atoms +.
    - *Lesson:* previous stop, next stop, restart, pause-at-stops on/off, style, coloring,
      water, H-bonds.
  - **Grip** to grab and move the system; **both grips** to scale and rotate it.
  - **Trigger** on atoms to pick them (up to 4 for measuring; trigger on empty space clears).
    The ray stops on whatever it is pointing at.
  - Shortcuts: A/X play/pause, **B** (right) one frame forward and **Y** (left) one frame back
    (hold to keep stepping), thumbstick click re-centers the view, right stick
    ←→ scrub / ↑↓ speed, left stick ←→ coloring / ↑↓ next/previous stop in Lesson mode
    (cycles the water display in Explore). On trackpad controllers (Vive wands) the pad
    acts as the stick while touched, and pressing it re-centers.
  - **Hand tracking** (put the controllers down on a Quest):
    - Your hands are drawn (hidden in AR passthrough, where you see your real ones), each
      with a pointing ray.
    - **Pinch** to pick an atom or press the wrist-menu button the ray points at; the pick
      happens when you let go.
    - **Make a fist** to grab and move the system; **two fists** scale and rotate it, like
      the grip buttons.
    - Or **poke** a wrist-menu button with your index fingertip (the menu sits on your left
      wrist). A click sound confirms presses, since hands have no vibration.
    - The A/B/X/Y and stick shortcuts have no hand equivalent: use the menu for play, stepping
      and lesson stops.

## Layout

How the pieces fit together (libraries, modules, data flow, algorithms, VR
interaction, testing, how to extend it) is documented in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). To have someone rebuild the project from
scratch, hand them [docs/REBUILD_BRIEF.md](docs/REBUILD_BRIEF.md): what to build, the core
layers, how each feature plugs in, and how to check their version.

```
index.html            UI + import map (three.js 0.169 from jsDelivr)
src/main.js           rendering, playback, desktop + VR interaction
src/lammps.js         dump / xyz / data-file parsers (runs in browser and Node)
src/model.js          element resolution, periodic bond inference, radii, box geometry
src/analysis.js       make-whole/wrap, measurements, atom paths, water detection
src/chem.js           element guessing, solvation-shell masks, hydrogen bonds
src/props.js          extra dump columns: vector detection, color ranges, colormaps
src/elements.js       element colors / radii / masses
src/voice.js          voice clips: recorder, player, lesson files (.lesson.json)
src/gestures.js       hand tracking: fist and fingertip-poke detection from hand joints
src/parse-worker.js   streams (and gunzips) files off the main thread (memory guard)
samples/caffeine_water.lammpstrj.gz  the sample: caffeine in water, real student NPT run
samples/sample.lesson.json  the sample's guided tour (lesson stops, same format as share links)
tools/fixtures/       synthetic parser fixture (random-walk molecules; not physical)
tools/make_sample.py  regenerates tools/fixtures/synthetic.lammpstrj + .data
tools/test_parser.mjs   parser, bond and wrapping tests:  node tools/test_parser.mjs
tools/test_features.mjs columns, gzip, guessing, H-bond, shell tests:  node tools/test_features.mjs
docs/ARCHITECTURE.md  how it is built (for maintainers)
docs/REBUILD_BRIEF.md what to ask a programmer to build a copy from scratch
sw.js                 service worker: offline cache for the installed (Quest) app
manifest.webmanifest  app name, icons and colors for installing
icons/                app icons (tools/make_icons.py draws them)
tools/build_site.py   copies the app into dist/ for hosting (--no-sample leaves the data out)
```

## Known limitations / next steps

- VR has been tested in the IWER emulator (menu, timeline, picking, one/two-hand grab,
  buttons, sticks), but not yet in a real headset. The Vive trackpad mapping follows the
  WebXR standard layout but hasn't been tried on a Vive. Comfort, menu size and placement need
  a real try-on.
- Reactive mode re-infers bonds from distances only (no bond orders). Molecule coloring
  and the water modes use the initial topology.
- Positions are held in memory as float32. For very long trajectories, a preprocessing
  step to a compact binary format (with on-demand frame streaming) would remove the
  frame cap.
- Element guessing covers common organic and biomolecular chemistry (H, C, N, O, S, P,
  water). Ions and unusual elements stay unknown; pick them in the table.
- H-bonds and the water shell are periodic: contacts across the box edge count (minimum
  image), so a shell water can appear at the opposite face from its solute, and such
  H-bonds are drawn as short dashes poking out of the box toward the partner's image.
- Lesson stops in VR don't move the view (only on desktop); the student stays where they
  are.
- Not yet started: recorded voice narration, video export, a multi-user/instructor-driven
  mode.
