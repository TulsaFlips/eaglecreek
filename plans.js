/* Eagle Creek — plan reader.
 *
 * Opens a drawing set (any PDF in a project's Documents): pinch to zoom, drag to move,
 * redrawn sharp at any zoom. Each sheet can have a scale (a printed one like 1/4" = 1'-0",
 * or measured from a known dimension), and measurements on it: lengths, runs, areas and counts.
 *
 * Scales and measurements sync as their own records ("planSheet", "planMark") in the same
 * documents table, so every phone and iPad sees them, and the Mac app can read them later.
 * Points are stored in PDF points (1/72 inch) on the sheet as printed, top-left origin.
 */
'use strict';

Object.assign(ICONS, {
  hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4.5a1.5 1.5 0 0 1 3 0V12M14 11.5V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L3.3 14a1.5 1.5 0 0 1 2.4-1.8L8 15"/>',
  ruler: '<path d="M3.5 16.5 16.5 3.5l4 4-13 13z"/><path d="M8 12l1.6 1.6M10.5 9.5l1.6 1.6M13 7l1.6 1.6"/>',
  run: '<circle cx="5" cy="18" r="1.8"/><circle cx="10" cy="7.5" r="1.8"/><circle cx="19" cy="14" r="1.8"/><path d="M5.8 16.3 9.2 9.2M11.6 8.6l5.9 4.3"/>',
  area: '<path d="M4 8.5 11 4l9 4.5-2.5 11.5h-11z"/><path d="M8 12h8M9 16h6" opacity=".5"/>',
  count: '<circle cx="7" cy="7" r="2.6"/><circle cx="17" cy="7" r="2.6"/><circle cx="7" cy="17" r="2.6"/><circle cx="17" cy="17" r="2.6"/>',
  scale: '<path d="M3 17.5h18M4.5 17.5v-3M8.25 17.5v-5.5M12 17.5v-3M15.75 17.5v-5.5M19.5 17.5v-3"/><path d="M8 6h8M8 6l2-2M8 6l2 2M16 6l-2-2M16 6l-2 2"/>',
  pages: '<rect x="7" y="3" width="13" height="16" rx="1.5"/><path d="M4 7v12.5A1.5 1.5 0 0 0 5.5 21H16"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  square: '<path d="M5 19V5M5 19h14"/><path d="M5 14h5v5" opacity=".6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
});

// Printed scales: inches on paper to feet on site.
const ARCH_SCALES = [
  ['1/16" = 1\'-0"', 16], ['3/32" = 1\'-0"', 32 / 3], ['1/8" = 1\'-0"', 8], ['3/16" = 1\'-0"', 16 / 3],
  ['1/4" = 1\'-0"', 4], ['3/8" = 1\'-0"', 8 / 3], ['1/2" = 1\'-0"', 2], ['3/4" = 1\'-0"', 4 / 3],
  ['1" = 1\'-0"', 1], ['1 1/2" = 1\'-0"', 2 / 3], ['3" = 1\'-0"', 1 / 3],
];
const ENG_SCALES = [10, 20, 30, 40, 50, 60, 100].map((n) => [`1" = ${n}'`, n]);
const MARK_TYPES = { length: 'Length', path: 'Run', area: 'Area', count: 'Count' };
// Strong enough to read on black-and-white drawings, from the app's palette family.
const MARK_COLORS = ['#B23A26', '#2E7D4F', '#2F6A9E', '#B8860B', '#7A4A8C'];
const MARK_DEFAULT_COLOR = { length: '#B23A26', path: '#B23A26', area: '#2E7D4F', count: '#2F6A9E' };

// ----- Numbers

/** 12' 6 1/2" (to the nearest 1/4"). */
function feetText(ft) {
  if (!Number.isFinite(ft)) return '—';
  let q = Math.round(Math.abs(ft) * 48);
  const feet = Math.floor(q / 48); q -= feet * 48;
  const inches = Math.floor(q / 4);
  const frac = ['', ' 1/4', ' 1/2', ' 3/4'][q % 4];
  return `${ft < 0 ? '-' : ''}${feet}' ${inches}${frac}"`;
}
const areaText = (sf) => (sf >= 100 ? `${Math.round(sf).toLocaleString('en-US')} sq ft` : `${sf.toFixed(1)} sq ft`);
const pdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const pmid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
function runLength(pts, closed = false) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += pdist(pts[i - 1], pts[i]);
  if (closed && pts.length > 2) total += pdist(pts[pts.length - 1], pts[0]);
  return total;
}
function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}
function polyCentroid(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    const f = x1 * y2 - x2 * y1;
    a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-9) return pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length], [0, 0]);
  return [cx / (3 * a), cy / (3 * a)];
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function inside(p, pts) {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
/** Straight mode: lines run level, plumb or at 45°. */
function snapStraight(from, p) {
  const dx = p[0] - from[0], dy = p[1] - from[1];
  const len = Math.hypot(dx, dy);
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [from[0] + Math.cos(ang) * len, from[1] + Math.sin(ang) * len];
}
const r2 = (p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];

// ----- Records

const planSheets = (fileID) => all('planSheet').filter((r) => sameId(r.fileID, fileID));
function pageScale(fileID, page) {
  return planSheets(fileID).filter((r) => r.page === page && r.feetPerPoint > 0).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
}
const planMarks = (fileID, page = null) => all('planMark')
  .filter((m) => sameId(m.fileID, fileID) && (page == null || m.page === page) && Array.isArray(m.points))
  .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
function markName(m) {
  if ((m.name || '').trim()) return m.name.trim();
  const same = planMarks(m.fileID).filter((x) => x.type === m.type);
  return `${MARK_TYPES[m.type] || 'Mark'} ${Math.max(1, same.findIndex((x) => sameId(x.id, m.id)) + 1)}`;
}
function markValue(m, fpp, points = m.points) {
  if (m.type === 'count') return `${points.length} ea`;
  if (!fpp) return 'Set the scale';
  if (m.type === 'area') return areaText(polyArea(points) * fpp * fpp);
  return feetText(runLength(points) * fpp);
}
const planMarkCount = (fileID) => planMarks(fileID).length;

// ----- The viewer

let PV = null;
const planMemory = new Map(); // file -> last sheet looked at

async function openPlan(f) {
  flushLogSave();
  viewerState?.cleanup?.();
  const root = $('#sheet-root');
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  root.innerHTML = `<div class="plan" id="plan" role="dialog" aria-modal="true" aria-label="${esc(fileTitle(f))}">
    <div class="plan-top">
      <button class="icon-btn" data-act="sheet-close" aria-label="Close">${icon('close')}</button>
      <button class="plan-title" data-act="plan-sheets" aria-label="Sheets"><span class="pt-name">${esc(fileTitle(f))}</span><span class="pt-sub" id="plan-sub">Opening…</span></button>
      <button class="icon-btn" data-act="plan-page" data-n="-1" id="plan-prev" aria-label="Previous sheet">${icon('left')}</button>
      <button class="icon-btn" data-act="plan-page" data-n="1" id="plan-next" aria-label="Next sheet">${icon('right')}</button>
      <button class="icon-btn" data-act="plan-list" aria-label="Measurements">${icon('list')}</button>
    </div>
    <div class="plan-stage" id="plan-stage">
      <canvas class="plan-base" id="plan-base"></canvas>
      <canvas class="plan-detail" id="plan-detail"></canvas>
      <svg class="plan-ink" id="plan-ink" xmlns="http://www.w3.org/2000/svg"></svg>
      <canvas class="plan-loupe" id="plan-loupe" width="${Math.round(128 * dpr)}" height="${Math.round(128 * dpr)}"></canvas>
      <button class="plan-chip hidden" id="plan-fit" data-act="plan-fit">${icon('fit')}<span id="plan-zoom">Fit</span></button>
      <div class="plan-msg" id="plan-msg">Opening the drawings…</div>
    </div>
    <div class="plan-bar" id="plan-bar"></div>
  </div>`;
  document.body.style.overflow = 'hidden';
  const pv = {
    file: f, fileID: key(f.id), dpr, page: 1, numPages: 0, doc: null, pageObj: null, w: 0, h: 0,
    view: { s: 1, tx: 0, ty: 0 }, fit: 1, maxS: 10, baseScale: 1, detailView: null, detailTask: null, baseTask: null,
    tool: 'move', draft: [], selected: null, editing: null, straight: false, hover: null, last: null, labels: null,
    stage: $('#plan-stage'), ink: $('#plan-ink'), base: $('#plan-base'), detail: $('#plan-detail'), loupe: $('#plan-loupe'),
    listeners: [],
  };
  PV = pv;
  viewerState = { index: -1, list: [], cleanup: () => planClose(pv) };
  bindStage(pv);
  const onKey = (e) => planKey(e);
  const onResize = () => planResize();
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  pv.listeners.push(['keydown', onKey, true], ['resize', onResize, false]);
  renderBar();
  try {
    const blob = await fileBlob(f);
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
    if (PV !== pv) { doc.destroy(); return; }
    pv.doc = doc;
    pv.numPages = doc.numPages;
    try { pv.labels = await doc.getPageLabels(); } catch { pv.labels = null; }
    const remembered = planMemory.get(pv.fileID);
    await showPage(Math.min(Math.max(1, remembered || 1), pv.numPages));
  } catch (e) {
    if (PV !== pv) return;
    const msg = e instanceof ApiError && (e.status === 400 || e.status === 404)
      ? "This file hasn't reached the cloud yet. It downloads after the Mac's next sync."
      : /Invalid PDF|password/i.test(String(e?.message)) ? "This PDF can't be opened here (it may be damaged or password-protected)."
        : friendlyError(e);
    $('#plan-msg').textContent = msg;
    $('#plan-sub').textContent = '';
  }
}

function planClose(pv) {
  clearTimeout(pv.detailTimer);
  try { pv.detailTask?.cancel(); } catch { /* fine */ }
  try { pv.baseTask?.cancel(); } catch { /* fine */ }
  for (const [type, fn, capture] of pv.listeners) window.removeEventListener(type, fn, capture);
  pv.doc?.destroy?.();
  if (PV === pv) PV = null;
}

function sheetLabel(pv, n) {
  const l = pv.labels?.[n - 1];
  return l && String(l).trim() && String(l) !== String(n) ? `Sheet ${l}` : `Sheet ${n}`;
}

async function showPage(n) {
  const pv = PV;
  if (!pv?.doc) return;
  n = Math.min(Math.max(1, n), pv.numPages);
  try { pv.detailTask?.cancel(); } catch { /* fine */ }
  try { pv.baseTask?.cancel(); } catch { /* fine */ }
  pv.page = n;
  planMemory.set(pv.fileID, n);
  pv.draft = []; pv.selected = null; pv.editing = null; pv.last = null;
  if (pv.tool === 'calibrate') pv.tool = 'move';
  const page = await pv.doc.getPage(n);
  if (PV !== pv || pv.page !== n) return;
  pv.pageObj = page;
  const vp = page.getViewport({ scale: 1 });
  pv.w = vp.width; pv.h = vp.height;
  measureStage(pv);
  pv.fit = Math.min(pv.stageW / pv.w, pv.stageH / pv.h) * 0.96;
  // Deep enough to read the smallest dimension on a full sheet (about 10 screen pixels per point).
  pv.maxS = Math.max(10, pv.fit * 6);
  pv.view = { s: pv.fit, tx: (pv.stageW - pv.w * pv.fit) / 2, ty: (pv.stageH - pv.h * pv.fit) / 2 };
  $('#plan-prev').disabled = n <= 1;
  $('#plan-next').disabled = n >= pv.numPages;
  updateSub();
  // The whole sheet at a moderate resolution, shown at once and while zooming.
  const maxPixels = 9_000_000;
  pv.baseScale = Math.min(pv.fit * pv.dpr * 2, Math.sqrt(maxPixels / (pv.w * pv.h)));
  const bvp = page.getViewport({ scale: pv.baseScale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(bvp.width);
  canvas.height = Math.floor(bvp.height);
  canvas.className = 'plan-base';
  canvas.style.width = `${pv.w}px`;
  canvas.style.height = `${pv.h}px`;
  pv.detail.style.display = 'none';
  pv.detailView = null;
  const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: bvp });
  pv.baseTask = task;
  try { await task.promise; } catch { return; }
  if (PV !== pv || pv.page !== n) return;
  pv.base.replaceWith(canvas);
  pv.base = canvas;
  $('#plan-msg')?.remove();
  applyView();
  scheduleDetail(0);
  renderBar();
}

function measureStage(pv) {
  const r = pv.stage.getBoundingClientRect();
  pv.stageW = Math.max(100, r.width);
  pv.stageH = Math.max(100, r.height);
  pv.ink.setAttribute('width', pv.stageW);
  pv.ink.setAttribute('height', pv.stageH);
  pv.ink.setAttribute('viewBox', `0 0 ${pv.stageW} ${pv.stageH}`);
}

function planResize() {
  const pv = PV;
  if (!pv?.pageObj) return;
  const oldFit = pv.fit;
  measureStage(pv);
  pv.fit = Math.min(pv.stageW / pv.w, pv.stageH / pv.h) * 0.96;
  pv.maxS = Math.max(10, pv.fit * 6);
  if (Math.abs(pv.view.s - oldFit) < 1e-6) pv.view = { s: pv.fit, tx: 0, ty: 0 };
  clampView();
  applyView();
  scheduleDetail();
}

function updateSub() {
  const pv = PV;
  const sc = pageScale(pv.fileID, pv.page);
  $('#plan-sub').textContent = `${sheetLabel(pv, pv.page)} of ${pv.numPages} · ${sc ? sc.scaleLabel || 'Scale set' : 'No scale set'}`;
}

// ----- View: page points -> screen = p * s + t

const toScreen = (p) => [p[0] * PV.view.s + PV.view.tx, p[1] * PV.view.s + PV.view.ty];
const toPage = (q) => [(q[0] - PV.view.tx) / PV.view.s, (q[1] - PV.view.ty) / PV.view.s];
const clampToPage = (p) => [Math.min(PV.w, Math.max(0, p[0])), Math.min(PV.h, Math.max(0, p[1]))];
const clampScale = (s) => Math.min(PV.maxS, Math.max(PV.fit * 0.8, s));

function clampView() {
  const pv = PV, v = pv.view, m = 60;
  const pw = pv.w * v.s, ph = pv.h * v.s;
  v.tx = pw <= pv.stageW ? (pv.stageW - pw) / 2 : Math.min(m, Math.max(pv.stageW - pw - m, v.tx));
  v.ty = ph <= pv.stageH ? (pv.stageH - ph) / 2 : Math.min(m, Math.max(pv.stageH - ph - m, v.ty));
}

let inkFrame = 0;
function applyView() {
  const pv = PV;
  if (!pv) return;
  const { s, tx, ty } = pv.view;
  pv.base.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  if (pv.detailView) {
    const d = pv.detailView, k = s / d.s;
    pv.detail.style.transform = `translate(${tx - d.tx * k}px, ${ty - d.ty * k}px) scale(${k})`;
  }
  const zoomed = s > pv.fit * 1.05;
  const chip = $('#plan-fit');
  chip?.classList.toggle('hidden', !zoomed);
  if (zoomed) $('#plan-zoom').textContent = `${(s / pv.fit).toFixed(1)}×`;
  if (!inkFrame) inkFrame = requestAnimationFrame(() => { inkFrame = 0; drawInk(); });
}

/** After a pinch or drag settles, the part on screen is drawn again at full sharpness. */
function scheduleDetail(delay = 160) {
  const pv = PV;
  if (!pv) return;
  clearTimeout(pv.detailTimer);
  pv.detailTimer = setTimeout(() => renderDetail(pv), delay);
}

async function renderDetail(pv) {
  if (PV !== pv || !pv.pageObj) return;
  const { s, tx, ty } = pv.view;
  if (s * pv.dpr <= pv.baseScale * 1.1) { pv.detail.style.display = 'none'; pv.detailView = null; return; }
  try { pv.detailTask?.cancel(); } catch { /* fine */ }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(pv.stageW * pv.dpr);
  canvas.height = Math.round(pv.stageH * pv.dpr);
  const viewport = pv.pageObj.getViewport({ scale: s * pv.dpr });
  const task = pv.pageObj.render({
    canvasContext: canvas.getContext('2d'), viewport,
    transform: [1, 0, 0, 1, tx * pv.dpr, ty * pv.dpr], background: 'rgba(0,0,0,0)',
  });
  pv.detailTask = task;
  try { await task.promise; } catch { return; }
  if (PV !== pv || pv.detailTask !== task) return;
  canvas.className = 'plan-detail';
  canvas.style.width = `${pv.stageW}px`;
  canvas.style.height = `${pv.stageH}px`;
  pv.detail.replaceWith(canvas);
  pv.detail = canvas;
  pv.detailView = { s, tx, ty };
  applyView();
}

function zoomAt(q, factor) {
  const v = PV.view;
  const s = clampScale(v.s * factor);
  const p = [(q[0] - v.tx) / v.s, (q[1] - v.ty) / v.s];
  PV.view = { s, tx: q[0] - p[0] * s, ty: q[1] - p[1] * s };
  clampView();
  applyView();
  scheduleDetail();
}

function animateTo(target) {
  const pv = PV;
  const from = { ...pv.view };
  const t0 = performance.now();
  const step = (now) => {
    if (PV !== pv) return;
    const k = Math.min(1, (now - t0) / 200);
    const e = 1 - (1 - k) ** 3;
    pv.view = { s: from.s + (target.s - from.s) * e, tx: from.tx + (target.tx - from.tx) * e, ty: from.ty + (target.ty - from.ty) * e };
    applyView();
    if (k < 1) requestAnimationFrame(step);
    else { clampView(); applyView(); scheduleDetail(0); }
  };
  requestAnimationFrame(step);
}
function fitView() {
  const pv = PV;
  animateTo({ s: pv.fit, tx: (pv.stageW - pv.w * pv.fit) / 2, ty: (pv.stageH - pv.h * pv.fit) / 2 });
}
function zoomToward(q, factor) {
  const v = PV.view;
  const s = clampScale(v.s * factor);
  const p = [(q[0] - v.tx) / v.s, (q[1] - v.ty) / v.s];
  // Bring the tapped spot toward the middle as it zooms.
  const target = { s, tx: PV.stageW / 2 - p[0] * s, ty: PV.stageH / 2 - p[1] * s };
  const saved = PV.view; PV.view = { ...target }; clampView(); const clamped = PV.view; PV.view = saved;
  animateTo(clamped);
}

// ----- Touch, pen, mouse and trackpad

function bindStage(pv) {
  const stage = pv.stage;
  const pts = new Map();
  let mode = null, start = null, pinch = null, drag = null, lastTap = null;
  const pos = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  stage.addEventListener('pointerdown', (e) => {
    if (PV !== pv || !pv.pageObj) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('button')) return; // the Fit chip and other controls on the drawing
    try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const q = pos(e);
    pts.set(e.pointerId, q);
    e.preventDefault();
    if (pts.size === 1) {
      const h = hitHandle(q, e.pointerType);
      if (h) { mode = 'handle'; drag = h; showLoupe(q, e.pointerType); }
      else { mode = 'tap'; start = { q, view: { ...pv.view }, t: performance.now() }; }
    } else if (pts.size === 2) {
      if (mode === 'handle') { commitHandle(drag); hideLoupe(); }
      const [a, b] = [...pts.values()];
      mode = 'pinch';
      pinch = { d: Math.max(1, pdist(a, b)), m: pmid(a, b), view: { ...pv.view } };
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (PV !== pv) return;
    const q = pos(e);
    if (!pts.has(e.pointerId)) {
      if (e.pointerType === 'mouse' && pv.tool !== 'move' && pv.draft.length) { pv.hover = q; applyView(); }
      return;
    }
    pts.set(e.pointerId, q);
    if (mode === 'tap' && pdist(q, start.q) > (e.pointerType === 'mouse' ? 4 : 9)) mode = 'pan';
    if (mode === 'pan') {
      pv.view.tx = start.view.tx + q[0] - start.q[0];
      pv.view.ty = start.view.ty + q[1] - start.q[1];
      clampView(); applyView(); scheduleDetail();
    } else if (mode === 'pinch' && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const v = pinch.view;
      const s = clampScale(v.s * pdist(a, b) / pinch.d);
      const p = [(pinch.m[0] - v.tx) / v.s, (pinch.m[1] - v.ty) / v.s];
      const m = pmid(a, b);
      pv.view = { s, tx: m[0] - p[0] * s, ty: m[1] - p[1] * s };
      clampView(); applyView(); scheduleDetail(220);
    } else if (mode === 'handle') {
      moveHandle(drag, q);
      showLoupe(q, e.pointerType);
    }
  });

  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    const q = pos(e);
    pts.delete(e.pointerId);
    if (mode === 'tap' && e.type === 'pointerup') {
      const now = performance.now();
      const double = lastTap && now - lastTap.t < 320 && pdist(q, lastTap.q) < 32;
      lastTap = double ? null : { t: now, q };
      onTap(q, e.pointerType, double);
    }
    if (mode === 'handle') { commitHandle(drag); hideLoupe(); drag = null; }
    if (pts.size === 0) mode = null;
    else if (mode === 'pinch' && pts.size === 1) {
      const [rest] = [...pts.values()];
      mode = 'pan';
      start = { q: rest, view: { ...pv.view }, t: 0 };
    }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && pv.hover) { pv.hover = null; applyView(); } });
  stage.addEventListener('wheel', (e) => {
    if (PV !== pv || !pv.pageObj) return;
    e.preventDefault();
    const q = pos(e);
    if (e.ctrlKey || e.metaKey) zoomAt(q, Math.exp(-e.deltaY * 0.012)); // trackpad pinch, or Ctrl/⌘ + wheel
    else if (e.deltaMode === 1 || (Math.abs(e.deltaY) >= 50 && !e.deltaX && Number.isInteger(e.deltaY))) zoomAt(q, e.deltaY < 0 ? 1.25 : 0.8); // mouse wheel
    else { pv.view.tx -= e.deltaX; pv.view.ty -= e.deltaY; clampView(); applyView(); scheduleDetail(); } // trackpad scroll
  }, { passive: false });
  // Safari's own pinch would zoom the whole page instead of the drawing.
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) stage.addEventListener(t, (e) => e.preventDefault());
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
}

function planKey(e) {
  const pv = PV;
  if (!pv) return;
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
  if (e.key === 'Escape') {
    e.stopPropagation(); e.preventDefault();
    if ($('.plan-dialog')) closePlanDialog();
    else if (pv.draft.length || pv.tool !== 'move') setTool('move');
    else if (pv.selected) { pv.selected = null; renderBar(); applyView(); }
    else closeSheet();
    return;
  }
  if (typing || $('.plan-dialog')) return;
  const mid = [pv.stageW / 2, pv.stageH / 2];
  if (e.key === '+' || e.key === '=') { zoomAt(mid, 1.4); e.stopPropagation(); }
  else if (e.key === '-' || e.key === '_') { zoomAt(mid, 1 / 1.4); e.stopPropagation(); }
  else if (e.key === '0') { fitView(); e.stopPropagation(); }
  else if (e.key === 'ArrowRight' || e.key === 'PageDown') { showPage(pv.page + 1); e.stopPropagation(); e.preventDefault(); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { showPage(pv.page - 1); e.stopPropagation(); e.preventDefault(); }
  else if ((e.key === 'Backspace' || e.key === 'Delete') && pv.draft.length) { pv.draft.pop(); renderBar(); applyView(); e.stopPropagation(); }
  else if (e.key === 'Enter' && pv.draft.length) { finishDraft(); e.stopPropagation(); }
}

// ----- Measuring

function onTap(q, pointerType, double) {
  const pv = PV;
  if (pv.tool === 'move') {
    if (double) { pv.view.s > pv.fit * 2.2 ? fitView() : zoomToward(q, 3); return; }
    const hit = hitMark(q, pointerType);
    pv.selected = hit ? key(hit.id) : null;
    renderBar(); applyView();
    return;
  }
  let p = toPage(q);
  if (p[0] < -4 || p[1] < -4 || p[0] > pv.w + 4 || p[1] > pv.h + 4) return; // off the sheet
  p = clampToPage(p);
  if (pv.straight && pv.draft.length && pv.tool !== 'count') p = snapStraight(pv.draft[pv.draft.length - 1], p);
  const tool = pv.tool;
  if (tool === 'area' && pv.draft.length >= 3 && pdist(toScreen(pv.draft[0]), q) < (pointerType === 'mouse' ? 10 : 22)) { finishDraft(); return; }
  pv.draft.push(p);
  pv.last = null;
  if ((tool === 'length' || tool === 'calibrate') && pv.draft.length === 2) { finishDraft(); return; }
  renderBar(); applyView();
}

async function finishDraft() {
  const pv = PV;
  const pts = pv.draft.map(r2);
  const tool = pv.tool;
  const enough = { length: 2, path: 2, area: 3, count: 1, calibrate: 2 }[tool] || 99;
  if (pts.length < enough) return;
  pv.draft = [];
  if (tool === 'calibrate') {
    const d = pdist(pts[0], pts[1]);
    if (d < 2) { toast('Those two points are too close together.'); renderBar(); applyView(); return; }
    calibrateDialog(d, pts);
    return;
  }
  const m = {
    id: newId(), fileID: pv.file.id, page: pv.page, type: tool, points: pts, name: '',
    color: MARK_DEFAULT_COLOR[tool], createdAt: stamp(),
  };
  await saveRecord('planMark', m);
  const sc = pageScale(pv.fileID, pv.page);
  pv.last = `${markName(m)}: ${markValue(m, sc?.feetPerPoint)}`;
  renderBar(); applyView();
}

function setTool(tool) {
  const pv = PV;
  pv.tool = tool;
  pv.draft = [];
  pv.selected = null;
  pv.editing = null;
  pv.last = null;
  pv.hover = null;
  renderBar(); applyView();
}

function hitHandle(q, pointerType) {
  const pv = PV;
  const r = pointerType === 'mouse' ? 9 : 24;
  let best = null;
  const consider = (pt, h) => { const d = pdist(toScreen(pt), q); if (d < r && (!best || d < best.d)) best = { ...h, d }; };
  if (pv.tool !== 'move') pv.draft.forEach((pt, i) => consider(pt, { kind: 'draft', i }));
  if (pv.selected) {
    const m = get(pv.selected);
    if (m) (pv.editing?.points || m.points).forEach((pt, i) => consider(pt, { kind: 'mark', id: pv.selected, i }));
  }
  return best;
}

function moveHandle(h, q) {
  const pv = PV;
  let p = clampToPage(toPage(q));
  const list = h.kind === 'draft' ? pv.draft : (pv.editing ||= { id: h.id, points: clone(get(h.id).points) }).points;
  const m = h.kind === 'mark' ? get(h.id) : null;
  if (pv.straight && h.i > 0 && (h.kind === 'draft' ? pv.tool : m?.type) !== 'count') p = snapStraight(list[h.i - 1], p);
  list[h.i] = p;
  renderBar(); applyView();
}

async function commitHandle(h) {
  const pv = PV;
  if (!h || h.kind !== 'mark' || !pv.editing) return;
  const m = clone(get(h.id));
  if (!m) { pv.editing = null; return; }
  m.points = pv.editing.points.map(r2);
  pv.editing = null;
  await saveRecord('planMark', m);
  renderBar(); applyView();
}

function hitMark(q, pointerType) {
  const pv = PV;
  const r = pointerType === 'mouse' ? 7 : 16;
  const marks = planMarks(pv.fileID, pv.page).reverse();
  for (const m of marks) {
    const sp = m.points.map(toScreen);
    if (m.type === 'count' && sp.some((p) => pdist(p, q) < r + 6)) return m;
    if (m.type === 'length' || m.type === 'path' || m.type === 'area') {
      for (let i = 1; i < sp.length; i++) if (segDist(q, sp[i - 1], sp[i]) < r) return m;
      if (m.type === 'area' && sp.length > 2 && (segDist(q, sp[sp.length - 1], sp[0]) < r)) return m;
    }
  }
  for (const m of marks) if (m.type === 'area' && m.points.length > 2 && inside(q, m.points.map(toScreen))) return m;
  return null;
}

// ----- Drawing the measurements

function labelSVG(x, y, text, color) {
  const w = Math.round(text.length * 7.1 + 16);
  return `<g transform="translate(${x.toFixed(1)},${y.toFixed(1)})"><rect x="${-w / 2}" y="-12" width="${w}" height="24" rx="7" fill="rgba(255,255,255,.94)" stroke="${color}" stroke-width="1.5"/><text text-anchor="middle" y="4.5" font-size="13" font-weight="600" fill="#1B1916" font-family="-apple-system,BlinkMacSystemFont,system-ui,sans-serif">${esc(text)}</text></g>`;
}

function markSVG(m, points, fpp, { selected = false, draft = false, noLabel = false } = {}) {
  const c = m.color || MARK_DEFAULT_COLOR[m.type] || MARK_COLORS[0];
  const sp = points.map(toScreen);
  const pl = sp.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const dash = draft ? ' stroke-dasharray="7 5"' : '';
  const width = selected ? 4 : 3;
  let out = '';
  if (m.type === 'count') {
    sp.forEach((p, i) => {
      out += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${selected ? 12 : 11}" fill="${c}" stroke="#fff" stroke-width="2"/><text x="${p[0].toFixed(1)}" y="${(p[1] + 4).toFixed(1)}" text-anchor="middle" font-size="11.5" font-weight="700" fill="#fff" font-family="-apple-system,system-ui,sans-serif">${i + 1}</text>`;
    });
  } else if (m.type === 'area') {
    if (sp.length >= 3) out += `<polygon points="${pl}" fill="${c}" fill-opacity="${selected ? 0.26 : 0.17}" stroke="${c}" stroke-width="${width}" stroke-linejoin="round"${dash}/>`;
    else if (sp.length === 2) out += `<polyline points="${pl}" fill="none" stroke="${c}" stroke-width="${width}"${dash}/>`;
  } else if (sp.length >= 2) {
    out += `<polyline points="${pl}" fill="none" stroke="${c}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`;
    if (m.type === 'length') {
      // Dimension ticks at both ends.
      const [a, b] = [sp[0], sp[sp.length - 1]];
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) + Math.PI / 2;
      const dx = Math.cos(ang) * 8, dy = Math.sin(ang) * 8;
      for (const p of [a, b]) out += `<line x1="${(p[0] - dx).toFixed(1)}" y1="${(p[1] - dy).toFixed(1)}" x2="${(p[0] + dx).toFixed(1)}" y2="${(p[1] + dy).toFixed(1)}" stroke="${c}" stroke-width="${width}" stroke-linecap="round"/>`;
    }
  }
  // Label (left off shapes too small to read at this zoom; zoom in or tap one to see it)
  const xs = sp.map((p) => p[0]), ys = sp.map((p) => p[1]);
  const extent = sp.length ? Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) : 0;
  const tooSmall = !selected && !draft && m.type !== 'count' && extent < 26;
  if (!noLabel && !tooSmall && (!draft || (m.type !== 'count' && points.length >= (m.type === 'area' ? 3 : 2)))) {
    const value = markValue(m, fpp, points);
    const text = !draft && (m.name || '').trim() ? `${m.name.trim()} · ${value}` : value;
    let at = null;
    if (m.type === 'area' && points.length >= 3) at = toScreen(polyCentroid(points));
    else if (m.type === 'count' && sp.length) at = [sp[sp.length - 1][0], sp[sp.length - 1][1] - 26];
    else if (sp.length >= 2) {
      // Over the middle of the longest segment.
      let bi = 1, bl = -1;
      for (let i = 1; i < sp.length; i++) { const l = pdist(sp[i - 1], sp[i]); if (l > bl) { bl = l; bi = i; } }
      const mpt = pmid(sp[bi - 1], sp[bi]);
      at = [mpt[0], mpt[1] - 18];
    }
    if (at && (draft || m.type !== 'count' || selected)) out += labelSVG(at[0], at[1], text, c);
  }
  if (selected || draft) {
    sp.forEach((p, i) => {
      const big = draft && m.type === 'area' && i === 0 && sp.length >= 3;
      out += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${big ? 10 : 7.5}" fill="#fff" stroke="${c}" stroke-width="3"/>`;
    });
  }
  return out;
}

function drawInk() {
  const pv = PV;
  if (!pv?.pageObj) return;
  const sc = pageScale(pv.fileID, pv.page);
  const fpp = sc?.feetPerPoint;
  let out = '';
  for (const m of planMarks(pv.fileID, pv.page)) {
    const editing = pv.editing && sameId(pv.editing.id, m.id) ? pv.editing.points : m.points;
    out += markSVG(m, editing, fpp, { selected: sameId(pv.selected, m.id) });
  }
  if (pv.tool !== 'move' && pv.draft.length) {
    const type = pv.tool === 'calibrate' ? 'length' : pv.tool;
    const color = pv.tool === 'calibrate' ? '#D97706' : MARK_DEFAULT_COLOR[type];
    const pts = [...pv.draft];
    // With a mouse, the next segment follows the pointer.
    if (pv.hover && pv.tool !== 'count') {
      let hp = clampToPage(toPage(pv.hover));
      if (pv.straight) hp = snapStraight(pts[pts.length - 1], hp);
      pts.push(hp);
    }
    out += markSVG({ type, color, name: '' }, pts, fpp, { draft: true, noLabel: pv.tool === 'calibrate' });
  }
  pv.ink.innerHTML = out;
}

// ----- Loupe: a magnified view above your finger while placing a point

function showLoupe(q, pointerType) {
  const pv = PV;
  if (pointerType === 'mouse') return;
  const L = pv.loupe, size = 128, mag = 2.5, dpr = pv.dpr;
  const ctx = L.getContext('2d');
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, L.width, L.height);
  const half = size / mag / 2;
  const fresh = pv.detailView && pv.detailView.s === pv.view.s && pv.detailView.tx === pv.view.tx && pv.detailView.ty === pv.view.ty && pv.detail.style.display !== 'none';
  try {
    if (fresh) ctx.drawImage(pv.detail, (q[0] - half) * dpr, (q[1] - half) * dpr, half * 2 * dpr, half * 2 * dpr, 0, 0, L.width, L.height);
    else {
      const p = toPage(q), bs = pv.baseScale, hp = half / pv.view.s;
      ctx.drawImage(pv.base, (p[0] - hp) * bs, (p[1] - hp) * bs, hp * 2 * bs, hp * 2 * bs, 0, 0, L.width, L.height);
    }
  } catch { /* off the edge */ }
  const c = L.width / 2;
  ctx.strokeStyle = '#B23A26';
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  ctx.moveTo(c, c - 14 * dpr); ctx.lineTo(c, c - 4 * dpr); ctx.moveTo(c, c + 4 * dpr); ctx.lineTo(c, c + 14 * dpr);
  ctx.moveTo(c - 14 * dpr, c); ctx.lineTo(c - 4 * dpr, c); ctx.moveTo(c + 4 * dpr, c); ctx.lineTo(c + 14 * dpr, c);
  ctx.stroke();
  ctx.restore();
  const above = q[1] - size - 46;
  L.style.left = `${Math.min(pv.stageW - size - 6, Math.max(6, q[0] - size / 2))}px`;
  L.style.top = `${above > 6 ? above : q[1] + 46}px`;
  L.style.display = 'block';
}
function hideLoupe() { if (PV) PV.loupe.style.display = 'none'; }

// ----- Bottom bar: tools, or the selected measurement

const TOOL_LIST = [['move', 'Move', 'hand'], ['length', 'Length', 'ruler'], ['path', 'Run', 'run'], ['area', 'Area', 'area'], ['count', 'Count', 'count'], ['scale', 'Scale', 'scale']];

function toolHint(pv, sc) {
  const n = pv.draft.length;
  const fpp = sc?.feetPerPoint;
  switch (pv.tool) {
    case 'length': return pv.last && !n ? `${pv.last}. Tap for another.` : n ? 'Now tap the end.' : 'Tap the start of what you’re measuring.';
    case 'path': return n >= 2 ? `${fpp ? feetText(runLength(pv.draft) * fpp) : 'No scale yet'} so far. Keep tapping, then Done.` : pv.last && !n ? `${pv.last}. Tap to start another.` : 'Tap along the run, point by point.';
    case 'area': return n >= 3 ? `${fpp ? areaText(polyArea(pv.draft) * fpp * fpp) : 'No scale yet'}. Tap the first corner or Done to close.` : pv.last && !n ? `${pv.last}. Tap to start another.` : 'Tap each corner of the area.';
    case 'count': return n ? `${n} counted. Tap each one, then Done.` : pv.last ? `${pv.last}. Tap to start another count.` : 'Tap each one to count it.';
    case 'calibrate': return n ? 'Now tap the other end.' : 'Tap one end of a dimension printed on the drawing.';
    default: return '';
  }
}

function renderBar() {
  const pv = PV;
  const bar = $('#plan-bar');
  if (!pv || !bar) return;
  const sc = pv.pageObj ? pageScale(pv.fileID, pv.page) : null;
  if (pv.pageObj) updateSub();
  const sel = pv.selected ? get(pv.selected) : null;
  if (sel) {
    const pts = pv.editing && sameId(pv.editing.id, sel.id) ? pv.editing.points : sel.points;
    const val = markValue(sel, sc?.feetPerPoint, pts);
    const extra = sel.type === 'area' && sc ? ` · ${feetText(runLength(pts, true) * sc.feetPerPoint)} around` : '';
    bar.innerHTML = `<div class="plan-info">
      <div class="pi-row"><span class="pi-dot" style="background:${esc(sel.color || MARK_DEFAULT_COLOR[sel.type])}"></span>
        <input id="plan-mark-name" class="input" value="${esc(sel.name || '')}" placeholder="${esc(markName({ ...sel, name: '' }))}" aria-label="Name" autocomplete="off">
        <button class="btn sm" data-act="plan-deselect">Done</button></div>
      <div class="pi-row"><div class="pi-value"><b>${esc(val)}</b>${esc(extra)}</div>
        <div class="pi-swatches">${MARK_COLORS.map((c) => `<button class="pi-swatch ${c === sel.color ? 'on' : ''}" style="background:${c}" data-act="plan-color" data-color="${c}" aria-label="Colour"></button>`).join('')}</div>
        <button class="icon-btn danger-ic" data-act="plan-mark-delete" aria-label="Delete">${icon('trash')}</button></div>
      <div class="pi-hint">Drag the white dots to adjust.</div>
    </div>`;
    const input = $('#plan-mark-name');
    let t = null;
    const save = async () => {
      clearTimeout(t);
      const m = get(pv.selected);
      if (!m || (m.name || '') === input.value.trim()) return;
      const c = clone(m); c.name = input.value.trim();
      await saveRecord('planMark', c);
      applyView();
    };
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(save, 600); });
    input.addEventListener('change', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    return;
  }
  const drawing = pv.tool !== 'move';
  const canFinish = { path: 2, area: 3, count: 1 }[pv.tool] && pv.draft.length >= { path: 2, area: 3, count: 1 }[pv.tool];
  const needsScale = !sc && ['length', 'path', 'area'].includes(pv.tool);
  let html = '';
  if (drawing) {
    html += `<div class="plan-help">
      <div class="ph-text">${needsScale ? '<b>No scale on this sheet yet.</b> ' : ''}${esc(toolHint(pv, sc))}</div>
      <div class="ph-btns">
        ${needsScale ? '<button class="btn sm" data-act="plan-tool" data-tool="scale">Set Scale</button>' : ''}
        ${pv.tool !== 'count' ? `<button class="icon-btn ${pv.straight ? 'on' : ''}" data-act="plan-straight" aria-label="Straight lines" aria-pressed="${pv.straight}" title="Straight: level, plumb or 45°">${icon('square')}</button>` : ''}
        ${pv.draft.length ? `<button class="icon-btn" data-act="plan-undo" aria-label="Undo last point">${icon('undo')}</button>` : ''}
        ${canFinish ? '<button class="btn sm primary" data-act="plan-done">Done</button>' : ''}
      </div></div>`;
  }
  html += `<div class="plan-tools" role="toolbar">${TOOL_LIST.map(([t, label, ic]) => `<button class="pt ${pv.tool === t || (t === 'scale' && pv.tool === 'calibrate') ? 'on' : ''}" data-act="plan-tool" data-tool="${t}" ${pv.pageObj ? '' : 'disabled'}>${icon(ic)}<span>${label}</span></button>`).join('')}</div>`;
  bar.innerHTML = html;
}

// ----- Dialogs on top of the drawing

function planDialog(html, onMount) {
  closePlanDialog();
  $('#plan').insertAdjacentHTML('beforeend', `<div class="sheet-backdrop plan-dialog" data-act="plan-dialog-backdrop"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div></div>`);
  onMount?.($('.plan-dialog .sheet'));
}
function closePlanDialog() { $('.plan-dialog')?.remove(); }
const dialogHead = (title, sub = '') => `<div class="sheet-head"><div><h1 style="font-size:20px">${esc(title)}</h1>${sub ? `<div class="sh-sub">${esc(sub)}</div>` : ''}</div><button class="icon-btn" data-act="plan-dialog-close" aria-label="Close">${icon('close')}</button></div>`;

function scaleDialog() {
  const pv = PV;
  const sc = pageScale(pv.fileID, pv.page);
  const size = `${(pv.w / 72).toFixed(1).replace('.0', '')} × ${(pv.h / 72).toFixed(1).replace('.0', '')} in`;
  const chip = ([label, fpi]) => `<button class="${sc && Math.abs(sc.feetPerPoint - fpi / 72) < 1e-9 ? 'on' : ''}" data-act="plan-scale-pick" data-fpi="${fpi}" data-label="${esc(label)}">${esc(label)}</button>`;
  planDialog(`${dialogHead('Drawing Scale', `${sheetLabel(pv, pv.page)} · sheet is ${size}`)}
    <div class="form-section"><div class="form-card" style="padding-bottom:12px">
      <div class="kv" style="padding-top:0"><span>This sheet</span><span>${esc(sc ? sc.scaleLabel || 'Set' : 'Not set')}</span></div>
      <button class="btn primary block" data-act="plan-calibrate">${icon('ruler')}Measure a Known Dimension</button>
      <p class="note">The most reliable way. Tap both ends of a dimension printed on the drawing, like a 12'-0" wall, and type its length.</p>
    </div></div>
    <div class="form-section"><div class="fs-head">Printed scale</div><div class="form-card" style="padding-bottom:6px">
      <div class="chips">${ARCH_SCALES.map(chip).join('')}</div>
      <div class="chips">${ENG_SCALES.map(chip).join('')}</div>
    </div><div class="fs-foot">A printed scale is only right when the PDF is full size. For a half-size set (like 11×17), measure a known dimension instead.</div></div>
    <label class="toggle" style="margin:0 4px 12px">Use for every sheet in this set<input type="checkbox" id="plan-scale-all" ${pv.numPages > 1 ? '' : 'disabled'}></label>`);
}

function calibrateDialog(distPts, pts) {
  const pv = PV;
  planDialog(`${dialogHead('How Long Is That?', sheetLabel(pv, pv.page))}
    <form id="plan-cal-form">
      <div class="form-section"><div class="form-card"><div class="two">
        <label class="field"><span>Feet</span><input name="ft" type="number" inputmode="decimal" min="0" step="any" autofocus></label>
        <label class="field"><span>Inches</span><input name="in" type="number" inputmode="decimal" min="0" step="any" placeholder="0"></label>
      </div></div><div class="fs-foot">Type the dimension as written on the drawing.</div></div>
      <label class="toggle" style="margin:0 4px 12px">Use for every sheet in this set<input type="checkbox" name="all" ${pv.numPages > 1 ? '' : 'disabled'}></label>
      <div class="err-text" id="plan-cal-err"></div>
      <div class="sheet-actions"><button type="button" class="btn" data-act="plan-dialog-close">Cancel</button><button type="submit" class="btn primary">Set Scale</button></div>
    </form>`, (el) => {
    const form = $('#plan-cal-form', el);
    setTimeout(() => form.elements.ft.focus(), 200);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const feet = (Number(form.elements.ft.value) || 0) + (Number(form.elements.in.value) || 0) / 12;
      if (!(feet > 0)) { $('#plan-cal-err').textContent = 'Type the length in feet and inches.'; return; }
      await setScale(feet / distPts, `Measured off ${feetText(feet).replace(' 0"', '')}`, form.elements.all.checked);
      closePlanDialog();
      setTool('move');
      toast('Scale set');
    });
  });
}

async function setScale(feetPerPoint, label, allPages) {
  const pv = PV;
  const pages = allPages ? [...Array(pv.numPages)].map((_, i) => i + 1) : [pv.page];
  for (const page of pages) {
    const existing = planSheets(pv.fileID).filter((r) => r.page === page).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    const rec = existing ? clone(existing) : { id: newId(), fileID: pv.file.id, page };
    rec.feetPerPoint = feetPerPoint;
    rec.scaleLabel = label;
    await saveRecord('planSheet', rec);
  }
  renderBar(); applyView();
}

function sheetsDialog() {
  const pv = PV;
  if (!pv.numPages) return;
  const rows = [...Array(pv.numPages)].map((_, i) => {
    const n = i + 1;
    const sc = pageScale(pv.fileID, n);
    const count = planMarks(pv.fileID, n).length;
    const sub = [sc ? sc.scaleLabel : 'No scale', count ? plural(count, 'measurement') : ''].filter(Boolean).join(' · ');
    return `<button class="row" data-act="plan-goto" data-page="${n}">${icon('pages', 'ic glyph', n === pv.page ? '--tint:var(--forest)' : '--tint:var(--faint)')}
      <div class="main"><div class="t">${esc(sheetLabel(pv, n))}${n === pv.page ? ' <span class="muted small">· showing</span>' : ''}</div><div class="s">${esc(sub)}</div></div>${icon('chev', 'ic chev')}</button>`;
  }).join('');
  planDialog(`${dialogHead('Sheets', `${plural(pv.numPages, 'sheet')} in ${fileTitle(pv.file)}`)}<section class="card flush">${rows}</section>`);
}

function measurementsText(pv) {
  const lines = [`${fileTitle(pv.file)}${project(pv.file.projectID) ? ` — ${projectName(project(pv.file.projectID))}` : ''}`];
  for (let n = 1; n <= pv.numPages; n++) {
    const marks = planMarks(pv.fileID, n);
    if (!marks.length) continue;
    const sc = pageScale(pv.fileID, n);
    lines.push('', `${sheetLabel(pv, n)}${sc ? ` (${sc.scaleLabel})` : ''}`);
    for (const m of marks) lines.push(`  ${markName(m)}: ${markValue(m, sc?.feetPerPoint)}`);
  }
  return lines.join('\n');
}

function listDialog() {
  const pv = PV;
  let total = { len: 0, area: 0, count: 0, unscaled: 0 };
  let body = '';
  for (let n = 1; n <= pv.numPages; n++) {
    const marks = planMarks(pv.fileID, n);
    if (!marks.length) continue;
    const sc = pageScale(pv.fileID, n);
    const fpp = sc?.feetPerPoint;
    body += `<section class="card flush"><div class="card-head"><h2>${esc(sheetLabel(pv, n))}</h2><span class="muted small">${esc(sc ? sc.scaleLabel : 'No scale')}</span></div>`;
    for (const m of marks) {
      if (m.type === 'count') total.count += m.points.length;
      else if (!fpp) total.unscaled++;
      else if (m.type === 'area') total.area += polyArea(m.points) * fpp * fpp;
      else total.len += runLength(m.points) * fpp;
      body += `<button class="row" data-act="plan-goto-mark" data-id="${esc(key(m.id))}" data-page="${n}"><span class="pi-dot" style="background:${esc(m.color || MARK_DEFAULT_COLOR[m.type])}"></span>
        <div class="main"><div class="t">${esc(markName(m))}</div><div class="s">${MARK_TYPES[m.type]}</div></div><span class="end num" style="color:var(--text);font-size:15px">${esc(markValue(m, fpp))}</span></button>`;
    }
    body += '</section>';
  }
  if (!body) {
    planDialog(`${dialogHead('Measurements')}${emptyState('ruler', 'No Measurements Yet', 'Pick Length, Run, Area or Count at the bottom, then tap on the drawing.')}`);
    return;
  }
  const sums = [
    total.len ? ['Lines', feetText(total.len)] : null,
    total.area ? ['Area', areaText(total.area)] : null,
    total.count ? ['Counted', `${total.count} ea`] : null,
  ].filter(Boolean);
  planDialog(`${dialogHead('Measurements', fileTitle(pv.file))}
    ${sums.length ? `<section class="card"><div class="card-head"><h2>All Sheets</h2></div>${sums.map(([l, v]) => `<div class="kv"><span>${l}</span><span class="total-v">${esc(v)}</span></div>`).join('')}
      ${total.unscaled ? `<p class="note">${plural(total.unscaled, 'measurement')} on sheets without a scale ${total.unscaled === 1 ? "isn't" : "aren't"} included.</p>` : ''}</section>` : ''}
    ${body}
    <button class="btn block" data-act="plan-copy">${icon('copy')}Copy as Text</button>
    <p class="note" style="text-align:center">Paste into a message, an estimate or a note.</p>`);
}

function zoomToMark(m) {
  const pv = PV;
  const xs = m.points.map((p) => p[0]), ys = m.points.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const bw = Math.max(maxX - minX, 40), bh = Math.max(maxY - minY, 40);
  const s = clampScale(Math.min(pv.stageW / (bw * 1.8), pv.stageH / (bh * 1.8)));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const saved = pv.view;
  pv.view = { s, tx: pv.stageW / 2 - cx * s, ty: pv.stageH / 2 - cy * s };
  clampView();
  const target = pv.view;
  pv.view = saved;
  animateTo(target);
}

/** Measurements made on another phone show up while the drawing is open. */
function planOnSync() {
  if (!PV?.pageObj) return;
  if (PV.selected && !get(PV.selected)) PV.selected = null;
  renderBar(); applyView();
}

// ----- Actions

Object.assign(ACTIONS, {
  'plan-tool': (el) => {
    const t = el.dataset.tool;
    if (t === 'scale') { scaleDialog(); return; }
    setTool(PV.tool === t && t !== 'move' ? 'move' : t);
  },
  'plan-page': (el) => showPage(PV.page + Number(el.dataset.n)),
  'plan-fit': () => fitView(),
  'plan-sheets': () => sheetsDialog(),
  'plan-list': () => listDialog(),
  'plan-goto': (el) => { closePlanDialog(); if (Number(el.dataset.page) !== PV.page) showPage(Number(el.dataset.page)); },
  'plan-goto-mark': async (el) => {
    closePlanDialog();
    const n = Number(el.dataset.page);
    if (n !== PV.page) await showPage(n);
    const m = get(el.dataset.id);
    if (!m) return;
    setTool('move');
    PV.selected = key(m.id);
    renderBar(); applyView();
    zoomToMark(m);
  },
  'plan-dialog-close': () => closePlanDialog(),
  'plan-dialog-backdrop': (el, e) => { if (e.target === el) closePlanDialog(); },
  'plan-straight': () => { PV.straight = !PV.straight; renderBar(); },
  'plan-undo': () => { PV.draft.pop(); renderBar(); applyView(); },
  'plan-done': () => finishDraft(),
  'plan-deselect': () => { PV.selected = null; renderBar(); applyView(); },
  'plan-color': async (el) => {
    const m = clone(get(PV.selected));
    if (!m) return;
    m.color = el.dataset.color;
    await saveRecord('planMark', m);
    renderBar(); applyView();
  },
  'plan-mark-delete': async () => {
    const m = get(PV.selected);
    if (!m || !confirm(`Delete ${markName(m)}?`)) return;
    await deleteRecord('planMark', m.id);
    PV.selected = null;
    renderBar(); applyView();
  },
  'plan-scale-pick': async (el) => {
    const all = $('#plan-scale-all')?.checked;
    await setScale(Number(el.dataset.fpi) / 72, el.dataset.label, all);
    closePlanDialog();
    toast(all ? `${el.dataset.label} on every sheet` : `Scale set to ${el.dataset.label}`);
  },
  'plan-calibrate': () => { closePlanDialog(); setTool('calibrate'); },
  'plan-copy': async () => {
    const text = measurementsText(PV);
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch {
      if (navigator.share) navigator.share({ text }).catch(() => {});
      else prompt('Copy:', text);
    }
  },
  // A project's drawings: straight to the set, or a choice when there are several.
  plans: (el) => {
    const files = planFiles(el.dataset.project);
    if (files.length === 1) { openPlan(files[0]); return; }
    openSheet(`${sheetHead('Plans', projectName(project(el.dataset.project)))}<section class="card flush">${files.map((f) => {
      const n = planMarkCount(f.id);
      return `<button class="row" data-act="open-file" data-id="${esc(key(f.id))}">${icon('doc', 'ic glyph', '--tint:var(--sage)')}<div class="main"><div class="t">${esc(fileTitle(f))}</div><div class="s">${esc([fmt.date(fileDate(f)), n ? plural(n, 'measurement') : ''].filter(Boolean).join(' · '))}</div></div>${icon('chev', 'ic chev')}</button>`;
    }).join('')}</section>`);
  },
});

/** Drawing sets for a project: Plans & Specs PDFs, newest first. */
function planFiles(projectID) {
  return filesFor('projectID', projectID).filter((f) => f.category === 'plansSpecs' && isPDF(f)).sort((a, b) => (b.documentDate || 0) - (a.documentDate || 0));
}
