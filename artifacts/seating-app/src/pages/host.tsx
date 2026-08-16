import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useLocation } from 'wouter';
import { useSeating } from '@/context/seating-context';
import { computeGeometry, countOpen, computeTotals, computeExtraRows, relativeTime, DEFAULT_LAYOUT } from '@/lib/geometry';
import { RoomCanvas, ZoomPane, Legend } from '@/components/seating-canvas';
import { Settings, Tv, History, Check, Save, Hand, Sparkles } from 'lucide-react';
import { useSaveGathering } from '@workspace/api-client-react';
import { toast } from 'sonner';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

export default function Host() {
  const [_, setLocation] = useLocation();
  const { layout, seatStatus, baseline, toggleSeat, markAll, resetAll, eventLog } = useSeating();
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [gatheringIdx, setGatheringIdx] = useState(0);
  const saveGathering = useSaveGathering();

  // Wrap toggleSeat with an undo toast so an accidental tap can be reversed
  // within 3 seconds without hunting for the seat again.
  const handleToggleSeat = useCallback(
    (id: string) => {
      const wasOpen = (seatStatus[id] ?? 'open') === 'open';
      toggleSeat(id);
      toast(wasOpen ? 'Seat marked unavailable' : 'Seat reopened', {
        duration: 3000,
        position: 'bottom-center',
        action: {
          label: 'Undo',
          onClick: () => toggleSeat(id),
        },
      });
    },
    [seatStatus, toggleSeat],
  );

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);

  const activeLayout = layout || DEFAULT_LAYOUT;
  const geometry = useMemo(() => computeGeometry(activeLayout), [activeLayout]);
  const counts = useMemo(() => countOpen(activeLayout, seatStatus), [activeLayout, seatStatus]);

  const submitFinal = () => {
    const gatheringName = activeLayout.gatheringNames[gatheringIdx] || `Gathering ${gatheringIdx + 1}`;
    const totals = computeTotals(activeLayout, seatStatus);
    const extraRows = computeExtraRows(activeLayout, baseline);
    
    saveGathering.mutate({
      data: {
        id: crypto.randomUUID(),
        date: new Date().toISOString(),
        gathering: gatheringName,
        savedAt: new Date().toISOString(),
        overallOpen: totals.overall.open,
        overallTotal: totals.overall.total,
        extraRows,
        layoutSnapshot: activeLayout,
        seatStatus: seatStatus,
        totals,
        events: eventLog.current
      }
    }, {
      onSuccess: () => {
        toast.success(`Saved ${gatheringName}`);
        resetAll();
        setShowSubmitModal(false);
      },
      onError: () => {
        toast.error("Failed to save gathering");
      }
    });
  };

  const isPortrait = typeof window !== 'undefined' && window.innerHeight > window.innerWidth;

  return (
    <div className="h-[100dvh] w-full flex flex-col bg-background text-foreground overflow-hidden">
      {isPortrait && (
        <div className="bg-amber-600/90 text-amber-50 text-xs text-center py-1.5 font-medium z-50">
          Rotate iPad to landscape for best experience
        </div>
      )}

      {/* Header */}
      <header className="h-16 border-b border-border bg-card flex items-center justify-between px-6 shrink-0 z-10 shadow-sm">
        <div className="flex items-center gap-6">
          <div className="flex flex-col">
            <h1 className="text-xl font-bold tracking-tight">Host Controls</h1>
            <div className="text-sm text-muted-foreground font-medium">
              <span className="text-primary font-bold">{counts.open}</span> open of {counts.total} total
            </div>
          </div>
          <div className="hidden sm:block h-8 w-px bg-border mx-2" />
          <div className="hidden sm:block">
            <Legend colors={activeLayout.colors} />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button 
            onClick={() => markAll('open')}
            className="hidden sm:flex items-center gap-2 px-3 py-2 rounded-md bg-secondary hover:bg-accent text-secondary-foreground text-sm font-medium transition-colors border border-border"
          >
            Mark all open
          </button>
          <button 
            onClick={() => markAll('unavailable')}
            className="hidden sm:flex items-center gap-2 px-3 py-2 rounded-md bg-secondary hover:bg-accent text-secondary-foreground text-sm font-medium transition-colors border border-border"
          >
            Mark all full
          </button>
          
          <div className="h-8 w-px bg-border mx-1" />
          
          <button 
            onClick={() => setShowSubmitModal(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-bold shadow-sm transition-colors"
          >
            <Save size={16} /> Submit Final
          </button>

          <div className="h-8 w-px bg-border mx-1" />

          <button onClick={() => setLocation('/setup')} className="p-2 text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-accent" title="Setup">
            <Settings size={20} />
          </button>
          <button onClick={() => window.open('/display', '_blank')} className="p-2 text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-accent" title="TV Display">
            <Tv size={20} />
          </button>
          <button onClick={() => setLocation('/history')} className="p-2 text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-accent" title="History">
            <History size={20} />
          </button>
        </div>
      </header>

      {/* Canvas Area */}
      <main className="flex-1 relative overflow-hidden bg-background/50">
        <ZoomPane geometry={geometry} initialScale={0.85}>
          <RoomCanvas 
            layout={activeLayout} 
            geometry={geometry} 
            seatStatus={seatStatus} 
            editable={true} 
            onToggleSeat={handleToggleSeat} 
          />
        </ZoomPane>
      </main>

      {/* Submit Modal */}
      <Dialog open={showSubmitModal} onOpenChange={setShowSubmitModal}>
        <DialogContent className="sm:max-w-md bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-xl">Archive Gathering</DialogTitle>
          </DialogHeader>
          <div className="py-6 space-y-4">
            <p className="text-muted-foreground text-sm">
              This will save the current room layout, open seat counts, and row configuration to history, and then <strong>reset all seats to open</strong>.
            </p>
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">Which gathering is this for?</label>
              <div className="grid gap-2">
                {activeLayout.gatheringNames.map((name, i) => (
                  <button
                    key={i}
                    onClick={() => setGatheringIdx(i)}
                    className={`flex items-center justify-between p-3 rounded-md border text-left transition-colors ${
                      gatheringIdx === i 
                        ? 'border-primary bg-primary/10 text-primary-foreground' 
                        : 'border-border bg-background hover:bg-accent hover:border-accent-foreground/20 text-foreground'
                    }`}
                  >
                    <span className="font-medium">{name}</span>
                    {gatheringIdx === i && <Check size={18} className="text-primary" />}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <button 
              onClick={() => setShowSubmitModal(false)}
              className="px-4 py-2 rounded-md bg-secondary hover:bg-accent text-secondary-foreground font-medium transition-colors"
            >
              Cancel
            </button>
            <button 
              onClick={submitFinal}
              disabled={saveGathering.isPending}
              className="px-4 py-2 rounded-md bg-primary hover:bg-primary/90 text-primary-foreground font-bold shadow-sm transition-colors flex items-center gap-2"
            >
              {saveGathering.isPending ? 'Saving...' : 'Save & Reset'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
