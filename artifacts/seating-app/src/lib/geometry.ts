import { RoomLayout, BaselineLayout } from "@workspace/api-client-react";

export const UNIT = 40; // px per seat "slot" (seat + gap), left-right within a row
export const SEAT = 32; // visible seat size
export const STAGE_H = 56;
export const PADDING = 120; // whitespace margin kept around the room in host (pan/zoom) mode
export const POLL_MS = 2500;

export const DEFAULT_LAYOUT: RoomLayout = {
  center: { seats: 8, rows: 10 },
  left: { seats: 7, angleDeg: 15, rows: 10 },
  right: { seats: 7, angleDeg: 15, rows: 10 },
  aisleSlots: 3,
  rowGap: 0.75,
  stageGap: 1.5,
  welcomeLines: [
    { text: '', fontSize: 22, bold: false, italic: false },
    { text: '', fontSize: 16, bold: false, italic: false },
  ],
  colors: { open: '#10b981', unavailable: '#3f4655' },
  gatheringNames: ['First Gathering', 'Second Gathering'],
};

export function seatId(section: string, row: number, idx: number) {
  return `${section}-r${row}-s${idx}`;
}

export function allSeatIds(layout: RoomLayout) {
  const ids: string[] = [];
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

export function buildSeatStatus(layout: RoomLayout, existing: Record<string, string> = {}) {
  const next: Record<string, string> = {};
  allSeatIds(layout).forEach((id) => {
    next[id] = existing[id] || 'open';
  });
  return next;
}

export function countOpen(layout: RoomLayout, seatStatus: Record<string, string>) {
  const ids = allSeatIds(layout);
  const open = ids.filter((id) => seatStatus[id] === 'open').length;
  return { open, total: ids.length };
}

export function computeTotals(layout: RoomLayout, seatStatus: Record<string, string>) {
  const bySection: Record<string, any> = {};
  (['left', 'center', 'right'] as const).forEach((key) => {
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
    filled: 0
  };
  overall.filled = overall.total - overall.open;
  return { overall, bySection };
}

export function computeExtraRows(layout: RoomLayout, baseline?: BaselineLayout | null) {
  const b = baseline || {} as any;
  const diff = (key: 'left'|'center'|'right') => layout[key].rows - (b[key]?.rows ?? layout[key].rows);
  return { left: diff('left'), center: diff('center'), right: diff('right') };
}

export function relativeTime(iso: string | null, nowMs: number) {
  if (!iso) return 'never';
  const diff = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 1000));
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

export function computeGeometry(layout: RoomLayout) {
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

  const rotatePoint = (px: number, py: number, ox: number, oy: number, deg: number) => {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = px - ox;
    const dy = py - oy;
    return { x: ox + dx * cos - dy * sin, y: oy + dx * sin + dy * cos };
  };

  const leftPivot = { x: leftWidth, y: rowsTop }; 
  const leftCorners = [
    { x: 0, y: rowsTop },
    { x: leftWidth, y: rowsTop },
    { x: 0, y: rowsTop + leftRowsHeight },
    { x: leftWidth, y: rowsTop + leftRowsHeight },
  ].map((p) => rotatePoint(p.x, p.y, leftPivot.x, leftPivot.y, layout.left.angleDeg || 0));

  const rightPivot = { x: rightLeft, y: rowsTop }; 
  const rightCorners = [
    { x: rightLeft, y: rowsTop },
    { x: rightLeft + rightWidth, y: rowsTop },
    { x: rightLeft, y: rowsTop + rightRowsHeight },
    { x: rightLeft + rightWidth, y: rowsTop + rightRowsHeight },
  ].map((p) => rotatePoint(p.x, p.y, rightPivot.x, rightPivot.y, -(layout.right.angleDeg || 0)));

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

  const centroid = (pts: {x: number, y: number}[]) => ({
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
