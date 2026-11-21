// Single source of truth for every option. Both the desktop DOM panel and the
// in-VR canvas panel are generated from these lists, so they can't drift apart.

export const TOOLS = [
  { id: 'push', label: 'Push', hint: 'Build clay outward' },
  { id: 'carve', label: 'Carve', hint: 'Press clay inward' },
  { id: 'inflate', label: 'Inflate', hint: 'Swell along the surface' },
  { id: 'smooth', label: 'Smooth', hint: 'Soften bumps and seams' },
  { id: 'flatten', label: 'Flatten', hint: 'Press an area into a plane' },
  { id: 'pinch', label: 'Pinch', hint: 'Draw clay into ridges' },
  { id: 'grab', label: 'Grab', hint: 'Drag clay with your hand' },
  { id: 'paint', label: 'Paint', hint: 'Colour the surface' },
];

export const MATERIALS = [
  { id: 'clay', label: 'Clay', color: 0xc98a63, roughness: 0.95, metalness: 0, clearcoat: 0 },
  { id: 'terracotta', label: 'Terracotta', color: 0xb4553a, roughness: 0.85, metalness: 0, clearcoat: 0 },
  { id: 'wet', label: 'Wet Clay', color: 0x8a6a55, roughness: 0.25, metalness: 0, clearcoat: 1 },
  { id: 'porcelain', label: 'Porcelain', color: 0xf2ece4, roughness: 0.35, metalness: 0, clearcoat: 0.6 },
  { id: 'marble', label: 'Marble', color: 0xe8e8ea, roughness: 0.2, metalness: 0, clearcoat: 0.35 },
  { id: 'plasticine', label: 'Plasticine', color: 0x4aa8c9, roughness: 0.6, metalness: 0, clearcoat: 0.15 },
  { id: 'bronze', label: 'Bronze', color: 0xb08d57, roughness: 0.32, metalness: 1, clearcoat: 0 },
  { id: 'graphite', label: 'Graphite', color: 0x4b4f57, roughness: 0.5, metalness: 0.8, clearcoat: 0 },
];

export const SHAPES = [
  { id: 'sphere', label: 'Sphere' },
  { id: 'egg', label: 'Egg' },
  { id: 'pebble', label: 'Pebble' },
  { id: 'pillar', label: 'Pillar' },
  { id: 'disc', label: 'Disc' },
];

export const RESOLUTIONS = [
  { id: 4, label: 'Low', hint: '2.5k points' },
  { id: 5, label: 'Medium', hint: '10k points' },
  { id: 6, label: 'High', hint: '41k points' },
];

export const PALETTE = [
  '#ffffff', '#f4e4c1', '#e8a33d', '#d4552f', '#a02c2c', '#6d3b2e',
  '#7fb069', '#2f8f6f', '#3a6ea5', '#4b3f72', '#c86fa8', '#2b2b30',
];

const DEFAULTS = {
  tool: 'push',
  size: 0.35,       // 0..1, maps to a fraction of the ball radius
  strength: 0.55,   // 0..1
  symmetry: false,
  material: 'clay',
  color: '#d4552f',   // colour loaded in the paint brush
  baseColor: null,    // overrides the material's own clay colour when set
  faceted: false,
  turntable: false,
  dyntopo: true,      // add and remove triangles as you sculpt
  density: 0.5,       // 0..1, higher = finer triangles under the brush
  detail: 5,
  shape: 'sphere',
  swapHands: false,
  exportFormat: 'glb',
};

export const state = { ...DEFAULTS };

const listeners = new Set();

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function set(key, value) {
  if (state[key] === value) return;
  state[key] = value;
  for (const fn of listeners) fn(key, value);
}

/** Notify everyone without changing anything (used after bulk loads). */
export function refresh() {
  for (const fn of listeners) fn(null, null);
}

/** Brush radius as a fraction of the ball's rest radius. */
export function brushFraction() {
  return 0.05 + state.size * 0.55;
}

/**
 * Target edge length for the dyntopo pass, relative to the brush — the same
 * "relative detail" idea Blender uses, so a small brush automatically carves
 * finer triangles than a big one. Returns 0 when dyntopo is off.
 */
export function detailLength(brushRadius, ballRadius) {
  if (!state.dyntopo) return 0;
  // A detail-5 ball starts with ~0.038x-radius edges. At the default density
  // this lands comfortably below that, so sculpting adds detail rather than
  // eating it; the low end is deliberately coarser, for decimating on purpose.
  const fraction = 0.20 - state.density * 0.17;   // 0.20x brush .. 0.03x brush
  // Floor keeps a tiny brush at high density from exploding the triangle count.
  return Math.max(ballRadius * 0.004, brushRadius * fraction);
}

export function toolInfo(id = state.tool) {
  return TOOLS.find((t) => t.id === id) || TOOLS[0];
}

export function materialInfo(id = state.material) {
  return MATERIALS.find((m) => m.id === id) || MATERIALS[0];
}

export function cycleTool(dir = 1) {
  const i = TOOLS.findIndex((t) => t.id === state.tool);
  set('tool', TOOLS[(i + dir + TOOLS.length) % TOOLS.length].id);
}

export function savePrefs() {
  try {
    localStorage.setItem('vrclay.prefs', JSON.stringify(state));
  } catch { /* private mode, ignore */ }
}

export function loadPrefs() {
  try {
    const raw = localStorage.getItem('vrclay.prefs');
    if (!raw) return;
    const saved = JSON.parse(raw);
    for (const key of Object.keys(DEFAULTS)) {
      if (saved[key] !== undefined) state[key] = saved[key];
    }
  } catch { /* ignore */ }
}
