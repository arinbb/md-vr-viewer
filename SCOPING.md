# VR molecular visualization for biology students: scoping notes

## What was asked

The lab runs LAMMPS molecular dynamics and dumps snapshots every N timesteps. Each
snapshot has, per atom, an **atom-ID**, an **atom type** (element or numeric type-ID) and
**XYZ coordinates**. Some formats also carry **molecule-IDs** and **bond/topology** data
(see https://docs.lammps.org/dump.html). The goal is to let biology students step
*inside* those trajectories in VR.

The two paths on the table:

1. **Use existing software (VMD)**, which already reads LAMMPS trajectories and has an
   immersive mode (described in the attached Stone et al. paper).
2. **Build something** in a game engine (Godot / Unreal / Unity) that plays back
   pre-produced coordinate trajectories.

## Assessment of the VMD-VR route

The attached paper describes VMD's immersive support as of ~2010: CAVE-style
displays and stereoscopic 3D TVs/projectors, tracked input via VRPN, haptic devices, and
interactive MD steering (IMD). VMD reads LAMMPS dumps very well, and researchers
already know it.

For a **student-facing, modern-headset** deployment, the problems are:

- **Headset support.** VMD's immersive mode was built for CAVEs, stereo displays and
  VRPN trackers, not for consumer headsets via OpenXR/SteamVR (Quest, Vive, Index).
  Later work from the same group (omnidirectional stereo ray-tracing streamed to
  headsets) depends on specific builds, NVIDIA GPUs and remote rendering. It isn't
  something a class can install and run. See the timeline below.
- **Standalone headsets.** Quest-class standalone headsets, the cheapest way to equip a
  classroom, can't run VMD at all.
- **UX.** VMD's interface is built for researchers (Tcl console, representations
  menus). Biology students need a few big, obvious controls.

### VMD headset support timeline (checked November 2026)

| When | What | Usable for a class? |
|---|---|---|
| ~2000s–2010 | CAVE library and **VRPN** trackers, buttons and haptics, configured in a `.vmdsensors` file. Stereo displays. This is what the attached paper covers. | No: needs CAVE or tracker hardware. |
| 2016 (HPDAV workshop paper, Stone, Sherman & Schulten) | Omnidirectional stereo **ray tracing (OptiX) on a remote GPU cluster**, streamed as H.264 to a local VMD client that rasterizes the view for the head-mounted display. Demos on Oculus Rift DK2, plus a VMD + Unreal chromatophore demo at SC'16. | No: research setup, NVIDIA-only. |
| 2017–2018 (VMD-L mailing list) | Experimental HMD code built on **OpenHMD** in development builds; one 2018 user reports running it on a Rift CV1 and Vive. In July 2018 John Stone wrote that VR in VMD was waiting on the first **OpenXR** release. | Barely: special builds, no documented setup. |
| 2021 (1.9.4 alpha 55) | Full-time interactive ray-tracing display mode on NVIDIA RTX GPUs (desktop, not VR). | n/a |
| 2025–2026 (VMD 2.0 alphas, latest 2.0.1a1, April 2026) | New UI, faster surfaces, real-time ray tracing. Builds for Linux, with some Windows and Apple Silicon alphas. **No headset, OpenXR or controller support mentioned.** | No VR. |

I found no evidence that VMD has ever shipped OpenXR support, or support for any current
headset (Quest 2/3, Index, Vive XR Elite) through SteamVR. Its LAMMPS reader is still the
best around, though it doesn't automatically unwrap triclinic cells.

**Worth asking the lab:** were they thinking of a specific VMD VR build or demo they've
seen? If so, that is a special research setup, and they should confirm it still builds.

**Verdict:** keep VMD as the *research* tool and the source of truth for checking that
our renderings match. Don't make it the classroom VR delivery vehicle.

## Prior art (checked November 2026)

Other existing tools worth a look before committing. We should try them on one of the
lab's real trajectories, not just read about them. Each feature here comes from the
project's docs, papers or forum posts; none has been tested by us yet.

| Tool | VR / headset | LAMMPS input | Cost | Notes |
|---|---|---|---|---|
| **NanoVer** (formerly Narupa, Bristol) | Quest 3/3S (Horizon Store, early access) and PC VR | `nanover-lammps` package (LAMMPS bindings/servers); MDAnalysis route for PDB+DCD | Free, open source | Strongest rival. Multi-user, built for interactive MD; can record and replay sessions. Students need a server running alongside. |
| **ChimeraX** + **ChimeraX-LAMMPS** bundle | `vr on` (PC VR via SteamVR/OpenXR) | Beta toolshed bundle: `open x.data coords x.dump` | Free for academics | Excellent rendering. LAMMPS support is a community beta. |
| **LookSee** (UCSF) | Quest standalone | None directly: ChimeraX exports GLTF scenes to it | Free, open source | Good for prepared static scenes, not trajectories. |
| **ParaView** + XRInterface plugin | PC VR (OpenXR/OpenVR) | Has a LAMMPS dump reader, but forum reports mention it reads only the first timestep and multi-file trouble | Free, open source | General science-visualization tool. Molecules need manual setup. |
| **GEARS** (USC) | PC VR (Unreal 4.16, Vive era) | Runs LAMMPS live or replays DUMP files; tested to 500k atoms | Free, open source | Closest in concept. Shows positions and types only, no bonds. Old engine version, little recent activity. |
| **VMD** | CAVE / stereo displays (see above) | Native, very good (no automatic triclinic unwrapping) | Free | The lab's research tool. |
| **UnityMol** | PC VR, some Quest 2 builds | PDB/GRO/XYZ + XTC, no LAMMPS dumps | Free for academics | Research-grade, Unity-based. |
| **Nanome** | Quest standalone | MD playback streamed from Nanome's web platform, via conversion | Commercial, per seat | Most polished student UX, but licensing costs. |
| **MolecularWebXR** (EPFL) | Any headset browser (WebXR) | None; prepared content via PDB2AR | Free, no sign-up | Same delivery model as ours (multi-user, for teaching). MD (HandMol) is still a prototype. |
| **Mol\*** | No VR | Has a LAMMPS trajectory parser (molstar 5.x) | Free, open source | Good desktop and web companion. |
| **Molecular Nodes** (Blender) | Blender VR scene inspection | Through MDAnalysis (data file + DCD likely needed) | Free | For polished pre-rendered animations, not interactive. |

**Takeaway.** Every option is missing one of these:
- reads the lab's LAMMPS dumps directly, with periodic boxes handled;
- runs on a standalone headset or any browser with nothing to install;
- has a student-friendly UI;
- is free.

NanoVer and ChimeraX + the LAMMPS bundle are the two to test seriously. If NanoVer's LAMMPS
route and Quest app work well for playback, it could replace or complement our viewer.
Live "push the atoms" sessions are its main strength.

## Engine choice if we build

| | WebXR (three.js) | Godot 4 | Unity | Unreal |
|---|---|---|---|---|
| Runs on Quest standalone | Yes, in the built-in browser | Yes (needs APK build + sideload) | Yes (APK) | Yes, but heavy |
| Runs on PC VR | Yes | Yes | Yes | Yes |
| Non-VR fallback (laptop) | Same page, mouse orbit | Separate build | Separate build | Separate build |
| Distribution to students | **A URL** | APK sideloading / store | APK / store | APK / store |
| Load *new* trajectories | Drag-and-drop file | Needs file browser on headset | Same | Same |
| Licensing | MIT | MIT | Per-seat terms | Royalty terms |
| Dev effort for this scope | Low | Medium | Medium | High |

### Perks and drawbacks of each option

**WebXR (three.js in the browser)**

- Perks
  - *Zero install:* students open a URL. The same page works on Quest (built-in
    browser), PC VR (Chrome/Edge + SteamVR/Oculus Link) and a plain laptop with a
    mouse, so students without a headset aren't left out.
  - *Easiest data path:* drag-and-drop a `.lammpstrj` straight from the cluster, with no
    asset import or rebuild. Researchers can share a new trajectory the same afternoon.
  - *Fast iteration:* edit JS, reload. No multi-minute Android builds, no sideloading,
    no developer-mode headsets.
  - *Text-heavy work suits it:* parsing, UI panels, tables and exports are much easier
    in JS than in engine UIs.
  - *Free, open, and easy to host:* MIT-licensed and served as static files.
- Drawbacks
  - *Performance ceiling:* JS + WebGL on a Quest browser is roughly 2–5× slower than a
    native build. Comfortable up to ~20–50k atoms with instancing on standalone
    headsets; beyond that you need decimation, LOD or a PC.
  - *Memory:* the browser tab's memory limit on Quest (a few GB) caps how many frames
    you can hold. Long trajectories need streaming or a binary preprocessing step.
  - *HTTPS required* for WebXR outside `localhost`, so it needs a hosted site or
    `adb reverse` while developing.
  - *Fewer XR niceties:* no built-in interaction toolkit (we write grab/scale code
    ourselves), and passthrough/hand-tracking support depends on the browser.
  - *Browser variance:* Safari/visionOS and some browsers lag behind on WebXR features.

**Godot 4 (OpenXR)**

- Perks
  - *Open source (MIT), with no licensing or royalty surprises.* That matters for a
    university project that might outlive grants.
  - *Lightweight:* small editor, quick to learn, GDScript is approachable for student
    developers. Native OpenXR support, and Quest export via the Godot OpenXR vendors
    plugin.
  - *Native performance* (MultiMesh instancing, compute shaders in 4.x), so it scales
    to larger systems than the browser.
  - *Easy to port to:* the parser and data model in this repo translate to GDScript/C#
    almost line for line.
- Drawbacks
  - *Distribution friction:* Quest needs an APK sideloaded (developer mode) or a store
    listing; PC needs an install.
  - *Loading new data on a standalone headset is awkward:* you have to copy files onto
    the device or add a download-from-URL feature.
  - *Smaller XR ecosystem* than Unity: fewer ready-made interaction samples, and the
    mobile (Quest) renderer is less mature.
  - Separate builds and testing per platform.

**Unity (OpenXR / XR Interaction Toolkit)**

- Perks
  - *The most mature XR stack:* the XR Interaction Toolkit gives grab, ray, UI and
    teleport out of the box. Meta's SDK is first-class, including hand tracking and
    passthrough.
  - *Existing molecular work to borrow from:* UnityMol and NanoVer/Narupa are
    Unity-based and open source, so we could reuse code or even extend NanoVer for
    live interactive MD.
  - *Big talent pool:* many students already know Unity/C#, and there's lots of
    documentation and Q&A.
  - Strong performance tools (GPU instancing, Burst/Jobs for parsing big files).
- Drawbacks
  - *Licensing risk:* terms have changed abruptly before (the 2023 runtime-fee episode).
    Academic/Personal tiers are fine today, but that is a dependency on a company's
    policy.
  - Same *APK/sideload distribution* and *data-on-headset* problems as Godot.
  - Heavy editor and project files that are hard to diff in git; slow Android builds.
  - More engine than this problem needs.

**Unreal Engine 5**

- Perks
  - *Best-looking rendering:* lighting, ambient occlusion and depth of field, if the
    goal is cinematic, museum-quality visuals or recorded videos.
  - Powerful Niagara particle system could render huge atom counts on a PC.
  - Free until $1M revenue (irrelevant for teaching).
- Drawbacks
  - *Poor fit for Quest standalone:* Lumen/Nanite don't run there; mobile rendering
    means giving up most of what makes Unreal attractive.
  - *Steepest learning curve:* C++/Blueprints, a very large editor, long compile
    times, big builds.
  - Custom file parsing and runtime data loading take more work than in the others.
  - Overkill for spheres and cylinders; the hardest to hand off to a future student
    maintainer.

**Existing software (VMD / ChimeraX / NanoVer)**

- Perks: no build effort, scientifically trusted, and researchers already know VMD.
- Drawbacks: researcher-oriented UX, PC-tethered (or legacy-display) VR, and conversion
  steps for LAMMPS data. On standalone headsets the options are commercial Nanome and
  NanoVer's early-access Quest app (which needs a server running alongside).

### Rule of thumb

- *Quick classroom access, mixed hardware, frequently changing data* → **WebXR**.
- *Systems over ~50k atoms on standalone headsets, or an offline kiosk app* → **Godot**
  (open, with no licensing risk) or **Unity** (if you want NanoVer/UnityMol code or
  Meta's hand-tracking polish).
- *Live, interactive MD where students push atoms around* → extend **NanoVer**
  (Unity) or VMD IMD rather than building from scratch.
- *A cinematic showcase on a powerful PC* → **Unreal**.

Rendering a few thousand to tens of thousands of spheres and cylinders with instancing
is well within what any of these can do. The hard parts here are **distribution**
and **getting the lab's data in**, not graphics. That favors WebXR strongly.

## Recommendation

**Start with a WebXR viewer that reads LAMMPS dump files directly**, prototyped in this
repo. It:

- opens on a laptop (mouse/trackpad) *and* on a headset (Enter VR button), from the
  same URL;
- parses LAMMPS text dumps (`atom`, `custom`, `xyz`, also gzipped), including
  scaled/unwrapped coordinates, triclinic boxes, atom re-ordering between frames, and any
  extra columns (velocities, forces, charges);
- optionally reads a LAMMPS **data file** for real bonds; otherwise infers bonds from
  distance;
- maps numeric type-IDs to elements: from the data file, or guessed from bond geometry
  when there is none (editable), with CPK coloring;
- plays back the trajectory, with grab/rotate/scale and atom inspection in VR;
- adds teaching tools: solvation shells, hydrogen bonds, coloring and arrows from data
  columns, measurements plotted over time, and timed lesson stops (captions + saved
  views) shared as a link that opens in a simplified student mode.

If we later need features the browser can't handle (e.g. huge systems at high frame
rates, or live interactive MD steering), the parser and data model carry straight over
to Godot. WebXR is a cheap way to find out what students actually need first.

## Phases

1. **Prototype (this repo, done):** file loading, playback, desktop + VR interaction, sample
   data. Goal: put a headset on someone in the lab and get a reaction.
2. **Pilot with real lab data:** test on 2–3 real trajectories; tune performance
   (frame decimation, a preprocessed binary format for large runs); pick color and
   representation defaults.
3. **Teaching features (first version done):** lesson stops with captions, saved views and
   settings; share links with a student mode; molecule-ID coloring; distance, angle and
   dihedral measurement with a plot over time; trails; solvation shells; hydrogen bonds;
   coloring and arrows from dump columns. Still open: recorded voice narration, video
   export, and an instructor-driven multi-headset mode, once the lab says what students
   should notice (question 5).
4. **Deployment:** host on a static site (GitHub Pages / university web space, HTTPS
   required for WebXR); set up a few classroom headsets.

## Questions for the group meeting

1. **System sizes:** typical atom count and number of frames? (This decides whether we
   need a binary preprocessing step.)
2. **Which dump styles** do you actually use: `custom` with `id type x y z`? `element`?
   `mol`? Scaled or unwrapped coordinates?
3. **Bonds:** do you have the LAMMPS data file with a `Bonds` section, or are
   distance-inferred bonds acceptable? Any reactive force fields (ReaxFF) where bonds
   change over time?
4. **Hardware:** which headsets are available (Quest 2/3, PC-tethered Vive/Index)? Is
   there a VR-capable PC?
5. **Learning goals:** what should a student *notice*? (Diffusion, folding, solvation
   shells, binding?) This drives the teaching features in phase 3 more than anything
   else.
6. **Class format:** one student in a headset at a time with others watching a screen,
   or several headsets at once? Should the instructor be able to drive the view?
7. **Where can we host** a static HTTPS site?
