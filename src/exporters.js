// Getting sculpts back out: mesh files in several formats, plus a
// browser-local save slot.
//
// Every exporter runs on clay.compact(), which drops recycled slots and
// renumbers, so dyntopo's dead vertices and degenerate triangles never reach a
// file. Vertex colours are stored linear; the formats that expect 8-bit sRGB
// get converted on the way out.

const SAVE_KEY = 'vrclay.sculpt';

export const EXPORT_FORMATS = [
  {
    id: 'glb',
    label: 'glTF (.glb)',
    ext: 'glb',
    hint: 'Keeps colour and material. Best for Blender, viewers and the web.',
  },
  {
    id: 'ply',
    label: 'PLY (.ply)',
    ext: 'ply',
    hint: 'Keeps colour. Reads cleanly in MeshLab and Blender.',
  },
  {
    id: 'obj',
    label: 'OBJ (.obj)',
    ext: 'obj',
    hint: 'Widest support. Colour travels as a non-standard extension.',
  },
  {
    id: 'stl',
    label: 'STL (.stl)',
    ext: 'stl',
    hint: 'For 3D printing. Geometry only, exported in millimetres.',
  },
];

export function exportMesh(clay, format, options = {}) {
  switch (format) {
    case 'ply': return toPLY(clay);
    case 'obj': return toOBJ(clay);
    case 'stl': return toSTL(clay);
    case 'glb':
    default: return toGLB(clay, options);
  }
}

// ------------------------------------------------------------------- glTF

/**
 * glTF 2.0 binary. COLOR_0 is linear float per the spec, which is exactly how
 * the colours are already stored, so painting survives the round trip.
 */
export function toGLB(clay, { metalness = 0, roughness = 0.9, name = 'Clay' } = {}) {
  const { positions, normals, colors, index, vertexCount } = clay.compact();

  const indexBytes = index.byteLength;
  const posBytes = positions.byteLength;
  const nrmBytes = normals.byteLength;
  const colBytes = colors.byteLength;
  const binLength = indexBytes + posBytes + nrmBytes + colBytes;

  const bin = new ArrayBuffer(binLength);
  new Uint32Array(bin, 0, index.length).set(index);
  new Float32Array(bin, indexBytes, positions.length).set(positions);
  new Float32Array(bin, indexBytes + posBytes, normals.length).set(normals);
  new Float32Array(bin, indexBytes + posBytes + nrmBytes, colors.length).set(colors);

  // POSITION accessors must carry min/max
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const value = positions[i + k];
      if (value < min[k]) min[k] = value;
      if (value > max[k]) max[k] = value;
    }
  }

  const json = {
    asset: { version: '2.0', generator: 'VR Clay' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{
      name,
      primitives: [{
        attributes: { POSITION: 1, NORMAL: 2, COLOR_0: 3 },
        indices: 0,
        material: 0,
        mode: 4,
      }],
    }],
    materials: [{
      name,
      pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: metalness,
        roughnessFactor: roughness,
      },
    }],
    buffers: [{ byteLength: binLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: indexBytes, target: 34963 },
      { buffer: 0, byteOffset: indexBytes, byteLength: posBytes, target: 34962 },
      { buffer: 0, byteOffset: indexBytes + posBytes, byteLength: nrmBytes, target: 34962 },
      { buffer: 0, byteOffset: indexBytes + posBytes + nrmBytes, byteLength: colBytes, target: 34962 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5125, count: index.length, type: 'SCALAR' },
      { bufferView: 1, componentType: 5126, count: vertexCount, type: 'VEC3', min, max },
      { bufferView: 2, componentType: 5126, count: vertexCount, type: 'VEC3' },
      { bufferView: 3, componentType: 5126, count: vertexCount, type: 'VEC3' },
    ],
  };

  // Both chunks are padded to 4 bytes — JSON with spaces, BIN with zeroes.
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = pad4(jsonBytes, 0x20);
  const binPadded = pad4(new Uint8Array(bin), 0);

  const total = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);

  view.setUint32(0, 0x46546c67, true);   // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded.length, true);
  view.setUint32(16, 0x4e4f534a, true);  // 'JSON'
  bytes.set(jsonPadded, 20);
  const binHeader = 20 + jsonPadded.length;
  view.setUint32(binHeader, binPadded.length, true);
  view.setUint32(binHeader + 4, 0x004e4942, true); // 'BIN\0'
  bytes.set(binPadded, binHeader + 8);

  return new Blob([out], { type: 'model/gltf-binary' });
}

// -------------------------------------------------------------------- PLY

/** Binary little-endian PLY with normals and 8-bit sRGB vertex colours. */
export function toPLY(clay) {
  const { positions, normals, colors, index, vertexCount, triangleCount } = clay.compact();

  const header = [
    'ply',
    'format binary_little_endian 1.0',
    'comment Created by VR Clay',
    `element vertex ${vertexCount}`,
    'property float x', 'property float y', 'property float z',
    'property float nx', 'property float ny', 'property float nz',
    'property uchar red', 'property uchar green', 'property uchar blue',
    `element face ${triangleCount}`,
    'property list uchar uint vertex_indices',
    'end_header',
    '',
  ].join('\n');

  const headerBytes = new TextEncoder().encode(header);
  const vertexStride = 6 * 4 + 3;      // 6 floats + 3 bytes
  const faceStride = 1 + 3 * 4;        // count byte + 3 uint32
  const body = new ArrayBuffer(vertexCount * vertexStride + triangleCount * faceStride);
  const view = new DataView(body);

  let offset = 0;
  for (let v = 0; v < vertexCount; v++) {
    for (let k = 0; k < 3; k++) view.setFloat32(offset + k * 4, positions[v * 3 + k], true);
    for (let k = 0; k < 3; k++) view.setFloat32(offset + 12 + k * 4, normals[v * 3 + k], true);
    for (let k = 0; k < 3; k++) view.setUint8(offset + 24 + k, toByteSRGB(colors[v * 3 + k]));
    offset += vertexStride;
  }
  for (let f = 0; f < triangleCount; f++) {
    view.setUint8(offset, 3);
    for (let k = 0; k < 3; k++) view.setUint32(offset + 1 + k * 4, index[f * 3 + k], true);
    offset += faceStride;
  }

  return new Blob([headerBytes, body], { type: 'application/octet-stream' });
}

// -------------------------------------------------------------------- OBJ

/**
 * OBJ has no official vertex colours, but Blender and MeshLab both read the
 * `v x y z r g b` extension, and anything that doesn't just ignores the extra
 * three numbers.
 */
export function toOBJ(clay) {
  const { positions, normals, colors, index, vertexCount } = clay.compact();
  const lines = [
    '# Created by VR Clay',
    `# ${vertexCount} vertices, colours as the v x y z r g b extension`,
    'o Clay',
  ];
  for (let i = 0; i < positions.length; i += 3) {
    lines.push(`v ${f(positions[i])} ${f(positions[i + 1])} ${f(positions[i + 2])}`
      + ` ${f(srgb(colors[i]))} ${f(srgb(colors[i + 1]))} ${f(srgb(colors[i + 2]))}`);
  }
  for (let i = 0; i < normals.length; i += 3) {
    lines.push(`vn ${f(normals[i])} ${f(normals[i + 1])} ${f(normals[i + 2])}`);
  }
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] + 1;
    const b = index[i + 1] + 1;
    const c = index[i + 2] + 1;
    lines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
  }
  return new Blob([lines.join('\n')], { type: 'text/plain' });
}

// -------------------------------------------------------------------- STL

/**
 * Binary STL, Z-up and in millimetres. The scene works in metres, but slicers
 * read STL as millimetres — exporting raw metres would give you a 0.3 mm speck.
 */
export function toSTL(clay, { scale = 1000 } = {}) {
  const { positions, index } = clay.compact();
  const triangles = index.length / 3;
  const buffer = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(buffer);
  new TextEncoder().encodeInto('Created by VR Clay', new Uint8Array(buffer, 0, 80));
  view.setUint32(80, triangles, true);

  let offset = 84;
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] * 3;
    const b = index[i + 1] * 3;
    const c = index[i + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;

    // Y-up scene -> Z-up file
    view.setFloat32(offset, nx, true);
    view.setFloat32(offset + 4, -nz, true);
    view.setFloat32(offset + 8, ny, true);
    offset += 12;
    for (const v of [a, b, c]) {
      view.setFloat32(offset, positions[v] * scale, true);
      view.setFloat32(offset + 4, -positions[v + 2] * scale, true);
      view.setFloat32(offset + 8, positions[v + 1] * scale, true);
      offset += 12;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'model/stl' });
}

// ------------------------------------------------------------------ helpers

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Posts a finished export to the machine running serve.py, which writes it to
 * ./exports. This is the way out of a headset — a browser download there lands
 * in the headset's own storage, not on your computer.
 */
export async function sendToHost(blob, filename) {
  const response = await fetch(`./export/${encodeURIComponent(filename)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: blob,
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText || 'upload refused'}`);
  }
  return response.json();
}

export function saveLocal(clay) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(clay.serialize()));
    return true;
  } catch {
    return false;
  }
}

export function readLocal() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function f(n) {
  return n.toFixed(5);
}

/** Working colours are linear; 8-bit and text formats expect sRGB. */
function srgb(c) {
  const v = Math.max(0, Math.min(1, c));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

function toByteSRGB(c) {
  return Math.round(srgb(c) * 255);
}

function pad4(bytes, fill) {
  const remainder = bytes.length % 4;
  if (remainder === 0) return bytes;
  const out = new Uint8Array(bytes.length + (4 - remainder));
  out.set(bytes);
  out.fill(fill, bytes.length);
  return out;
}
