// The sculpt library: save your work to the machine running serve.py and pick
// it back up later, from the headset or the desktop.
//
// Sculpts travel as a compact binary blob rather than JSON — the same 100k
// triangle mesh is ~2.5 MB packed and well over 10 MB as JSON numbers, which
// matters when the headset is posting it over Wi-Fi.

const MAGIC = 'VRCLAY01';
const API = './api/sculpts';

/** @returns {Blob} */
export function encodeSculpt(clay, meta = {}) {
  const { positions, colors, index, vertexCount, triangleCount } = clay.compact();

  // painted flags, compacted in the same vertex order
  const painted = new Uint8Array(vertexCount);
  let p = 0;
  for (let v = 0; v < clay.vTop; v++) {
    if (clay.vAlive[v]) painted[p++] = clay.painted[v];
  }

  const header = {
    ...meta,
    version: 2,
    radius: clay.radius,
    detail: clay.detail,
    shape: clay.shape,
    vertexCount,
    triangleCount,
  };
  // Pad the header with spaces, not zeroes: the padding is inside the declared
  // length, and both JSON.parse and json.loads accept trailing whitespace but
  // choke on trailing NULs.
  const metaBytes = pad4(new TextEncoder().encode(JSON.stringify(header)), 0x20);
  const paintedPadded = pad4(painted);

  const size = 8 + 4 + metaBytes.length + 8
    + positions.byteLength + colors.byteLength + paintedPadded.length + index.byteLength;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  bytes.set(new TextEncoder().encode(MAGIC), 0);
  view.setUint32(8, metaBytes.length, true);
  bytes.set(metaBytes, 12);

  let offset = 12 + metaBytes.length;
  view.setUint32(offset, vertexCount, true);
  view.setUint32(offset + 4, triangleCount, true);
  offset += 8;

  new Float32Array(buffer, offset, positions.length).set(positions);
  offset += positions.byteLength;
  new Float32Array(buffer, offset, colors.length).set(colors);
  offset += colors.byteLength;
  bytes.set(paintedPadded, offset);
  offset += paintedPadded.length;
  new Uint32Array(buffer, offset, index.length).set(index);

  return new Blob([buffer], { type: 'application/octet-stream' });
}

/** Shaped like ClayMesh.serialize() output, but backed by typed arrays. */
export function decodeSculpt(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC) {
    throw new Error('Not a VR Clay sculpt');
  }
  const metaLength = view.getUint32(8, true);
  const metaText = new TextDecoder().decode(bytes.subarray(12, 12 + metaLength));
  const meta = JSON.parse(metaText.replace(/\0+$/, ''));

  let offset = 12 + metaLength;
  const vertexCount = view.getUint32(offset, true);
  const triangleCount = view.getUint32(offset + 4, true);
  offset += 8;

  const positions = new Float32Array(buffer, offset, vertexCount * 3);
  offset += positions.byteLength;
  const colors = new Float32Array(buffer, offset, vertexCount * 3);
  offset += colors.byteLength;
  const painted = new Uint8Array(buffer, offset, vertexCount);
  offset += align4(vertexCount);
  const index = new Uint32Array(buffer, offset, triangleCount * 3);

  return { ...meta, version: 2, positions, colors, painted, index };
}

// ------------------------------------------------------------------ transport

export async function listSculpts() {
  const response = await fetch(API, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Library unavailable (${response.status})`);
  return response.json();
}

export async function saveSculpt(id, blob) {
  const response = await fetch(`${API}/${encodeURIComponent(id)}`, { method: 'PUT', body: blob });
  if (!response.ok) throw new Error(await describe(response));
  return response.json();
}

export async function fetchSculpt(id) {
  const response = await fetch(`${API}/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(await describe(response));
  return response.arrayBuffer();
}

export async function deleteSculpt(id) {
  const response = await fetch(`${API}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(await describe(response));
  return response.json();
}

/** Ids are filenames on the host, so keep them boring. */
export function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `sculpt-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export function describeAge(modified) {
  const seconds = Math.max(0, (Date.now() - modified) / 1000);
  if (seconds < 90) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

async function describe(response) {
  return `${response.status} ${response.statusText || 'request failed'}`;
}

function align4(n) {
  return n % 4 === 0 ? n : n + (4 - n % 4);
}

function pad4(bytes, fill = 0) {
  if (bytes.length % 4 === 0) return bytes;
  const out = new Uint8Array(align4(bytes.length));
  out.set(bytes);
  if (fill) out.fill(fill, bytes.length);
  return out;
}
