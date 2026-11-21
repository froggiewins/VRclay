// The sculptor's hands.
//
// hand.dae is a rigged right hand from Blender. The skeleton is kept live so
// the fingers can actually move (see handrig.js); only the placement is
// normalised here, into the convention WebXR uses for hand joints:
//
//     +Y  toward the fingertips
//     +Z  out of the BACK of the hand
//     +X  thumb side (right hand)
//
// so a hand can be parented straight onto a tracked wrist joint.
//
// Two independent skeletons are needed, one per hand. SkinnedMesh.clone() does
// not carry its skeleton (the mesh collapses into a sliver), so the file is
// parsed twice instead — the download happens once and the parse is cheap
// compared to getting cloning right.

import * as THREE from 'three';
import { ColladaLoader } from '../vendor/jsm/loaders/ColladaLoader.js';
import { buildHandRig, HandPoser } from './handrig.js';

const MODEL_URL = './hand.dae';
const HAND_LENGTH = 0.19;        // metres, wrist to fingertip

let pending = null;

export function loadHands(url = MODEL_URL) {
  if (!pending) pending = prepare(url);
  return pending;
}

async function prepare(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → ${response.status}`);
  const text = await response.text();

  const loader = new ColladaLoader();
  const right = build(loader.parse(text, ''), 'right');
  const left = build(loader.parse(text, ''), 'left');
  return { right, left, fingertip: right.fingertip.clone() };
}

function build(collada, handedness) {
  const scene = collada.scene;
  scene.updateMatrixWorld(true);

  let skinned = null;
  scene.traverse((o) => { if (!skinned && o.isSkinnedMesh) skinned = o; });
  if (!skinned) throw new Error('hand.dae has no skinned mesh');

  const inner = new THREE.Group();
  inner.add(scene);

  const group = new THREE.Group();
  group.name = `hand-${handedness}`;
  group.add(inner);
  group.updateMatrixWorld(true);

  // The rig has to be read before anything is moved, so its bend axes are
  // derived in the model's own frame.
  const rig = buildHandRig(skinned);

  // Orient from the skeleton rather than assuming: the bones, not the raw
  // geometry, decide which way the finished hand points, and in this file they
  // disagree. Line the fingers up with +Y and the back of the hand with +Z.
  if (rig) {
    const wrist = new THREE.Vector3();
    const tip = new THREE.Vector3();
    rig.root.getWorldPosition(wrist);
    const middle = rig.fingers.middle;
    middle[middle.length - 1].getWorldPosition(tip);

    const forward = tip.sub(wrist).normalize();                 // toward fingertips
    const back = rig.palmNormal.clone().negate();               // out of the back
    const side = new THREE.Vector3().crossVectors(forward, back).normalize();
    back.crossVectors(side, forward).normalize();               // re-square it

    const basis = new THREE.Matrix4().makeBasis(side, forward, back);
    inner.quaternion.setFromRotationMatrix(basis).invert();
    group.updateMatrixWorld(true);
  }

  // Measure what the skinning actually produces rather than what the geometry
  // and node transforms imply. In this file the armature sits at a different
  // scale from the mesh, so geometry-bounds x world-matrix is out by ~12x; the
  // bones are what really place the vertices.
  const bounds = measureSkinned(skinned, group);
  const size = new THREE.Vector3();
  bounds.getSize(size);
  const scale = HAND_LENGTH / Math.max(size.x, size.y, size.z);
  inner.scale.setScalar(scale);
  // Wrist to the origin, hand centred across its width.
  inner.position.set(
    -(bounds.min.x + bounds.max.x) * 0.5 * scale,
    -bounds.min.y * scale,
    -(bounds.min.z + bounds.max.z) * 0.5 * scale,
  );
  group.updateMatrixWorld(true);
  // Which way the thumb points in this hand's own space, so a held tool can be
  // offset toward it rather than toward the pinky on one side.
  // hand.dae is a LEFT hand, not a right one. Measured, not eyeballed: the
  // thumb sits at +X, fingers run +Y and the back faces +Z, so
  // thumb x fingers points along the back — and that cross product comes out
  // the other way for a right hand. So the right hand is the mirrored one.
  const mirrored = handedness === 'right';
  group.userData.handSign = mirrored ? -1 : 1;

  if (mirrored) {
    // Mirroring reverses triangle winding, so the far side is the one facing
    // us — render back faces to put the surface right again.
    group.scale.x = -1;
  }

  skinned.material = new THREE.MeshStandardMaterial({
    color: 0xd8a184,
    roughness: 0.72,
    metalness: 0,
    side: mirrored ? THREE.BackSide : THREE.FrontSide,
  });
  skinned.castShadow = true;
  skinned.frustumCulled = false;      // it lives on the camera's doorstep

  const poser = rig ? new HandPoser(rig) : null;
  if (poser) {
    poser.setPose('relaxed');
    poser.current = { ...poser.target };
    poser.apply();
  }

  // Contact point for bare-handed sculpting: just inside the fingertips, taken
  // from the placed hand rather than guessed.
  const placed = measureSkinned(skinned, group);
  const fingertip = new THREE.Vector3(0, placed.max.y * 0.96, 0);

  return { group, skinned, rig, poser, fingertip };
}

/**
 * Bounding box of the mesh *after* skinning, expressed in `space`'s local
 * coordinates. Samples vertices rather than walking all 45k of them.
 */
function measureSkinned(skinned, space) {
  const position = skinned.geometry.attributes.position;
  const step = Math.max(1, Math.floor(position.count / 3000));
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i += step) {
    v.fromBufferAttribute(position, i);
    skinned.applyBoneTransform(i, v);
    v.applyMatrix4(skinned.matrixWorld);
    space.worldToLocal(v);
    box.expandByPoint(v);
  }
  return box;
}

/** @deprecated kept so older callers still work */
export function createHandMaterial() {
  return new THREE.MeshStandardMaterial({ color: 0xd8a184, roughness: 0.72 });
}

export function createHand(hands, handedness) {
  return handedness === 'left' ? hands.left : hands.right;
}

export function fingertipOffset(hands) {
  return hands.fingertip;
}
