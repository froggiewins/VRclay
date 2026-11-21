// Posing and animating the hand skeleton.
//
// The model's 21 bones are named Bone, Bone.001 ... Bone.020 — no anatomy in
// the names — so which chain is which finger is worked out from the bind pose:
// five chains hang off the wrist, the thumb is the one sitting on the palm side
// of the others, and the remaining four sort across the hand from index to
// pinky. Doing it by measurement rather than by hardcoded names means a
// different hand export has a fair chance of just working.

import * as THREE from 'three';

export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];

/** WebXR hand joints, in order along each finger. */
const JOINT_NAMES = {
  thumb: ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  index: ['index-finger-metacarpal', 'index-finger-phalanx-proximal',
    'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
  middle: ['middle-finger-metacarpal', 'middle-finger-phalanx-proximal',
    'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
  ring: ['ring-finger-metacarpal', 'ring-finger-phalanx-proximal',
    'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
  pinky: ['pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal',
    'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'],
};

const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _current = new THREE.Vector3();
const _boneWorld = new THREE.Quaternion();
const _parentWorld = new THREE.Quaternion();
const _swing = new THREE.Quaternion();

// How far each bone in a chain rotates at full curl, in radians. The first bone
// is the metacarpal, buried in the palm, so it barely moves; the knuckle and
// middle joints do most of the work.
//
// These are deliberately short of a real hand's range. Anatomically a finger
// folds through about 200 degrees, but this mesh's skin weights fall apart well
// before that — the fingers collapse through the palm. ~150 still reads as a
// closed fist and stays clean.
const CURL_LIMITS = {
  thumb: [0.18, 0.48, 0.58, 0.42],
  index: [0.09, 0.98, 1.08, 0.52],
  middle: [0.09, 1.00, 1.10, 0.54],
  ring: [0.10, 1.00, 1.10, 0.54],
  pinky: [0.11, 0.98, 1.08, 0.52],
};

// A splay angle opens the fingers away from each other; negative closes them.
const SPLAY_LIMITS = { thumb: 0.55, index: 0.16, middle: 0.0, ring: -0.14, pinky: -0.26 };

// Poses stay inside about 0.65 curl. Past that this model's skin weights give
// out — the fingers start folding through the palm — and a closed hand reads
// perfectly well at this range anyway.
export const POSES = {
  // flat, fingers straight out
  open: { thumb: 0.02, index: 0.02, middle: 0.02, ring: 0.02, pinky: 0.02, splay: 0.35 },
  // what a hand does when you stop thinking about it
  relaxed: { thumb: 0.26, index: 0.28, middle: 0.31, ring: 0.35, pinky: 0.40, splay: 0.15 },
  // wrapped around a tool handle
  grip: { thumb: 0.46, index: 0.52, middle: 0.58, ring: 0.61, pinky: 0.63, splay: -0.05 },
  // pressing a fingertip into the clay
  press: { thumb: 0.40, index: 0.10, middle: 0.52, ring: 0.56, pinky: 0.60, splay: 0.0 },
  // squeezing a fistful of clay
  fist: { thumb: 0.56, index: 0.62, middle: 0.65, ring: 0.65, pinky: 0.65, splay: -0.10 },
  // thumb and index meeting
  pinch: { thumb: 0.58, index: 0.50, middle: 0.44, ring: 0.47, pinky: 0.50, splay: 0.0 },
};

/**
 * Works out the finger chains and, for each bone, the axis that curls it.
 * @returns {object|null} rig, or null if the skeleton isn't shaped as expected
 */
export function buildHandRig(skinnedMesh) {
  const skeleton = skinnedMesh?.skeleton;
  if (!skeleton || skeleton.bones.length < 6) return null;

  const bones = skeleton.bones;
  const root = bones.find((b) => !b.parent || !b.parent.isBone) || bones[0];
  const chains = [];
  for (const child of root.children) {
    if (!child.isBone) continue;
    const chain = [];
    let node = child;
    while (node) {
      chain.push(node);
      node = node.children.find((c) => c.isBone);
    }
    chains.push(chain);
  }
  if (chains.length !== 5) return null;

  skinnedMesh.updateMatrixWorld(true);
  const wrist = new THREE.Vector3();
  root.getWorldPosition(wrist);

  const measured = chains.map((chain) => {
    const tip = new THREE.Vector3();
    chain[chain.length - 1].getWorldPosition(tip);
    const knuckle = new THREE.Vector3();
    (chain[1] || chain[0]).getWorldPosition(knuckle);
    return {
      chain,
      tip: tip.clone().sub(wrist),
      knuckle: knuckle.clone().sub(wrist),
      dir: tip.clone().sub(wrist).normalize(),
      length: tip.distanceTo(wrist),
    };
  });

  const fingers = identifyFingers(measured) || identifyByName(chains);
  if (!fingers) return null;

  // Palm normal: perpendicular to the way the fingers point *and* the way the
  // knuckles run across the hand. Deriving it from the fingertips instead looks
  // tempting but the tips sit almost in a line, so that plane is ill-conditioned
  // and comes out tilted ~45 degrees into the fingers.
  const four = FINGERS.slice(1).map((n) => measured.find((m) => m.chain === fingers[n]));
  const along = four.map((m) => m.dir).reduce((a, b) => a.clone().add(b)).normalize();
  const across = four[3].knuckle.clone().sub(four[0].knuckle).normalize();
  const palmNormal = new THREE.Vector3().crossVectors(across, along).normalize();

  // Point it palm-ward: that is the side the thumb sits on.
  const centroid = four.map((m) => m.tip)
    .reduce((a, b) => a.clone().add(b)).divideScalar(four.length);
  if (tipOf(measured, fingers.thumb).clone().sub(centroid).dot(palmNormal) < 0) {
    palmNormal.negate();
  }

  const rest2 = new Map();
  const bend = new Map();
  const spread = new Map();
  const worldQuat = new THREE.Quaternion();
  const knuckleWorld = new THREE.Vector3();
  const tipWorld = new THREE.Vector3();

  for (const name of FINGERS) {
    const chain = fingers[name];

    // One hinge axis for the whole finger, worked out in world space. Deriving
    // it separately per bone looks equivalent but isn't: bone roll varies along
    // the chain, so the axis comes out flipped on some joints and the finger
    // folds into an S and stretches instead of curling.
    chain[Math.min(1, chain.length - 1)].getWorldPosition(knuckleWorld);
    chain[chain.length - 1].getWorldPosition(tipWorld);
    const fingerDir = tipWorld.clone().sub(knuckleWorld).normalize();
    const hinge = new THREE.Vector3().crossVectors(fingerDir, palmNormal);
    if (hinge.lengthSq() < 1e-8) hinge.copy(across);
    hinge.normalize();

    for (const bone of chain) {
      rest2.set(bone, bone.quaternion.clone());
      bone.getWorldQuaternion(worldQuat).invert();
      // The same physical axis, expressed in each bone's own frame.
      bend.set(bone, hinge.clone().applyQuaternion(worldQuat).normalize());
      // Splay swings sideways instead, about the palm normal.
      spread.set(bone, palmNormal.clone().applyQuaternion(worldQuat).normalize());
    }
  }

  return { root, fingers, rest: rest2, bend, spread, palmNormal };
}

function tipOf(measured, chain) {
  return measured.find((m) => m.chain === chain).tip;
}

/** Rough plane normal through four roughly-coplanar points, via the diagonals. */
function planeNormal(points) {
  const d1 = points[2].clone().sub(points[0]);
  const d2 = points[3].clone().sub(points[1]);
  return new THREE.Vector3().crossVectors(d1, d2).normalize();
}

/**
 * Which chain is which finger, from shape alone.
 *
 * The four fingers point roughly the same way and lie in a plane; the thumb
 * does neither. So: rank the chains by how far their direction strays from the
 * average, take the two odd ones out (thumb and pinky are both short and
 * splayed, so both score high), then settle it by which one sits furthest off
 * the plane of the other four — that is the thumb, because it opposes.
 */
function identifyFingers(measured) {
  const mean = measured.map((m) => m.dir).reduce((a, b) => a.clone().add(b)).normalize();
  const ranked = [...measured].sort((a, b) => a.dir.dot(mean) - b.dir.dot(mean));

  let thumb = null;
  let bestOffset = -Infinity;
  for (const candidate of ranked.slice(0, 2)) {
    const rest = measured.filter((m) => m !== candidate);
    const normal = planeNormal(rest.map((m) => m.tip));
    const centroid = rest.map((m) => m.tip)
      .reduce((a, b) => a.clone().add(b)).divideScalar(rest.length);
    const offset = Math.abs(candidate.tip.clone().sub(centroid).dot(normal));
    if (offset > bestOffset) { bestOffset = offset; thumb = candidate; }
  }
  if (!thumb) return null;

  // The remaining four run in a row across the hand. The row's direction is
  // perpendicular to both the palm normal and the way the fingers point.
  const rest = measured.filter((m) => m !== thumb);
  const normal = planeNormal(rest.map((m) => m.tip));
  const along = rest.map((m) => m.dir).reduce((a, b) => a.clone().add(b)).normalize();
  const across = new THREE.Vector3().crossVectors(normal, along).normalize();

  // Order by knuckle, not fingertip: knuckles sit in a clean row across the
  // palm, while tips vary with finger length and can end up nearly tied.
  const ordered = rest.sort((a, b) => a.knuckle.dot(across) - b.knuckle.dot(across));
  if (ordered[ordered.length - 1].knuckle.distanceTo(thumb.knuckle)
    < ordered[0].knuckle.distanceTo(thumb.knuckle)) ordered.reverse();

  const fingers = {
    thumb: thumb.chain,
    index: ordered[0].chain,
    middle: ordered[1].chain,
    ring: ordered[2].chain,
    pinky: ordered[3].chain,
  };

  // Check the result against the shape of a real hand before trusting it: the
  // middle finger is the longest, and they get shorter out to the pinky.
  const len = (name) => measured.find((m) => m.chain === fingers[name]).length;
  const plausible = len('middle') >= len('index')
    && len('middle') >= len('ring')
    && len('ring') >= len('pinky')
    && len('index') >= len('pinky');
  return plausible ? fingers : null;
}

/** Fallback for the bundled hand.dae, whose bones are named without anatomy. */
function identifyByName(chains) {
  const byFirst = new Map(chains.map((c) => [c[0].name.replace('.', '_'), c]));
  const map = {
    thumb: 'Bone_001', index: 'Bone_002', middle: 'Bone_003',
    ring: 'Bone_004', pinky: 'Bone_005',
  };
  const fingers = {};
  for (const [finger, bone] of Object.entries(map)) {
    const chain = byFirst.get(bone);
    if (!chain) return null;
    fingers[finger] = chain;
  }
  return fingers;
}

/** Eases a hand between poses and writes the result onto the bones. */
export class HandPoser {
  constructor(rig) {
    this.rig = rig;
    this.current = { splay: 0.2 };
    this.target = { splay: 0.2 };
    for (const name of FINGERS) {
      this.current[name] = 0.2;
      this.target[name] = 0.2;
    }
    this._q = new THREE.Quaternion();
    this._jointDriven = false;
  }

  /** @param {string|object} pose a name from POSES, or per-finger amounts */
  setPose(pose) {
    const values = typeof pose === 'string' ? POSES[pose] : pose;
    if (!values) return;
    for (const key of Object.keys(this.target)) {
      if (values[key] !== undefined) this.target[key] = values[key];
    }
  }

  /** Overrides one finger, e.g. the index while the trigger is squeezed. */
  setFinger(name, amount) {
    if (this.target[name] !== undefined) this.target[name] = amount;
  }

  update(dt) {
    if (!this.rig || this._jointDriven) return;
    // Time-constant easing, so it settles the same way at any frame rate.
    const k = 1 - Math.exp(-dt * 14);
    for (const key of Object.keys(this.current)) {
      this.current[key] += (this.target[key] - this.current[key]) * k;
    }
    this.apply();
  }

  apply() {
    const { rig } = this;
    for (const name of FINGERS) {
      const curl = this.current[name];
      const limits = CURL_LIMITS[name];
      const splay = this.current.splay * (SPLAY_LIMITS[name] || 0);
      rig.fingers[name].forEach((bone, i) => {
        const restQ = rig.rest.get(bone);
        bone.quaternion.copy(restQ);
        const angle = curl * (limits[i] ?? limits[limits.length - 1]);
        if (angle) {
          bone.quaternion.multiply(this._q.setFromAxisAngle(rig.bend.get(bone), angle));
        }
        // Only the knuckle splays; the joints past it just follow.
        if (i === 1 && splay) {
          bone.quaternion.multiply(this._q.setFromAxisAngle(rig.spread.get(bone), splay));
        }
      });
    }
  }

  /**
   * Drives the fingers from real tracked hand joints, aiming each bone at the
   * next joint along. Aiming uses joint *positions* only, so it doesn't depend
   * on the per-joint orientation convention.
   *
   * Every frame starts from the rest pose and is solved fresh. Nudging the
   * previous frame's pose toward the target instead lets error accumulate, and
   * the hand shakes itself apart.
   */
  poseFromJoints(joints, handRoot) {
    const { rig } = this;
    if (!rig || !joints) return false;
    const wrist = joints.wrist;
    if (!wrist || wrist.visible === false) return false;

    for (const name of FINGERS) {
      for (const bone of rig.fingers[name]) bone.quaternion.copy(rig.rest.get(bone));
    }
    if (handRoot) handRoot.updateMatrixWorld(true);

    let posed = 0;
    for (const finger of FINGERS) {
      const chain = rig.fingers[finger];
      const jointNames = JOINT_NAMES[finger];

      for (let i = 0; i < chain.length; i++) {
        const a = joints[jointNames[i]];
        const b = joints[jointNames[i + 1]];
        if (!a || !b || a.visible === false || b.visible === false) continue;

        const bone = chain[i];
        const child = bone.children.find((c) => c.isBone);
        if (!child) continue;

        a.getWorldPosition(_from);
        b.getWorldPosition(_to);
        _desired.copy(_to).sub(_from);
        if (_desired.lengthSq() < 1e-10) continue;
        _desired.normalize();

        // Where this bone points right now, in world space.
        bone.getWorldQuaternion(_boneWorld);
        _current.copy(child.position).normalize().applyQuaternion(_boneWorld);
        if (_current.lengthSq() < 1e-10) continue;

        // Swing it onto the tracked direction, expressed in the parent's space.
        _swing.setFromUnitVectors(_current, _desired);
        bone.parent.getWorldQuaternion(_parentWorld).invert();
        bone.quaternion.copy(_parentWorld).multiply(_swing).multiply(_boneWorld);
        // Children move with it, so refresh before solving the next bone down.
        bone.updateMatrixWorld(true);
        posed++;
      }
    }

    this._jointDriven = posed > 0;
    return this._jointDriven;
  }

  /** Hand tracking dropped out — go back to pose-driven animation. */
  releaseJoints() {
    this._jointDriven = false;
  }
}
