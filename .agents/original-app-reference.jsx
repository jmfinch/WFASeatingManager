import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import { ZoomIn, ZoomOut, Maximize2, Settings, Tv, Hand, Check, RotateCw, Move, History, Archive, Sparkles, Trash2, Loader2, X, Save } from 'lucide-react';

const STORAGE_LAYOUT_KEY = 'room-layout';
const STORAGE_STATE_KEY = 'room-state';
const STORAGE_BASELINE_KEY = 'baseline-layout';
const STORAGE_HISTORY_INDEX_KEY = 'history-index';
const POLL_MS = 2500;

const UNIT = 40; // px per seat "slot" (seat + gap), left-right within a row
const SEAT = 32; // visible seat size
const STAGE_H = 56;
const PADDING = 120; // whitespace margin kept around the room in host (pan/zoom) mode

// Visible marker so it's obvious from the device itself whether you're on the
// latest published version or a stale cached copy — bump this string whenever
// you republish and check that it changed on the actual iPad/TV.
const BUILD_TAG = 'build-2026-08-16-fields-fix';

const DEFAULT_LAYOUT = {
  center: { seats: 8, rows: 10 },
  left: { seats: 7, angleDeg: 15, rows: 10 },
  right: { seats: 7, angleDeg: 15, rows: 10 },
  aisleSlots: 3, // width of each aisle, in seat-slot units
  rowGap: 0.75, // gap between rows, as a fraction of seat size
  stageGap: 1.5, // extra clearance from stage to first row, as a fraction of seat size
  welcomeLines: [
    { text: '', fontSize: 22, bold: false, italic: false },
    { text: '', fontSize: 16, bold: false, italic: false },
  ],
  colors: { open: '#10b981', unavailable: '#3f4655' },
  gatheringNames: ['First Gathering', 'Second Gathering'],
};

// ---------- storage helpers ----------
// Backed by our own Express server (see /server/index.js) instead of Claude's
// artifact-only window.storage API, so this runs as a normal, independently
// hosted web app. Same function names/shapes as before, so the rest of the
// app didn't need to change.
const API_BASE = '/api/storage';

async function kvGet(key) {
  try {
    const res = await fetch(`${API_BASE}/${encodeURIComponent(key)}`);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return await res.json(); // { key, value }
  } catch {
    return null;
  }
}
async function kvSet(key, value) {
  try {
    await fetch(`${API_BASE}/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
  } catch (e) {
    console.error(`save ${key} failed`, e);
  }
}
async function kvDelete(key) {
  try {
    await fetch(`${API_BASE}/${encodeURIComponent(key)}`, { method: 'DELETE' });
  } catch (e) {
    console.error(`delete ${key} failed`, e);
  }
}

async function loadLayout() {
  const res = await kvGet(STORAGE_LAYOUT_KEY);
  return res ? JSON.parse(res.value) : null;
}
async function saveLayout(layout) {
  await kvSet(STORAGE_LAYOUT_KEY, JSON.stringify(layout));
}
async function loadState() {
  const res = await kvGet(STORAGE_STATE_KEY);
  return res ? JSON.parse(res.value) : null;
}
async function saveState(state) {
  await kvSet(STORAGE_STATE_KEY, JSON.stringify(state));
}

// Baseline = each section's "normal" seats/rows. Saved gathering records
// compare their own row counts against this to compute how many extra rows
// were put out that day, automatically, whenever a host changes row counts
// in Setup — no separate manual note needed.
async function loadBaseline() {
  const res = await kvGet(STORAGE_BASELINE_KEY);
  return res ? JSON.parse(res.value) : null;
}
async function saveBaseline(baseline) {
  await kvSet(STORAGE_BASELINE_KEY, JSON.stringify(baseline));
}

async function loadHistoryIndex() {
  const res = await kvGet(STORAGE_HISTORY_INDEX_KEY);
  return res ? JSON.parse(res.value) : [];
}
async function saveHistoryIndex(index) {
  await kvSet(STORAGE_HISTORY_INDEX_KEY, JSON.stringify(index));
}
async function saveHistoryRecord(id, record) {
  await kvSet(`history:${id}`, JSON.stringify(record));
}
async function loadHistoryRecord(id) {
  const res = await kvGet(`history:${id}`);
  return res ? JSON.parse(res.value) : null;
}
async function deleteHistoryRecord(id) {
  await kvDelete(`history:${id}`);
}

function seatId(section, row, idx) {
  return `${section}-r${row}-s${idx}`;
}

function allSeatIds(layout) {
  const ids = [];
  for (let r = 0; r < layout.left.rows; r++) {
    for (let i = 0; i < layout.left.seats; i++) ids.push(seatId('L', r, i));
  }
  for (let r = 0; r < layout.center.rows; r++) {
    for (let i = 0; i < layout.center.seats; i++) ids.push(seatId('C', r, i));
  }
  for (let r = 0; r < layout.right.rows; r++) {
    for (let i = 0; i < layout.right.seats; i++) ids.push(seatId('R', r, i));
  }
  return ids;
}

function buildSeatStatus(layout, existing = {}) {
  const next = {};
  allSeatIds(layout).forEach((id) => {
    next[id] = existing[id] || 'open';
  });
  return next;
}

function countOpen(layout, seatStatus) {
  const ids = allSeatIds(layout);
  const open = ids.filter((id) => seatStatus[id] === 'open').length;
  return { open, total: ids.length };
}

// Per-section + overall fill counts, used both live and when archiving a gathering.
function computeTotals(layout, seatStatus) {
  const bySection = {};
  ['left', 'center', 'right'].forEach((key) => {
    const prefix = key === 'left' ? 'L' : key === 'center' ? 'C' : 'R';
    const section = layout[key];
    let open = 0;
    let total = 0;
    for (let r = 0; r < section.rows; r++) {
      for (let i = 0; i < section.seats; i++) {
        total++;
        if ((seatStatus[seatId(prefix, r, i)] || 'open') === 'open') open++;
      }
    }
    bySection[key] = { open, total, filled: total - open };
  });
  const overall = {
    open: bySection.left.open + bySection.center.open + bySection.right.open,
    total: bySection.left.total + bySection.center.total + bySection.right.total,
  };
  overall.filled = overall.total - overall.open;
  return { overall, bySection };
}

// Extra rows put out today vs. the saved baseline (positive = added, negative
// = fewer than normal). Baseline is optional — if none is saved yet, every
// section reads as 0 extra.
function computeExtraRows(layout, baseline) {
  const b = baseline || {};
  const diff = (key) => layout[key].rows - (b[key]?.rows ?? layout[key].rows);
  return { left: diff('left'), center: diff('center'), right: diff('right') };
}

function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD, local-ish is fine for a weekly cadence
}

function relativeTime(iso, nowMs) {
  if (!iso) return 'never';
  const diff = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 1000));
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

// ---------- room geometry (shared by canvas, pan/zoom, and TV auto-fit) ----------
function computeGeometry(layout) {
  const rowGap = layout.rowGap ?? DEFAULT_LAYOUT.rowGap;
  const stageGap = layout.stageGap ?? DEFAULT_LAYOUT.stageGap;
  const rowH = SEAT * (1 + rowGap);
  const stageClearance = SEAT * stageGap;

  const leftWidth = layout.left.seats * UNIT;
  const centerWidth = layout.center.seats * UNIT;
  const rightWidth = layout.right.seats * UNIT;
  const aisle = layout.aisleSlots * UNIT;

  const leftRowsHeight = layout.left.rows * rowH;
  const centerRowsHeight = layout.center.rows * rowH;
  const rightRowsHeight = layout.right.rows * rowH;

  const centerLeft = leftWidth + aisle;
  const rightLeft = centerLeft + centerWidth + aisle;
  const rowsTop = STAGE_H + stageClearance;

  const rotatePoint = (px, py, ox, oy, deg) => {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = px - ox;
    const dy = py - oy;
    return { x: ox + dx * cos - dy * sin, y: oy + dx * sin + dy * cos };
  };

  // Corners of each section's box BEFORE rotation, rotated around its actual
  // CSS transform-origin. This finds the true bounding box (angled sections
  // swing outside their unrotated rectangle) instead of assuming one. Each
  // section can now have its own row count/depth.
  const leftPivot = { x: leftWidth, y: rowsTop }; // top right
  const leftCorners = [
    { x: 0, y: rowsTop },
    { x: leftWidth, y: rowsTop },
    { x: 0, y: rowsTop + leftRowsHeight },
    { x: leftWidth, y: rowsTop + leftRowsHeight },
  ].map((p) => rotatePoint(p.x, p.y, leftPivot.x, leftPivot.y, layout.left.angleDeg));

  const rightPivot = { x: rightLeft, y: rowsTop }; // top left
  const rightCorners = [
    { x: rightLeft, y: rowsTop },
    { x: rightLeft + rightWidth, y: rowsTop },
    { x: rightLeft, y: rowsTop + rightRowsHeight },
    { x: rightLeft + rightWidth, y: rowsTop + rightRowsHeight },
  ].map((p) => rotatePoint(p.x, p.y, rightPivot.x, rightPivot.y, -layout.right.angleDeg));

  const centerCorners = [
    { x: centerLeft, y: rowsTop },
    { x: centerLeft + centerWidth, y: rowsTop },
    { x: centerLeft, y: rowsTop + centerRowsHeight },
    { x: centerLeft + centerWidth, y: rowsTop + centerRowsHeight },
  ];

  const stageCorners = [
    { x: centerLeft, y: 0 },
    { x: centerLeft + centerWidth, y: 0 },
    { x: centerLeft, y: STAGE_H - 16 },
    { x: centerLeft + centerWidth, y: STAGE_H - 16 },
  ];

  const allPoints = [...leftCorners, ...centerCorners, ...rightCorners, ...stageCorners];
  const minX = Math.min(...allPoints.map((p) => p.x));
  const maxX = Math.max(...allPoints.map((p) => p.x));
  const minY = Math.min(...allPoints.map((p) => p.y));
  const maxY = Math.max(...allPoints.map((p) => p.y));

  const offsetX = -minX;
  const offsetY = -minY;
  const totalWidth = maxX - minX;
  const totalHeight = maxY - minY;

  const centroid = (pts) => ({
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length + offsetX,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length + offsetY,
  });

  return {
    rowH,
    stageClearance,
    leftWidth,
    centerWidth,
    rightWidth,
    aisle,
    leftRowsHeight,
    centerRowsHeight,
    rightRowsHeight,
    rowsTop,
    centerLeft,
    rightLeft,
    totalWidth,
    totalHeight,
    offsetX,
    offsetY,
    sections: {
      left: centroid(leftCorners),
      center: centroid(centerCorners),
      right: centroid(rightCorners),
    },
  };
}

// ---------- Setup screen ----------
// Defined at module scope (not inside SetupScreen) so it keeps a stable
// identity across re-renders. When a component like this is defined inside
// another component's body, React treats it as a brand-new component type on
// every re-render (e.g. every keystroke) and unmounts/remounts the actual
// <input> DOM node — which is what was yanking focus and dismissing the
// iPad's keyboard immediately after it appeared. Also adds real +/- tap
// targets, since Safari on iOS never renders native number-input spinners
// (on this app or any site) — they were never actually there to click.
function Field({ label, value, onChange, min = 0, max = 60, step = 1, suffix }) {
  const setTo = (n) => {
    const clamped = Math.min(max, Math.max(min, n));
    onChange({ target: { value: String(clamped) } });
  };
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-slate-400">{label}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setTo((Number(value) || 0) - step)}
          className="w-9 h-9 shrink-0 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-lg leading-none flex items-center justify-center"
          aria-label={`Decrease ${label}`}
        >
          −
        </button>
        <input
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={onChange}
          className="bg-slate-800 rounded-lg px-3 py-2 w-16 text-center outline-none focus:ring-1 focus:ring-emerald-500"
        />
        <button
          type="button"
          onClick={() => setTo((Number(value) || 0) + step)}
          className="w-9 h-9 shrink-0 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-lg leading-none flex items-center justify-center"
          aria-label={`Increase ${label}`}
        >
          +
        </button>
        {suffix && <span className="text-slate-500 text-xs">{suffix}</span>}
      </div>
    </label>
  );
}

function SetupScreen({ layout, baseline, onSave, onSetBaseline, onCancel, hasExisting }) {
  const [form, setForm] = useState(() => ({
    centerSeats: layout?.center?.seats ?? DEFAULT_LAYOUT.center.seats,
    centerRows: layout?.center?.rows ?? DEFAULT_LAYOUT.center.rows,
    leftSeats: layout?.left?.seats ?? DEFAULT_LAYOUT.left.seats,
    leftRows: layout?.left?.rows ?? DEFAULT_LAYOUT.left.rows,
    rightSeats: layout?.right?.seats ?? DEFAULT_LAYOUT.right.seats,
    rightRows: layout?.right?.rows ?? DEFAULT_LAYOUT.right.rows,
    leftAngle: layout?.left?.angleDeg ?? DEFAULT_LAYOUT.left.angleDeg,
    rightAngle: layout?.right?.angleDeg ?? DEFAULT_LAYOUT.right.angleDeg,
    aisleSlots: layout?.aisleSlots ?? DEFAULT_LAYOUT.aisleSlots,
    rowGap: layout?.rowGap ?? DEFAULT_LAYOUT.rowGap,
    stageGap: layout?.stageGap ?? DEFAULT_LAYOUT.stageGap,
    welcomeLines: layout?.welcomeLines
      ? layout.welcomeLines.map((l) => ({ ...l }))
      : DEFAULT_LAYOUT.welcomeLines.map((l) => ({ ...l })),
    openColor: layout?.colors?.open ?? DEFAULT_LAYOUT.colors.open,
    unavailableColor: layout?.colors?.unavailable ?? DEFAULT_LAYOUT.colors.unavailable,
    gatheringNames: layout?.gatheringNames ? [...layout.gatheringNames] : [...DEFAULT_LAYOUT.gatheringNames],
  }));

  const set = (key) => (e) => {
    const v = Number(e.target.value);
    setForm((f) => ({ ...f, [key]: Number.isFinite(v) ? v : 0 }));
  };

  const updateLine = (idx, patch) =>
    setForm((f) => ({
      ...f,
      welcomeLines: f.welcomeLines.map((l, i) => (i === idx ? { ...l, ...patch } : l)),
    }));

  const updateGatheringName = (idx, value) =>
    setForm((f) => ({
      ...f,
      gatheringNames: f.gatheringNames.map((n, i) => (i === idx ? value : n)),
    }));

  const save = () => {
    onSave({
      center: { seats: Math.max(0, form.centerSeats), rows: Math.max(1, form.centerRows) },
      left: { seats: Math.max(0, form.leftSeats), rows: Math.max(1, form.leftRows), angleDeg: form.leftAngle },
      right: { seats: Math.max(0, form.rightSeats), rows: Math.max(1, form.rightRows), angleDeg: form.rightAngle },
      aisleSlots: Math.max(0, form.aisleSlots),
      rowGap: Math.max(0, form.rowGap),
      stageGap: Math.max(0, form.stageGap),
      welcomeLines: form.welcomeLines,
      colors: { open: form.openColor, unavailable: form.unavailableColor },
      gatheringNames: form.gatheringNames,
    });
  };

  const setAsBaseline = () => {
    onSetBaseline({
      left: { rows: Math.max(1, form.leftRows) },
      center: { rows: Math.max(1, form.centerRows) },
      right: { rows: Math.max(1, form.rightRows) },
    });
  };

  const baselineDiffers =
    baseline &&
    (baseline.left?.rows !== form.leftRows || baseline.center?.rows !== form.centerRows || baseline.right?.rows !== form.rightRows);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 sm:p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-semibold tracking-tight mb-1">Room layout</h1>
        <p className="text-slate-500 text-xs mb-2">{BUILD_TAG}</p>
        <p className="text-slate-400 text-sm mb-6">
          Matches a 3-section room: straight center section, with the two outer sections angled
          inward. Front row lines up across all three sections — each section can have its own
          number of rows and seats per row.
        </p>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-6">
          <div className="grid grid-cols-3 gap-4">
            <Field label="Left rows" value={form.leftRows} onChange={set('leftRows')} min={1} max={40} />
            <Field label="Center rows" value={form.centerRows} onChange={set('centerRows')} min={1} max={40} />
            <Field label="Right rows" value={form.rightRows} onChange={set('rightRows')} min={1} max={40} />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <Field label="Left seats / row" value={form.leftSeats} onChange={set('leftSeats')} />
            <Field label="Center seats / row" value={form.centerSeats} onChange={set('centerSeats')} />
            <Field label="Right seats / row" value={form.rightSeats} onChange={set('rightSeats')} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Left angle (inward)" value={form.leftAngle} onChange={set('leftAngle')} min={0} max={45} suffix="degrees" />
            <Field label="Right angle (inward)" value={form.rightAngle} onChange={set('rightAngle')} min={0} max={45} suffix="degrees" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Aisle width" value={form.aisleSlots} onChange={set('aisleSlots')} min={0} max={10} suffix="seat-widths (~6ft ≈ 3)" />
            <Field label="Row spacing" value={form.rowGap} onChange={set('rowGap')} min={0} max={2} step={0.25} suffix="× seat depth (0.5–1 typical)" />
          </div>
          <Field label="Stage clearance" value={form.stageGap} onChange={set('stageGap')} min={0} max={5} step={0.25} suffix="× seat depth, front row to stage" />

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-slate-400">Welcome message — shown on the TV, below the header</span>
          </label>
          <div className="space-y-2">
            {form.welcomeLines.map((line, idx) => (
              <div key={idx} className="flex flex-wrap items-center gap-2 bg-slate-800/60 rounded-lg p-2.5">
                <input
                  type="text"
                  value={line.text}
                  onChange={(e) => updateLine(idx, { text: e.target.value })}
                  placeholder={idx === 0 ? 'Line 1 — e.g. Welcome to ...' : 'Line 2 — optional'}
                  className="flex-1 min-w-[180px] bg-slate-900 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-emerald-500"
                />
                <select
                  value={line.fontSize}
                  onChange={(e) => updateLine(idx, { fontSize: Number(e.target.value) })}
                  className="bg-slate-900 rounded-lg px-2 py-2 text-sm outline-none focus:ring-1 focus:ring-emerald-500"
                >
                  <option value={16}>Small</option>
                  <option value={20}>Medium</option>
                  <option value={26}>Large</option>
                  <option value={34}>X-Large</option>
                </select>
                <button
                  type="button"
                  onClick={() => updateLine(idx, { bold: !line.bold })}
                  className={`w-9 h-9 rounded-lg font-bold text-sm ${
                    line.bold ? 'bg-emerald-600 text-white' : 'bg-slate-900 text-slate-300'
                  }`}
                >
                  B
                </button>
                <button
                  type="button"
                  onClick={() => updateLine(idx, { italic: !line.italic })}
                  className={`w-9 h-9 rounded-lg italic text-sm ${
                    line.italic ? 'bg-emerald-600 text-white' : 'bg-slate-900 text-slate-300'
                  }`}
                >
                  I
                </button>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-slate-400">Open seat color</span>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={form.openColor}
                  onChange={(e) => setForm((f) => ({ ...f, openColor: e.target.value }))}
                  className="h-10 w-14 bg-slate-800 rounded-lg cursor-pointer"
                />
                <span className="text-slate-500 text-xs">{form.openColor}</span>
              </div>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-slate-400">Unavailable seat color</span>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={form.unavailableColor}
                  onChange={(e) => setForm((f) => ({ ...f, unavailableColor: e.target.value }))}
                  className="h-10 w-14 bg-slate-800 rounded-lg cursor-pointer"
                />
                <span className="text-slate-500 text-xs">{form.unavailableColor}</span>
              </div>
            </label>
          </div>

          <label className="flex flex-col gap-2 text-sm">
            <span className="text-slate-400">Gathering names (used when saving history)</span>
            <div className="grid grid-cols-2 gap-3">
              {form.gatheringNames.map((name, idx) => (
                <input
                  key={idx}
                  type="text"
                  value={name}
                  onChange={(e) => updateGatheringName(idx, e.target.value)}
                  className="bg-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-emerald-500"
                />
              ))}
            </div>
          </label>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mt-4">
          <div className="text-sm text-slate-400 mb-2">Baseline (normal) row counts</div>
          {baseline ? (
            <div className="text-sm text-slate-300 mb-3">
              Left {baseline.left?.rows ?? '—'} · Center {baseline.center?.rows ?? '—'} · Right {baseline.right?.rows ?? '—'}
              {baselineDiffers && <span className="text-amber-400 ml-2">(today's counts differ — that's fine, this is how extra rows get tracked)</span>}
            </div>
          ) : (
            <div className="text-sm text-slate-500 mb-3">Not set yet — using today's row counts won't be compared against anything until you set a baseline.</div>
          )}
          <button
            onClick={setAsBaseline}
            className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-2 rounded-lg"
          >
            Set current row counts as baseline
          </button>
        </div>

        <div className="mt-6 flex items-center justify-between">
          {hasExisting ? (
            <button onClick={onCancel} className="text-slate-400 hover:text-slate-200 text-sm">
              Cancel
            </button>
          ) : (
            <span />
          )}
          <button
            onClick={save}
            className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-5 py-2.5 rounded-lg flex items-center gap-2"
          >
            <Check size={18} /> Save layout
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Room canvas (the spatially accurate seat map) ----------
function RoomCanvas({ layout, geometry, seatStatus, editable, onToggleSeat }) {
  const { rowH, stageClearance, leftWidth, centerWidth, centerLeft, rightLeft, totalWidth, totalHeight, offsetX, offsetY } =
    geometry;
  const colors = layout.colors ?? DEFAULT_LAYOUT.colors;

  const renderSection = (key, seatsPerRow, rowCount, left, rotateDeg, origin) => {
    const rows = [];
    for (let r = 0; r < rowCount; r++) {
      const seats = [];
      for (let i = 0; i < seatsPerRow; i++) {
        const id = seatId(key, r, i);
        const status = seatStatus[id] || 'open';
        seats.push(
          <button
            key={id}
            disabled={!editable}
            onClick={() => editable && onToggleSeat(id)}
            title={id}
            style={{
              width: SEAT,
              height: SEAT,
              marginRight: UNIT - SEAT,
              backgroundColor: status === 'open' ? colors.open : colors.unavailable,
            }}
            className={`relative rounded-t-md rounded-b-sm shrink-0 ${editable ? 'active:scale-90' : ''}`}
          >
            <span
              style={{ background: 'rgba(255,255,255,0.35)' }}
              className="absolute top-0.5 left-1 right-1 h-1 rounded-full"
            />
          </button>
        );
      }
      rows.push(
        <div key={r} style={{ height: rowH, display: 'flex', alignItems: 'center' }}>
          {seats}
        </div>
      );
    }
    return (
      <div
        style={{
          position: 'absolute',
          left: left + offsetX,
          top: STAGE_H + stageClearance + offsetY,
          width: seatsPerRow * UNIT,
          transform: `rotate(${rotateDeg}deg)`,
          transformOrigin: origin,
        }}
      >
        {rows}
      </div>
    );
  };

  return (
    <div style={{ position: 'relative', width: totalWidth, height: totalHeight }}>
      <div
        style={{
          position: 'absolute',
          left: centerLeft + offsetX,
          top: 0 + offsetY,
          width: centerWidth,
          height: STAGE_H - 16,
        }}
        className="bg-slate-800/70 border border-slate-700 rounded-md flex items-center justify-center text-slate-400 text-xs tracking-widest uppercase"
      >
        Stage
      </div>

      {renderSection('L', layout.left.seats, layout.left.rows, 0, layout.left.angleDeg, 'top right')}
      {renderSection('C', layout.center.seats, layout.center.rows, centerLeft, 0, 'top left')}
      {renderSection('R', layout.right.seats, layout.right.rows, rightLeft, -layout.right.angleDeg, 'top left')}
    </div>
  );
}

function Legend({ dense, colors }) {
  const c = colors ?? DEFAULT_LAYOUT.colors;
  return (
    <div className={`flex items-center gap-4 ${dense ? 'text-xs text-slate-400' : 'text-sm text-slate-300'}`}>
      <div className="flex items-center gap-1.5">
        <span style={{ backgroundColor: c.open }} className="w-3.5 h-3.5 rounded-sm inline-block" /> Open
      </div>
      <div className="flex items-center gap-1.5">
        <span style={{ backgroundColor: c.unavailable }} className="w-3.5 h-3.5 rounded-sm inline-block" /> Unavailable
      </div>
    </div>
  );
}

// ---------- Pan/zoom wrapper for Host mode: drag to move, pinch to zoom, section snap buttons ----------
function ZoomPane({ children, geometry, initialScale = 0.9 }) {
  const [scale, setScale] = useState(initialScale);
  const scrollRef = useRef(null);
  const pointers = useRef(new Map());
  const startPos = useRef(new Map());
  const panRef = useRef({ x: 0, y: 0 });
  const pinchRef = useRef({ dist: 0, scale: 1 });
  const draggingRef = useRef(false);
  const rafRef = useRef(null);
  const pendingDelta = useRef({ dx: 0, dy: 0 });
  const markerRefs = useRef({});
  const focusKeyRef = useRef(null);
  const [focusToken, setFocusToken] = useState(0);

  const DRAG_THRESHOLD = 6;

  const clampScale = (s) => Math.min(3, Math.max(0.3, s));
  const zoomIn = () => setScale((s) => clampScale(+(s + 0.2).toFixed(2)));
  const zoomOut = () => setScale((s) => clampScale(+(s - 0.2).toFixed(2)));
  const reset = () => setScale(initialScale);

  const dist = (pts) => {
    const [a, b] = pts;
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  // Coalesces however many pointermove events fired since the last frame into
  // a single scroll update, instead of moving scrollLeft/scrollTop on every
  // raw touch event (which forces a layout recalculation each time and is
  // what caused the choppy single-finger panning).
  const flushPan = () => {
    rafRef.current = null;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft -= pendingDelta.current.dx;
    el.scrollTop -= pendingDelta.current.dy;
    pendingDelta.current = { dx: 0, dy: 0 };
  };

  const onPointerDown = (e) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    startPos.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      draggingRef.current = true; // a second finger always means a gesture, never a seat tap
      try {
        scrollRef.current.setPointerCapture(e.pointerId);
      } catch {}
      const pts = Array.from(pointers.current.values());
      pinchRef.current = { dist: dist(pts), scale };
    } else if (e.pointerType === 'mouse') {
      // Touch panning is handled natively by the browser (see touchAction below) —
      // it's smoother than anything we can do by hand-mutating scrollLeft. Only
      // mouse click-drag needs our own logic, since there's no native gesture for it.
      panRef.current = { x: e.clientX, y: e.clientY };
    }
  };

  const onPointerMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const el = scrollRef.current;
    if (pointers.current.size === 2) {
      const pts = Array.from(pointers.current.values());
      const d = dist(pts);
      if (pinchRef.current.dist > 0) {
        setScale(clampScale(pinchRef.current.scale * (d / pinchRef.current.dist)));
      }
    } else if (e.pointerType === 'mouse' && pointers.current.size === 1) {
      const start = startPos.current.get(e.pointerId);
      const moved = start ? Math.hypot(e.clientX - start.x, e.clientY - start.y) : 0;
      if (!draggingRef.current && moved > DRAG_THRESHOLD) {
        draggingRef.current = true;
        try {
          scrollRef.current.setPointerCapture(e.pointerId);
        } catch {}
        el.style.cursor = 'grabbing';
      }
      if (draggingRef.current) {
        pendingDelta.current.dx += e.clientX - panRef.current.x;
        pendingDelta.current.dy += e.clientY - panRef.current.y;
        if (!rafRef.current) rafRef.current = requestAnimationFrame(flushPan);
      }
      panRef.current = { x: e.clientX, y: e.clientY };
    }
    // single-finger touch: intentionally a no-op here — native scrolling handles it
  };

  const endPointer = (e) => {
    pointers.current.delete(e.pointerId);
    startPos.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      draggingRef.current = false;
      if (scrollRef.current) scrollRef.current.style.cursor = 'grab';
    } else if (pointers.current.size === 1) {
      const [pt] = Array.from(pointers.current.values());
      panRef.current = { x: pt.x, y: pt.y };
    }
  };

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const onWheel = (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setScale((s) => clampScale(+(s - e.deltaY * 0.001).toFixed(2)));
    }
  };

  const runFocus = (key, targetScale) => {
    focusKeyRef.current = key;
    setScale(clampScale(targetScale));
    setFocusToken((t) => t + 1); // always changes, so the effect below always runs even if scale didn't
  };

  const focusFull = () => {
    const el = scrollRef.current;
    if (!el || !geometry) return;
    const s = clampScale(
      Math.min(
        el.clientWidth / (geometry.totalWidth + PADDING * 2),
        el.clientHeight / (geometry.totalHeight + PADDING * 2)
      )
    );
    runFocus('full', s);
  };

  // Runs after React has committed the new `scale` to the DOM (and thus resized
  // the scrollable content). Uses the browser's own scrollIntoView centering
  // rather than hand-computed offsets, so it's correct regardless of exactly
  // how the zoomed content is sized.
  useLayoutEffect(() => {
    const key = focusKeyRef.current;
    if (key) {
      const marker = markerRefs.current[key];
      if (marker && marker.scrollIntoView) {
        marker.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      }
      focusKeyRef.current = null;
    }
  }, [focusToken]);

  const contentWidth = geometry ? geometry.totalWidth + PADDING * 2 : 0;
  const contentHeight = geometry ? geometry.totalHeight + PADDING * 2 : 0;

  return (
    <div className="relative">
      <div className="sticky top-0 z-10 flex flex-wrap justify-between items-center gap-2 mb-2 bg-slate-950/90 backdrop-blur py-2">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={focusFull} className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-lg">
            View Full Room
          </button>
          <span className="text-slate-600 text-xs flex items-center gap-1 ml-1">
            <Move size={13} /> drag to move · pinch/⌘+scroll to zoom
          </span>
        </div>
        <div className="flex gap-2">
          <button onClick={zoomOut} className="bg-slate-800 hover:bg-slate-700 p-2 rounded-lg text-slate-200">
            <ZoomOut size={18} />
          </button>
          <button onClick={reset} className="bg-slate-800 hover:bg-slate-700 p-2 rounded-lg text-slate-200">
            <Maximize2 size={18} />
          </button>
          <button onClick={zoomIn} className="bg-slate-800 hover:bg-slate-700 p-2 rounded-lg text-slate-200">
            <ZoomIn size={18} />
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onPointerLeave={endPointer}
        onWheel={onWheel}
        className="overflow-auto border border-slate-900 rounded-lg"
        style={{ maxHeight: '70vh', touchAction: 'pan-x pan-y', cursor: 'grab' }}
      >
        <div style={{ width: contentWidth * scale, height: contentHeight * scale }}>
          <div
            style={{
              width: contentWidth,
              height: contentHeight,
              padding: PADDING,
              boxSizing: 'border-box',
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              position: 'relative',
            }}
          >
            {children}
            {geometry && (
              <span
                ref={(el) => (markerRefs.current.full = el)}
                style={{ position: 'absolute', left: contentWidth / 2, top: contentHeight / 2, width: 1, height: 1 }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- TV Display: auto-fits the whole room to the screen, no scrolling needed ----------
const DISPLAY_MARGIN_X = 70; // reserved whitespace outside the seats, left and right

function DisplayScreen({ layout, geometry, seatStatus, lastUpdated, now, stale, open, total, onSwitchHost }) {
  const containerRef = useRef(null);
  const [fitScale, setFitScale] = useState(0.5);
  const colors = layout.colors ?? DEFAULT_LAYOUT.colors;
  const lines = (layout.welcomeLines ?? []).filter((l) => l.text && l.text.trim());

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !geometry) return;
    const compute = () => {
      const availW = Math.max(50, el.clientWidth - DISPLAY_MARGIN_X * 2);
      const s = Math.min(availW / geometry.totalWidth, el.clientHeight / geometry.totalHeight);
      setFitScale(Math.max(0.1, s));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [geometry?.totalWidth, geometry?.totalHeight]);

  return (
    <div className="h-screen w-screen bg-slate-950 text-slate-100 flex flex-col overflow-hidden">
      <div className="flex items-start justify-between px-10 py-4 shrink-0">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Seating Availability</h1>
          <div className={`mt-1 text-sm ${stale ? 'text-amber-400' : 'text-slate-400'}`}>
            {stale ? '⚠ No recent updates — ' : 'Updated '}
            {relativeTime(lastUpdated, now)}
          </div>
        </div>
        <div className="flex items-center gap-10">
          <Legend colors={colors} />
          <div className="text-right">
            <div className="text-5xl font-bold text-emerald-400 leading-none">{open}</div>
            <div className="text-slate-400 text-sm mt-1">seats open of {total}</div>
          </div>
        </div>
      </div>
      {lines.length > 0 && (
        <div className="text-center px-10 pb-3 shrink-0 space-y-1">
          {lines.map((l, i) => (
            <div
              key={i}
              style={{ fontSize: l.fontSize, fontWeight: l.bold ? 700 : 400, fontStyle: l.italic ? 'italic' : 'normal' }}
              className="text-slate-200"
            >
              {l.text}
            </div>
          ))}
        </div>
      )}
      <div ref={containerRef} className="flex-1 min-h-0 flex items-center justify-center pb-8">
        {geometry && (
          <div style={{ width: geometry.totalWidth * fitScale, height: geometry.totalHeight * fitScale }}>
            <div style={{ transform: `scale(${fitScale})`, transformOrigin: 'top left' }}>
              <RoomCanvas layout={layout} geometry={geometry} seatStatus={seatStatus} editable={false} onToggleSeat={() => {}} />
            </div>
          </div>
        )}
      </div>
      <button
        onClick={onSwitchHost}
        className="fixed bottom-4 right-4 bg-slate-900/80 hover:bg-slate-800 text-slate-500 hover:text-slate-300 p-2.5 rounded-full"
        aria-label="Switch to host controls"
      >
        <Hand size={16} />
      </button>
    </div>
  );
}

function usePortraitWarning() {
  const [portrait, setPortrait] = useState(
    typeof window !== 'undefined' ? window.innerHeight > window.innerWidth : false
  );
  useEffect(() => {
    const onResize = () => setPortrait(window.innerHeight > window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return portrait;
}

// ---------- History: archived gatherings + on-demand AI analysis ----------
// Goes through our own server (see /server/index.js), which holds the real
// Anthropic API key as a Replit Secret and never exposes it to the browser —
// unlike calling api.anthropic.com directly, which only worked inside a
// Claude artifact's own sandboxed proxy.
async function callClaudeForAnalysis(prompt) {
  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  const data = await response.json();
  if (!response.ok) {
    const msg = data?.error?.message || data?.error || `Request failed (${response.status})`;
    throw new Error(msg);
  }
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function buildSingleRecordPrompt(record) {
  const t = record.totals;
  const trimmedEvents = (record.events || []).slice(0, 400); // keep prompt size reasonable
  return `You are analyzing seat-utilization data for one gathering at a church auditorium with 3 seating sections (Left, Center, Right).

Date: ${record.date}
Gathering: ${record.gathering}
Overall: ${t.overall.filled} filled of ${t.overall.total} seats (${Math.round((t.overall.filled / Math.max(1, t.overall.total)) * 100)}%)
Left section: ${t.bySection.left.filled}/${t.bySection.left.total} filled
Center section: ${t.bySection.center.filled}/${t.bySection.center.total} filled
Right section: ${t.bySection.right.filled}/${t.bySection.right.total} filled
Extra rows vs. normal baseline: Left ${record.extraRows.left >= 0 ? '+' : ''}${record.extraRows.left}, Center ${record.extraRows.center >= 0 ? '+' : ''}${record.extraRows.center}, Right ${record.extraRows.right >= 0 ? '+' : ''}${record.extraRows.right}

Chronological seat-marking events (ISO timestamps, up to 400 shown):
${JSON.stringify(trimmedEvents)}

Give a concise, practical analysis for the person running this room: overall utilization, which section(s) filled fastest or most, whether the extra rows (if any) were the right call, and one or two concrete, specific recommendations for next time. Keep it under 200 words.`;
}

function buildTrendPrompt(records) {
  const lines = records
    .map(
      (r) =>
        `${r.date} — ${r.gathering}: ${r.overallOpen != null ? r.overallTotal - r.overallOpen : '?'}/${r.overallTotal} filled, extra rows L${r.extraRows?.left ?? 0}/C${r.extraRows?.center ?? 0}/R${r.extraRows?.right ?? 0}`
    )
    .join('\n');
  return `You are analyzing seat-utilization trends across multiple gatherings at a church auditorium with 3 seating sections (Left, Center, Right).

Records (date — gathering: filled/total, extra rows put out that day):
${lines}

Give a concise, practical trend analysis for the person who manages this room: is utilization trending up, down, or flat; which gathering or section tends to run fullest; and — based on this data — roughly when they should expect to need more permanent seating (a specific row count if the data supports it, otherwise a reasonable estimate). Keep it under 250 words.`;
}

function HistoryScreen({ onClose }) {
  const [index, setIndex] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadHistoryIndex().then((idx) => setIndex([...idx].sort((a, b) => (a.date < b.date ? 1 : -1))));
  }, []);

  const toggleSelect = (id) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const remove = async (id) => {
    await deleteHistoryRecord(id);
    const newIndex = index.filter((r) => r.id !== id);
    setIndex(newIndex);
    await saveHistoryIndex(newIndex);
    setSelected((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  };

  const analyzeSelected = async () => {
    setError(null);
    setAnalysis(null);
    setAnalyzing(true);
    try {
      const ids = Array.from(selected);
      if (ids.length === 1) {
        const record = await loadHistoryRecord(ids[0]);
        if (!record) throw new Error('Could not load that record.');
        const text = await callClaudeForAnalysis(buildSingleRecordPrompt(record));
        setAnalysis(text);
      } else {
        const records = index.filter((r) => ids.includes(r.id));
        const text = await callClaudeForAnalysis(buildTrendPrompt(records));
        setAnalysis(text);
      }
    } catch (e) {
      setError(e.message || 'Analysis failed. You may need to sign in to Claude to use this.');
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 sm:p-8">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Archive size={22} /> Gathering History
          </h1>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 text-sm flex items-center gap-1">
            <X size={16} /> Close
          </button>
        </div>
        <p className="text-slate-400 text-sm mb-6">
          Every gathering you've submitted is archived here. Select one for a detailed read on that
          gathering, or select several to see trends across them.
        </p>

        {index === null ? (
          <div className="text-slate-500 text-sm">Loading…</div>
        ) : index.length === 0 ? (
          <div className="text-slate-500 text-sm">
            Nothing archived yet — use "Submit Final" on Host Controls at the end of a gathering to start
            building history.
          </div>
        ) : (
          <div className="space-y-2 mb-6">
            {index.map((r) => {
              const pct = r.overallTotal ? Math.round(((r.overallTotal - r.overallOpen) / r.overallTotal) * 100) : 0;
              const extra = r.extraRows || {};
              const extraTotal = (extra.left || 0) + (extra.center || 0) + (extra.right || 0);
              return (
                <div
                  key={r.id}
                  className={`flex items-center gap-3 rounded-lg p-3 border ${
                    selected.has(r.id) ? 'border-emerald-600 bg-emerald-950/30' : 'border-slate-800 bg-slate-900'
                  }`}
                >
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelect(r.id)} className="w-4 h-4" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">
                      {r.date} — {r.gathering}
                    </div>
                    <div className="text-xs text-slate-400">
                      {r.overallTotal - r.overallOpen}/{r.overallTotal} filled ({pct}%)
                      {extraTotal !== 0 && (
                        <span className="text-amber-400 ml-2">
                          extra rows L{extra.left >= 0 ? '+' : ''}
                          {extra.left ?? 0}/C{extra.center >= 0 ? '+' : ''}
                          {extra.center ?? 0}/R{extra.right >= 0 ? '+' : ''}
                          {extra.right ?? 0}
                        </span>
                      )}
                    </div>
                  </div>
                  <button onClick={() => remove(r.id)} className="text-slate-500 hover:text-rose-400 p-1.5" aria-label="Delete record">
                    <Trash2 size={16} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {index && index.length > 0 && (
          <button
            disabled={selected.size === 0 || analyzing}
            onClick={analyzeSelected}
            className="bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-600 text-white font-medium px-5 py-2.5 rounded-lg flex items-center gap-2"
          >
            {analyzing ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}
            {analyzing ? 'Analyzing…' : `Analyze ${selected.size || ''} selected with Claude`}
          </button>
        )}

        {error && (
          <div className="mt-4 bg-rose-950/40 border border-rose-800/50 text-rose-300 text-sm rounded-lg p-4">{error}</div>
        )}

        {analysis && (
          <div className="mt-4 bg-slate-900 border border-slate-800 rounded-xl p-5 text-sm text-slate-200 whitespace-pre-wrap leading-relaxed">
            {analysis}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Main App ----------
export default function App() {
  const [mode, setMode] = useState('host');
  const [layout, setLayout] = useState(null);
  const [seatStatus, setSeatStatus] = useState({});
  const [lastUpdated, setLastUpdated] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [baseline, setBaseline] = useState(null);
  const [showSubmitPicker, setShowSubmitPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const skipNextPoll = useRef(false);
  const portrait = usePortraitWarning();
  const eventLogRef = useRef([]);

  const seatStatusRef = useRef({});
  const saveTimer = useRef(null);
  const pendingIso = useRef(null);

  const applyRemoteStatus = (status, iso) => {
    seatStatusRef.current = status;
    setSeatStatus(status);
    setLastUpdated(iso);
  };

  const refresh = useCallback(async () => {
    if (skipNextPoll.current) {
      skipNextPoll.current = false;
      return;
    }
    const [l, st] = await Promise.all([loadLayout(), loadState()]);
    if (l) setLayout(l);
    if (st) applyRemoteStatus(st.seatStatus || {}, st.lastUpdated || null);
  }, []);

  useEffect(() => {
    (async () => {
      const l = await loadLayout();
      if (!l) {
        setLoading(false);
        setMode('setup');
        return;
      }
      setLayout(l);
      const st = await loadState();
      if (st) {
        applyRemoteStatus(st.seatStatus || {}, st.lastUpdated || null);
      } else {
        applyRemoteStatus(buildSeatStatus(l), null);
      }
      const b = await loadBaseline();
      setBaseline(b);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Every local edit goes through here. It always reads/writes seatStatusRef
  // (never the React state closure), so rapid taps can never race each other
  // based on a stale snapshot. The actual network save is debounced so a
  // burst of taps becomes one save of the true final state, not several
  // competing saves of partial state.
  const saveInFlight = useRef(false);
  const saveQueued = useRef(false);

  // Only ever one save request in flight at a time. If the network is slow
  // and a new save would otherwise overlap with one still in progress, we
  // just remember to re-send once it finishes — always with whatever the
  // ref's current value is *at that later moment*, not a stale queued copy.
  // This is what stops an old, slow-to-complete save from landing after (and
  // silently undoing) a newer one that finished first.
  const flushSave = async () => {
    if (saveInFlight.current) {
      saveQueued.current = true;
      return;
    }
    saveInFlight.current = true;
    saveQueued.current = false;
    try {
      await saveState({ seatStatus: seatStatusRef.current, lastUpdated: pendingIso.current });
    } finally {
      saveInFlight.current = false;
      if (saveQueued.current) flushSave();
    }
  };

  const commitSeatStatus = (updater) => {
    const next = typeof updater === 'function' ? updater(seatStatusRef.current) : updater;
    seatStatusRef.current = next;
    const iso = new Date().toISOString();
    pendingIso.current = iso;
    setSeatStatus(next);
    setLastUpdated(iso);
    skipNextPoll.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSave, 350);
  };

  const toggleSeat = (id) => {
    const cur = seatStatusRef.current[id] || 'open';
    const next = cur === 'open' ? 'full' : 'open';
    eventLogRef.current.push({ t: new Date().toISOString(), type: 'seat', id, from: cur, to: next });
    commitSeatStatus((prev) => ({ ...prev, [id]: next }));
  };

  const markAll = (status) => {
    const ids = allSeatIds(layout);
    eventLogRef.current.push({ t: new Date().toISOString(), type: 'markAll', status, count: ids.length });
    commitSeatStatus((prev) => {
      const patch = {};
      ids.forEach((id) => (patch[id] = status));
      return { ...prev, ...patch };
    });
  };

  const saveNewLayout = async (newLayout) => {
    const mergedStatus = buildSeatStatus(newLayout, seatStatusRef.current);
    setLayout(newLayout);
    const iso = new Date().toISOString();
    skipNextPoll.current = true;
    applyRemoteStatus(mergedStatus, iso);
    await saveLayout(newLayout);
    await saveState({ seatStatus: mergedStatus, lastUpdated: iso });
    setMode('host');
  };

  const setAsBaseline = async (b) => {
    setBaseline(b);
    await saveBaseline(b);
  };

  // Archives the current gathering (final seat state + the full event log
  // since the last submit + totals + extra-rows-vs-baseline) to history, then
  // resets seats to all-open for the next gathering.
  const submitFinal = async (gatheringIdx) => {
    if (!layout) return;
    setSubmitting(true);
    try {
      const totals = computeTotals(layout, seatStatusRef.current);
      const extraRows = computeExtraRows(layout, baseline);
      const gatheringName = (layout.gatheringNames ?? DEFAULT_LAYOUT.gatheringNames)[gatheringIdx] || 'Gathering';
      const date = todayKey();
      const id = `${date}__${gatheringIdx}`;
      const record = {
        id,
        date,
        gathering: gatheringName,
        savedAt: new Date().toISOString(),
        layoutSnapshot: layout,
        seatStatus: seatStatusRef.current,
        totals,
        extraRows,
        events: eventLogRef.current,
      };
      await saveHistoryRecord(id, record);
      const idx = await loadHistoryIndex();
      const summary = {
        id,
        date,
        gathering: gatheringName,
        savedAt: record.savedAt,
        overallOpen: totals.overall.open,
        overallTotal: totals.overall.total,
        extraRows,
      };
      const newIndex = [...idx.filter((r) => r.id !== id), summary];
      await saveHistoryIndex(newIndex);

      eventLogRef.current = [];
      const resetStatus = buildSeatStatus(layout, {});
      commitSeatStatus(() => resetStatus);
      setShowSubmitPicker(false);
    } finally {
      setSubmitting(false);
    }
  };

  const geometry = useMemo(() => (layout ? computeGeometry(layout) : null), [layout]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-500">
        Loading…
      </div>
    );
  }

  if (mode === 'setup') {
    return (
      <SetupScreen
        layout={layout}
        baseline={baseline}
        hasExisting={!!layout}
        onSave={saveNewLayout}
        onSetBaseline={setAsBaseline}
        onCancel={() => setMode('host')}
      />
    );
  }

  if (mode === 'history') {
    return <HistoryScreen onClose={() => setMode('host')} />;
  }

  const { open, total } = layout ? countOpen(layout, seatStatus) : { open: 0, total: 0 };
  const stale = lastUpdated ? now - new Date(lastUpdated).getTime() > 90000 : true;

  if (mode === 'display') {
    return (
      <DisplayScreen
        layout={layout}
        geometry={geometry}
        seatStatus={seatStatus}
        lastUpdated={lastUpdated}
        now={now}
        stale={stale}
        open={open}
        total={total}
        onSwitchHost={() => setMode('host')}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-3 sm:p-6">
      {portrait && (
        <div className="mb-3 bg-amber-900/40 border border-amber-700/50 text-amber-300 text-xs rounded-lg px-3 py-2 flex items-center gap-2">
          <RotateCw size={14} /> Rotate to landscape for the best view of the room.
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Seating — Host Controls</h1>
          <div className="text-slate-500 text-xs mt-0.5 flex items-center gap-3 flex-wrap">
            <span>
              {open} open of {total} · updated {relativeTime(lastUpdated, now)}
            </span>
            <Legend dense colors={layout?.colors ?? DEFAULT_LAYOUT.colors} />
            <span className="text-slate-700">{BUILD_TAG}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => markAll('open')} className="text-xs bg-slate-800 hover:bg-emerald-900 text-emerald-400 px-3 py-2 rounded-lg">
            Mark all open
          </button>
          <button onClick={() => markAll('full')} className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-2 rounded-lg">
            Mark all full
          </button>
          <button
            onClick={() => setShowSubmitPicker(true)}
            className="text-xs bg-emerald-700 hover:bg-emerald-600 text-white px-3 py-2 rounded-lg flex items-center gap-1.5"
          >
            <Save size={14} /> Submit Final
          </button>
          <button onClick={() => setMode('history')} className="bg-slate-800 hover:bg-slate-700 p-2 rounded-lg text-slate-300" aria-label="Gathering history">
            <History size={18} />
          </button>
          <button onClick={() => setMode('setup')} className="bg-slate-800 hover:bg-slate-700 p-2 rounded-lg text-slate-300" aria-label="Edit layout">
            <Settings size={18} />
          </button>
          <button onClick={() => setMode('display')} className="bg-slate-800 hover:bg-slate-700 p-2 rounded-lg text-slate-300" aria-label="Switch to TV display">
            <Tv size={18} />
          </button>
        </div>
      </div>

      {showSubmitPicker && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 max-w-sm w-full">
            <h2 className="text-lg font-semibold mb-1">Submit Final</h2>
            <p className="text-slate-400 text-sm mb-4">
              Which gathering was this? This archives the current seating data and resets the map to
              all-open for the next gathering.
            </p>
            <div className="space-y-2 mb-4">
              {(layout?.gatheringNames ?? DEFAULT_LAYOUT.gatheringNames).map((name, idx) => (
                <button
                  key={idx}
                  disabled={submitting}
                  onClick={() => submitFinal(idx)}
                  className="w-full text-left bg-slate-800 hover:bg-emerald-900 disabled:opacity-50 rounded-lg px-4 py-3 text-sm"
                >
                  {name}
                </button>
              ))}
            </div>
            <button
              disabled={submitting}
              onClick={() => setShowSubmitPicker(false)}
              className="text-slate-400 hover:text-slate-200 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {layout && geometry && (
        <ZoomPane geometry={geometry}>
          <RoomCanvas layout={layout} geometry={geometry} seatStatus={seatStatus} editable={true} onToggleSeat={toggleSeat} />
        </ZoomPane>
      )}
    </div>
  );
}
