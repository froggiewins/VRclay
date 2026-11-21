// VR Clay — entry point. Builds the studio, wires up VR and desktop input,
// and drives the sculpting engine.

import * as THREE from 'three';
import { ClayMesh } from './claymesh.js';
import { Panel } from './panel.js';
import { createDomUI } from './domui.js';
import { createVRButton, XRInput, Holder } from './xr.js';
import {
  TOOLS, state, set, onChange, brushFraction, detailLength, materialInfo, cycleTool,
  savePrefs, loadPrefs,
} from './state.js';
import {
  EXPORT_FORMATS, exportMesh, download, listPeers, sendToPeer, saveLocal, readLocal,
  timestamp, formatSize,
} from './exporters.js';
import {
  encodeSculpt, decodeSculpt, listSculpts, saveSculpt, fetchSculpt, deleteSculpt, newId,
} from './library.js';
import { loadHands } from './handmodel.js';
import { ToolTray, BARE_HAND_BRUSH, BARE_HAND_GRIP } from './tools.js';

const BALL_RADIUS = 0.15;
const BALL_POSITION = new THREE.Vector3(0, 1.15, -0.4);

const scratch = {
  v: new THREE.Vector3(),
  delta: new THREE.Vector3(),
  quat: new THREE.Quaternion(),
  projection: {},
  ndc: new THREE.Vector2(),
};

loadPrefs();

// ---------------------------------------------------------------- renderer

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1116);
scene.fog = new THREE.Fog(0x0f1116, 3, 9);
scene.environment = buildEnvironment(renderer);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 40);

// ------------------------------------------------------------------- studio

const key = new THREE.DirectionalLight(0xfff4e6, 2.4);
key.position.set(1.4, 2.6, 1.0);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 6;
key.shadow.camera.left = -1;
key.shadow.camera.right = 1;
key.shadow.camera.top = 1;
key.shadow.camera.bottom = -1;
key.shadow.bias = -0.0012;
scene.add(key);

const rim = new THREE.DirectionalLight(0x9db4ff, 0.7);
rim.position.set(-1.6, 1.2, -1.4);
scene.add(rim);

scene.add(new THREE.HemisphereLight(0xbcd0ff, 0x2b2118, 0.55));

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(3.2, 64).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x1a1d24, roughness: 0.95, metalness: 0 }),
);
floor.receiveShadow = true;
scene.add(floor);

const grid = new THREE.GridHelper(6, 24, 0x2a2f3a, 0x1f232b);
grid.position.y = 0.002;
scene.add(grid);

const pedestal = new THREE.Mesh(
  new THREE.CylinderGeometry(0.17, 0.22, 1.0, 40),
  new THREE.MeshStandardMaterial({ color: 0x272b33, roughness: 0.8, metalness: 0.1 }),
);
pedestal.position.set(BALL_POSITION.x, 0.5, BALL_POSITION.z);
pedestal.castShadow = true;
pedestal.receiveShadow = true;
scene.add(pedestal);

// --------------------------------------------------------------------- clay

const clayMaterial = new THREE.MeshPhysicalMaterial({ vertexColors: true });
const materialColor = new THREE.Color();

const clayGroup = new THREE.Group();
clayGroup.position.copy(BALL_POSITION);
scene.add(clayGroup);

let clay = null;
let clayMesh = null;
buildClay(state.detail, state.shape);

function buildClay(detail, shape) {
  if (clayMesh) {
    clayGroup.remove(clayMesh);
    clay.dispose();
  }
  clay = new ClayMesh({ radius: BALL_RADIUS, detail, shape });
  clayMesh = new THREE.Mesh(clay.geometry, clayMaterial);
  clayMesh.castShadow = true;
  clayMesh.receiveShadow = true;
  clayGroup.add(clayMesh);
  clayGroup.rotation.set(0, 0, 0);
  clayGroup.scale.setScalar(1);
  clayGroup.position.copy(BALL_POSITION);
  applyMaterial();
}

function applyMaterial() {
  const m = materialInfo();
  // The material stays white and the clay's colour lives in vertex colours, so
  // a swatch renders as exactly the colour you picked.
  clayMaterial.color.setHex(0xffffff);
  if (state.baseColor) materialColor.set(state.baseColor);
  else materialColor.setHex(m.color);
  clay?.setBaseColor(materialColor);
  clayMaterial.roughness = m.roughness;
  clayMaterial.metalness = m.metalness;
  clayMaterial.clearcoat = m.clearcoat;
  clayMaterial.clearcoatRoughness = 0.25;
  clayMaterial.flatShading = state.faceted;
  clayMaterial.envMapIntensity = 0.85;
  clayMaterial.needsUpdate = true;
}

// -------------------------------------------------------------------- panel

// ------------------------------------------------------------- tools & hands

const tray = new ToolTray();
scene.add(tray.object3D);

// Tools are picked up, so the held tool *is* the brush. Nothing held means bare
// hands, which smooth with a fingertip and pull clay when you squeeze.
function brushFor(rig, squeezing) {
  const tool = rig ? tray.heldBy(rig.handModel) : null;
  if (tool) return tool.id;
  return squeezing ? BARE_HAND_GRIP : BARE_HAND_BRUSH;
}

const panel = new Panel({ onAction: handleAction });
panel.mesh.position.set(0.52, 1.22, -0.28);
panel.mesh.rotation.set(-0.15, -0.6, 0);
scene.add(panel.mesh);

const cursor = new THREE.Group();
const cursorShell = new THREE.Mesh(
  new THREE.SphereGeometry(1, 20, 14),
  new THREE.MeshBasicMaterial({ color: 0xe07a5f, wireframe: true, transparent: true, opacity: 0.5 }),
);
const cursorCore = new THREE.Mesh(
  new THREE.SphereGeometry(1, 12, 8),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
);
cursor.add(cursorShell, cursorCore);
cursor.visible = false;
scene.add(cursor);

// ----------------------------------------------------------------- desktop UI

const ui = createDomUI({ onAction: handleAction });
document.getElementById('vr-slot').appendChild(
  createVRButton(renderer, { onStatus: (msg) => ui.setStatus(msg) }),
);

let prefsTimer = 0;
onChange((changedKey) => {
  // Choosing a material hands colour control back to that material.
  if (changedKey === 'material') state.baseColor = null;
  if (changedKey === 'material' || changedKey === 'baseColor'
    || changedKey === 'faceted' || changedKey === null) applyMaterial();
  panel.dirty = true;
  // Sliders and thumbsticks fire this every frame; only hit storage once idle.
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(savePrefs, 400);
});

// -------------------------------------------------------------------- actions

function handleAction(action, value) {
  switch (action) {
    case 'color':
      set('color', value);
      // With Paint selected a swatch just loads the brush; otherwise it
      // recolours the bare clay, leaving any painted detail on top.
      if (state.tool !== 'paint') {
        clay.beginStroke();
        set('baseColor', value);
      }
      break;
    case 'flood':
      // Wipes painted detail as well as recolouring.
      set('color', value);
      clay.beginStroke();
      clay.fillColor(new THREE.Color(value));
      set('baseColor', value);
      break;
    case 'shape':
      set('shape', value);
      buildClay(state.detail, value);
      ui.setStatus(`New ${value}`);
      break;
    case 'detail':
      set('detail', value);
      buildClay(value, state.shape);
      ui.setStatus(`Detail: ${clay.count.toLocaleString()} points`);
      break;
    case 'undo':
      ui.setStatus(clay.undo() ? 'Undone' : 'Nothing to undo');
      break;
    case 'reset':
      buildClay(state.detail, state.shape);
      ui.setStatus('Fresh ball');
      break;
    case 'recenter':
      recenterPanel();
      break;
    case 'save':
      ui.setStatus(saveLocal(clay) ? 'Saved in this browser' : 'Save failed (storage full?)');
      break;
    case 'library-save':
      saveToLibrary(false, value).catch(fail);
      break;
    case 'library-save-new':
      saveToLibrary(true, value).catch(fail);
      break;
    case 'library-load':
      loadFromLibrary(value).catch(fail);
      break;
    case 'library-delete':
      deleteSculpt(value).then(() => {
        if (current.id === value) current = { id: null, name: current.name };
        announceLibrary();
        ui.setStatus('Deleted from the library');
        refreshLibrary();
      }).catch(fail);
      break;
    case 'library-rename':
      current = { ...current, name: value || 'Untitled' };
      announceLibrary();
      break;
    case 'library-refresh':
      refreshLibrary();
      break;
    case 'cycle-peer':
      cyclePeer();
      break;
    case 'load': {
      const data = readLocal();
      if (!data) {
        ui.setStatus('No save found');
        break;
      }
      if (data.detail !== clay.detail) buildClay(data.detail, data.shape || state.shape);
      ui.setStatus(clay.load(data) ? 'Loaded' : 'Could not load that save');
      break;
    }
    case 'export': {
      const { blob, filename, format } = buildExport(value);
      download(blob, filename);
      ui.setStatus(`Saved .${format.ext} — ${formatSize(blob.size)},`
        + ` ${clay.triangleCount.toLocaleString()} triangles`);
      break;
    }
    case 'send':
      // Ask which machine first — the browser can't see the network, so the
      // server we're talking to reports who else is out there.
      ui.setStatus('Looking for machines…');
      listPeers().then(({ peers }) => {
        ui.showPeers(peers, (peer) => sendExportTo(peer, value));
        ui.setStatus(peers.length ? '' : 'No machines found on the network');
      }).catch(() => {
        ui.setStatus('Needs the local server — run python serve.py');
        panel.setNotice('Needs the local server (serve.py)');
      });
      break;
    case 'send-to-selected':
      if (selectedPeer) sendExportTo(selectedPeer, state.exportFormat);
      else panel.setNotice('No machine selected');
      break;
    default:
      break;
  }
  panel.dirty = true;
}

function fail(err) {
  const message = err && err.message ? err.message : String(err);
  ui.setStatus(`Library error: ${message}`);
  panel.setNotice(`Error: ${message}`);
}

// ------------------------------------------------------------------ library

// Which library entry the current sculpt belongs to, so Save keeps updating it
// instead of spawning a new copy every time.
let current = { id: null, name: 'Untitled' };
const libraryListeners = new Set();

function onLibraryChange(fn) {
  libraryListeners.add(fn);
}

function announceLibrary() {
  for (const fn of libraryListeners) fn(current);
}

/** @param {boolean} asNew force a new entry rather than overwriting */
async function saveToLibrary(asNew = false, nameOverride) {
  const id = asNew || !current.id ? newId() : current.id;
  const name = nameOverride || current.name || 'Untitled';
  const blob = encodeSculpt(clay, {
    name,
    material: state.material,
    baseColor: state.baseColor,
    saved: Date.now(),
  });
  ui.setStatus(`Saving ${formatSize(blob.size)}…`);
  panel.setNotice(`Saving ${formatSize(blob.size)}…`, 60000);
  await saveSculpt(id, blob);
  current = { id, name };
  announceLibrary();
  ui.setStatus(`Saved "${name}" to the library`);
  panel.setNotice(`Saved "${name}"`);
  refreshLibrary();
}

async function loadFromLibrary(id) {
  ui.setStatus('Loading…');
  panel.setNotice('Loading…', 60000);
  const buffer = await fetchSculpt(id);
  const data = decodeSculpt(buffer);

  // The saved mesh replaces the geometry wholesale, but shape/detail metadata
  // keeps Reset and the readouts honest afterwards.
  if (!clay.load(data)) throw new Error('That sculpt could not be read');
  clay.detail = data.detail ?? clay.detail;
  clay.shape = data.shape ?? clay.shape;
  set('detail', clay.detail);
  set('shape', clay.shape);
  if (data.material) set('material', data.material);
  set('baseColor', data.baseColor ?? null);
  clayGroup.rotation.set(0, 0, 0);
  clayGroup.scale.setScalar(1);
  clayGroup.position.copy(BALL_POSITION);

  current = { id, name: data.name || 'Untitled' };
  announceLibrary();
  ui.setStatus(`Loaded "${current.name}" — ${clay.triangleCount.toLocaleString()} triangles`);
  panel.setNotice(`Loaded "${current.name}"`);
  refreshLibrary();
}

let librarySnapshot = [];
// The library and send-to-PC both need serve.py behind the page. Served as a
// static site (GitHub Pages, say) there is no backend, so the probe below fails
// and those controls present themselves as unavailable rather than erroring.
let backendReady = false;

async function refreshLibrary() {
  try {
    librarySnapshot = await listSculpts();
    backendReady = true;
  } catch {
    librarySnapshot = [];
    backendReady = false;
  }
  ui.setLibrary(librarySnapshot, current, backendReady);
  panel.setSlots(librarySnapshot.slice(0, 3));
  panel.setBackend(backendReady);
}

/** Which machine the VR panel will send to. */
let peerList = [];
let selectedPeer = null;

async function refreshPeers() {
  try {
    const { peers } = await listPeers();
    peerList = peers;
    if (!selectedPeer || !peers.some((p) => p.id === selectedPeer.id)) {
      selectedPeer = peers.find((p) => p.self) || peers[0] || null;
    }
  } catch {
    peerList = [];
    selectedPeer = null;
  }
  panel.setPeer(selectedPeer ? selectedPeer.name : '');
}

/** Step to the next machine in the list, for choosing one in VR. */
function cyclePeer() {
  if (peerList.length === 0) {
    panel.setNotice('No machines found');
    return;
  }
  const at = peerList.findIndex((p) => selectedPeer && p.id === selectedPeer.id);
  selectedPeer = peerList[(at + 1) % peerList.length];
  panel.setPeer(selectedPeer.name);
  panel.setNotice(`Send to ${selectedPeer.name}`);
}

function sendExportTo(peer, formatId) {
  const { blob, filename } = buildExport(formatId);
  const size = formatSize(blob.size);
  ui.setStatus(`Sending ${size} to ${peer.name}…`);
  panel.setNotice(`Sending to ${peer.name}…`, 60000);
  sendToPeer(peer.id, blob, filename).then((result) => {
    ui.setStatus(`Sent to ${result.to}: exports/${filename}`);
    panel.setNotice(`Sent to ${result.to}`);
  }).catch((err) => {
    ui.setStatus(`Send to ${peer.name} failed: ${err.message}`);
    panel.setNotice(`Send failed: ${err.message}`);
  });
}

/** Builds the mesh file for the chosen format, tagged with today's material. */
function buildExport(formatId) {
  const format = EXPORT_FORMATS.find((x) => x.id === (formatId || state.exportFormat))
    || EXPORT_FORMATS[0];
  const material = materialInfo();
  const blob = exportMesh(clay, format.id, {
    metalness: material.metalness,
    roughness: material.roughness,
    name: `VR Clay ${material.label}`,
  });
  return { blob, format, filename: `vrclay-${timestamp()}.${format.ext}` };
}

function recenterPanel() {
  const xrCamera = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  xrCamera.getWorldPosition(scratch.v);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCamera.getWorldQuaternion(scratch.quat));
  forward.y = 0;
  if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
  forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
  panel.mesh.position.copy(scratch.v)
    .addScaledVector(forward, 0.55)
    .addScaledVector(right, 0.35);
  panel.mesh.position.y = Math.max(0.9, scratch.v.y - 0.25);
  panel.mesh.lookAt(scratch.v);
}

// ------------------------------------------------------------------ XR input

const input = new XRInput(renderer, scene);
const holder = new Holder(clayGroup);
let panelCaptured = false;
let strokeActive = false;

// Each hand has its own skeleton, so they're assigned exclusively by
// handedness — and reassigned if a controller reports differently on connect.
let handAssets = null;

function assignHands() {
  if (!handAssets) return;
  for (const rig of input.rigs) {
    const asset = rig.handedness === 'left' ? handAssets.left : handAssets.right;
    if (rig.handAsset === asset) continue;
    rig.handAsset = asset;
    if (!asset.group.parent) {
      asset.group.visible = false;
      scene.add(asset.group);
    }
    rig.setHandModel(asset.group, asset.fingertip);
  }
}

loadHands().then((hands) => {
  handAssets = hands;
  assignHands();
}).catch((err) => {
  ui.setStatus(`Hand model failed to load: ${err.message}`);
});

for (const rig of input.rigs) {
  rig.controller.addEventListener('connected', () => assignHands());
}

/**
 * Poses the fingers. Tracked hands drive the bones from real joint positions;
 * controllers get an animated pose chosen from what the hand is doing.
 */
function poseHands(dt) {
  for (const rig of input.rigs) {
    const poser = rig.handAsset?.poser;
    if (!poser) continue;

    const joints = rig.hand?.joints;
    if (joints && poser.poseFromJoints(joints, rig.handModel)) continue;
    poser.releaseJoints();

    const holding = rig.handModel ? tray.heldBy(rig.handModel) : null;
    if (holding) {
      poser.setPose('grip');
      // The trigger finger tightens as you press.
      poser.setFinger('index', rig.selecting ? 0.78 : 0.62);
    } else if (rig.squeezing) {
      poser.setPose('fist');
    } else if (rig.selecting) {
      poser.setPose('press');
    } else if (tray.nearestTool(rig.tipWorld, 0.20)) {
      // reaching over the tray: open up ready to take something
      poser.setPose('open');
    } else {
      poser.setPose('relaxed');
    }
    poser.update(dt);
  }
}

// Effective contact point per hand: the held tool's tip, or the fingertip.
const contact = input.rigs.map(() => ({
  now: new THREE.Vector3(),
  last: new THREE.Vector3(),
  valid: false,
  had: false,
}));

function updateContacts() {
  for (const rig of input.rigs) {
    const state = contact[rig.index];
    state.had = state.valid;
    state.last.copy(state.now);

    const tool = rig.handModel ? tray.heldBy(rig.handModel) : null;
    if (tool) {
      tray.tipWorld(tool, state.now);
      state.valid = true;
    } else if (rig.hasTip) {
      state.now.copy(rig.tipWorld);
      state.valid = true;
    } else {
      state.valid = false;
    }
    if (state.valid && !state.had) state.last.copy(state.now);
  }
}

input.on('selectstart', (rig) => {
  if (!rig.hasTip) return;
  const hit = panel.project(rig.tipWorld, scratch.projection);
  if (hit.inside) {
    panelCaptured = true;
    panel.press(hit.u, hit.v);
    rig.pulse(0.4, 15);
    return;
  }
  if (rig === sculptRig()) beginStroke();
});

input.on('selectend', () => {
  panelCaptured = false;
  panel.release();
  endStroke();
});

input.on('squeezestart', (rig) => {
  // Squeezing is how you handle tools: take one if your hand is over the tray,
  // put the one you're holding back, otherwise fall through to the clay.
  if (rig.handModel && rig.handPosed) {
    const held = tray.heldBy(rig.handModel);
    if (held) {
      tray.putDown(held);
      set('tool', BARE_HAND_BRUSH);
      rig.pulse(0.3, 15);
      panel.setNotice('Put the tool down — bare hands');
      panel.dirty = true;
      rig.squeezing = true;
      rig.toolAction = true;
      return;
    }
    const reachable = tray.nearestTool(rig.tipWorld);
    if (reachable) {
      tray.pickUp(reachable, rig.handModel);
      set('tool', reachable.id);
      rig.pulse(0.5, 20);
      panel.setNotice(`Holding the ${reachable.label.toLowerCase()}`);
      panel.dirty = true;
      rig.squeezing = true;
      rig.toolAction = true;
      return;
    }
  }
  if (rig === sculptRig() && !offHandRig()?.squeezing) beginStroke();
  rig.squeezing = true;
});

input.on('squeezeend', (rig) => {
  rig.squeezing = false;
  rig.toolAction = false;   // that squeeze was spent on a tool, not the clay
  endStroke();
});

function sculptRig() {
  const dominant = state.swapHands ? 'left' : 'right';
  return input.byHandedness(dominant) || input.rigs.find((r) => r.connected);
}

function offHandRig() {
  const active = sculptRig();
  return input.rigs.find((r) => r.connected && r !== active);
}

function beginStroke() {
  if (!strokeActive) {
    clay.beginStroke();
    strokeActive = true;
  }
}

function endStroke() {
  strokeActive = false;
}

function updateXR(dt) {
  input.update();
  poseHands(dt);
  updateContacts();

  const sculpt = sculptRig();
  const off = offHandRig();

  // --- hold the sculpture: off hand alone moves it, both hands also scale it.
  //     A squeeze spent picking a tool up doesn't count as grabbing the ball.
  const hands = [];
  if (off?.squeezing && !off.toolAction && off.hasTip) {
    hands.push(pose(off));
    if (sculpt?.squeezing && !sculpt.toolAction && sculpt.hasTip) hands.push(pose(sculpt));
  }
  if (hands.length) {
    if (holder.active) holder.update(hands);
    else holder.begin(hands);
  } else if (holder.active) {
    holder.end();
  }

  if (!sculpt) {
    cursor.visible = false;
    panel.clearPointer();
    return;
  }

  // --- thumbstick tweaks brush size (Y) and strength (X)
  const stickY = input.axis(sculpt, 3);
  const stickX = input.axis(sculpt, 2);
  if (stickY) set('size', clamp01(state.size - stickY * dt * 0.8));
  if (stickX) set('strength', clamp01(state.strength + stickX * dt * 0.5));
  if (input.pressed(sculpt, 4)) handleAction('undo');
  if (input.pressed(sculpt, 5)) cycleTool(1);
  if (off) {
    if (input.pressed(off, 4)) handleAction('undo');
    if (input.pressed(off, 5)) set('symmetry', !state.symmetry);
  }

  const point = contact[sculpt.index];
  if (!point.valid) {
    cursor.visible = false;
    panel.clearPointer();
    return;
  }

  // --- panel pointer
  const hit = panel.project(point.now, scratch.projection);
  if (hit.inside) {
    panel.setPointer(hit.u, hit.v);
    if (panelCaptured) panel.drag(hit.u);
  } else {
    panel.clearPointer();
  }

  // --- brush cursor
  const radiusLocal = brushFraction() * BALL_RADIUS;
  const worldRadius = radiusLocal * clayGroup.scale.x;
  const holding = sculpt.handModel ? tray.heldBy(sculpt.handModel) : null;
  const grabbing = sculpt.squeezing && !sculpt.toolAction && !off?.squeezing && !holding;
  const activeBrush = brushFor(sculpt, grabbing);

  cursor.visible = !hit.inside;
  cursor.position.copy(point.now);
  cursorShell.scale.setScalar(worldRadius);
  cursorCore.scale.setScalar(worldRadius * 0.08);
  cursorShell.material.color.set(activeBrush === 'paint' ? state.color : 0xe07a5f);

  // --- sculpt
  const sculpting = (sculpt.selecting || grabbing) && !panelCaptured && !hit.inside;
  if (!sculpting) return;

  const center = clayGroup.worldToLocal(scratch.v.copy(point.now));
  // Skip the grid query when the hand is nowhere near the clay. Uses the live
  // extent, not the safety ceiling, so it stays meaningful as the sculpt grows.
  if (center.length() > clay.extent + radiusLocal * 2) return;

  scratch.delta.copy(point.now).sub(point.last);
  scratch.delta
    .applyQuaternion(scratch.quat.copy(clayGroup.quaternion).invert())
    .divideScalar(clayGroup.scale.x);

  const tool = activeBrush;
  const touched = clay.stroke({
    tool,
    center,
    radius: radiusLocal,
    strength: state.strength,
    dt,
    color: brushColor,
    delta: scratch.delta,
    symmetry: state.symmetry,
    detailLength: dyntopoFor(tool, radiusLocal),
  });
  if (touched) sculpt.pulse(0.12 + state.strength * 0.2, 12);
}

const poseCache = input.rigs.map(() => ({
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
}));

function pose(rig) {
  const out = poseCache[rig.index];
  out.position.copy(rig.tipWorld);
  rig.controller.getWorldQuaternion(out.quaternion);
  return out;
}

// three fires select on the controller object; mirror it onto our rigs
for (const rig of input.rigs) {
  rig.controller.addEventListener('selectstart', () => { rig.selecting = true; });
  rig.controller.addEventListener('selectend', () => { rig.selecting = false; });
}

const brushColor = new THREE.Color(state.color);
onChange((changedKey) => {
  if (changedKey === 'color' || changedKey === null) brushColor.set(state.color);
});

// -------------------------------------------------------------- desktop input

const raycaster = new THREE.Raycaster();
const orbit = { theta: 0, phi: 1.25, radius: 0.85, dragging: null, lastX: 0, lastY: 0 };
let desktopSculpting = false;
const lastLocalHit = new THREE.Vector3();
let hasLastHit = false;

const canvas = renderer.domElement;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  if (renderer.xr.isPresenting) return;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
  orbit.lastX = e.clientX;
  orbit.lastY = e.clientY;

  // Tools are objects on the tray here too: click one to take it up.
  if (e.button === 0 && !e.shiftKey) {
    const picked = pickTool(e);
    if (picked) {
      tray.raise(picked.tool);
      set('tool', picked.tool.id);
      ui.setStatus(`Picked up the ${picked.tool.label.toLowerCase()}`);
      return;
    }
    if (picked === null && pickTable(e)) {
      tray.raise(null);
      set('tool', BARE_HAND_BRUSH);
      ui.setStatus('Bare hands — smooth, and squeeze to pull clay');
      return;
    }
  }

  const sculptable = e.button === 0 && !e.shiftKey && pickClay(e) !== null;
  if (sculptable) {
    desktopSculpting = true;
    hasLastHit = false;
    beginStroke();
  } else {
    orbit.dragging = 'orbit';
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (orbit.dragging === 'orbit') {
    orbit.theta -= (e.clientX - orbit.lastX) * 0.008;
    orbit.phi = Math.max(0.15, Math.min(Math.PI - 0.15, orbit.phi - (e.clientY - orbit.lastY) * 0.008));
  }
  orbit.lastX = e.clientX;
  orbit.lastY = e.clientY;
  scratch.ndc.set(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1,
  );
});

const stopDesktop = () => {
  orbit.dragging = null;
  desktopSculpting = false;
  hasLastHit = false;
  endStroke();
};
canvas.addEventListener('pointerup', stopDesktop);
canvas.addEventListener('pointercancel', stopDesktop);
canvas.addEventListener('pointerleave', stopDesktop);

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  orbit.radius = Math.max(0.3, Math.min(3, orbit.radius * (1 + Math.sign(e.deltaY) * 0.1)));
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    handleAction('undo');
    return;
  }
  if (e.key >= '1' && e.key <= '8') {
    cycleToolByIndex(parseInt(e.key, 10) - 1);
  } else if (e.key === '[') {
    set('size', clamp01(state.size - 0.05));
  } else if (e.key === ']') {
    set('size', clamp01(state.size + 0.05));
  } else if (e.key.toLowerCase() === 'x') {
    set('symmetry', !state.symmetry);
  } else if (e.key === ' ') {
    e.preventDefault();
    set('turntable', !state.turntable);
  }
});

function cycleToolByIndex(i) {
  if (TOOLS[i]) set('tool', TOOLS[i].id);
}

/** Raycast the tray's tools. Returns {tool} or null. */
function pickTool(event) {
  setNdcFromEvent(event);
  raycaster.setFromCamera(scratch.ndc, camera);
  const hits = raycaster.intersectObjects(tray.pickables(), true);
  if (!hits.length) return null;
  const tool = tray.toolFromObject(hits[0].object);
  return tool ? { tool, point: hits[0].point } : null;
}

/** The tray surface itself — clicking bare wood means putting the tool down. */
function pickTable(event) {
  setNdcFromEvent(event);
  raycaster.setFromCamera(scratch.ndc, camera);
  return raycaster.intersectObject(tray.object3D, true).length > 0;
}

function setNdcFromEvent(event) {
  scratch.ndc.set(
    (event.clientX / window.innerWidth) * 2 - 1,
    -(event.clientY / window.innerHeight) * 2 + 1,
  );
}

function pickClay(event) {
  if (event) {
    scratch.ndc.set(
      (event.clientX / window.innerWidth) * 2 - 1,
      -(event.clientY / window.innerHeight) * 2 + 1,
    );
  }
  raycaster.setFromCamera(scratch.ndc, camera);
  const hits = raycaster.intersectObject(clayMesh, false);
  return hits.length ? hits[0] : null;
}

function updateDesktop(dt) {
  const target = clayGroup.position;
  camera.position.set(
    target.x + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta),
    target.y + orbit.radius * Math.cos(orbit.phi),
    target.z + orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta),
  );
  camera.lookAt(target);

  const radiusLocal = brushFraction() * BALL_RADIUS;
  const hit = pickClay(null);
  if (hit) {
    cursor.visible = true;
    cursor.position.copy(hit.point);
    cursorShell.scale.setScalar(radiusLocal * clayGroup.scale.x);
    cursorCore.scale.setScalar(radiusLocal * 0.08);
    cursorShell.material.color.set(state.tool === 'paint' ? state.color : 0xe07a5f);
  } else {
    cursor.visible = false;
  }

  if (!desktopSculpting || !hit) return;

  const center = clayGroup.worldToLocal(scratch.v.copy(hit.point));
  scratch.delta.set(0, 0, 0);
  if (hasLastHit) scratch.delta.copy(center).sub(lastLocalHit);
  lastLocalHit.copy(center);
  hasLastHit = true;

  clay.stroke({
    tool: state.tool,
    center,
    radius: radiusLocal,
    strength: state.strength,
    dt,
    color: brushColor,
    delta: scratch.delta,
    symmetry: state.symmetry,
    detailLength: dyntopoFor(state.tool, radiusLocal),
  });
}

/**
 * Paint only recolours, and grab is meant to drag existing clay around, so
 * neither should be rebuilding topology underneath the brush.
 */
function dyntopoFor(tool, radiusLocal) {
  if (tool === 'paint' || tool === 'grab') return 0;
  return detailLength(radiusLocal, BALL_RADIUS);
}

// --------------------------------------------------------------------- loop

renderer.xr.addEventListener('sessionstart', () => {
  camera.position.set(0, 0, 0);
  camera.quaternion.identity();
  document.body.classList.add('in-vr');
  panel.dirty = true;
});

renderer.xr.addEventListener('sessionend', () => {
  document.body.classList.remove('in-vr');
  cursor.visible = false;
});

const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);

  if (state.turntable) clayGroup.rotation.y += dt * 0.35;
  clayGroup.updateMatrixWorld(true);
  tray.update(dt);

  if (renderer.xr.isPresenting) updateXR(dt);
  else updateDesktop(dt);

  updateMeshStats();
  panel.update();
  clay.flush();
  renderer.render(scene, camera);
});

// The counts move constantly while dyntopo runs; refresh a few times a second
// rather than every frame, so the panel canvas isn't redrawn needlessly.
let statsClock = 0;
function updateMeshStats() {
  statsClock += 1;
  if (statsClock % 12) return;
  const text = `${clay.triangleCount.toLocaleString()} triangles`
    + (clay.atCapacity ? ' — at limit' : '');
  panel.setStats(text);
  ui.setMeshStats(text);

  const held = input.rigs
    .map((rig) => (rig.handModel ? tray.heldBy(rig.handModel) : null))
    .find(Boolean) || tray.tools.find((t) => t.raised);
  panel.setHeldTool(held ? held.label : '');
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

document.getElementById('boot')?.remove();
onLibraryChange(() => { panel.dirty = true; });
refreshLibrary();
refreshPeers();
// Machines come and go, so keep the list current for the in-VR picker.
setInterval(refreshPeers, 4000);

// Debug handle: poke at the engine from the console, e.g.
//   vrclay.clay.stroke({ tool:'push', center:new THREE.Vector3(0,0.15,0), radius:0.05, strength:1, dt:0.5 })
window.vrclay = {
  get clay() { return clay; },
  clayGroup, panel, state, set, scene, camera, renderer, THREE,
  tray, input, contact, brushFor, updateContacts,
};

// ---------------------------------------------------------------- utilities

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/** A tiny procedural studio environment, so metals have something to reflect. */
function buildEnvironment(rendererRef) {
  const canvasEl = document.createElement('canvas');
  canvasEl.width = 256;
  canvasEl.height = 128;
  const ctx = canvasEl.getContext('2d');

  const sky = ctx.createLinearGradient(0, 0, 0, 128);
  sky.addColorStop(0, '#e8eef7');
  sky.addColorStop(0.45, '#8d97a6');
  sky.addColorStop(1, '#22252b');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 256, 128);

  const lamp = ctx.createRadialGradient(72, 26, 0, 72, 26, 46);
  lamp.addColorStop(0, 'rgba(255,255,255,1)');
  lamp.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = lamp;
  ctx.fillRect(0, 0, 256, 128);

  const texture = new THREE.CanvasTexture(canvasEl);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;

  const pmrem = new THREE.PMREMGenerator(rendererRef);
  const env = pmrem.fromEquirectangular(texture).texture;
  pmrem.dispose();
  texture.dispose();
  return env;
}
