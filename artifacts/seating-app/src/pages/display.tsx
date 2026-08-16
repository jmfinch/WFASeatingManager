import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useLocation } from 'wouter';
import { useSeating } from '@/context/seating-context';
import { computeGeometry, countOpen, relativeTime, DEFAULT_LAYOUT } from '@/lib/geometry';
import { RoomCanvas, Legend } from '@/components/seating-canvas';

export default function Display() {
  const [_, setLocation] = useLocation();
  const { layout, seatStatus, lastUpdated } = useSeating();
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [now, setNow] = useState(Date.now());

  // Update timer for "last updated" text
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);

  const activeLayout = layout || DEFAULT_LAYOUT;
  const geometry = useMemo(() => computeGeometry(activeLayout), [activeLayout]);
  const counts = useMemo(() => countOpen(activeLayout, seatStatus), [activeLayout, seatStatus]);

  // Scale canvas to strictly fit the screen
  useEffect(() => {
    const updateScale = () => {
      if (!containerRef.current) return;
      const { clientWidth, clientHeight } = containerRef.current;
      // Add safe padding
      const paddingX = 120;
      const paddingY = 80;
      const availW = clientWidth - paddingX;
      const availH = clientHeight - paddingY;
      
      const scaleW = availW / geometry.totalWidth;
      const scaleH = availH / geometry.totalHeight;
      setScale(Math.min(scaleW, scaleH, 1.5));
    };
    
    updateScale();
    const obs = new ResizeObserver(updateScale);
    if (containerRef.current) obs.observe(containerRef.current);
    
    return () => obs.disconnect();
  }, [geometry.totalWidth, geometry.totalHeight]);

  const staleWarning = lastUpdated && (Date.now() - new Date(lastUpdated).getTime() > 90000);

  return (
    <div className="h-screen w-screen bg-background text-foreground overflow-hidden flex flex-col select-none cursor-default">
      
      {/* Hidden button to escape back to Host mode */}
      <button 
        onClick={() => setLocation('/')}
        className="fixed bottom-0 right-0 w-24 h-24 z-50 opacity-0"
        aria-label="Back to host"
      />

      <header className="flex flex-col items-center justify-center pt-8 pb-4 shrink-0 z-10">
        <div className="flex items-center justify-between w-full max-w-6xl px-12">
          <div className="flex flex-col">
            <h1 className="text-3xl font-bold tracking-tight text-muted-foreground">Seating Availability</h1>
            {staleWarning && (
              <div className="text-amber-500 font-medium text-sm mt-1 animate-pulse">
                Connection lost — data may be stale
              </div>
            )}
            {!staleWarning && lastUpdated && (
              <div className="text-muted-foreground text-sm mt-1">
                Updated {relativeTime(lastUpdated, now)}
              </div>
            )}
          </div>

          <div className="flex flex-col items-end">
            <div className="text-7xl font-bold tracking-tighter tabular-nums leading-none">
              <span className="text-primary">{counts.open}</span>
              <span className="text-muted-foreground text-4xl ml-2">open</span>
            </div>
          </div>
        </div>

        <div className="mt-8 text-center space-y-1">
          {activeLayout.welcomeLines.map((line, i) => (
            <div 
              key={i} 
              style={{ 
                fontSize: `${line.fontSize || 22}px`, 
                fontWeight: line.bold ? 'bold' : 'normal',
                fontStyle: line.italic ? 'italic' : 'normal'
              }}
              className="text-foreground"
            >
              {line.text}
            </div>
          ))}
        </div>
      </header>

      <div className="w-full flex justify-center py-2 z-10 shrink-0">
        <Legend colors={activeLayout.colors} />
      </div>

      <main 
        ref={containerRef}
        className="flex-1 w-full h-full flex items-center justify-center relative overflow-hidden"
      >
        <div 
          style={{
            width: geometry.totalWidth,
            height: geometry.totalHeight,
            transform: `scale(${scale})`,
            transformOrigin: 'center center'
          }}
          className="transition-transform duration-700 ease-out"
        >
          <RoomCanvas 
            layout={activeLayout}
            geometry={geometry}
            seatStatus={seatStatus}
            editable={false}
          />
        </div>
      </main>

    </div>
  );
}
