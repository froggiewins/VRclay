// A side table holding real sculpting tools you pick up with your hands.
//
// Each tool is an object in the world, not a button: it sits in its slot on the
// tray, you reach over and squeeze to take it, and it goes back when you let
// go. Which tool you're holding *is* the brush selection — there is no separate
// tool UI in VR.
//
// Tool local space: the handle runs down -Y, the working tip is up at +Y, and
// the origin is where the hand grips it.

import * as THREE from 'three';

export const BARE_HAND_BRUSH = 'smooth';   // what a bare fingertip does
export const BARE_HAND_GRIP = 'grab';      // what a bare hand does when squeezed

const PICKUP_RADIUS = 0.14;
const RETURN_SPEED = 6;                    // how fast a dropped tool flies home

// Held the way you actually hold a pen: gripped up near the fingertips with the
// shaft crossing the hand at an angle, so the working tip comes out past the
// fingers on the palm side and the butt end rides up over the back of the
// knuckles. The tilt is negative about X because +Z is the back of the hand —
// positive would cock the tip the wrong way, up over the knuckles.
const HOLD_TILT_ANGLE = -0.70;                 // ~40 degrees across the hand
const HOLD_ALONG = 0.165;                      // up the hand, fingertips are 0.178
const HOLD_ACROSS = 0.015;                     // toward the thumb, mirrored per hand
const HOLD_DEPTH = -0.008;                     // slightly palm-side

const HOLD_TILT = new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(1, 0, 0), HOLD_TILT_ANGLE);

const HANDLE = new THREE.MeshStandardMaterial({ color: 0x2f333c, roughness: 0.55, metalness: 0.35 });
const STEEL = new THREE.MeshStandardMaterial({ color: 0xb9c0cc, roughness: 0.28, metalness: 0.9 });
const WOOD = new THREE.MeshStandardMaterial({ color: 0x8a5a3b, roughness: 0.7 });
const BRISTLE = new THREE.MeshStandardMaterial({ color: 0xd8c9a8, roughness: 0.85 });

/** id matches a brush in claymesh.stroke() */
const TOOL_SPECS = [
  { id: 'push', label: 'Push', build: ballStylus },
  { id: 'carve', label: 'Carve', build: pointedStylus },
  { id: 'inflate', label: 'Inflate', build: bulbStylus },
  { id: 'smooth', label: 'Smooth', build: spatula },
  { id: 'flatten', label: 'Flatten', build: paddle },
  { id: 'pinch', label: 'Pinch', build: needle },
  { id: 'paint', label: 'Paint', build: paintBrush },
];

export class ToolTray {
  constructor() {
    this.group = new THREE.Group();
    this.group.position.set(0.46, 0, -0.22);
    this.group.rotation.y = -0.38;

    this.tools = [];
    this._v = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._trayQuat = new THREE.Quaternion();
    this._trayInverse = new THREE.Quaternion();

    this._buildTable();
    this._buildTools();
  }

  get object3D() { return this.group; }

  _buildTable() {
    const topY = 0.92;
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(0.62, 0.03, 0.30),
      new THREE.MeshStandardMaterial({ color: 0x39302a, roughness: 0.75 }),
    );
    top.position.y = topY;
    top.castShadow = true;
    top.receiveShadow = true;
    this.group.add(top);

    // a shallow lip so the tools read as resting *in* the tray
    const lip = new THREE.Mesh(
      new THREE.TorusGeometry(0.001, 0.001, 4, 4),
      HANDLE,
    );
    lip.visible = false;
    this.group.add(lip);

    const legMat = new THREE.MeshStandardMaterial({ color: 0x2a2420, roughness: 0.8 });
    for (const [x, z] of [[-0.28, -0.12], [0.28, -0.12], [-0.28, 0.12], [0.28, 0.12]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, topY, 10), legMat);
      leg.position.set(x, topY / 2, z);
      leg.castShadow = true;
      this.group.add(leg);
    }
    this.topY = topY;
  }

  _buildTools() {
    const count = TOOL_SPECS.length;
    const spread = 0.50;
    TOOL_SPECS.forEach((spec, i) => {
      const built = spec.build();
      const group = built.group;
      group.name = `tool-${spec.id}`;
      group.traverse((o) => { if (o.isMesh) o.castShadow = true; });

      // resting pose: lying flat across the tray, tip pointing away from you
      const x = -spread / 2 + (spread * i) / (count - 1);
      const slotPosition = new THREE.Vector3(x, this.topY + 0.022, 0);
      const slotQuaternion = new THREE.Quaternion()
        .setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));

      this.group.add(group);
      group.position.copy(slotPosition);
      group.quaternion.copy(slotQuaternion);

      this.tools.push({
        id: spec.id,
        label: spec.label,
        group,
        tipLocal: new THREE.Vector3(0, built.tipLength, 0),
        slotPosition,
        slotQuaternion,
        holder: null,      // an Object3D (a hand) while carried
        raised: false,     // desktop selection lifts it out of the slot
        highlight: built.highlight,
      });
    });

    this.group.add(this._buildLabels(spread));
  }

  /** Names painted along the tray's front edge, so tools are identifiable. */
  _buildLabels(spread) {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2a2420';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#c9bda9';
    ctx.font = '600 30px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const count = TOOL_SPECS.length;
    TOOL_SPECS.forEach((spec, i) => {
      // matches the slot spacing above, mapped into canvas space
      const x = (-spread / 2 + (spread * i) / (count - 1)) / 0.62 + 0.5;
      ctx.fillText(spec.label.toUpperCase(), x * canvas.width, canvas.height / 2);
    });

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(0.62, 0.058),
      new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
    );
    strip.position.set(0, this.topY + 0.0155, 0.121);
    strip.rotation.x = -Math.PI / 2.35;
    return strip;
  }

  // ------------------------------------------------------------ interaction

  /** Closest tool to a world point, or null if nothing is within reach. */
  nearestTool(worldPoint, maxDistance = PICKUP_RADIUS) {
    let best = null;
    let bestDistance = maxDistance;
    for (const tool of this.tools) {
      tool.group.getWorldPosition(this._v);
      const d = this._v.distanceTo(worldPoint);
      if (d < bestDistance) {
        bestDistance = d;
        best = tool;
      }
    }
    return best;
  }

  byId(id) {
    return this.tools.find((t) => t.id === id) || null;
  }

  heldBy(holder) {
    return this.tools.find((t) => t.holder === holder) || null;
  }

  pickUp(tool, holder) {
    const previous = this.heldBy(holder);
    if (previous && previous !== tool) this.putDown(previous);
    if (tool.holder && tool.holder !== holder) tool.holder = null;
    tool.holder = holder;
    tool.raised = false;
  }

  putDown(tool) {
    if (!tool) return;
    tool.holder = null;
    tool.raised = false;
  }

  /** Desktop: lift a tool out of its slot to show it is the active one. */
  raise(tool) {
    for (const other of this.tools) if (other !== tool) other.raised = false;
    if (tool) tool.raised = true;
  }

  /** World-space position of a tool's working tip. */
  tipWorld(tool, out) {
    tool.group.updateMatrixWorld();
    return out.copy(tool.tipLocal).applyMatrix4(tool.group.matrixWorld);
  }

  /** All tool meshes, for desktop mouse picking. */
  pickables() {
    return this.tools.map((t) => t.group);
  }

  toolFromObject(object) {
    let node = object;
    while (node) {
      const hit = this.tools.find((t) => t.group === node);
      if (hit) return hit;
      node = node.parent;
    }
    return null;
  }

  update(dt) {
    // Tools stay parented to the tray even while carried, so a held pose has to
    // be converted out of world space and into the tray's frame.
    this.group.updateMatrixWorld();
    this.group.getWorldQuaternion(this._trayQuat);
    this._trayInverse.copy(this._trayQuat).invert();

    for (const tool of this.tools) {
      if (tool.holder) {
        tool.holder.updateMatrixWorld();
        tool.holder.getWorldQuaternion(this._q);
        tool.holder.getWorldPosition(this._v);
        // The left hand is mirrored geometry, so its thumb sits at -X.
        const sign = tool.holder.userData.handSign || 1;
        this._w.set(HOLD_ACROSS * sign, HOLD_ALONG, HOLD_DEPTH);
        this._v.add(this._w.applyQuaternion(this._q));

        tool.group.quaternion.copy(this._trayInverse).multiply(this._q).multiply(HOLD_TILT);
        tool.group.position.copy(this.group.worldToLocal(this._v));
        continue;
      }

      // ease back into the slot (raised a little if desktop-selected)
      const targetY = tool.slotPosition.y + (tool.raised ? 0.055 : 0);
      const k = Math.min(1, dt * RETURN_SPEED);
      tool.group.position.x += (tool.slotPosition.x - tool.group.position.x) * k;
      tool.group.position.y += (targetY - tool.group.position.y) * k;
      tool.group.position.z += (tool.slotPosition.z - tool.group.position.z) * k;
      tool.group.quaternion.slerp(tool.slotQuaternion, k);
    }
  }
}

// --------------------------------------------------------------- tool shapes

function handle(length = 0.10, radius = 0.0085, material = HANDLE) {
  const geometry = new THREE.CylinderGeometry(radius * 0.8, radius, length, 14);
  geometry.translate(0, -length / 2, 0);
  const mesh = new THREE.Mesh(geometry, material);
  return mesh;
}

function ballStylus() {
  const group = new THREE.Group();
  group.add(handle());
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.014, 20, 14), STEEL);
  tip.position.y = 0.014;
  group.add(tip);
  return { group, tipLength: 0.028, highlight: tip };
}

function pointedStylus() {
  const group = new THREE.Group();
  group.add(handle());
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.010, 0.038, 18), STEEL);
  tip.position.y = 0.019;
  group.add(tip);
  return { group, tipLength: 0.038, highlight: tip };
}

function bulbStylus() {
  const group = new THREE.Group();
  group.add(handle());
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.020, 20, 14), STEEL);
  tip.position.y = 0.020;
  tip.scale.set(1, 1.15, 1);
  group.add(tip);
  return { group, tipLength: 0.040, highlight: tip };
}

function spatula() {
  const group = new THREE.Group();
  group.add(handle(0.09, 0.0085, WOOD));
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.048, 0.005), STEEL);
  blade.position.y = 0.024;
  group.add(blade);
  return { group, tipLength: 0.046, highlight: blade };
}

function paddle() {
  const group = new THREE.Group();
  group.add(handle(0.09, 0.0085, WOOD));
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.032, 0.004), STEEL);
  blade.position.y = 0.016;
  group.add(blade);
  return { group, tipLength: 0.030, highlight: blade };
}

function needle() {
  const group = new THREE.Group();
  group.add(handle());
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.0045, 0.048, 14), STEEL);
  tip.position.y = 0.024;
  group.add(tip);
  return { group, tipLength: 0.048, highlight: tip };
}

function paintBrush() {
  const group = new THREE.Group();
  group.add(handle(0.10, 0.0085, WOOD));
  const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.018, 14), STEEL);
  ferrule.position.y = 0.009;
  group.add(ferrule);
  const bristles = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.030, 16), BRISTLE);
  bristles.position.y = 0.031;
  group.add(bristles);
  return { group, tipLength: 0.044, highlight: bristles };
}
