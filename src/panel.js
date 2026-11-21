// The in-VR control panel: a canvas texture on a plane you poke with the brush
// hand. Layout regions double as hit boxes, so drawing and clicking can never
// disagree about where a button is.

import * as THREE from 'three';
import {
  MATERIALS, SHAPES, RESOLUTIONS, PALETTE,
  state, set, toolInfo,
} from './state.js';
import { EXPORT_FORMATS } from './exporters.js';

const W = 900;
const H = 760;
const PANEL_WIDTH = 0.40;
const PANEL_HEIGHT = PANEL_WIDTH * (H / W);

const BG = '#171a20';
const PANEL_EDGE = '#2b303a';
const TEXT = '#e9e6e1';
const MUTED = '#8b93a1';
const ACCENT = '#e07a5f';
const FILL = '#232833';
const FILL_HOVER = '#2f3543';

const _local = new THREE.Vector3();

export class Panel {
  constructor({ onAction }) {
    this.onAction = onAction;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;

    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false }),
    );
    this.mesh.renderOrder = 10;

    this.regions = [];
    this.slots = [];
    this.backend = true;   // is serve.py behind this page?
    this.peer = '';        // machine a model would be sent to
    this.heldTool = '';
    this.stats = '';
    this.notice = '';
    this._noticeTimer = 0;
    this.hover = null;
    this.pointer = null;
    this.dragging = null;
    this._layout();
    this.dirty = true;
  }

  // ----------------------------------------------------------------- layout

  _layout() {
    const r = [];
    const L = 24;
    const R = 470;
    const COLW = 406;

    // --- left column: tools + sliders + toggles + actions
    // Tools are picked up off the tray, not chosen here.
    r.push({ kind: 'label', text: 'IN YOUR HAND', x: L, y: 74, w: COLW, h: 18 });
    r.push({ kind: 'held', x: L, y: 98, w: COLW, h: 238 });

    r.push({ kind: 'slider', key: 'size', text: 'BRUSH SIZE', x: L, y: 372, w: COLW, h: 28 });
    r.push({ kind: 'slider', key: 'strength', text: 'STRENGTH', x: L, y: 438, w: COLW, h: 28 });
    r.push({ kind: 'slider', key: 'density', text: 'DYNTOPO DETAIL', x: L, y: 504, w: COLW, h: 28 });

    const toggles = [
      { key: 'dyntopo', text: 'Dyntopo' },
      { key: 'symmetry', text: 'Mirror' },
      { key: 'faceted', text: 'Faceted' },
      { key: 'turntable', text: 'Spin' },
    ];
    toggles.forEach((t, i) => {
      r.push({ kind: 'toggle', key: t.key, text: t.text, x: L + i * 103, w: 97, y: 560, h: 48 });
    });

    const actions = [
      { action: 'undo', text: 'Undo' },
      { action: 'reset', text: 'Reset' },
      { action: 'recenter', text: 'Bring here' },
    ];
    actions.forEach((a, i) => {
      r.push({ kind: 'action', action: a.action, text: a.text, x: L + i * 139, w: 128, y: 622, h: 48 });
    });

    // --- right column: colour, material, shape, detail
    r.push({ kind: 'label', text: 'COLOUR', x: R, y: 20, w: COLW, h: 18 });
    PALETTE.forEach((hex, i) => {
      const col = i % 6;
      const row = (i / 6) | 0;
      r.push({ kind: 'swatch', color: hex, x: R + col * 68, y: 44 + row * 52, w: 60, h: 44 });
    });

    r.push({ kind: 'label', text: 'MATERIAL', x: R, y: 162, w: COLW, h: 18 });
    MATERIALS.forEach((m, i) => {
      const col = i % 2;
      const row = (i / 2) | 0;
      r.push({
        kind: 'material', id: m.id, text: m.label, swatch: m.color,
        x: R + col * 208, y: 186 + row * 54, w: 198, h: 46,
      });
    });

    r.push({ kind: 'label', text: 'NEW BALL', x: R, y: 410, w: COLW, h: 18 });
    SHAPES.forEach((s, i) => {
      r.push({ kind: 'shape', id: s.id, text: s.label, x: R + i * 81, y: 434, w: 76, h: 44 });
    });
    RESOLUTIONS.forEach((d, i) => {
      r.push({ kind: 'detail', id: d.id, text: d.label, x: R + i * 135, y: 486, w: 130, h: 44 });
    });

    // Sculpting in the headset? A download would land in the headset's own
    // storage, so this posts the file to the machine serving the app instead.
    r.push({ kind: 'label', text: 'SEND A MODEL', x: R, y: 648, w: COLW, h: 18 });
    EXPORT_FORMATS.forEach((format, i) => {
      r.push({
        kind: 'format', id: format.id, text: format.ext.toUpperCase(),
        x: R + i * 103, y: 670, w: 97, h: 38,
      });
    });
    // Which machine it goes to: tap to step through the ones on the network.
    r.push({ kind: 'peer', x: R, y: 714, w: 276, h: 40 });
    r.push({ kind: 'action', action: 'send-to-selected', text: 'Send',
      x: R + 286, y: 714, w: 120, h: 40 });

    // Library: save the current sculpt, or reopen one of the three most recent
    // without taking the headset off.
    r.push({ kind: 'label', text: 'LIBRARY', x: L, y: 682, w: COLW, h: 18 });
    r.push({ kind: 'action', action: 'library-save', text: 'Save', x: L, y: 706, w: 88, h: 44 });
    for (let i = 0; i < 3; i++) {
      r.push({ kind: 'slot', index: i, text: '—', x: L + 94 + i * 106, y: 706, w: 100, h: 44 });
    }

    this.regions = r;
  }

  // ------------------------------------------------------------------ input

  /** Converts a world-space point to canvas pixels and reports whether it hits. */
  project(worldPoint, out = {}) {
    const p = this.mesh.worldToLocal(_local.copy(worldPoint));
    const u = (p.x / PANEL_WIDTH + 0.5) * W;
    const v = (0.5 - p.y / PANEL_HEIGHT) * H;
    out.u = u;
    out.v = v;
    out.depth = p.z;
    out.inside = u >= 0 && u <= W && v >= 0 && v <= H && Math.abs(p.z) < 0.09;
    return out;
  }

  /** Live mesh readout, redrawn only when the text actually changes. */
  setStats(text) {
    if (text === this.stats) return;
    this.stats = text;
    this.dirty = true;
  }

  /** Name of the tool in hand, or empty for bare hands. */
  setHeldTool(label) {
    if (this.heldTool === label) return;
    this.heldTool = label;
    this.dirty = true;
  }

  /** Name of the machine a model will be sent to. */
  setPeer(name) {
    if (this.peer === name) return;
    this.peer = name;
    this.dirty = true;
  }

  /** Whether the page is backed by serve.py; false when statically hosted. */
  setBackend(ready) {
    if (this.backend === ready) return;
    this.backend = ready;
    this.dirty = true;
  }

  /** The most recent library entries, shown as one-press reopen slots. */
  setSlots(items) {
    this.slots = items || [];
    this.dirty = true;
  }

  /** Transient message, so headset users see the result of an action. */
  setNotice(text, holdMs = 4000) {
    this.notice = text;
    this.dirty = true;
    clearTimeout(this._noticeTimer);
    if (text) {
      this._noticeTimer = setTimeout(() => {
        this.notice = '';
        this.dirty = true;
      }, holdMs);
    }
  }

  hitTest(u, v) {
    for (const region of this.regions) {
      if (region.kind === 'label') continue;
      if (u >= region.x && u <= region.x + region.w && v >= region.y && v <= region.y + region.h) {
        return region;
      }
    }
    return null;
  }

  setPointer(u, v) {
    const changed = !this.pointer || this.pointer.u !== u || this.pointer.v !== v;
    this.pointer = { u, v };
    const hit = this.hitTest(u, v);
    if (hit !== this.hover || changed) this.dirty = true;
    this.hover = hit;
  }

  clearPointer() {
    if (this.pointer) this.dirty = true;
    this.pointer = null;
    this.hover = null;
    this.dragging = null;
  }

  /** @returns true if the press was consumed by the panel */
  press(u, v) {
    const region = this.hitTest(u, v);
    if (!region) return false;
    if (region.kind === 'slider') {
      this.dragging = region;
      this._applySlider(region, u);
      return true;
    }
    this._activate(region);
    return true;
  }

  drag(u) {
    if (this.dragging) this._applySlider(this.dragging, u);
  }

  release() {
    this.dragging = null;
  }

  _applySlider(region, u) {
    const t = Math.max(0, Math.min(1, (u - region.x) / region.w));
    set(region.key, Math.round(t * 100) / 100);
    this.dirty = true;
  }

  _activate(region) {
    if (!this.backend && this._needsBackend(region)) {
      this.setNotice('Needs the local server (serve.py)');
      return;
    }
    switch (region.kind) {
      case 'tool': set('tool', region.id); break;
      case 'toggle': set(region.key, !state[region.key]); break;
      case 'material': set('material', region.id); break;
      case 'format': set('exportFormat', region.id); break;
      case 'peer': this.onAction('cycle-peer'); break;
      case 'slot': {
        const slot = this.slots[region.index];
        if (slot) this.onAction('library-load', slot.id);
        break;
      }
      case 'swatch': this.onAction('color', region.color); break;
      case 'shape': this.onAction('shape', region.id); break;
      case 'detail': this.onAction('detail', region.id); break;
      case 'action': this.onAction(region.action); break;
      default: break;
    }
    this.dirty = true;
  }

  /** Controls that only work when serve.py is serving the page. */
  _needsBackend(region) {
    return region.kind === 'slot' || region.kind === 'peer'
      || (region.kind === 'action'
        && (region.action === 'send-to-selected' || region.action === 'library-save'));
  }

  // ------------------------------------------------------------------- draw

  update() {
    if (!this.dirty) return;
    this.dirty = false;
    this._draw();
    this.texture.needsUpdate = true;
  }

  _draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);

    roundRect(ctx, 0, 0, W, H, 24);
    ctx.fillStyle = BG;
    ctx.fill();
    ctx.strokeStyle = PANEL_EDGE;
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.textBaseline = 'middle';

    // header
    ctx.fillStyle = TEXT;
    ctx.font = '600 30px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('VR CLAY', 24, 38);
    ctx.fillStyle = ACCENT;
    ctx.font = '500 18px system-ui, sans-serif';
    const info = toolInfo();
    ctx.fillText(`${info.label} — ${info.hint}`, 168, 39);

    for (const region of this.regions) {
      const hovered = region === this.hover;
      switch (region.kind) {
        case 'label':
          ctx.fillStyle = MUTED;
          ctx.font = '600 15px system-ui, sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(region.text, region.x, region.y + 9);
          break;
        case 'held':
          this._heldPanel(region);
          break;
        case 'toggle':
          this._button(region, !!state[region.key], hovered, 18);
          break;
        case 'action':
          this._button(region, false, hovered, 18);
          break;
        case 'material':
          this._button(region, state.material === region.id, hovered, 17, region.swatch);
          break;
        case 'shape':
          this._button(region, state.shape === region.id, hovered, 16);
          break;
        case 'detail':
          this._button(region, state.detail === region.id, hovered, 16);
          break;
        case 'format':
          this._button(region, state.exportFormat === region.id, hovered, 15);
          break;
        case 'peer':
          this._peerButton(region, hovered);
          break;
        case 'slot': {
          const slot = this.slots[region.index];
          region.text = slot ? truncate(slot.name || slot.id, 11) : '—';
          this._button(region, false, hovered && !!slot, 14);
          break;
        }
        case 'swatch':
          this._swatch(region, hovered);
          break;
        case 'slider':
          this._slider(region, hovered);
          break;
        default:
          break;
      }
    }

    ctx.fillStyle = MUTED;
    ctx.font = '400 15px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('New ball discards the current sculpt', 470, 552);
    ctx.fillText('Trigger sculpts · Grip holds the ball · Stick resizes brush', 470, 578);

    if (this.notice) {
      ctx.fillStyle = ACCENT;
      ctx.font = '500 17px system-ui, sans-serif';
      ctx.fillText(this.notice, 470, 606);
    }
    if (this.stats) {
      ctx.fillStyle = TEXT;
      ctx.font = '500 17px system-ui, sans-serif';
      ctx.fillText(this.stats, 470, 628);
    }

    if (this.pointer) {
      ctx.beginPath();
      ctx.arc(this.pointer.u, this.pointer.v, 7, 0, Math.PI * 2);
      ctx.fillStyle = ACCENT;
      ctx.fill();
      ctx.strokeStyle = '#00000088';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  /** The machine a model will be sent to; tapping steps to the next one. */
  _peerButton(region, hovered) {
    const ctx = this.ctx;
    const known = !!this.peer;
    roundRect(ctx, region.x, region.y, region.w, region.h, 10);
    ctx.fillStyle = hovered && known ? FILL_HOVER : FILL;
    ctx.fill();
    if (hovered && known) {
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = MUTED;
    ctx.font = '500 13px system-ui, sans-serif';
    ctx.fillText('TO', region.x + 14, region.y + 13);
    ctx.fillStyle = known ? TEXT : MUTED;
    ctx.font = '600 19px system-ui, sans-serif';
    ctx.fillText(truncate(this.peer || 'no machines found', 22),
      region.x + 14, region.y + 28);
    ctx.textAlign = 'center';
  }

  /** What you're currently holding, and how to change it. */
  _heldPanel(region) {
    const ctx = this.ctx;
    roundRect(ctx, region.x, region.y, region.w, region.h, 12);
    ctx.fillStyle = FILL;
    ctx.fill();

    const info = toolInfo();
    const bare = !this.heldTool;

    ctx.textAlign = 'left';
    ctx.fillStyle = ACCENT;
    ctx.font = '600 40px system-ui, sans-serif';
    ctx.fillText(bare ? 'Bare hands' : this.heldTool, region.x + 22, region.y + 52);

    ctx.fillStyle = TEXT;
    ctx.font = '400 20px system-ui, sans-serif';
    ctx.fillText(bare ? 'Fingertip smooths the clay' : info.hint, region.x + 22, region.y + 92);
    if (bare) ctx.fillText('Squeeze to pull clay around', region.x + 22, region.y + 122);

    ctx.fillStyle = MUTED;
    ctx.font = '400 18px system-ui, sans-serif';
    const lines = [
      'Reach to the tray and squeeze',
      'to pick up a tool.',
      'Squeeze again to put it back.',
    ];
    lines.forEach((line, i) => {
      ctx.fillText(line, region.x + 22, region.y + 162 + i * 26);
    });
  }

  _button(region, active, hovered, fontSize, swatch) {
    const ctx = this.ctx;
    roundRect(ctx, region.x, region.y, region.w, region.h, 10);
    ctx.fillStyle = active ? ACCENT : hovered ? FILL_HOVER : FILL;
    ctx.fill();
    if (hovered && !active) {
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    let textX = region.x + region.w / 2;
    if (swatch !== undefined) {
      const size = 18;
      const cx = region.x + 16;
      roundRect(ctx, cx, region.y + region.h / 2 - size / 2, size, size, 5);
      ctx.fillStyle = `#${swatch.toString(16).padStart(6, '0')}`;
      ctx.fill();
      textX = region.x + 30 + (region.w - 30) / 2;
    }
    ctx.fillStyle = active ? '#1b1006' : TEXT;
    ctx.font = `${active ? 600 : 500} ${fontSize}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(region.text, textX, region.y + region.h / 2 + 1);
  }

  _swatch(region, hovered) {
    const ctx = this.ctx;
    roundRect(ctx, region.x, region.y, region.w, region.h, 9);
    ctx.fillStyle = region.color;
    ctx.fill();
    const selected = state.color.toLowerCase() === region.color.toLowerCase();
    if (selected || hovered) {
      ctx.strokeStyle = selected ? ACCENT : TEXT;
      ctx.lineWidth = selected ? 4 : 2;
      ctx.stroke();
    }
  }

  _slider(region, hovered) {
    const ctx = this.ctx;
    const value = state[region.key];
    ctx.fillStyle = MUTED;
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(region.text, region.x, region.y - 14);
    ctx.textAlign = 'right';
    ctx.fillStyle = TEXT;
    ctx.fillText(`${Math.round(value * 100)}%`, region.x + region.w, region.y - 14);

    roundRect(ctx, region.x, region.y + 6, region.w, 16, 8);
    ctx.fillStyle = FILL;
    ctx.fill();
    roundRect(ctx, region.x, region.y + 6, Math.max(16, region.w * value), 16, 8);
    ctx.fillStyle = ACCENT;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(region.x + region.w * value, region.y + 14, hovered ? 15 : 12, 0, Math.PI * 2);
    ctx.fillStyle = TEXT;
    ctx.fill();
  }
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
