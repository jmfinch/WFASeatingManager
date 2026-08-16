import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { RoomLayout } from "@workspace/api-client-react";
import { STAGE_H, UNIT, SEAT, DEFAULT_LAYOUT, seatId } from "@/lib/geometry";
import { ZoomIn, ZoomOut, Maximize2, Move } from 'lucide-react';

export function RoomCanvas({ 
  layout, 
  geometry, 
  seatStatus, 
  editable = false, 
  onToggleSeat 
}: {
  layout: RoomLayout;
  geometry: any;
  seatStatus: Record<string, string>;
  editable?: boolean;
  onToggleSeat?: (id: string) => void;
}) {
  const { rowH, stageClearance, centerLeft, centerWidth, rightLeft, totalWidth, totalHeight, offsetX, offsetY } = geometry;
  const colors = layout.colors ?? DEFAULT_LAYOUT.colors;

  const renderSection = (key: string, seatsPerRow: number, rowCount: number, left: number, rotateDeg: number, origin: string) => {
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
            disabled={!editable}
            onClick={() => editable && onToggleSeat && onToggleSeat(id)}
            title={id}
            style={{
              width: SEAT,
              height: SEAT,
              marginRight: UNIT - SEAT,
              backgroundColor: status === 'open' ? colors.open : colors.unavailable,
            }}
            className={`relative rounded-t-md rounded-b-sm shrink-0 transition-transform ${editable ? 'active:scale-90 hover:brightness-110' : ''}`}
          >
            {/* subtle seat-back detail highlight */}
            <span
              style={{ background: 'rgba(255,255,255,0.35)' }}
              className="absolute top-0.5 left-1 right-1 h-1 rounded-full pointer-events-none"
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
        className="bg-card border border-border rounded-md flex items-center justify-center text-muted-foreground text-xs tracking-widest uppercase shadow-sm"
      >
        Stage
      </div>

      {renderSection('L', layout.left.seats, layout.left.rows, 0, layout.left.angleDeg || 0, 'top right')}
      {renderSection('C', layout.center.seats, layout.center.rows, centerLeft, 0, 'top left')}
      {renderSection('R', layout.right.seats, layout.right.rows, rightLeft, -(layout.right.angleDeg || 0), 'top left')}
    </div>
  );
}

export function Legend({ dense, colors }: { dense?: boolean; colors?: { open: string; unavailable: string } }) {
  const c = colors ?? DEFAULT_LAYOUT.colors;
  return (
    <div className={`flex items-center gap-4 ${dense ? 'text-xs text-muted-foreground' : 'text-sm text-muted-foreground'}`}>
      <div className="flex items-center gap-1.5 font-medium">
        <span style={{ backgroundColor: c.open }} className="w-3.5 h-3.5 rounded-sm inline-block shadow-sm" /> Open
      </div>
      <div className="flex items-center gap-1.5 font-medium">
        <span style={{ backgroundColor: c.unavailable }} className="w-3.5 h-3.5 rounded-sm inline-block shadow-sm" /> Unavailable
      </div>
    </div>
  );
}

// Pan/zoom wrapper for Host mode: drag to move, pinch to zoom, section snap buttons
export function ZoomPane({ children, geometry, initialScale = 0.9 }: { children: React.ReactNode; geometry: any; initialScale?: number }) {
  const [scale, setScale] = useState(initialScale);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map());
  const startPos = useRef(new Map());
  const panRef = useRef({ x: 0, y: 0 });
  const pinchRef = useRef({ dist: 0, scale: 1 });
  const draggingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const pendingDelta = useRef({ dx: 0, dy: 0 });
  const markerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const focusKeyRef = useRef<string | null>(null);
  const [focusToken, setFocusToken] = useState(0);

  const DRAG_THRESHOLD = 6;

  const clampScale = (s: number) => Math.min(3, Math.max(0.3, s));
  const zoomIn = () => setScale((s) => clampScale(+(s + 0.2).toFixed(2)));
  const zoomOut = () => setScale((s) => clampScale(+(s - 0.2).toFixed(2)));
  const reset = () => setScale(initialScale);

  const dist = (pts: {x: number, y: number}[]) => {
    const [a, b] = pts;
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const flushPan = () => {
    rafRef.current = null;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft -= pendingDelta.current.dx;
    el.scrollTop -= pendingDelta.current.dy;
    pendingDelta.current = { dx: 0, dy: 0 };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    startPos.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      draggingRef.current = true;
      try {
        const pts = Array.from(pointers.current.values());
        pinchRef.current = { dist: dist(pts), scale };
      } catch {}
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const prev = pointers.current.get(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 1) {
      const start = startPos.current.get(e.pointerId);
      if (!draggingRef.current && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_THRESHOLD) {
        draggingRef.current = true;
      }
      if (draggingRef.current) {
        pendingDelta.current.dx += e.clientX - prev.x;
        pendingDelta.current.dy += e.clientY - prev.y;
        if (!rafRef.current) {
          rafRef.current = requestAnimationFrame(flushPan);
        }
      }
    } else if (pointers.current.size === 2) {
      try {
        const pts = Array.from(pointers.current.values());
        const currentDist = dist(pts);
        if (pinchRef.current.dist > 0) {
          const newScale = clampScale(pinchRef.current.scale * (currentDist / pinchRef.current.dist));
          setScale(newScale);
        }
      } catch {}
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    startPos.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      setTimeout(() => {
        draggingRef.current = false;
      }, 50);
    }
  };

  const onClickCapture = (e: React.MouseEvent) => {
    if (draggingRef.current) {
      e.stopPropagation();
      e.preventDefault();
    }
  };

  const snapTo = (key: string, pt: {x: number, y: number}) => {
    focusKeyRef.current = key;
    setFocusToken((t) => t + 1);
    const el = scrollRef.current;
    if (!el) return;
    const targetScale = 1.3;
    setScale(targetScale);
    setTimeout(() => {
      const vw = el.clientWidth;
      const vh = el.clientHeight;
      el.scrollTo({
        left: pt.x * targetScale + 120 * targetScale - vw / 2,
        top: pt.y * targetScale + 120 * targetScale - vh / 2,
        behavior: 'smooth',
      });
    }, 50);
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || focusKeyRef.current) return;
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
    el.scrollTop = 0;
  }, [geometry.totalWidth]);

  return (
    <div className="relative w-full h-full bg-slate-950/50 overflow-hidden select-none">
      <div
        ref={scrollRef}
        className="w-full h-full overflow-auto touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerUp}
        onClickCapture={onClickCapture}
      >
        <div
          style={{
            width: geometry.totalWidth * scale + 240 * scale,
            height: geometry.totalHeight * scale + 240 * scale,
            position: 'relative',
          }}
        >
          <div
            style={{
              transform: `scale(${scale})`,
              transformOrigin: '0 0',
              position: 'absolute',
              left: 120 * scale,
              top: 120 * scale,
            }}
          >
            {children}
          </div>
        </div>
      </div>

      <div className="absolute bottom-6 right-6 flex flex-col gap-2 z-10">
        <div className="bg-card border border-border rounded-xl shadow-lg flex flex-col overflow-hidden">
          <button onClick={zoomIn} className="p-3 hover:bg-muted text-foreground border-b border-border active:bg-accent flex items-center justify-center">
            <ZoomIn size={20} />
          </button>
          <button onClick={reset} className="p-3 hover:bg-muted text-foreground border-b border-border active:bg-accent flex items-center justify-center">
            <Maximize2 size={18} />
          </button>
          <button onClick={zoomOut} className="p-3 hover:bg-muted text-foreground active:bg-accent flex items-center justify-center">
            <ZoomOut size={20} />
          </button>
        </div>
      </div>

      <div className="absolute left-6 bottom-6 flex gap-2 z-10 pointer-events-none">
        {Object.entries(geometry.sections).map(([key, pt]: [string, any]) => (
          <button
            key={key}
            onClick={() => snapTo(key, pt)}
            className="w-12 h-12 rounded-full bg-card border border-border shadow-lg flex items-center justify-center text-foreground font-semibold hover:bg-muted active:scale-95 transition-transform pointer-events-auto"
          >
            {key[0].toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}
