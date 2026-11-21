// Desktop control panel. Same option lists as the VR panel, rendered as real
// DOM so keyboard/mouse users get a normal, accessible UI.

import {
  TOOLS, MATERIALS, SHAPES, RESOLUTIONS, PALETTE,
  state, set, onChange,
} from './state.js';
import { EXPORT_FORMATS } from './exporters.js';
import { describeAge } from './library.js';

export function createDomUI({ onAction }) {
  const root = document.getElementById('ui');
  const sync = [];

  const section = (title) => {
    const el = document.createElement('section');
    if (title) {
      const h = document.createElement('h2');
      h.textContent = title;
      el.appendChild(h);
    }
    root.appendChild(el);
    return el;
  };

  const grid = (parent, cols) => {
    const el = document.createElement('div');
    el.className = 'grid';
    el.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    parent.appendChild(el);
    return el;
  };

  const button = (parent, label, onClick, title) => {
    const el = document.createElement('button');
    el.textContent = label;
    if (title) el.title = title;
    el.addEventListener('click', onClick);
    parent.appendChild(el);
    return el;
  };

  // --- tools
  const tools = section('Tool');
  const toolGrid = grid(tools, 2);
  for (const tool of TOOLS) {
    const el = button(toolGrid, tool.label, () => set('tool', tool.id), tool.hint);
    sync.push(() => el.classList.toggle('active', state.tool === tool.id));
  }
  const hint = document.createElement('p');
  hint.className = 'hint';
  tools.appendChild(hint);
  sync.push(() => {
    hint.textContent = (TOOLS.find((t) => t.id === state.tool) || TOOLS[0]).hint;
  });

  // --- brush
  const brush = section('Brush');
  for (const [key, label] of [['size', 'Size'], ['strength', 'Strength']]) {
    const row = document.createElement('label');
    row.className = 'slider';
    const name = document.createElement('span');
    name.textContent = label;
    const value = document.createElement('em');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '1';
    input.step = '0.01';
    input.addEventListener('input', () => set(key, parseFloat(input.value)));
    row.append(name, value, input);
    brush.appendChild(row);
    sync.push(() => {
      input.value = String(state[key]);
      value.textContent = `${Math.round(state[key] * 100)}%`;
    });
  }

  const toggleRow = grid(brush, 3);
  for (const [key, label, title] of [
    ['symmetry', 'Mirror', 'Mirror every stroke across the X axis'],
    ['faceted', 'Faceted', 'Flat shading, for a chiselled look'],
    ['turntable', 'Spin', 'Slowly rotate the ball'],
  ]) {
    const el = button(toggleRow, label, () => set(key, !state[key]), title);
    sync.push(() => el.classList.toggle('active', !!state[key]));
  }

  // --- dyntopo
  const dyn = section('Dynamic topology');
  const dynToggle = button(dyn, 'Dyntopo',
    () => set('dyntopo', !state.dyntopo),
    'Add and remove triangles under the brush as you sculpt');
  sync.push(() => dynToggle.classList.toggle('active', state.dyntopo));

  const densityRow = document.createElement('label');
  densityRow.className = 'slider';
  const densityName = document.createElement('span');
  densityName.textContent = 'Detail';
  const densityValue = document.createElement('em');
  const densityInput = document.createElement('input');
  densityInput.type = 'range';
  densityInput.min = '0';
  densityInput.max = '1';
  densityInput.step = '0.01';
  densityInput.title = 'Finer means smaller triangles under the brush';
  densityInput.addEventListener('input', () => set('density', parseFloat(densityInput.value)));
  densityRow.append(densityName, densityValue, densityInput);
  dyn.appendChild(densityRow);
  sync.push(() => {
    densityInput.value = String(state.density);
    densityInput.disabled = !state.dyntopo;
    densityValue.textContent = state.density < 0.34 ? 'Coarse'
      : state.density < 0.67 ? 'Medium' : 'Fine';
  });

  const meshStats = document.createElement('p');
  meshStats.className = 'hint';
  dyn.appendChild(meshStats);

  // --- colour
  const colour = section('Colour');
  const swatches = document.createElement('div');
  swatches.className = 'swatches';
  colour.appendChild(swatches);
  for (const hex of PALETTE) {
    const el = document.createElement('button');
    el.className = 'swatch';
    el.style.background = hex;
    el.title = `${hex} — click to select, double-click to flood the whole ball`;
    el.addEventListener('click', () => onAction('color', hex));
    el.addEventListener('dblclick', () => onAction('flood', hex));
    swatches.appendChild(el);
    sync.push(() => el.classList.toggle('active', state.color.toLowerCase() === hex.toLowerCase()));
  }
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.className = 'picker';
  custom.addEventListener('input', () => onAction('color', custom.value));
  colour.appendChild(custom);
  sync.push(() => { custom.value = state.color; });

  // --- material
  const material = section('Material');
  const matGrid = grid(material, 2);
  for (const m of MATERIALS) {
    const el = button(matGrid, m.label, () => set('material', m.id));
    const dot = document.createElement('i');
    dot.style.background = `#${m.color.toString(16).padStart(6, '0')}`;
    el.prepend(dot);
    sync.push(() => el.classList.toggle('active', state.material === m.id));
  }

  // --- new ball
  const ball = section('New ball');
  const shapeGrid = grid(ball, 3);
  for (const s of SHAPES) {
    const el = button(shapeGrid, s.label, () => onAction('shape', s.id));
    sync.push(() => el.classList.toggle('active', state.shape === s.id));
  }
  const detailGrid = grid(ball, 3);
  for (const d of RESOLUTIONS) {
    const el = button(detailGrid, d.label, () => onAction('detail', d.id), d.hint);
    sync.push(() => el.classList.toggle('active', state.detail === d.id));
  }
  const warn = document.createElement('p');
  warn.className = 'hint';
  warn.textContent = 'Changing shape or detail starts a fresh ball.';
  ball.appendChild(warn);

  // --- actions
  const actions = section('Sculpt');
  const actionGrid = grid(actions, 2);
  button(actionGrid, 'Undo', () => onAction('undo'), 'Ctrl+Z');
  button(actionGrid, 'Reset', () => onAction('reset'));
  button(actionGrid, 'Save', () => onAction('save'), 'Store in this browser');
  button(actionGrid, 'Load', () => onAction('load'));

  // --- download: pinned below the scrolling panel, so it never scrolls away
  const exportSection = document.getElementById('export-bar');
  const exportTitle = document.createElement('h2');
  exportTitle.textContent = 'Download';
  exportSection.appendChild(exportTitle);
  const exportRow = document.createElement('div');
  exportRow.className = 'export-row';
  const picker = document.createElement('select');
  for (const format of EXPORT_FORMATS) {
    const option = document.createElement('option');
    option.value = format.id;
    option.textContent = format.label;
    picker.appendChild(option);
  }
  picker.value = state.exportFormat;
  picker.addEventListener('change', () => set('exportFormat', picker.value));
  const exportButton = document.createElement('button');
  exportButton.className = 'primary';
  exportButton.textContent = 'Export';
  exportButton.title = 'Download to this computer';
  exportButton.addEventListener('click', () => onAction('export', picker.value));

  const sendButton = document.createElement('button');
  sendButton.textContent = 'To PC';
  sendButton.title = 'Write the file into the exports folder next to serve.py'
    + ' — the way out of a headset, where a download would land in the headset itself';
  sendButton.addEventListener('click', () => onAction('send', picker.value));

  exportRow.append(picker, exportButton, sendButton);
  // flipped by setLibrary() once we know whether serve.py is there
  let sendAvailable = true;
  exportSection.appendChild(exportRow);

  const exportHint = document.createElement('p');
  exportHint.className = 'hint';
  exportSection.appendChild(exportHint);
  sync.push(() => {
    picker.value = state.exportFormat;
    const format = EXPORT_FORMATS.find((x) => x.id === state.exportFormat) || EXPORT_FORMATS[0];
    exportHint.textContent = format.hint;
  });

  const status = document.createElement('p');
  status.className = 'status';
  root.appendChild(status);

  // --- "send to which machine?" picker
  const peersOverlay = document.getElementById('peers');
  const peersList = peersOverlay.querySelector('#peers-list');
  const peersEmpty = peersOverlay.querySelector('#peers-empty');
  const closePeers = () => peersOverlay.classList.remove('open');
  peersOverlay.querySelector('#peers-close').addEventListener('click', closePeers);
  peersOverlay.addEventListener('click', (e) => { if (e.target === peersOverlay) closePeers(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && peersOverlay.classList.contains('open')) closePeers();
  });

  // --- library: a header button and an overlay, so saved work is one click
  //     away instead of buried in the scrolling panel
  const libraryButton = document.createElement('button');
  libraryButton.textContent = 'Library';
  libraryButton.title = 'Sculpts saved on the computer running serve.py';
  document.getElementById('vr-slot').appendChild(libraryButton);

  const overlay = document.getElementById('library');
  const nameInput = overlay.querySelector('#library-name');
  const listEl = overlay.querySelector('#library-list');
  const emptyEl = overlay.querySelector('#library-empty');

  const openLibrary = (open) => {
    overlay.classList.toggle('open', open);
    if (open) onAction('library-refresh');
  };
  libraryButton.addEventListener('click', () => openLibrary(!overlay.classList.contains('open')));
  overlay.querySelector('#library-close').addEventListener('click', () => openLibrary(false));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) openLibrary(false); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) openLibrary(false);
  });

  const saveButton = overlay.querySelector('#library-save');
  const saveCopyButton = overlay.querySelector('#library-save-new');
  const offlineNote = overlay.querySelector('#library-offline');

  nameInput.addEventListener('input', () => onAction('library-rename', nameInput.value));
  saveButton.addEventListener('click', () => onAction('library-save', nameInput.value));
  saveCopyButton.addEventListener('click', () => onAction('library-save-new', nameInput.value));

  const apply = () => sync.forEach((fn) => fn());
  onChange(apply);
  apply();

  let statusTimer = 0;
  return {
    setStatus(text) {
      status.textContent = text;
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => { status.textContent = ''; }, 2600);
    },
    /** Shows the machine list; `onPick` gets the chosen peer. */
    showPeers(peers, onPick) {
      peersList.textContent = '';
      peersEmpty.hidden = peers.length > 0;
      peersEmpty.textContent = 'No machines found. Is VR Clay running on the other one?';

      for (const peer of peers) {
        const row = document.createElement('button');
        row.className = 'peer-item';
        const dot = document.createElement('i');
        dot.className = 'dot';
        const info = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = peer.name;
        const detail = document.createElement('span');
        detail.textContent = peer.host + ':' + peer.port;
        info.append(title, detail);
        const tag = document.createElement('em');
        tag.textContent = peer.self ? 'this machine' : '';
        row.append(dot, info, tag);
        row.addEventListener('click', () => { closePeers(); onPick(peer); });
        peersList.appendChild(row);
      }
      peersOverlay.classList.add('open');
    },

    setMeshStats(text) {
      if (meshStats.textContent !== text) meshStats.textContent = text;
    },

    /** Redraws the library list and reflects which entry is being edited. */
    setLibrary(items, currentSculpt, backendReady = true) {
      if (document.activeElement !== nameInput) nameInput.value = currentSculpt.name || '';
      libraryButton.textContent = currentSculpt.id ? `Library · ${currentSculpt.name}` : 'Library';
      listEl.textContent = '';

      // No serve.py behind the page: saving and send-to-PC can't work, so turn
      // them off with an explanation instead of letting them fail on click.
      if (sendAvailable !== backendReady) {
        sendAvailable = backendReady;
        sendButton.disabled = !backendReady;
        sendButton.title = backendReady
          ? 'Write the file into the exports folder next to serve.py'
          : 'Needs the local server — run python serve.py and open it from there';
        for (const el of [saveButton, saveCopyButton, nameInput]) el.disabled = !backendReady;
      }
      offlineNote.hidden = backendReady;
      emptyEl.hidden = items.length > 0 || !backendReady;

      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'library-item';
        if (item.id === currentSculpt.id) row.classList.add('current');

        const info = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = item.name || item.id;
        const detail = document.createElement('span');
        const tris = (item.triangleCount || 0).toLocaleString();
        detail.textContent = `${tris} triangles · ${describeAge(item.modified)}`
          + (item.id === currentSculpt.id ? ' · editing' : '');
        info.append(title, detail);

        const load = document.createElement('button');
        load.textContent = 'Open';
        load.addEventListener('click', () => onAction('library-load', item.id));

        const remove = document.createElement('button');
        remove.className = 'danger';
        remove.textContent = 'Delete';
        remove.addEventListener('click', () => {
          if (remove.dataset.armed) onAction('library-delete', item.id);
          else {
            remove.dataset.armed = '1';
            remove.textContent = 'Sure?';
            setTimeout(() => { delete remove.dataset.armed; remove.textContent = 'Delete'; }, 3000);
          }
        });

        row.append(info, load, remove);
        listEl.appendChild(row);
      }
    },
  };
}
