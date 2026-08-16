import React, {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
} from 'react';
import { RoomLayout } from '@workspace/api-client-react';
import { STAGE_H, UNIT, SEAT, DEFAULT_LAYOUT, seatId } from '@/lib/geometry';
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';

// ─── RoomCanvas ───────────────────────────────────────────────────────────────

export function RoomCanvas({
  layout,
  geometry,
  seatStatus,
  editable = false,
  onToggleSeat,
}: {
  layout: RoomLayout;
  geometry: ReturnType<typeof import('@/lib/geometry').computeGeometry>;
  seatStatus: Record<string, string>;
  editable?: boolean;
  onToggleSeat?: (id: string) => void;
}) {
  const {
    rowH,
    stageClearance,
    centerLeft,
    centerWidth,
    rightLeft,
    totalWidth,
    totalHeight,
    offsetX,
    offsetY,
  } = geometry;
  const colors = layout.colors ?? DEFAULT_LAYOUT.colors;

  // Per-seat cooldown: prevents a mis-aimed second tap from instantly reverting
  // a seat that was just toggled. 400ms is long enough to avoid accidents while
  // short enough not to feel sluggish during intentional rapid toggling.
  const cooldown = useRef<Record<string, number>>({});
  const COOLDOWN_MS = 400;

  const handleSeatClick = useCallback(
    (id: string) => {
      if (!editable || !onToggleSeat) return;
      const last = cooldown.current[id] ?? 0;
      if (Date.now() - last < COOLDOWN_MS) return;
      cooldown.current[id] = Date.now();
      onToggleSeat(id);
    },
    [editable, onToggleSeat],
  );

  const renderSection = (
    key: string,
    seatsPerRow: number,
    rowCount: number,
    left: number,
    rotateDeg: number,
    origin: string,
  ) => {
    const rows = [];
    for (let r = 0; r < rowCount; r++) {
      const seats = [];
      for (let i = 0; i < seatsPerRow; i++) {
        const id = seatId(key, r, i);
        const status = seatStatus[id] || 'open';
        seats.push(
          <button
            key={id}
            type="button"
            data-testid={`seat-${id}`}
            disabled={!editable}
            onClick={() => handleSeatClick(id)}
            style={{
              width: SEAT,
              height: SEAT,
              marginRight: UNIT - SEAT,
              backgroundColor:
                status === 'open' ? colors.open : colors.unavailable,
            }}
            className={`relative rounded-t-md rounded-b-sm shrink-0 ${
              editable
                ? 'active:scale-90 hover:brightness-110 cursor-pointer'
                : 'cursor-default'
            }`}
          >
            {/* seat-back highlight */}
            <span
              style={{ background: 'rgba(255,255,255,0.35)' }}
              className="absolute top-0.5 left-1 right-1 h-1 rounded-full pointer-events-none"
            />
          </button>,
        );
      }
      rows.push(
        <div
          key={r}
          style={{ height: rowH, display: 'flex', alignItems: 'center' }}
        >
          {seats}
        </div>,
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
      {/* Stage label */}
      <div
        style={{
          position: 'absolute',
          left: centerLeft + offsetX,
          top: 0 + offsetY,
          width: centerWidth,
          height: STAGE_H - 16,
        }}
        className="bg-card border border-border rounded-md flex items-center justify-center text-muted-foreground text-xs tracking-widest uppercase shadow-sm"
      >
        Stage
      </div>

      {renderSection(
        'L',
        layout.left.seats,
        layout.left.rows,
        0,
        layout.left.angleDeg || 0,
        'top right',
      )}
      {renderSection(
        'C',
        layout.center.seats,
        layout.center.rows,
        centerLeft,
        0,
        'top left',
      )}
      {renderSection(
        'R',
        layout.right.seats,
        layout.right.rows,
        rightLeft,
        -(layout.right.angleDeg || 0),
        'top left',
      )}
    </div>
  );
}

// ─── Legend ───────────────────────────────────────────────────────────────────

export function Legend({
  dense,
  colors,
}: {
  dense?: boolean;
  colors?: { open: string; unavailable: string };
}) {
  const c = colors ?? DEFAULT_LAYOUT.colors;
  return (
    <div
      className={`flex items-center gap-4 ${
        dense
          ? 'text-xs text-muted-foreground'
          : 'text-sm text-muted-foreground'
      }`}
    >
      <div className="flex items-center gap-1.5 font-medium">
        <span
          style={{ backgroundColor: c.open }}
          className="w-3.5 h-3.5 rounded-sm inline-block shadow-sm"
        />{' '}
        Open
      </div>
      <div className="flex items-center gap-1.5 font-medium">
        <span
          style={{ backgroundColor: c.unavailable }}
          className="w-3.5 h-3.5 rounded-sm inline-block shadow-sm"
        />{' '}
        Unavailable
      </div>
    </div>
  );
}

// ─── ZoomPane ─────────────────────────────────────────────────────────────────
//
// Pan + zoom wrapper for the Host screen.
//
// Performance design:
//   • The inner content div is promoted to its own GPU layer (`will-change:
//     transform`). Pan and zoom are applied as a single CSS `translate() scale()`
//     on that element — this runs entirely on the compositor thread and never
//     triggers layout or paint.
//   • Pan deltas are accumulated in a ref and flushed in a rAF callback by
//     writing directly to el.style.transform (not React state), so there is
//     zero React re-render overhead per frame.
//   • React state is only updated on pinch zoom and zoom-button presses, which
//     happen infrequently.
//
// Touch design:
//   • Single finger: tracks pointerdown + pointermove to compute dx/dy; lets
//     click events through only when total movement ≤ DRAG_THRESHOLD.
//   • Two fingers: pinch-zoom; replaces the ongoing scale ref.
//   • onClickCapture on the container suppresses seat-button clicks when a drag
//     occurred, keeping toggle and pan completely decoupled.

const DRAG_THRESHOLD = 6; // px before a touch counts as a pan
const EDGE_PAD = 80; // px of extra space kept around the room

export function ZoomPane({
  children,
  geometry,
  initialScale = 0.9,
}: {
  children: React.ReactNode;
  geometry: ReturnType<typeof import('@/lib/geometry').computeGeometry>;
  initialScale?: number;
}) {
  const [scale, setScale] = useState(initialScale);
  const scaleRef = useRef(scale);

  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  // Pan position — held in a ref so we can mutate it each rAF without
  // triggering a React re-render.
  const panRef = useRef({ x: 0, y: 0 });

  // Touch tracking
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const startPos = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef({ dist: 0, scale: 1 });
  const draggingRef = useRef(false);

  // rAF accumulator for pan
  const rafRef = useRef<number | null>(null);
  const pendingDelta = useRef({ dx: 0, dy: 0 });

  // ── helpers ──────────────────────────────────────────────────────────────

  const clampScale = (s: number) => Math.min(3, Math.max(0.3, s));

  const pointerDist = (pts: { x: number; y: number }[]) => {
    const [a, b] = pts;
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  /** Clamp pan so the room content stays comfortably in the viewport. */
  const clampPan = useCallback(
    (x: number, y: number, sc: number) => {
      const container = containerRef.current;
      if (!container) return { x, y };
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      const contentW = geometry.totalWidth * sc;
      const contentH = geometry.totalHeight * sc;
      return {
        x: Math.max(-(contentW - cw + EDGE_PAD), Math.min(EDGE_PAD, x)),
        y: Math.max(-(contentH - ch + EDGE_PAD), Math.min(EDGE_PAD, y)),
      };
    },
    [geometry.totalWidth, geometry.totalHeight],
  );

  /**
   * Write the current pan + scale to the inner element's style.transform.
   * Runs on the compositor thread — no layout or paint.
   */
  const commitTransform = useCallback(
    (x = panRef.current.x, y = panRef.current.y, sc = scaleRef.current) => {
      const el = innerRef.current;
      if (!el) return;
      const clamped = clampPan(x, y, sc);
      panRef.current = clamped;
      el.style.transform = `translate(${clamped.x}px,${clamped.y}px) scale(${sc})`;
    },
    [clampPan],
  );

  // Keep scaleRef in sync and re-commit transform when scale state changes.
  useEffect(() => {
    scaleRef.current = scale;
    commitTransform(panRef.current.x, panRef.current.y, scale);
  }, [scale, commitTransform]);

  // Center the room horizontally on mount and when geometry changes.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const contentW = geometry.totalWidth * scaleRef.current;
    const startX = Math.max(EDGE_PAD, (container.clientWidth - contentW) / 2);
    panRef.current = { x: startX, y: EDGE_PAD };
    commitTransform(startX, EDGE_PAD, scaleRef.current);
  }, [geometry.totalWidth, commitTransform]);

  // ── rAF pan flush ─────────────────────────────────────────────────────────

  const flushPan = useCallback(() => {
    rafRef.current = null;
    const dx = pendingDelta.current.dx;
    const dy = pendingDelta.current.dy;
    pendingDelta.current = { dx: 0, dy: 0 };
    commitTransform(panRef.current.x + dx, panRef.current.y + dy);
  }, [commitTransform]);

  // ── pointer handlers ──────────────────────────────────────────────────────

  const onPointerDown = (e: React.PointerEvent) => {
    // Only track primary button for mouse; track all for touch/pen
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    startPos.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      draggingRef.current = true;
      const pts = Array.from(pointers.current.values());
      pinchRef.current = { dist: pointerDist(pts), scale: scaleRef.current };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const prev = pointers.current.get(e.pointerId)!;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 1) {
      const start = startPos.current.get(e.pointerId);
      if (
        !draggingRef.current &&
        start &&
        Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_THRESHOLD
      ) {
        draggingRef.current = true;
      }
      if (draggingRef.current) {
        pendingDelta.current.dx += e.clientX - prev.x;
        pendingDelta.current.dy += e.clientY - prev.y;
        if (!rafRef.current) {
          rafRef.current = requestAnimationFrame(flushPan);
        }
      }
    } else if (pointers.current.size >= 2) {
      const pts = Array.from(pointers.current.values());
      const d = pointerDist(pts);
      if (pinchRef.current.dist > 0) {
        const newScale = clampScale(
          pinchRef.current.scale * (d / pinchRef.current.dist),
        );
        setScale(newScale);
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    startPos.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      // Short delay so the click handler (seat toggle) fires before we reset.
      setTimeout(() => {
        draggingRef.current = false;
      }, 50);
    }
  };

  // Suppress click events on seats when the user was panning.
  const onClickCapture = (e: React.MouseEvent) => {
    if (draggingRef.current) {
      e.stopPropagation();
      e.preventDefault();
    }
  };

  // ── zoom controls ─────────────────────────────────────────────────────────

  const zoomIn = () => setScale((s) => clampScale(+(s + 0.2).toFixed(2)));
  const zoomOut = () => setScale((s) => clampScale(+(s - 0.2).toFixed(2)));
  const resetView = () => {
    const container = containerRef.current;
    if (!container) return;
    const contentW = geometry.totalWidth * initialScale;
    const startX = Math.max(EDGE_PAD, (container.clientWidth - contentW) / 2);
    panRef.current = { x: startX, y: EDGE_PAD };
    setScale(initialScale); // triggers commitTransform via useEffect
  };

  // Snap to a section centroid and zoom in.
  const snapTo = (pt: { x: number; y: number }) => {
    const targetScale = 1.3;
    const container = containerRef.current;
    if (!container) return;
    const newX = container.clientWidth / 2 - pt.x * targetScale;
    const newY = container.clientHeight / 2 - pt.y * targetScale;
    panRef.current = { x: newX, y: newY };
    setScale(targetScale); // triggers commitTransform via useEffect
  };

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-slate-950/50 overflow-hidden select-none touch-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerUp}
      onClickCapture={onClickCapture}
    >
      {/* Inner div is promoted to its own GPU layer. Pan+zoom are written
          directly to style.transform each rAF — never causes layout/paint. */}
      <div
        ref={innerRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          transformOrigin: '0 0',
          willChange: 'transform',
        }}
      >
        {children}
      </div>

      {/* Zoom controls */}
      <div className="absolute bottom-6 right-6 flex flex-col gap-2 z-10">
        <div className="bg-card border border-border rounded-xl shadow-lg flex flex-col overflow-hidden">
          <button
            data-testid="button-zoom-in"
            onClick={zoomIn}
            className="p-3 hover:bg-muted text-foreground border-b border-border active:bg-accent flex items-center justify-center"
          >
            <ZoomIn size={20} />
          </button>
          <button
            data-testid="button-zoom-reset"
            onClick={resetView}
            className="p-3 hover:bg-muted text-foreground border-b border-border active:bg-accent flex items-center justify-center"
          >
            <Maximize2 size={18} />
          </button>
          <button
            data-testid="button-zoom-out"
            onClick={zoomOut}
            className="p-3 hover:bg-muted text-foreground active:bg-accent flex items-center justify-center"
          >
            <ZoomOut size={20} />
          </button>
        </div>
      </div>

      {/* Section snap buttons */}
      <div className="absolute left-6 bottom-6 flex gap-2 z-10">
        {(
          Object.entries(geometry.sections) as [
            string,
            { x: number; y: number },
          ][]
        ).map(([key, pt]) => (
          <button
            key={key}
            data-testid={`button-snap-${key}`}
            onClick={() => snapTo(pt)}
            className="w-12 h-12 rounded-full bg-card border border-border shadow-lg flex items-center justify-center text-foreground font-semibold hover:bg-muted active:scale-95 transition-transform"
          >
            {key[0].toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}
