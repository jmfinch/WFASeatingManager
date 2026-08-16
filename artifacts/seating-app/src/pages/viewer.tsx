import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useGetLayout, useGetSeatState } from '@workspace/api-client-react';
import { computeGeometry, countOpen, relativeTime, DEFAULT_LAYOUT, POLL_MS } from '@/lib/geometry';
import { RoomCanvas, Legend } from '@/components/seating-canvas';

// Standalone viewer — no SeatingProvider dependency, fetches its own data.
// Designed to be shared as a link with anyone who wants to see current seating
// without being able to change anything or navigate to host controls.
export default function Viewer() {
  const { data: layoutRes } = useGetLayout({ query: { refetchInterval: POLL_MS } });
  const { data: seatStateRes } = useGetSeatState({ query: { refetchInterval: POLL_MS } });

  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);

  const activeLayout = layoutRes?.layout || DEFAULT_LAYOUT;
  const seatStatus = seatStateRes?.seatStatus || {};
  const lastUpdated = seatStateRes?.lastUpdated || null;

  const geometry = useMemo(() => computeGeometry(activeLayout), [activeLayout]);
  const counts = useMemo(() => countOpen(activeLayout, seatStatus), [activeLayout, seatStatus]);

  // Scale the canvas to fit the available width without overflowing
  useEffect(() => {
    const updateScale = () => {
      if (!containerRef.current) return;
      const availW = containerRef.current.clientWidth - 32; // 16px padding each side
      const naturalW = geometry.totalWidth;
      setScale(Math.min(availW / naturalW, 1.2)); // cap at 1.2x to keep seats readable
    };
    updateScale();
    const obs = new ResizeObserver(updateScale);
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, [geometry.totalWidth]);

  const stale = lastUpdated && Date.now() - new Date(lastUpdated).getTime() > 90000;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">

      {/* Header */}
      <header className="px-5 pt-6 pb-4 border-b border-border shrink-0">
        <div className="max-w-2xl mx-auto flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Seating Availability</h1>
            {stale ? (
              <p className="text-amber-500 text-sm font-medium mt-0.5 animate-pulse">
                Connection lost — data may be outdated
              </p>
            ) : lastUpdated ? (
              <p className="text-muted-foreground text-sm mt-0.5">
                Updated {relativeTime(lastUpdated, now)}
              </p>
            ) : (
              <p className="text-muted-foreground text-sm mt-0.5">Waiting for data…</p>
            )}
          </div>

          <div className="text-right shrink-0">
            <div className="text-5xl font-bold tabular-nums leading-none">
              <span className="text-primary">{counts.open}</span>
            </div>
            <div className="text-muted-foreground text-sm font-medium mt-0.5">
              open of {counts.total}
            </div>
          </div>
        </div>

        {/* Welcome lines */}
        {activeLayout.welcomeLines.some(l => l.text) && (
          <div className="max-w-2xl mx-auto mt-3 space-y-0.5">
            {activeLayout.welcomeLines.map((line, i) => (
              line.text ? (
                <p
                  key={i}
                  style={{
                    fontSize: Math.min(line.fontSize || 18, 20),
                    fontWeight: line.bold ? 700 : 400,
                    fontStyle: line.italic ? 'italic' : 'normal',
                  }}
                  className="text-foreground/90"
                >
                  {line.text}
                </p>
              ) : null
            ))}
          </div>
        )}
      </header>

      {/* Legend */}
      <div className="px-5 pt-3 pb-2 max-w-2xl mx-auto w-full">
        <Legend dense colors={activeLayout.colors} />
      </div>

      {/* Room map — scales to fit screen width */}
      <main
        ref={containerRef}
        className="flex-1 w-full max-w-2xl mx-auto px-4 pb-8 flex flex-col items-center"
      >
        <div
          style={{
            width: geometry.totalWidth,
            height: geometry.totalHeight,
            transform: `scale(${scale})`,
            transformOrigin: 'top center',
            marginBottom: geometry.totalHeight * (scale - 1), // compensate for scale shrink
          }}
        >
          <RoomCanvas
            layout={activeLayout}
            geometry={geometry}
            seatStatus={seatStatus}
            editable={false}
          />
        </div>
      </main>

      <footer className="text-center text-xs text-muted-foreground/50 pb-6 select-none">
        View only
      </footer>
    </div>
  );
}
