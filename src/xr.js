// WebXR plumbing: the session button, per-hand input rigs (controllers *and*
// tracked hands), and the two-handed hold/scale manipulator.

import * as THREE from 'three';

const JOINT_TIP = 'index-finger-tip';
const JOINT_WRIST = 'wrist';

// Placing the hand model on a controller. The grip frame has -Z pointing the
// way a held rod points and +Y out of the top of the fist; the model's frame is
// +Y toward the fingertips and +Z out of the back of the hand. Rotating -90
// degrees about X maps one onto the other. The offset then slides the wrist
// back behind the grip point, where a real wrist sits.
const GRIP_TO_WRIST = new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const GRIP_WRIST_OFFSET = new THREE.Vector3(0, 0.012, 0.036);

const _wristPos = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _side = new THREE.Vector3();
const _back = new THREE.Vector3();
const _basis = new THREE.Matrix4();

export function createVRButton(renderer, { onStatus } = {}) {
  const button = document.createElement('button');
  button.id = 'vr-button';
  button.textContent = 'Checking VR…';
  button.disabled = true;

  if (!navigator.xr) {
    button.textContent = 'VR not available';
    onStatus?.('This browser has no WebXR. Desktop sculpting still works.');
    return button;
  }

  navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
    if (!supported) {
      button.textContent = 'No VR headset';
      onStatus?.('No immersive-VR device found. Desktop sculpting still works.');
      return;
    }
    button.disabled = false;
    button.textContent = 'Enter VR';
  }).catch(() => {
    button.textContent = 'VR unavailable';
  });

  let session = null;
  button.addEventListener('click', async () => {
    if (session) {
      session.end();
      return;
    }
    try {
      session = await navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'],
      });
      await renderer.xr.setSession(session);
      button.textContent = 'Exit VR';
      session.addEventListener('end', () => {
        session = null;
        button.textContent = 'Enter VR';
      });
    } catch (err) {
      onStatus?.(`Could not start VR: ${err.message}`);
      session = null;
    }
  });

  return button;
}

/** One tracked hand or controller. */
class Rig {
  constructor(renderer, scene, index) {
    this.index = index;
    this.handedness = index === 0 ? 'left' : 'right';
    this.isHand = false;
    this.connected = false;
    this.selecting = false;
    this.squeezing = false;
    this.gamepad = null;
    this.tipWorld = new THREE.Vector3();
    this.prevTipWorld = new THREE.Vector3();
    this.hasTip = false;
    this.hadTip = false;

    // the visible hand, and where its fingertip lands
    this.handModel = null;
    this.fingertipLocal = new THREE.Vector3(0, 0.178, 0);
    this.fingertipWorld = new THREE.Vector3();
    this.handPosed = false;
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();

    this.controller = renderer.xr.getController(index);
    this.grip = renderer.xr.getControllerGrip(index);
    this.hand = renderer.xr.getHand(index);
    scene.add(this.controller, this.grip, this.hand);

    // Brush tip sits a little ahead of the controller, roughly where a real
    // modelling tool would poke out of your fist.
    this.tip = new THREE.Object3D();
    this.tip.position.set(0, -0.005, -0.06);
    this.grip.add(this.tip);

    this.controller.addEventListener('connected', (event) => {
      this.connected = true;
      this.handedness = event.data.handedness || this.handedness;
      this.isHand = !!event.data.hand;
      this.gamepad = event.data.gamepad || null;
      this.inputSource = event.data;
    });
    this.controller.addEventListener('disconnected', () => {
      this.connected = false;
      this.gamepad = null;
      this.inputSource = null;
      this.selecting = false;
      this.squeezing = false;
    });
  }

  /** The hand mesh this rig drives. Origin is the wrist. */
  setHandModel(group, fingertipLocal) {
    this.handModel = group;
    if (fingertipLocal) this.fingertipLocal.copy(fingertipLocal);
  }

  /**
   * Places the hand from tracked joint *positions* — wrist for the origin,
   * wrist-to-middle-knuckle for forward, and the knuckle row for the sideways
   * axis. Reading the wrist joint's own orientation would be shorter, but it
   * depends on a convention that is easy to get 90 degrees wrong; positions are
   * unambiguous.
   *
   * @returns {boolean} whether the hand was placed
   */
  _poseFromJoints() {
    const joints = this.hand?.joints;
    if (!joints) return false;
    const wrist = joints[JOINT_WRIST];
    const middle = joints['middle-finger-metacarpal'];
    const index = joints['index-finger-metacarpal'];
    const pinky = joints['pinky-finger-metacarpal'];
    if (!wrist || !middle || !index || !pinky) return false;
    if (wrist.visible === false) return false;

    wrist.getWorldPosition(_wristPos);
    middle.getWorldPosition(_a);
    index.getWorldPosition(_b);
    pinky.getWorldPosition(_c);

    _forward.copy(_a).sub(_wristPos);
    if (_forward.lengthSq() < 1e-8) return false;       // joints not tracked yet
    _forward.normalize();

    // +X of the model is the thumb side on the left hand and, because the right
    // hand is the mirrored copy, the pinky side on the right.
    if (this.handedness === 'right') _side.copy(_c).sub(_b);
    else _side.copy(_b).sub(_c);
    if (_side.lengthSq() < 1e-8) return false;
    _side.normalize();

    _back.crossVectors(_side, _forward).normalize();
    _side.crossVectors(_forward, _back).normalize();     // re-square

    _basis.makeBasis(_side, _forward, _back);
    this.handModel.quaternion.setFromRotationMatrix(_basis);
    this.handModel.position.copy(_wristPos);
    return true;
  }

  /**
   * Poses the hand. Tracked hands give a real wrist joint, so the model lands
   * exactly on it; controllers only give a grip pose, so the wrist is derived
   * from that.
   */
  _poseHand() {
    if (!this.handModel) return;
    if (this._poseFromJoints()) {
      this.handPosed = true;
    } else if (this.grip.visible) {
      this.grip.getWorldQuaternion(this._q);
      this.handModel.quaternion.copy(this._q).multiply(GRIP_TO_WRIST);
      this.grip.getWorldPosition(this._v);
      this.handModel.position.copy(GRIP_WRIST_OFFSET)
        .applyQuaternion(this._q).add(this._v);
      this.handPosed = true;
    } else {
      this.handPosed = false;
    }

    this.handModel.visible = this.handPosed;
    if (this.handPosed) {
      this.handModel.updateMatrixWorld();
      this.fingertipWorld.copy(this.fingertipLocal).applyMatrix4(this.handModel.matrixWorld);
    }
  }

  /** Recomputes the brush tip in world space. */
  update() {
    this.hadTip = this.hasTip;
    this.prevTipWorld.copy(this.tipWorld);
    this._poseHand();

    const joint = this.hand?.joints?.[JOINT_TIP];
    const tracked = joint && joint.visible !== false
      && (joint.position.x !== 0 || joint.position.y !== 0 || joint.position.z !== 0);
    if (tracked) {
      joint.getWorldPosition(this.tipWorld);
      this.hasTip = true;
    } else if (this.handPosed) {
      // Contact point is the visible fingertip, so bare-handed sculpting lands
      // where the hand looks like it is touching.
      this.tipWorld.copy(this.fingertipWorld);
      this.hasTip = true;
    } else if (this.grip.visible) {
      this.tip.getWorldPosition(this.tipWorld);
      this.hasTip = true;
    } else {
      this.hasTip = false;
    }

    if (this.hasTip && !this.hadTip) this.prevTipWorld.copy(this.tipWorld);
  }

  /** Movement of the tip since the previous frame. */
  tipDelta(out) {
    return out.copy(this.tipWorld).sub(this.prevTipWorld);
  }

  pulse(intensity = 0.3, ms = 20) {
    const actuator = this.gamepad?.hapticActuators?.[0];
    if (actuator?.pulse) {
      try { actuator.pulse(intensity, ms); } catch { /* not fatal */ }
    }
  }
}

export class XRInput {
  constructor(renderer, scene) {
    this.rigs = [new Rig(renderer, scene, 0), new Rig(renderer, scene, 1)];
    this._buttons = [[], []];
  }

  on(event, handler) {
    for (const rig of this.rigs) {
      rig.controller.addEventListener(event, () => handler(rig));
    }
  }

  update() {
    for (const rig of this.rigs) rig.update();
  }

  /** Rising-edge detection for a gamepad button on a specific rig. */
  pressed(rig, buttonIndex) {
    const button = rig.gamepad?.buttons?.[buttonIndex];
    const down = !!button?.pressed;
    const store = this._buttons[rig.index];
    const was = !!store[buttonIndex];
    store[buttonIndex] = down;
    return down && !was;
  }

  axis(rig, index) {
    const value = rig.gamepad?.axes?.[index];
    if (value === undefined) return 0;
    return Math.abs(value) < 0.2 ? 0 : value;
  }

  byHandedness(handedness) {
    return this.rigs.find((r) => r.connected && r.handedness === handedness);
  }
}

/**
 * Holds the sculpture: one hand moves and rotates it, two hands also scale it.
 * Works off raw hand poses, so controllers and tracked hands behave the same.
 */
export class Holder {
  constructor(target, { minScale = 0.35, maxScale = 3.5 } = {}) {
    this.target = target;
    this.minScale = minScale;
    this.maxScale = maxScale;
    this.active = false;
    this._start = null;
    this._q = new THREE.Quaternion();
    this._inv = new THREE.Quaternion();
    this._axis = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._mid = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._x = new THREE.Vector3(1, 0, 0);
    this._frameOut = { position: this._mid, quaternion: this._axis, distance: 0 };
  }

  /** @param {Array<{position:THREE.Vector3, quaternion:THREE.Quaternion}>} hands */
  begin(hands) {
    if (hands.length === 0) return;
    const frame = this._frame(hands);
    this._start = {
      count: hands.length,
      position: frame.position.clone(),
      quaternion: frame.quaternion.clone(),
      distance: frame.distance,
      targetPosition: this.target.position.clone(),
      targetQuaternion: this.target.quaternion.clone(),
      targetScale: this.target.scale.x,
    };
    this.active = true;
  }

  update(hands) {
    if (!this.active || !this._start) return;
    if (hands.length !== this._start.count) {
      // A hand joined or left: rebase so the sculpture doesn't jump.
      this.begin(hands);
      return;
    }
    const frame = this._frame(hands);
    const start = this._start;

    const dq = this._q.copy(frame.quaternion)
      .multiply(this._inv.copy(start.quaternion).invert());

    let ratio = 1;
    if (start.count === 2 && start.distance > 1e-4) {
      ratio = frame.distance / start.distance;
    }
    const scale = clamp(start.targetScale * ratio, this.minScale, this.maxScale);
    ratio = scale / start.targetScale;

    this.target.quaternion.copy(dq).multiply(start.targetQuaternion);
    this.target.scale.setScalar(scale);

    const rel = this._v.copy(start.targetPosition).sub(start.position)
      .applyQuaternion(dq).multiplyScalar(ratio);
    this.target.position.copy(frame.position).add(rel);
  }

  end() {
    this.active = false;
    this._start = null;
  }

  _frame(hands) {
    const out = this._frameOut;
    if (hands.length === 1) {
      out.position = this._mid.copy(hands[0].position);
      out.quaternion = hands[0].quaternion;
      out.distance = 0;
      return out;
    }
    const a = hands[0].position;
    const b = hands[1].position;
    this._mid.copy(a).add(b).multiplyScalar(0.5);
    this._dir.copy(b).sub(a);
    const distance = this._dir.length() || 1e-4;
    this._dir.divideScalar(distance);
    // With two hands, rotation follows the axis between them: turn the axis and
    // the sculpture turns with it, pull them apart and it grows.
    out.position = this._mid;
    out.quaternion = this._axis.setFromUnitVectors(this._x, this._dir);
    out.distance = distance;
    return out;
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
