# VR Clay

A ball of clay you can shape with your hands. WebXR + Three.js, no build step —
open it in a headset browser and start sculpting, or use a mouse on the desktop.

## Try it

<https://froggiewins.github.io/VRclay/>

GitHub Pages serves over HTTPS, which is what WebXR requires — so you can open
that link straight in a headset browser and press **Enter VR**, with no
certificate or local server needed.

The hosted copy is a static site, so the parts that need `serve.py` behind them
turn themselves off there and say so: the sculpt **library** and **send to PC**.
Everything else is self-contained and works — sculpting, dyntopo, the tool tray,
the hands, and **Export**, which downloads to whatever device you're on. For the
library and send-to-PC, run it locally as below.

## Run it locally

```bash
python serve.py
```

Then open <http://localhost:8080>.

### On a Quest (or any standalone headset)

WebXR only runs in a secure context, and `localhost` counts as one. The least
fiddly route is USB:

```bash
adb reverse tcp:8080 tcp:8080
```

Then open `http://localhost:8080` in the headset's browser and press **Enter VR**.

Over Wi-Fi instead, you need TLS: create a self-signed pair and serve with it.

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=vrclay"
```

```bash
python serve.py --https
```

Then browse to the `https://<your-ip>:8080` address the server prints and accept
the certificate warning.

## Controls

### Hands and the tool tray

You have hands, and the tools are real objects on a side table — there is no
tool menu in VR. Reach over to the tray and **squeeze** to pick a tool up;
squeeze again to put it back in its slot. Whatever you're holding is the brush,
and sculpting happens at that tool's working tip.

| Tool | Does |
| --- | --- |
| Ball stylus | Push clay outward |
| Pointed stylus | Carve inward |
| Bulb | Inflate along the surface |
| Spatula | Smooth |
| Paddle | Flatten an area |
| Needle | Pinch into ridges |
| Brush | Paint colour |

**Your bare hands are a tool too.** With nothing in your hand, the trigger
smooths the clay with a fingertip and squeezing pulls it around — the two things
hands do to clay that a tool doesn't.

### VR controls

| Input | Does |
| --- | --- |
| Squeeze over the tray | Pick up / put back a tool |
| Trigger | Sculpt with what you're holding |
| Trigger, empty-handed | Smooth with your fingertip |
| Squeeze, empty-handed | Pull clay around |
| Grip (off hand, away from the tray) | Hold the ball — move and turn it |
| Both grips | Turn and resize the ball |
| Thumbstick ↕ | Brush size |
| Thumbstick ↔ | Brush strength |
| A / X | Undo |

The settings panel floats to your right — sizes, colours, materials, library.
Poke it with a hand and pull the trigger; **Bring here** summons it to you.

### Hand tracking

Pinch to sculpt, same tray. The hand model lands on your real tracked wrist, so
it lines up with where your hand actually is.

### Desktop

| Input | Does |
| --- | --- |
| Click a tool on the tray | Pick it up |
| Click the bare tray | Put it down (back to bare hands) |
| Drag on the clay | Sculpt |
| Drag off the clay, or right-drag | Orbit |
| Scroll | Zoom |
| `1`–`8` | Pick a tool |
| `[` `]` | Brush size |
| `X` | Mirror |
| `Space` | Turntable |
| `Ctrl+Z` | Undo |

## Dynamic topology

Dyntopo is on by default. The mesh isn't a fixed cage — as you sculpt, edges
that stretch past a target length are split, and edges that bunch up below 0.4x
it are collapsed. Detail appears exactly where you're working, so you can carve
a crease far finer than the ball's starting resolution without the whole model
paying for it.

- **Dyntopo** toggles it. Off, the triangle count never changes.
- **Detail** sets the target edge length *relative to your brush*, the way
  Blender's relative detail works — a small brush automatically carves finer
  triangles than a big one. Coarse deliberately decimates; Fine can push a
  brush-sized patch past 100k triangles.
- Paint and Grab never retopologise: one only recolours, the other is meant to
  drag existing clay around.
- The panel shows the live triangle count. There's a hard ceiling of 120k
  vertices / 240k triangles, and the readout says *at limit* when you reach it.

The gap between the split and collapse thresholds matters: halving an edge at
the split threshold lands at 0.5x, comfortably above the 0.4x collapse
threshold, so edges can't ping-pong between the two passes every frame. A
collapse is also refused if it would create an edge long enough to be split
straight back apart.

## Customising the ball

- **8 tools** — push, carve, inflate, smooth, flatten, pinch, grab, paint.
- **Materials** — clay, terracotta, wet clay, porcelain, marble, plasticine,
  bronze, graphite. These set the surface finish *and* the clay's colour.
- **Colours** — with Paint selected, a swatch loads the brush. With any other
  tool, a swatch recolours the bare clay and leaves painted detail on top.
  Double-click a swatch on desktop to wipe all paint and flood the whole ball.
- **Start shapes** — sphere, egg, pebble, pillar, disc.
- **Detail** — 2.5k / 10k / 41k points. Higher holds finer detail and costs
  more per stroke.
- **Mirror** — every stroke is mirrored across the X axis, for symmetric work.
- **Faceted** — flat shading, for a chiselled look.

Changing the start shape or detail begins a fresh ball; everything else is
non-destructive.

## The library — save now, keep editing later

Press **Library** in the header (or **Save** on the in-VR panel) to store the
current sculpt on the machine running `serve.py`, in `library/`. Reopen it any
time, from either device: start something in the headset, carry on at the desk,
go back to the headset. Geometry, vertex colours, painted areas, material and
start shape all come back exactly as they were, and the reloaded mesh is fully
editable — dyntopo included.

- **Save** updates the entry you're editing; **Save a copy** branches a new one.
- The header button shows which sculpt you have open.
- The VR panel keeps the three most recent as one-press slots.
- This is *your computer*, not a third-party cloud: the sculpts live in
  `library/` and are reachable from anything on your network while the server is
  running. Nothing leaves your machine.

Sculpts are stored as a compact binary `.clay` file — the same 100k-triangle
mesh is about 2.5 MB packed and well over 10 MB as JSON, which matters when the
headset is posting it over Wi-Fi.

## Exporting

**Save** / **Load** in the Sculpt section keep one sculpt in the browser's own
local storage, separate from the library.

Pick a format and press **Export** to download it:

| Format | Colour | Notes |
| --- | --- | --- |
| glTF `.glb` | yes | Keeps colour *and* material. Best for Blender, viewers, the web. |
| PLY `.ply` | yes | Binary, with normals. Reads cleanly in MeshLab and Blender. |
| OBJ `.obj` | yes* | Widest support. \*Colour rides along as the `v x y z r g b` extension, which Blender and MeshLab read and everything else ignores. |
| STL `.stl` | no | For 3D printing. Geometry only, Z-up, **in millimetres**. |

Exports run on a compacted copy of the mesh, so the recycled slots and
degenerate triangles dyntopo leaves behind never reach a file.

STL is scaled to millimetres because that's what slicers assume — exported in
the scene's native metres, a 15 cm ball would arrive as a 0.3 mm speck.

### Sending a model to another machine

Press **To PC** and you get a list of the machines on your network running VR
Clay — yours first, labelled *this machine*. Pick one and the model lands in
that machine's `exports/` folder. In VR the panel has the same thing: a **TO**
button that steps through the machines, next to **Send**.

Discovery is done by the servers, not the browser. A page can't find anything on
a LAN — there's no mDNS from JavaScript, and a page served over HTTPS isn't
allowed to reach private addresses at all. So each `serve.py` announces itself
with a small UDP broadcast every two seconds and listens for the others, which
is Bonjour's idea at a much smaller scale. A machine drops off the list eight
seconds after it goes quiet.

Sending is a relay for the same reason: the browser posts the model to the
server it is already talking to, and that server forwards it to the peer. No
cross-origin request, and no certificate prompt for the other machine.

Both halves are optional:

```bash
python serve.py --name "Studio PC"   # how this machine appears in the list
python serve.py --no-discovery       # don't announce, don't look
python serve.py --no-upload          # refuse incoming models entirely
```

Relayed files are held to the same rules as a direct upload: the four mesh
extensions, plain filenames, into `exports/` only, 96 MB cap.

### Getting a sculpt out of the headset

A browser download inside a headset lands in the *headset's* storage. So the
in-VR panel has a **Send to computer** row instead: pick a format, press
**Send**, and the file is posted to whichever machine is running `serve.py` and
written to `exports/` next to it. The desktop UI has the same button.

That upload endpoint is deliberately narrow — it only accepts the four
extensions above, only plain filenames, only into `exports/`, and only up to
96 MB. The library API (`GET/PUT/DELETE /api/sculpts`) is bounded the same way:
plain ids only, into `library/` only. Both are writable by anything on your
network, so start the server with `--no-upload` to make it read-only.

## The hands

`hand.dae` is a rigged **left** hand exported from Blender, and the skeleton is
kept live so the fingers actually move. The file is parsed twice rather than
cloned, because `SkinnedMesh.clone()` doesn't carry its skeleton and the mesh
collapses into a sliver. The right hand is the left one mirrored, rendered
back-faces-first so the reversed winding still lights correctly.

Which hand it is was worth measuring rather than eyeballing — it's easy to talk
yourself into the wrong answer looking at a render. For a real right hand,
`thumb x fingers` points *into* the palm; for a left hand it points out of the
back. This model gives +0.415 along the back, so: left.

Almost nothing about the placement is hardcoded, because measuring beat guessing
at every step:

- **Scale** comes from the mesh *after* skinning, sampled through
  `applyBoneTransform`. This file's armature sits at a different scale from its
  mesh, so the obvious geometry-bounds × world-matrix calculation is out by 12x.
- **Orientation** comes from the skeleton — wrist to middle fingertip for
  forward, the palm normal for up. The bones and the raw geometry disagree about
  which way the hand points, and the bones are the ones that win.
- **Which chain is which finger** is derived from the bind pose: the bones are
  named `Bone.001`…`Bone.020` with no anatomy in them. Five chains hang off the
  wrist; the thumb is the one furthest off the plane of the other four, and the
  rest sort across the knuckles. The result is checked against real hand
  proportions (middle longest, shortening out to the pinky) and falls back to a
  name map if it doesn't hold up.

The finished hand has +Y toward the fingertips and +Z out of the back.

With **hand tracking**, the wrist is placed from tracked joint *positions* —
wrist for the origin, wrist-to-middle-knuckle for forward, the knuckle row for
sideways. Reading the wrist joint's own orientation would be shorter but relies
on a convention that's easy to get 90 degrees wrong; positions are unambiguous.
Finger bones are then aimed at the joints, solved fresh from the rest pose every
frame — nudging the previous frame's pose toward the target instead lets error
build up and the hand shakes itself apart.

With **controllers** there's no wrist to track, so it comes from the grip pose
via `GRIP_TO_WRIST` and `GRIP_WRIST_OFFSET` in `src/xr.js`.

### Finger animation

Each finger curls about a single hinge axis, worked out in world space from the
finger direction and the palm normal. Deriving that axis per bone instead looks
equivalent but isn't — bone roll varies along a chain, so some joints come out
flipped and the finger folds into an S and *stretches* rather than curling.

Poses (`open`, `relaxed`, `grip`, `press`, `fist`, `pinch`) ease into each other
on a frame-rate-independent time constant, and are chosen from what the hand is
doing: holding a tool grips it, the trigger presses, squeezing closes, and
reaching over the tray opens the hand ready to take something.

Curl is capped at about 0.65 of anatomical range. A real finger folds through
~200°, but this model's skin weights come apart well before that and the fingers
sink through the palm; ~150° still reads as a closed hand and stays clean.

Tools are held the way you hold a pen: gripped up near the fingertips with the
shaft crossing the hand at ~40 degrees, so the working tip comes out past the
fingers on the palm side while the butt end rides up over the back of the
knuckles. The offset is mirrored per hand so a tool always sits toward the
thumb, never the pinky.

If the hands sit slightly wrong on your controllers, `GRIP_TO_WRIST` and
`GRIP_WRIST_OFFSET` in `src/xr.js` are the constants to nudge; the grip itself
is `HOLD_TILT_ANGLE` / `HOLD_ALONG` / `HOLD_ACROSS` / `HOLD_DEPTH` in
`src/tools.js`.

## How it works

The ball starts as a subdivided icosahedron with welded vertices
(`src/icosphere.js`), then lives in a slab allocator: vertices and triangles sit
in pre-sized typed arrays and are recycled through free lists, so the GPU
buffers are created once and only dirty ranges are re-uploaded as the mesh
changes shape and size.

Brushes move the vertices they touch; a uniform hash grid answers "which
vertices are under the brush" in constant time. Face normals are cached, so a
moved vertex costs one cross product per incident face rather than one per face
*per vertex of that face*, and only the touched vertices plus their one ring are
renormalised.

Measured in-browser: a stroke step costs **0.4 ms at the default detail**
(~22k triangles) and **4.7 ms at the finest** (~51k triangles) — inside a 90 Hz
frame either way.

Every split and collapse is guarded so the surface stays a closed manifold: an
edge collapse is refused unless the two endpoints share exactly the two opposite
corners (the link condition), no triangle flips its facing, and valence stays in
bounds. `clay.validate()` checks the invariants — every edge shared by exactly
two triangles, consistent adjacency links, no orphans, and Euler characteristic
2 — and it holds after heavy sculpting with every tool.

How far clay can travel is a safety net, not a creative limit: you can pull a
horn out to ~24x the ball's radius, which is set by how far the hash grid can
address before its cell keys would alias. The bounding volumes follow the real
extent as the sculpt grows, so raycasting and culling stay tight and the mouse
can still reach the far end of a long spike. Undo keeps whole-mesh snapshots,
including topology, within a 48 MB budget.

Colour lives entirely in the vertex-colour attribute with a white material, so
painted colours render exactly as picked rather than being tinted by the
material underneath.

```
index.html          page shell, import map, desktop styling
serve.py            static server, sculpt library, LAN discovery + relay
                    (--vendor, --https, --no-upload, --no-discovery, --name)
exports/            mesh files sent from the headset land here
library/            saved sculpts (.clay), reopenable from any device
src/main.js         scene, input wiring, frame loop
src/claymesh.js     sculpting engine: slab storage, hash grid, brushes,
                    dyntopo splits/collapses, normals, undo, validate()
src/icosphere.js    starting geometry + adjacency tables
src/state.js        every option, in one place
src/panel.js        in-VR canvas panel
src/domui.js        desktop panel (same option lists)
src/handmodel.js    loads hand.dae, normalises scale/orientation, mirrors left
src/handrig.js      finds the finger chains, poses and animates them
src/tools.js        the tool tray and the tools you pick up
src/xr.js           session button, controller/hand rigs, hold + scale
hand.dae            the hand model
vendor/jsm/loaders/ ColladaLoader (+ TGALoader, which it imports)
src/exporters.js    glTF, PLY, OBJ, STL, send-to-PC, local save
src/library.js      .clay binary format + library API client
vendor/             pinned three.js r169
```

`vendor/three.module.js` is used when present so the app runs with no network.
Delete the folder to fall back to the CDN, or re-fetch it with
`python serve.py --vendor`.

There's a debug handle on `window.vrclay` (`clay`, `state`, `scene`, `renderer`,
`THREE`) if you want to poke at the engine from the console.
