// The sculpting engine.
//
// The mesh is dynamic: brushes move vertices, and a dyntopo pass splits edges
// that get too long and collapses ones that get too short, so detail appears
// exactly where you sculpt instead of being fixed at creation time.
//
// Storage is a slab allocator over pre-sized typed arrays — vertices and
// triangles are never reallocated, they're recycled through free lists, so the
// GPU buffers are created once and only dirty ranges are re-uploaded.

import * as THREE from 'three';
import { createIcosphere } from './icosphere.js';

const MAX_VERTS = 120000;
const MAX_TRIS = 240000;
// The hash grid packs cell coordinates into 10 bits each, so it can only
// address +/- 512 cells before keys alias and queries silently return the wrong
// vertices. Everything the clay is allowed to do has to stay inside that.
const GRID_HALF_CELLS = 512;
const REACH_CELLS = 205;                   // ~24x the ball radius
const VALENCE = 16;                        // triangles per vertex, hard cap
const UNDO_BUDGET = 48 * 1024 * 1024;      // total bytes kept for undo
const SPLIT_BUDGET = 700;                  // topology edits per stroke step

/** Uniform spatial hash with O(1) insert/remove, so it can track moving points. */
class HashGrid {
  constructor(capacity, cell) {
    this.cell = cell;
    this.buckets = new Map();
    this.keyOf = new Int32Array(capacity).fill(-1);
    this.slot = new Int32Array(capacity).fill(-1);
  }

  key(x, y, z) {
    const c = this.cell;
    return ((Math.floor(x / c) + 512) * 1024 + (Math.floor(y / c) + 512)) * 1024
      + (Math.floor(z / c) + 512);
  }

  insertKey(id, key) {
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = [];
      this.buckets.set(key, bucket);
    }
    this.slot[id] = bucket.length;
    bucket.push(id);
    this.keyOf[id] = key;
  }

  insert(id, x, y, z) {
    this.insertKey(id, this.key(x, y, z));
  }

  remove(id) {
    if (this.keyOf[id] === -1) return;
    const bucket = this.buckets.get(this.keyOf[id]);
    if (bucket) {
      const last = bucket.pop();
      if (last !== id) {
        bucket[this.slot[id]] = last;
        this.slot[last] = this.slot[id];
      }
    }
    this.keyOf[id] = -1;
  }

  move(id, x, y, z) {
    const key = this.key(x, y, z);
    if (key === this.keyOf[id]) return;
    this.remove(id);
    this.insertKey(id, key);
  }

  clear() {
    this.buckets.clear();
    this.keyOf.fill(-1);
  }

  /** Fills `out` with live vertex ids inside the sphere; returns how many. */
  query(positions, x, y, z, r, out) {
    const c = this.cell;
    const i0 = Math.floor((x - r) / c);
    const i1 = Math.floor((x + r) / c);
    const j0 = Math.floor((y - r) / c);
    const j1 = Math.floor((y + r) / c);
    const k0 = Math.floor((z - r) / c);
    const k1 = Math.floor((z + r) / c);
    const r2 = r * r;
    let n = 0;

    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (let k = k0; k <= k1; k++) {
          const bucket = this.buckets.get(((i + 512) * 1024 + (j + 512)) * 1024 + (k + 512));
          if (bucket === undefined) continue;
          for (let b = 0; b < bucket.length; b++) {
            const id = bucket[b];
            const dx = positions[id * 3] - x;
            const dy = positions[id * 3 + 1] - y;
            const dz = positions[id * 3 + 2] - z;
            if (dx * dx + dy * dy + dz * dz <= r2) out[n++] = id;
          }
        }
      }
    }
    return n;
  }
}

export class ClayMesh {
  constructor({ radius = 0.15, detail = 5, shape = 'sphere' } = {}) {
    this.radius = radius;
    this.detail = detail;
    this.shape = shape;
    this.cell = radius * 0.12;
    // Purely a safety net against clay inverting through its own centre or
    // running away out of the grid's reach — not a limit on how far you can
    // pull a horn or a limb, which is what a tight bound used to make it.
    this.minRadius = radius * 0.02;
    this.maxRadius = this.cell * REACH_CELLS;
    // Tracked separately: the actual extent, which the bounding volumes follow
    // so raycasting and culling stay tight as the sculpt grows.
    this.extent = radius;
    this._boundsDirty = false;

    // --- vertex slab
    this.pos = new Float32Array(MAX_VERTS * 3);
    this.nrm = new Float32Array(MAX_VERTS * 3);
    this.col = new Float32Array(MAX_VERTS * 3);
    this.vAlive = new Uint8Array(MAX_VERTS);
    this.painted = new Uint8Array(MAX_VERTS);
    this.vTri = new Int32Array(MAX_VERTS * VALENCE);   // incident triangles
    this.vTriCount = new Uint8Array(MAX_VERTS);
    this.vTop = 0;          // high-water mark
    this.vLive = 0;
    this.vFree = [];

    // --- triangle slab
    this.tri = new Uint32Array(MAX_TRIS * 3);
    this.tAlive = new Uint8Array(MAX_TRIS);
    // Cached face normals. Vertex normals are sums of these, so a moved vertex
    // costs one cross product per incident face instead of one per face *per
    // vertex of that face* — the difference between 4 ms and 1 ms a frame.
    this.fNrm = new Float32Array(MAX_TRIS * 3);
    this.tTop = 0;
    this.tLive = 0;
    this.tFree = [];

    this.baseColor = new THREE.Color(0xffffff);
    this.grid = new HashGrid(MAX_VERTS, this.cell);

    // --- scratch, all reused
    this._hits = new Int32Array(MAX_VERTS);
    this._weights = new Float32Array(MAX_VERTS);
    this._vStamp = new Int32Array(MAX_VERTS).fill(-1);
    this._tStamp = new Int32Array(MAX_TRIS).fill(-1);
    this._gen = 0;      // vertex stamps, one per stroke
    this._tGen = 0;     // triangle stamps, one per collection sweep
    this._shared2 = new Int32Array(2);
    this._nbrsA = new Int32Array(VALENCE * 2);
    this._nbrsB = new Int32Array(VALENCE * 2);
    this._edge = { a: 0, b: 0, len2: 0 };
    this._dirtyList = new Int32Array(MAX_VERTS);
    this._dirtyCount = 0;
    this._nbrs = new Int32Array(VALENCE * 2);
    this._edges = new Int32Array(SPLIT_BUDGET * 2);
    this._collapses = new Int32Array(SPLIT_BUDGET * 2);
    this._cand = new Int32Array(MAX_TRIS > 65536 ? 65536 : MAX_TRIS);
    this._undo = [];
    this._undoBytes = 0;

    this._vMin = MAX_VERTS; this._vMax = -1;
    this._cMin = MAX_VERTS; this._cMax = -1;
    this._tMin = MAX_TRIS; this._tMax = -1;

    this.stats = { splits: 0, collapses: 0, capped: false };

    this._buildBase(radius, detail, shape);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setIndex(new THREE.BufferAttribute(this.tri, 1));
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius);
    this.geometry.boundingBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
    this.geometry.setDrawRange(0, this.tTop * 3);
    this._recomputeExtent();
    this._applyBounds();

    this.computeAllNormals();
    this._markAll();
  }

  dispose() {
    this.geometry.dispose();
  }

  /** Exact pass over live vertices; used after undo, load and rebuilds. */
  _recomputeExtent() {
    let max = 0;
    for (let v = 0; v < this.vTop; v++) {
      if (!this.vAlive[v]) continue;
      const x = this.pos[v * 3];
      const y = this.pos[v * 3 + 1];
      const z = this.pos[v * 3 + 2];
      const d2 = x * x + y * y + z * z;
      if (d2 > max) max = d2;
    }
    this.extent = Math.max(this.radius * 0.25, Math.sqrt(max));
    this._boundsDirty = true;
  }

  /** Keeps the bounding volumes just big enough for what's actually there. */
  _applyBounds() {
    const r = this.extent * 1.02;
    this.geometry.boundingSphere.radius = r;
    this.geometry.boundingBox.min.set(-r, -r, -r);
    this.geometry.boundingBox.max.set(r, r, r);
    this._boundsDirty = false;
  }

  get count() { return this.vLive; }
  get vertexCount() { return this.vLive; }
  get triangleCount() { return this.tLive; }
  get atCapacity() { return this.vTop >= MAX_VERTS - 64 || this.tTop >= MAX_TRIS - 128; }

  // ------------------------------------------------------------ construction

  _buildBase(radius, detail, shape) {
    const { positions, index } = createIcosphere(1, detail);
    applyShape(positions, shape);
    for (let i = 0; i < positions.length; i++) positions[i] *= radius;

    for (let i = 0; i < positions.length; i += 3) {
      this._addVertex(positions[i], positions[i + 1], positions[i + 2]);
    }
    for (let i = 0; i < index.length; i += 3) {
      this._addTriangle(index[i], index[i + 1], index[i + 2]);
    }
  }

  // ------------------------------------------------------------- slab access

  _addVertex(x, y, z) {
    let v;
    if (this.vFree.length) v = this.vFree.pop();
    else if (this.vTop < MAX_VERTS) v = this.vTop++;
    else return -1;

    this.vAlive[v] = 1;
    this.vTriCount[v] = 0;
    this.painted[v] = 0;
    this.pos[v * 3] = x; this.pos[v * 3 + 1] = y; this.pos[v * 3 + 2] = z;
    this.col[v * 3] = this.baseColor.r;
    this.col[v * 3 + 1] = this.baseColor.g;
    this.col[v * 3 + 2] = this.baseColor.b;
    this.vLive++;
    this.grid.insert(v, x, y, z);
    this._touchVertex(v);
    this._touchColor(v);
    return v;
  }

  _removeVertex(v) {
    this.vAlive[v] = 0;
    this.grid.remove(v);
    this.vFree.push(v);
    this.vLive--;
  }

  _addTriangle(a, b, c) {
    if (this.vTriCount[a] >= VALENCE || this.vTriCount[b] >= VALENCE
      || this.vTriCount[c] >= VALENCE) return -1;

    let t;
    if (this.tFree.length) t = this.tFree.pop();
    else if (this.tTop < MAX_TRIS) t = this.tTop++;
    else return -1;

    this.tri[t * 3] = a; this.tri[t * 3 + 1] = b; this.tri[t * 3 + 2] = c;
    this.tAlive[t] = 1;
    this.tLive++;
    this._faceNormal(t);
    this.vTri[a * VALENCE + this.vTriCount[a]++] = t;
    this.vTri[b * VALENCE + this.vTriCount[b]++] = t;
    this.vTri[c * VALENCE + this.vTriCount[c]++] = t;
    this._touchTriangle(t);
    return t;
  }

  _removeTriangle(t) {
    const a = this.tri[t * 3];
    const b = this.tri[t * 3 + 1];
    const c = this.tri[t * 3 + 2];
    this._unlink(a, t); this._unlink(b, t); this._unlink(c, t);
    // Dead slots render as a degenerate triangle until they're recycled.
    this.tri[t * 3] = 0; this.tri[t * 3 + 1] = 0; this.tri[t * 3 + 2] = 0;
    this.tAlive[t] = 0;
    this.tLive--;
    this.tFree.push(t);
    this._touchTriangle(t);
  }

  _unlink(v, t) {
    const base = v * VALENCE;
    const n = this.vTriCount[v];
    for (let i = 0; i < n; i++) {
      if (this.vTri[base + i] === t) {
        this.vTri[base + i] = this.vTri[base + n - 1];
        this.vTriCount[v] = n - 1;
        return;
      }
    }
  }

  /** Triangles containing both a and b. Returns how many were written to out. */
  _sharedTriangles(a, b, out) {
    const base = a * VALENCE;
    const n = this.vTriCount[a];
    let found = 0;
    for (let i = 0; i < n; i++) {
      const t = this.vTri[base + i];
      const x = this.tri[t * 3];
      const y = this.tri[t * 3 + 1];
      const z = this.tri[t * 3 + 2];
      if (x === b || y === b || z === b) {
        if (found < 2) out[found] = t;
        found++;
      }
    }
    return found;
  }

  /** Unique neighbours of v, written to out. Returns the count. */
  _neighbours(v, out) {
    const base = v * VALENCE;
    const n = this.vTriCount[v];
    let m = 0;
    for (let i = 0; i < n; i++) {
      const t = this.vTri[base + i] * 3;
      for (let k = 0; k < 3; k++) {
        const u = this.tri[t + k];
        if (u === v) continue;
        let seen = false;
        for (let j = 0; j < m; j++) if (out[j] === u) { seen = true; break; }
        if (!seen && m < out.length) out[m++] = u;
      }
    }
    return m;
  }

  // ------------------------------------------------------- dirty-range marks

  _touchVertex(v) {
    if (v < this._vMin) this._vMin = v;
    if (v > this._vMax) this._vMax = v;
  }

  _touchColor(v) {
    if (v < this._cMin) this._cMin = v;
    if (v > this._cMax) this._cMax = v;
  }

  _touchTriangle(t) {
    if (t < this._tMin) this._tMin = t;
    if (t > this._tMax) this._tMax = t;
  }

  _markAll() {
    this._vMin = 0; this._vMax = this.vTop - 1;
    this._cMin = 0; this._cMax = this.vTop - 1;
    this._tMin = 0; this._tMax = this.tTop - 1;
  }

  // ------------------------------------------------------------------ normals

  /** Recomputes and caches the (area-weighted) normal of one triangle. */
  _faceNormal(t) {
    const { pos, tri, fNrm } = this;
    const a = tri[t * 3] * 3, b = tri[t * 3 + 1] * 3, c = tri[t * 3 + 2] * 3;
    const abx = pos[b] - pos[a], aby = pos[b + 1] - pos[a + 1], abz = pos[b + 2] - pos[a + 2];
    const acx = pos[c] - pos[a], acy = pos[c + 1] - pos[a + 1], acz = pos[c + 2] - pos[a + 2];
    fNrm[t * 3] = aby * acz - abz * acy;
    fNrm[t * 3 + 1] = abz * acx - abx * acz;
    fNrm[t * 3 + 2] = abx * acy - aby * acx;
  }

  computeAllNormals() {
    const { nrm, tri, fNrm } = this;
    nrm.fill(0, 0, this.vTop * 3);
    for (let t = 0; t < this.tTop; t++) {
      if (!this.tAlive[t]) continue;
      this._faceNormal(t);
      const nx = fNrm[t * 3], ny = fNrm[t * 3 + 1], nz = fNrm[t * 3 + 2];
      const a = tri[t * 3] * 3, b = tri[t * 3 + 1] * 3, c = tri[t * 3 + 2] * 3;
      nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz;
      nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz;
      nrm[c] += nx; nrm[c + 1] += ny; nrm[c + 2] += nz;
    }
    for (let v = 0; v < this.vTop; v++) {
      const i = v * 3;
      const l = Math.sqrt(nrm[i] * nrm[i] + nrm[i + 1] * nrm[i + 1] + nrm[i + 2] * nrm[i + 2]) || 1;
      nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l;
    }
    this._markAll();
  }

  /** Queues a vertex for normal recomputation at the end of the step. */
  _dirty(v) {
    if (this._vStamp[v] === this._gen) return;
    this._vStamp[v] = this._gen;
    if (this._dirtyCount < MAX_VERTS) this._dirtyList[this._dirtyCount++] = v;
  }

  _flushNormals() {
    const { nrm, tri, fNrm } = this;
    const list = this._dirtyList;
    const n = this._dirtyCount;
    if (n === 0) return;

    // Pass 1: one walk over the moved vertices' triangle fans, doing two jobs —
    // refresh each face's cached normal, and collect the affected vertex set.
    // That set is the moved vertices plus their one ring, since a moved vertex
    // tilts its neighbours' normals too.
    const fgen = ++this._tGen;
    const vgen = this._gen;
    const stampV = this._vStamp;
    const stampT = this._tStamp;
    let m = n;
    for (let a = 0; a < n; a++) {
      const v = list[a];
      const base = v * VALENCE;
      for (let i = 0; i < this.vTriCount[v]; i++) {
        const t = this.vTri[base + i];
        if (stampT[t] === fgen) continue;
        stampT[t] = fgen;
        this._faceNormal(t);
        const f = t * 3;
        for (let k = 0; k < 3; k++) {
          const u = tri[f + k];
          if (stampV[u] !== vgen) {
            stampV[u] = vgen;
            if (m < MAX_VERTS) list[m++] = u;
          }
        }
      }
    }

    // Pass 2: sum cached face normals. Adds only, no cross products.
    for (let a = 0; a < m; a++) {
      const v = list[a];
      if (!this.vAlive[v]) continue;
      const base = v * VALENCE;
      let nx = 0, ny = 0, nz = 0;
      for (let i = 0; i < this.vTriCount[v]; i++) {
        const t = this.vTri[base + i] * 3;
        nx += fNrm[t]; ny += fNrm[t + 1]; nz += fNrm[t + 2];
      }
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nrm[v * 3] = nx / l; nrm[v * 3 + 1] = ny / l; nrm[v * 3 + 2] = nz / l;
      this._touchVertex(v);
    }
    this._dirtyCount = 0;
  }

  // ------------------------------------------------------------------- undo

  beginStroke() {
    const snap = {
      vTop: this.vTop,
      tTop: this.tTop,
      vLive: this.vLive,
      tLive: this.tLive,
      pos: this.pos.slice(0, this.vTop * 3),
      col: this.col.slice(0, this.vTop * 3),
      painted: this.painted.slice(0, this.vTop),
      vAlive: this.vAlive.slice(0, this.vTop),
      tAlive: this.tAlive.slice(0, this.tTop),
      tri: this.tri.slice(0, this.tTop * 3),
      vFree: this.vFree.slice(),
      tFree: this.tFree.slice(),
    };
    snap.bytes = snap.pos.byteLength * 2 + snap.tri.byteLength + snap.painted.byteLength * 3;
    this._undo.push(snap);
    this._undoBytes += snap.bytes;
    while (this._undo.length > 1 && this._undoBytes > UNDO_BUDGET) {
      this._undoBytes -= this._undo.shift().bytes;
    }
  }

  undo() {
    const snap = this._undo.pop();
    if (!snap) return false;
    this._undoBytes -= snap.bytes;

    this.vTop = snap.vTop;
    this.tTop = snap.tTop;
    this.vLive = snap.vLive;
    this.tLive = snap.tLive;
    this.pos.set(snap.pos);
    this.col.set(snap.col);
    this.painted.set(snap.painted);
    this.vAlive.set(snap.vAlive);
    this.tAlive.set(snap.tAlive);
    this.tri.set(snap.tri);
    // Anything above the restored high-water mark is gone for good.
    this.tri.fill(0, snap.tTop * 3);
    this.vAlive.fill(0, snap.vTop);
    this.tAlive.fill(0, snap.tTop);
    this.vFree = snap.vFree.slice();
    this.tFree = snap.tFree.slice();

    this._rebuildAdjacency();
    this._rebuildGrid();
    this.computeAllNormals();
    this._recomputeExtent();
    this.geometry.setDrawRange(0, this.tTop * 3);
    this._markAll();
    return true;
  }

  get undoDepth() { return this._undo.length; }

  _rebuildAdjacency() {
    this.vTriCount.fill(0, 0, this.vTop);
    for (let t = 0; t < this.tTop; t++) {
      if (!this.tAlive[t]) continue;
      for (let k = 0; k < 3; k++) {
        const v = this.tri[t * 3 + k];
        if (this.vTriCount[v] < VALENCE) this.vTri[v * VALENCE + this.vTriCount[v]++] = t;
      }
    }
  }

  _rebuildGrid() {
    this.grid.clear();
    for (let v = 0; v < this.vTop; v++) {
      if (this.vAlive[v]) this.grid.insert(v, this.pos[v * 3], this.pos[v * 3 + 1], this.pos[v * 3 + 2]);
    }
  }

  // ----------------------------------------------------------------- stroke

  /**
   * @param {object} o
   * @param {string} o.tool push|carve|inflate|smooth|flatten|pinch|grab|paint
   * @param {THREE.Vector3} o.center brush centre, in mesh-local space
   * @param {number} o.radius brush radius, in mesh-local units
   * @param {number} o.strength 0..1
   * @param {number} o.dt seconds since the last step
   * @param {THREE.Color} [o.color] for the paint tool
   * @param {THREE.Vector3} [o.delta] hand movement since the last step, for grab
   * @param {boolean} [o.symmetry] mirror the stroke across X
   * @param {number} [o.detailLength] target edge length; omit to disable dyntopo
   */
  stroke(o) {
    this._gen++;
    this.stats.splits = 0;
    this.stats.collapses = 0;
    let touched = this._strokeOne(o, false);
    if (o.symmetry) touched += this._strokeOne(o, true);
    this._flushNormals();
    return touched;
  }

  _strokeOne(o, mirror) {
    const sign = mirror ? -1 : 1;
    const cx = o.center.x * sign;
    const cy = o.center.y;
    const cz = o.center.z;
    const r = o.radius;

    const hits = this._hits;
    const n = this.grid.query(this.pos, cx, cy, cz, r, hits);
    if (n === 0) return 0;

    const weights = this._weights;
    const pos = this.pos;
    for (let a = 0; a < n; a++) {
      const v = hits[a];
      const dx = pos[v * 3] - cx;
      const dy = pos[v * 3 + 1] - cy;
      const dz = pos[v * 3 + 2] - cz;
      const t = 1 - Math.min(1, Math.sqrt(dx * dx + dy * dy + dz * dz) / r);
      weights[v] = t * t * (3 - 2 * t); // smoothstep falloff
    }

    if (o.tool === 'paint') {
      this._paint(hits, n, o);
      return n;
    }

    switch (o.tool) {
      case 'push': this._displace(hits, n, o, 1); break;
      case 'carve': this._displace(hits, n, o, -1); break;
      case 'inflate': this._inflate(hits, n, o); break;
      case 'smooth': this._smooth(hits, n, o); break;
      case 'flatten': this._flatten(hits, n, o); break;
      case 'pinch': this._pinch(hits, n, o, cx, cy, cz); break;
      case 'grab': this._grab(hits, n, o, sign); break;
      default: return 0;
    }

    this._settle(hits, n);
    if (o.detailLength > 0) this._refine(hits, n, cx, cy, cz, r, o.detailLength);
    return n;
  }

  _displace(hits, n, o, dir) {
    const { pos, nrm } = this;
    const w = this._weights;
    let nx = 0, ny = 0, nz = 0;
    for (let a = 0; a < n; a++) {
      const v = hits[a];
      nx += nrm[v * 3] * w[v];
      ny += nrm[v * 3 + 1] * w[v];
      nz += nrm[v * 3 + 2] * w[v];
    }
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;

    const amount = o.strength * o.radius * 2.5 * o.dt * dir;
    for (let a = 0; a < n; a++) {
      const v = hits[a];
      const k = amount * w[v];
      pos[v * 3] += nx * k;
      pos[v * 3 + 1] += ny * k;
      pos[v * 3 + 2] += nz * k;
    }
  }

  _inflate(hits, n, o) {
    const { pos, nrm } = this;
    const w = this._weights;
    const amount = o.strength * o.radius * 2.0 * o.dt;
    for (let a = 0; a < n; a++) {
      const v = hits[a];
      const k = amount * w[v];
      pos[v * 3] += nrm[v * 3] * k;
      pos[v * 3 + 1] += nrm[v * 3 + 1] * k;
      pos[v * 3 + 2] += nrm[v * 3 + 2] * k;
    }
  }

  _smooth(hits, n, o) {
    const { pos } = this;
    const w = this._weights;
    const nbrs = this._nbrs;
    const rate = o.strength * 10 * o.dt;
    for (let a = 0; a < n; a++) {
      const v = hits[a];
      const c = this._neighbours(v, nbrs);
      if (c === 0) continue;
      let sx = 0, sy = 0, sz = 0;
      for (let k = 0; k < c; k++) {
        const u = nbrs[k] * 3;
        sx += pos[u]; sy += pos[u + 1]; sz += pos[u + 2];
      }
      const t = Math.min(1, rate * w[v]);
      pos[v * 3] += (sx / c - pos[v * 3]) * t;
      pos[v * 3 + 1] += (sy / c - pos[v * 3 + 1]) * t;
      pos[v * 3 + 2] += (sz / c - pos[v * 3 + 2]) * t;
    }
  }

  _flatten(hits, n, o) {
    const { pos, nrm } = this;
    const w = this._weights;
    let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0, sum = 0;
    for (let a = 0; a < n; a++) {
      const v = hits[a];
      const k = w[v];
      px += pos[v * 3] * k; py += pos[v * 3 + 1] * k; pz += pos[v * 3 + 2] * k;
      nx += nrm[v * 3] * k; ny += nrm[v * 3 + 1] * k; nz += nrm[v * 3 + 2] * k;
      sum += k;
    }
    if (sum < 1e-9) return;
    px /= sum; py /= sum; pz /= sum;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;

    const rate = o.strength * 8 * o.dt;
    for (let a = 0; a < n; a++) {
      const v = hits[a];
      const d = (pos[v * 3] - px) * nx + (pos[v * 3 + 1] - py) * ny + (pos[v * 3 + 2] - pz) * nz;
      const k = Math.min(1, rate * w[v]) * d;
      pos[v * 3] -= nx * k;
      pos[v * 3 + 1] -= ny * k;
      pos[v * 3 + 2] -= nz * k;
    }
  }

  _pinch(hits, n, o, cx, cy, cz) {
    const { pos } = this;
    const w = this._weights;
    const rate = o.strength * 6 * o.dt;
    for (let a = 0; a < n; a++) {
      const v = hits[a];
      const t = Math.min(1, rate * w[v]);
      pos[v * 3] += (cx - pos[v * 3]) * t;
      pos[v * 3 + 1] += (cy - pos[v * 3 + 1]) * t;
      pos[v * 3 + 2] += (cz - pos[v * 3 + 2]) * t;
    }
  }

  _grab(hits, n, o, sign) {
    if (!o.delta) return;
    const { pos } = this;
    const w = this._weights;
    const dx = o.delta.x * sign;
    const dy = o.delta.y;
    const dz = o.delta.z;
    for (let a = 0; a < n; a++) {
      const v = hits[a];
      pos[v * 3] += dx * w[v];
      pos[v * 3 + 1] += dy * w[v];
      pos[v * 3 + 2] += dz * w[v];
    }
  }

  _paint(hits, n, o) {
    const { col, painted } = this;
    const w = this._weights;
    const c = o.color;
    const rate = o.strength * 12 * o.dt;
    for (let a = 0; a < n; a++) {
      const v = hits[a];
      const t = Math.min(1, rate * w[v]);
      col[v * 3] += (c.r - col[v * 3]) * t;
      col[v * 3 + 1] += (c.g - col[v * 3 + 1]) * t;
      col[v * 3 + 2] += (c.b - col[v * 3 + 2]) * t;
      painted[v] = 1;
      this._touchColor(v);
    }
  }

  /** Clamps runaway displacement, then refreshes the grid and dirty marks. */
  _settle(hits, n) {
    const { pos, grid, minRadius, maxRadius } = this;
    let reach = this.extent;
    for (let a = 0; a < n; a++) {
      const v = hits[a];
      let x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      let d = Math.sqrt(x * x + y * y + z * z);
      if (d < minRadius || d > maxRadius) {
        if (d > 1e-9) {
          const s = (d < minRadius ? minRadius : maxRadius) / d;
          x *= s; y *= s; z *= s;
        } else {
          y = minRadius;
        }
        pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
        d = d < minRadius ? minRadius : maxRadius;
      }
      if (d > reach) reach = d;
      grid.move(v, x, y, z);
      this._touchVertex(v);
      this._dirty(v);
    }
    // Grows with the sculpt. Shrinking waits for an exact pass, since a stroke
    // only sees the vertices it touched — an overestimate is harmless.
    if (reach > this.extent) {
      this.extent = reach;
      this._boundsDirty = true;
    }
  }

  // ------------------------------------------------------------ dyntopo pass

  /**
   * Splits edges longer than the target length and collapses those shorter than
   * 0.4x it. The gap matters: halving an edge at the split threshold yields
   * 0.5x, safely above the collapse threshold, so edges can't ping-pong between
   * being split and collapsed every frame.
   */
  _refine(hits, n, cx, cy, cz, r, detailLength) {
    const maxLen2 = detailLength * detailLength;
    const minLen2 = (detailLength * 0.4) ** 2;
    const r2 = r * r;

    // One sweep over the triangles under the brush, queueing both kinds of
    // edit. Refinement converges over a handful of frames while you hold the
    // brush there, which is imperceptible and keeps each frame cheap.
    const count = this._collectTriangles(hits, n);
    const splits = this._edges;
    const collapses = this._collapses;
    let ns = 0;
    let nc = 0;

    for (let i = 0; i < count; i++) {
      const t = this._cand[i];
      const x = this.tri[t * 3], y = this.tri[t * 3 + 1], z = this.tri[t * 3 + 2];
      const xy = this._edgeLen2(x, y);
      const yz = this._edgeLen2(y, z);
      const zx = this._edgeLen2(z, x);

      let la = x, lb = y, longest = xy;
      if (yz > longest) { la = y; lb = z; longest = yz; }
      if (zx > longest) { la = z; lb = x; longest = zx; }

      if (longest > maxLen2) {
        if (ns < SPLIT_BUDGET && this._insideBrush(la, lb, cx, cy, cz, r2)) {
          splits[ns * 2] = la; splits[ns * 2 + 1] = lb; ns++;
        }
        continue;              // a triangle that wants splitting can't also collapse
      }

      let sa = x, sb = y, shortest = xy;
      if (yz < shortest) { sa = y; sb = z; shortest = yz; }
      if (zx < shortest) { sa = z; sb = x; shortest = zx; }

      if (shortest < minLen2 && nc < SPLIT_BUDGET
        && this._insideBrush(sa, sb, cx, cy, cz, r2)) {
        collapses[nc * 2] = sa; collapses[nc * 2 + 1] = sb; nc++;
      }
    }

    // Both loops re-validate: earlier edits invalidate later queue entries.
    for (let i = 0; i < ns; i++) {
      const a = splits[i * 2];
      const b = splits[i * 2 + 1];
      if (!this.vAlive[a] || !this.vAlive[b]) continue;
      if (this._edgeLen2(a, b) <= maxLen2) continue;
      if (this._splitEdge(a, b)) this.stats.splits++;
      if (this.atCapacity) { this.stats.capped = true; break; }
    }
    for (let i = 0; i < nc; i++) {
      const a = collapses[i * 2];
      const b = collapses[i * 2 + 1];
      if (!this.vAlive[a] || !this.vAlive[b]) continue;
      if (this._edgeLen2(a, b) >= minLen2) continue;
      if (this._collapseEdge(a, b, maxLen2)) this.stats.collapses++;
    }
  }

  /**
   * Unique live triangles around the given vertices, written to `_cand`.
   * Reuses the stroke's own query results rather than hitting the grid again.
   */
  _collectTriangles(hits, n) {
    const list = this._cand;
    const gen = ++this._tGen;   // separate from the vertex stamp generation
    let count = 0;
    for (let a = 0; a < n; a++) {
      const v = hits[a];
      const base = v * VALENCE;
      for (let i = 0; i < this.vTriCount[v]; i++) {
        const t = this.vTri[base + i];
        if (this._tStamp[t] === gen) continue;
        this._tStamp[t] = gen;
        if (count < list.length) list[count++] = t;
      }
    }
    return count;
  }

  _insideBrush(a, b, cx, cy, cz, r2) {
    const mx = (this.pos[a * 3] + this.pos[b * 3]) * 0.5 - cx;
    const my = (this.pos[a * 3 + 1] + this.pos[b * 3 + 1]) * 0.5 - cy;
    const mz = (this.pos[a * 3 + 2] + this.pos[b * 3 + 2]) * 0.5 - cz;
    return mx * mx + my * my + mz * mz <= r2;
  }

  _edgeLen2(a, b) {
    const dx = this.pos[a * 3] - this.pos[b * 3];
    const dy = this.pos[a * 3 + 1] - this.pos[b * 3 + 1];
    const dz = this.pos[a * 3 + 2] - this.pos[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  }

  // Both return the same reused object — copy out before the next call.
  _longestEdge(t) {
    const x = this.tri[t * 3], y = this.tri[t * 3 + 1], z = this.tri[t * 3 + 2];
    const xy = this._edgeLen2(x, y);
    const yz = this._edgeLen2(y, z);
    const zx = this._edgeLen2(z, x);
    const e = this._edge;
    if (xy >= yz && xy >= zx) { e.a = x; e.b = y; e.len2 = xy; }
    else if (yz >= zx) { e.a = y; e.b = z; e.len2 = yz; }
    else { e.a = z; e.b = x; e.len2 = zx; }
    return e;
  }

  _shortestEdge(t) {
    const x = this.tri[t * 3], y = this.tri[t * 3 + 1], z = this.tri[t * 3 + 2];
    const xy = this._edgeLen2(x, y);
    const yz = this._edgeLen2(y, z);
    const zx = this._edgeLen2(z, x);
    const e = this._edge;
    if (xy <= yz && xy <= zx) { e.a = x; e.b = y; e.len2 = xy; }
    else if (yz <= zx) { e.a = y; e.b = z; e.len2 = yz; }
    else { e.a = z; e.b = x; e.len2 = zx; }
    return e;
  }

  /**
   * Inserts a vertex at the midpoint of edge (a,b) and re-fans both adjacent
   * triangles onto it. Winding is preserved by rotating each triangle to start
   * at its opposite corner.
   */
  _splitEdge(a, b) {
    // Needs 1 vertex and a net 2 triangles; bail before mutating anything,
    // since a half-finished split would leave a hole.
    if (this.vFree.length === 0 && this.vTop >= MAX_VERTS) return false;
    if (this.tFree.length + (MAX_TRIS - this.tTop) < 2) return false;

    const shared = this._shared2;
    const found = this._sharedTriangles(a, b, shared);
    if (found !== 2) return false;                 // non-manifold or boundary

    // Both opposite corners gain a neighbour, so they need valence headroom.
    for (let i = 0; i < 2; i++) {
      const c = this._opposite(shared[i], a, b);
      if (c < 0 || this.vTriCount[c] >= VALENCE - 1) return false;
    }
    if (this.vTriCount[a] >= VALENCE || this.vTriCount[b] >= VALENCE) return false;

    const mx = (this.pos[a * 3] + this.pos[b * 3]) * 0.5;
    const my = (this.pos[a * 3 + 1] + this.pos[b * 3 + 1]) * 0.5;
    const mz = (this.pos[a * 3 + 2] + this.pos[b * 3 + 2]) * 0.5;
    const m = this._addVertex(mx, my, mz);
    if (m < 0) return false;

    // interpolate appearance from the two endpoints
    for (let k = 0; k < 3; k++) {
      this.col[m * 3 + k] = (this.col[a * 3 + k] + this.col[b * 3 + k]) * 0.5;
      this.nrm[m * 3 + k] = (this.nrm[a * 3 + k] + this.nrm[b * 3 + k]) * 0.5;
    }
    this.painted[m] = this.painted[a] & this.painted[b];

    const t0 = shared[0];
    const t1 = shared[1];
    const c0 = this._orient(t0, a, b);
    const c1 = this._orient(t1, a, b);
    this._removeTriangle(t0);
    this._removeTriangle(t1);
    // (c, u, v) with the edge running u -> v; split into (c,u,m) and (c,m,v)
    this._addTriangle(c0.c, c0.u, m);
    this._addTriangle(c0.c, m, c0.v);
    this._addTriangle(c1.c, c1.u, m);
    this._addTriangle(c1.c, m, c1.v);

    this._dirty(a); this._dirty(b); this._dirty(m);
    this._dirty(c0.c); this._dirty(c1.c);
    return true;
  }

  /** The corner of t that is neither a nor b. */
  _opposite(t, a, b) {
    const x = this.tri[t * 3], y = this.tri[t * 3 + 1], z = this.tri[t * 3 + 2];
    if (x !== a && x !== b) return x;
    if (y !== a && y !== b) return y;
    if (z !== a && z !== b) return z;
    return -1;
  }

  /** Rotates t to (c, u, v) where c is the opposite corner — keeps winding. */
  _orient(t, a, b) {
    const x = this.tri[t * 3], y = this.tri[t * 3 + 1], z = this.tri[t * 3 + 2];
    if (x !== a && x !== b) return { c: x, u: y, v: z };
    if (y !== a && y !== b) return { c: y, u: z, v: x };
    return { c: z, u: x, v: y };
  }

  /**
   * Merges b into a at the midpoint. Rejected unless the result stays a valid
   * closed manifold with no flipped triangles.
   */
  _collapseEdge(a, b, maxLen2) {
    if (this.vLive <= 64 || this.tLive <= 32) return false;

    const shared = this._shared2;
    if (this._sharedTriangles(a, b, shared) !== 2) return false;

    const o0 = this._opposite(shared[0], a, b);
    const o1 = this._opposite(shared[1], a, b);
    if (o0 < 0 || o1 < 0 || o0 === o1) return false;

    // Link condition: a and b may share exactly the two opposite corners.
    // Anything else pinches the surface into a non-manifold.
    const nbrsA = this._nbrsA;
    const na = this._neighbours(a, nbrsA);
    const nbrsB = this._nbrsB;
    const nb = this._neighbours(b, nbrsB);
    let common = 0;
    for (let i = 0; i < na; i++) {
      for (let j = 0; j < nb; j++) {
        if (nbrsA[i] === nbrsB[j]) { common++; break; }
      }
    }
    if (common !== 2) return false;

    // The merged vertex inherits both fans, minus the two shared triangles.
    if (this.vTriCount[a] + this.vTriCount[b] - 4 > VALENCE) return false;
    // Valence 3 corners collapse into slivers; leave them alone.
    if (this.vTriCount[o0] <= 3 || this.vTriCount[o1] <= 3) return false;

    const mx = (this.pos[a * 3] + this.pos[b * 3]) * 0.5;
    const my = (this.pos[a * 3 + 1] + this.pos[b * 3 + 1]) * 0.5;
    const mz = (this.pos[a * 3 + 2] + this.pos[b * 3 + 2]) * 0.5;

    // Refuse if the merged vertex would sprout an edge long enough to be split
    // straight back apart — otherwise the two passes fight forever.
    if (maxLen2 > 0) {
      for (let side = 0; side < 2; side++) {
        const nbrs = side === 0 ? nbrsA : nbrsB;
        const cnt = side === 0 ? na : nb;
        const skip = side === 0 ? b : a;
        for (let i = 0; i < cnt; i++) {
          const u = nbrs[i];
          if (u === skip) continue;
          const dx = this.pos[u * 3] - mx;
          const dy = this.pos[u * 3 + 1] - my;
          const dz = this.pos[u * 3 + 2] - mz;
          if (dx * dx + dy * dy + dz * dz > maxLen2) return false;
        }
      }
    }

    if (!this._collapseKeepsOrientation(a, b, shared, mx, my, mz)) return false;

    // Re-point b's triangles at a, then drop the two that spanned the edge.
    this._removeTriangle(shared[0]);
    this._removeTriangle(shared[1]);

    const base = b * VALENCE;
    while (this.vTriCount[b] > 0) {
      const t = this.vTri[base];
      for (let k = 0; k < 3; k++) if (this.tri[t * 3 + k] === b) this.tri[t * 3 + k] = a;
      this._unlink(b, t);
      if (this.vTriCount[a] < VALENCE) this.vTri[a * VALENCE + this.vTriCount[a]++] = t;
      this._touchTriangle(t);
    }

    this.pos[a * 3] = mx; this.pos[a * 3 + 1] = my; this.pos[a * 3 + 2] = mz;
    for (let k = 0; k < 3; k++) {
      this.col[a * 3 + k] = (this.col[a * 3 + k] + this.col[b * 3 + k]) * 0.5;
    }
    this.painted[a] |= this.painted[b];
    this.grid.move(a, mx, my, mz);
    this._touchVertex(a);
    this._touchColor(a);
    this._removeVertex(b);

    this._dirty(a); this._dirty(o0); this._dirty(o1);
    return true;
  }

  /** True if no triangle flips its facing when a and b merge at (mx,my,mz). */
  _collapseKeepsOrientation(a, b, shared, mx, my, mz) {
    for (let side = 0; side < 2; side++) {
      const v = side === 0 ? a : b;
      const base = v * VALENCE;
      for (let i = 0; i < this.vTriCount[v]; i++) {
        const t = this.vTri[base + i];
        if (t === shared[0] || t === shared[1]) continue;
        if (!this._triFacingPreserved(t, a, b, mx, my, mz)) return false;
      }
    }
    return true;
  }

  _triFacingPreserved(t, a, b, mx, my, mz) {
    const { pos, tri } = this;
    const p = tri[t * 3], q = tri[t * 3 + 1], r = tri[t * 3 + 2];
    const before = triNormal(pos, p, q, r, _n0);
    const ax = p === a || p === b ? mx : pos[p * 3];
    const ay = p === a || p === b ? my : pos[p * 3 + 1];
    const az = p === a || p === b ? mz : pos[p * 3 + 2];
    const bx = q === a || q === b ? mx : pos[q * 3];
    const by = q === a || q === b ? my : pos[q * 3 + 1];
    const bz = q === a || q === b ? mz : pos[q * 3 + 2];
    const cx = r === a || r === b ? mx : pos[r * 3];
    const cy = r === a || r === b ? my : pos[r * 3 + 1];
    const cz = r === a || r === b ? mz : pos[r * 3 + 2];
    const after = rawNormal(ax, ay, az, bx, by, bz, cx, cy, cz, _n1);
    if (after.len < 1e-16) return false;          // would become degenerate
    if (before.len < 1e-16) return true;
    const dot = (before.x * after.x + before.y * after.y + before.z * after.z)
      / (before.len * after.len);
    return dot > 0.1;
  }

  // ------------------------------------------------------------------ colour

  /** Recolours bare clay, leaving brushed-on paint alone. */
  setBaseColor(color) {
    this.baseColor.copy(color);
    const { col, painted } = this;
    for (let v = 0; v < this.vTop; v++) {
      if (!this.vAlive[v] || painted[v]) continue;
      col[v * 3] = color.r; col[v * 3 + 1] = color.g; col[v * 3 + 2] = color.b;
    }
    this._cMin = 0; this._cMax = this.vTop - 1;
  }

  /** Wipes all paint and makes `color` the new bare-clay colour. */
  fillColor(color) {
    this.painted.fill(0);
    this.setBaseColor(color);
  }

  // ------------------------------------------------------------------ upload

  flush() {
    if (this._boundsDirty) this._applyBounds();
    const posAttr = this.geometry.attributes.position;
    const nrmAttr = this.geometry.attributes.normal;
    const colAttr = this.geometry.attributes.color;
    const idxAttr = this.geometry.index;

    if (this._vMax >= this._vMin) {
      const start = this._vMin * 3;
      const count = (this._vMax - this._vMin + 1) * 3;
      setRange(posAttr, start, count);
      setRange(nrmAttr, start, count);
      this._vMin = MAX_VERTS; this._vMax = -1;
    }
    if (this._cMax >= this._cMin) {
      setRange(colAttr, this._cMin * 3, (this._cMax - this._cMin + 1) * 3);
      this._cMin = MAX_VERTS; this._cMax = -1;
    }
    if (this._tMax >= this._tMin) {
      setRange(idxAttr, this._tMin * 3, (this._tMax - this._tMin + 1) * 3);
      this._tMin = MAX_TRIS; this._tMax = -1;
      this.geometry.setDrawRange(0, this.tTop * 3);
    }
  }

  // ------------------------------------------------------------- save / load

  /** Live-only copy with vertices renumbered, for export and saving. */
  compact() {
    const remap = new Int32Array(this.vTop).fill(-1);
    const positions = new Float32Array(this.vLive * 3);
    const normals = new Float32Array(this.vLive * 3);
    const colors = new Float32Array(this.vLive * 3);
    let n = 0;
    for (let v = 0; v < this.vTop; v++) {
      if (!this.vAlive[v]) continue;
      remap[v] = n;
      for (let k = 0; k < 3; k++) {
        positions[n * 3 + k] = this.pos[v * 3 + k];
        normals[n * 3 + k] = this.nrm[v * 3 + k];
        colors[n * 3 + k] = this.col[v * 3 + k];
      }
      n++;
    }
    const index = new Uint32Array(this.tLive * 3);
    let f = 0;
    for (let t = 0; t < this.tTop; t++) {
      if (!this.tAlive[t]) continue;
      index[f * 3] = remap[this.tri[t * 3]];
      index[f * 3 + 1] = remap[this.tri[t * 3 + 1]];
      index[f * 3 + 2] = remap[this.tri[t * 3 + 2]];
      f++;
    }
    return { positions, normals, colors, index, vertexCount: n, triangleCount: f };
  }

  serialize() {
    const data = this.compact();
    const painted = [];
    for (let v = 0; v < this.vTop; v++) if (this.vAlive[v]) painted.push(this.painted[v]);
    return {
      version: 2,
      radius: this.radius,
      shape: this.shape,
      detail: this.detail,
      positions: Array.from(data.positions),
      colors: Array.from(data.colors),
      index: Array.from(data.index),
      painted,
    };
  }

  load(data) {
    if (!data) return false;
    if (data.version !== 2 || !data.index) return false;

    this.vTop = 0; this.vLive = 0; this.vFree.length = 0;
    this.tTop = 0; this.tLive = 0; this.tFree.length = 0;
    this.vAlive.fill(0);
    this.tAlive.fill(0);
    this.tri.fill(0);
    this.grid.clear();

    const n = data.positions.length / 3;
    if (n > MAX_VERTS || data.index.length / 3 > MAX_TRIS) return false;
    for (let v = 0; v < n; v++) {
      const id = this._addVertex(data.positions[v * 3], data.positions[v * 3 + 1], data.positions[v * 3 + 2]);
      if (id < 0) return false;
      for (let k = 0; k < 3; k++) this.col[id * 3 + k] = data.colors[v * 3 + k];
      this.painted[id] = data.painted ? data.painted[v] : 0;
    }
    for (let t = 0; t < data.index.length; t += 3) {
      this._addTriangle(data.index[t], data.index[t + 1], data.index[t + 2]);
    }
    this.computeAllNormals();
    this._recomputeExtent();
    this.geometry.setDrawRange(0, this.tTop * 3);
    this._markAll();
    return true;
  }

  // -------------------------------------------------------------- invariants

  /** Debug: verifies the mesh is still a valid closed manifold. */
  validate() {
    const problems = [];
    const edges = new Map();
    let liveTris = 0;

    for (let t = 0; t < this.tTop; t++) {
      if (!this.tAlive[t]) continue;
      liveTris++;
      const a = this.tri[t * 3], b = this.tri[t * 3 + 1], c = this.tri[t * 3 + 2];
      if (a === b || b === c || a === c) problems.push(`degenerate triangle ${t}`);
      for (const v of [a, b, c]) {
        if (!this.vAlive[v]) problems.push(`triangle ${t} uses dead vertex ${v}`);
        let linked = false;
        for (let i = 0; i < this.vTriCount[v]; i++) {
          if (this.vTri[v * VALENCE + i] === t) { linked = true; break; }
        }
        if (!linked) problems.push(`vertex ${v} missing link to triangle ${t}`);
      }
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const key = u < v ? u * MAX_VERTS + v : v * MAX_VERTS + u;
        edges.set(key, (edges.get(key) || 0) + 1);
      }
    }

    let nonManifold = 0;
    for (const shareCount of edges.values()) if (shareCount !== 2) nonManifold++;
    if (nonManifold) problems.push(`${nonManifold} edges not shared by exactly 2 triangles`);

    let liveVerts = 0;
    let nan = 0;
    let orphans = 0;
    for (let v = 0; v < this.vTop; v++) {
      if (!this.vAlive[v]) continue;
      liveVerts++;
      if (this.vTriCount[v] === 0) orphans++;
      for (let k = 0; k < 3; k++) {
        if (!Number.isFinite(this.pos[v * 3 + k]) || !Number.isFinite(this.nrm[v * 3 + k])) nan++;
      }
    }
    if (nan) problems.push(`${nan} non-finite components`);
    if (orphans) problems.push(`${orphans} vertices with no triangles`);
    if (liveVerts !== this.vLive) problems.push(`vLive ${this.vLive} != counted ${liveVerts}`);
    if (liveTris !== this.tLive) problems.push(`tLive ${this.tLive} != counted ${liveTris}`);

    const euler = liveVerts - edges.size + liveTris;
    if (euler !== 2) problems.push(`Euler characteristic ${euler}, expected 2 (sphere)`);

    return { ok: problems.length === 0, problems, verts: liveVerts, tris: liveTris, edges: edges.size, euler };
  }
}

const _n0 = { x: 0, y: 0, z: 0, len: 0 };
const _n1 = { x: 0, y: 0, z: 0, len: 0 };

function triNormal(pos, p, q, r, out) {
  return rawNormal(
    pos[p * 3], pos[p * 3 + 1], pos[p * 3 + 2],
    pos[q * 3], pos[q * 3 + 1], pos[q * 3 + 2],
    pos[r * 3], pos[r * 3 + 1], pos[r * 3 + 2],
    out,
  );
}

function rawNormal(ax, ay, az, bx, by, bz, cx, cy, cz, out) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  out.x = aby * acz - abz * acy;
  out.y = abz * acx - abx * acz;
  out.z = abx * acy - aby * acx;
  out.len = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
  return out;
}

function setRange(attribute, start, count) {
  if (attribute.clearUpdateRanges) {
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(start, count);
  }
  attribute.needsUpdate = true;
}

/** Starting silhouettes, applied to the unit sphere before scaling. */
export function applyShape(p, shape) {
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    switch (shape) {
      case 'egg': {
        const taper = 1 - 0.22 * y;
        p[i] = x * taper; p[i + 1] = y * 1.2; p[i + 2] = z * taper;
        break;
      }
      case 'pebble': {
        const k = 1 + 0.18 * lumps(x * 2.4, y * 2.4, z * 2.4);
        p[i] = x * k * 1.1; p[i + 1] = y * k * 0.78; p[i + 2] = z * k;
        break;
      }
      case 'pillar':
        p[i] = x * 0.72; p[i + 1] = y * 1.7; p[i + 2] = z * 0.72;
        break;
      case 'disc':
        p[i] = x * 1.25; p[i + 1] = y * 0.45; p[i + 2] = z * 1.25;
        break;
      default:
        break;
    }
  }
}

// Cheap deterministic bumpiness. Not real noise, but it reads as organic.
function lumps(x, y, z) {
  return Math.sin(x * 1.3 + Math.cos(y * 1.1)) * 0.5
    + Math.sin(y * 1.7 + Math.cos(z * 0.9)) * 0.3
    + Math.sin(z * 1.5 + Math.cos(x * 1.2)) * 0.2;
}
