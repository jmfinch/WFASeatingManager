import React, { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useGetLayout, useGetSeatState, useSaveSeatState, useGetBaseline, RoomLayout, BaselineLayout } from '@workspace/api-client-react';
import { POLL_MS, buildSeatStatus } from '@/lib/geometry';
import { toast } from 'sonner';

interface SeatEvent {
  t: string;
  type: string;
  id?: string;
  status?: string;
  count?: number;
}

interface SeatingContextValue {
  layout: RoomLayout | null;
  seatStatus: Record<string, string>;
  baseline: BaselineLayout | null;
  lastUpdated: string | null;
  toggleSeat: (id: string) => void;
  markAll: (status: 'open' | 'unavailable') => void;
  resetAll: () => void;
  eventLog: React.MutableRefObject<SeatEvent[]>;
}

const SeatingContext = createContext<SeatingContextValue | null>(null);

export function SeatingProvider({ children }: { children: React.ReactNode }) {
  const { data: layoutRes } = useGetLayout({ query: { refetchInterval: POLL_MS } });
  const { data: baselineRes } = useGetBaseline({ query: { refetchInterval: POLL_MS } });
  const { data: seatStateRes } = useGetSeatState({ query: { refetchInterval: POLL_MS } });
  
  const saveSeatState = useSaveSeatState();

  const [localSeatStatus, setLocalSeatStatus] = useState<Record<string, string>>({});
  const seatStatusRef = useRef<Record<string, string>>({});
  const lastSaveTime = useRef(0);
  const saveTimeout = useRef<any>(null);
  
  const eventLog = useRef<SeatEvent[]>([]);

  // Sync from server if we haven't modified locally in the last 2 seconds
  useEffect(() => {
    if (seatStateRes?.seatStatus && Date.now() - lastSaveTime.current > 2000) {
      setLocalSeatStatus(seatStateRes.seatStatus);
      seatStatusRef.current = seatStateRes.seatStatus;
    }
  }, [seatStateRes?.seatStatus]);

  const queueSave = useCallback(() => {
    clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => {
      lastSaveTime.current = Date.now();
      saveSeatState.mutate({ 
        data: { 
          seatStatus: seatStatusRef.current,
          lastUpdated: new Date().toISOString()
        } 
      }, {
        onError: () => {
          toast.error("Failed to sync seat changes");
        }
      });
    }, 350);
  }, [saveSeatState]);

  const toggleSeat = useCallback((id: string) => {
    const current = seatStatusRef.current[id] || 'open';
    const nextStatus = current === 'open' ? 'unavailable' : 'open';
    
    const next = { ...seatStatusRef.current, [id]: nextStatus };
    setLocalSeatStatus(next);
    seatStatusRef.current = next;

    eventLog.current.push({
      t: new Date().toISOString(),
      type: 'toggle',
      id,
      status: nextStatus
    });

    queueSave();
  }, [queueSave]);

  const markAll = useCallback((status: 'open' | 'unavailable') => {
    if (!layoutRes?.layout) return;
    const next = buildSeatStatus(layoutRes.layout, {});
    Object.keys(next).forEach(k => { next[k] = status; });
    
    setLocalSeatStatus(next);
    seatStatusRef.current = next;

    eventLog.current.push({
      t: new Date().toISOString(),
      type: 'mark-all',
      status
    });

    queueSave();
  }, [layoutRes, queueSave]);

  const resetAll = useCallback(() => {
    if (!layoutRes?.layout) return;
    const next = buildSeatStatus(layoutRes.layout, {});
    setLocalSeatStatus(next);
    seatStatusRef.current = next;
    eventLog.current = [];
    queueSave();
  }, [layoutRes, queueSave]);

  const value = useMemo(() => ({
    layout: layoutRes?.layout || null,
    seatStatus: localSeatStatus,
    baseline: baselineRes?.baseline || null,
    lastUpdated: seatStateRes?.lastUpdated || null,
    toggleSeat,
    markAll,
    resetAll,
    eventLog,
  }), [layoutRes, localSeatStatus, baselineRes, seatStateRes, toggleSeat, markAll, resetAll]);

  return (
    <SeatingContext.Provider value={value}>
      {children}
    </SeatingContext.Provider>
  );
}

export function useSeating() {
  const ctx = useContext(SeatingContext);
  if (!ctx) throw new Error('useSeating must be used within SeatingProvider');
  return ctx;
}
