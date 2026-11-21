// Subdivided icosahedron with welded (shared) vertices, plus the adjacency
// tables the sculpting engine needs: vertex -> neighbour vertices and
// vertex -> incident faces, both stored as flat CSR arrays.

const BASE_FACES = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

/**
 * @param {number} radius
 * @param {number} detail number of subdivisions (0-6). Vertex count is
 *   10 * 4^detail + 2, so detail 5 -> 10242 verts, detail 6 -> 40962.
 */
export function createIcosphere(radius = 1, detail = 4) {
  detail = Math.max(0, Math.min(6, detail | 0));

  const t = (1 + Math.sqrt(5)) / 2;
  const verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(normalized);

  let faces = BASE_FACES;

  for (let step = 0; step < detail; step++) {
    const cache = new Map();
    const next = new Array(faces.length * 4);
    let f = 0;

    const midpoint = (a, b) => {
      const key = a < b ? a * 1e6 + b : b * 1e6 + a;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const va = verts[a];
      const vb = verts[b];
      const id = verts.length;
      verts.push(normalized([va[0] + vb[0], va[1] + vb[1], va[2] + vb[2]]));
      cache.set(key, id);
      return id;
    };

    for (let i = 0; i < faces.length; i++) {
      const [a, b, c] = faces[i];
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next[f++] = [a, ab, ca];
      next[f++] = [b, bc, ab];
      next[f++] = [c, ca, bc];
      next[f++] = [ab, bc, ca];
    }
    faces = next;
  }

  const positions = new Float32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    positions[i * 3] = verts[i][0] * radius;
    positions[i * 3 + 1] = verts[i][1] * radius;
    positions[i * 3 + 2] = verts[i][2] * radius;
  }

  const index = new Uint32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    index[i * 3] = faces[i][0];
    index[i * 3 + 1] = faces[i][1];
    index[i * 3 + 2] = faces[i][2];
  }

  return { positions, index };
}

/** CSR neighbour + incident-face tables. Built once per geometry. */
export function buildAdjacency(index, vertexCount) {
  const faceCount = index.length / 3;

  // vertex -> faces
  const faceDegree = new Uint32Array(vertexCount);
  for (let i = 0; i < index.length; i++) faceDegree[index[i]]++;

  const faceStart = new Uint32Array(vertexCount + 1);
  for (let v = 0; v < vertexCount; v++) faceStart[v + 1] = faceStart[v] + faceDegree[v];

  const faceList = new Uint32Array(index.length);
  const faceCursor = faceStart.slice(0, vertexCount);
  for (let f = 0; f < faceCount; f++) {
    for (let k = 0; k < 3; k++) faceList[faceCursor[index[f * 3 + k]]++] = f;
  }

  // vertex -> unique neighbour vertices (walk the incident faces, dedupe)
  const nbrStart = new Uint32Array(vertexCount + 1);
  const scratch = new Int32Array(vertexCount).fill(-1);
  let total = 0;
  for (let v = 0; v < vertexCount; v++) {
    let degree = 0;
    for (let i = faceStart[v]; i < faceStart[v + 1]; i++) {
      const f = faceList[i] * 3;
      for (let k = 0; k < 3; k++) {
        const u = index[f + k];
        if (u !== v && scratch[u] !== v) {
          scratch[u] = v;
          degree++;
        }
      }
    }
    total += degree;
    nbrStart[v + 1] = total;
  }

  const nbrList = new Uint32Array(total);
  scratch.fill(-1);
  for (let v = 0; v < vertexCount; v++) {
    let cursor = nbrStart[v];
    for (let i = faceStart[v]; i < faceStart[v + 1]; i++) {
      const f = faceList[i] * 3;
      for (let k = 0; k < 3; k++) {
        const u = index[f + k];
        if (u !== v && scratch[u] !== v) {
          scratch[u] = v;
          nbrList[cursor++] = u;
        }
      }
    }
  }

  return { nbrStart, nbrList, faceStart, faceList };
}

function normalized(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
