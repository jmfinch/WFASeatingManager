import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useLocation } from 'wouter';
import { useSeating } from '@/context/seating-context';
import { Field } from '@/components/field';
import { DEFAULT_LAYOUT, computeGeometry } from '@/lib/geometry';
import { RoomCanvas } from '@/components/seating-canvas';
import { useSaveLayout, useSaveBaseline, RoomLayout } from '@workspace/api-client-react';
import { Check, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';

export default function Setup() {
  const [_, setLocation] = useLocation();
  const { layout, baseline } = useSeating();
  const saveLayout = useSaveLayout();
  const saveBaseline = useSaveBaseline();

  const initialLayout = layout || DEFAULT_LAYOUT;

  const [form, setForm] = useState(() => ({
    centerSeats: initialLayout.center.seats,
    centerRows: initialLayout.center.rows,
    leftSeats: initialLayout.left.seats,
    leftRows: initialLayout.left.rows,
    rightSeats: initialLayout.right.seats,
    rightRows: initialLayout.right.rows,
    leftAngle: initialLayout.left.angleDeg ?? DEFAULT_LAYOUT.left.angleDeg,
    rightAngle: initialLayout.right.angleDeg ?? DEFAULT_LAYOUT.right.angleDeg,
    aisleSlots: initialLayout.aisleSlots,
    rowGap: initialLayout.rowGap,
    stageGap: initialLayout.stageGap,
    welcomeLines: initialLayout.welcomeLines.map(l => ({ ...l })),
    openColor: initialLayout.colors.open,
    unavailableColor: initialLayout.colors.unavailable,
    gatheringNames: [...initialLayout.gatheringNames]
  }));

  const set = (key: string) => (e: any) => {
    const v = Number(e.target.value);
    setForm(f => ({ ...f, [key]: Number.isFinite(v) ? v : 0 }));
  };

  const updateLine = (idx: number, patch: any) =>
    setForm((f) => ({
      ...f,
      welcomeLines: f.welcomeLines.map((l, i) => (i === idx ? { ...l, ...patch } : l)),
    }));

  const updateGatheringName = (idx: number, value: string) =>
    setForm((f) => ({
      ...f,
      gatheringNames: f.gatheringNames.map((n, i) => (i === idx ? value : n)),
    }));

  // Create preview layout
  const previewLayout: RoomLayout = useMemo(() => ({
    center: { seats: Math.max(0, form.centerSeats), rows: Math.max(1, form.centerRows) },
    left: { seats: Math.max(0, form.leftSeats), rows: Math.max(1, form.leftRows), angleDeg: form.leftAngle },
    right: { seats: Math.max(0, form.rightSeats), rows: Math.max(1, form.rightRows), angleDeg: form.rightAngle },
    aisleSlots: Math.max(0, form.aisleSlots),
    rowGap: Math.max(0, form.rowGap),
    stageGap: Math.max(0, form.stageGap),
    welcomeLines: form.welcomeLines,
    colors: { open: form.openColor, unavailable: form.unavailableColor },
    gatheringNames: form.gatheringNames,
  }), [form]);

  const geometry = useMemo(() => computeGeometry(previewLayout), [previewLayout]);
  const dummySeatStatus = useMemo(() => {
    // Generate a dummy status just for preview
    const s: Record<string, string> = {};
    return s; // all open
  }, []);

  const onSave = () => {
    saveLayout.mutate({ data: previewLayout }, {
      onSuccess: () => {
        toast.success("Layout saved successfully");
      },
      onError: () => {
        toast.error("Failed to save layout");
      }
    });
  };

  const onSetBaseline = () => {
    saveBaseline.mutate({
      data: {
        left: { rows: Math.max(1, form.leftRows) },
        center: { rows: Math.max(1, form.centerRows) },
        right: { rows: Math.max(1, form.rightRows) }
      }
    }, {
      onSuccess: () => {
        toast.success("Baseline updated");
      }
    });
  };

  const baselineDiffers = baseline && (
    baseline.left?.rows !== form.leftRows || 
    baseline.center?.rows !== form.centerRows || 
    baseline.right?.rows !== form.rightRows
  );

  // Auto scale preview canvas to fit right pane
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const updateScale = () => {
      if (!containerRef.current) return;
      const { clientWidth, clientHeight } = containerRef.current;
      const padding = 64;
      const availW = clientWidth - padding;
      const availH = clientHeight - padding;
      
      const scaleW = availW / geometry.totalWidth;
      const scaleH = availH / geometry.totalHeight;
      setScale(Math.min(scaleW, scaleH, 1));
    };
    
    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, [geometry.totalWidth, geometry.totalHeight]);

  return (
    <div className="h-[100dvh] w-full flex flex-col md:flex-row bg-background text-foreground overflow-hidden">
      {/* Left Pane: Controls */}
      <div className="w-full md:w-[500px] lg:w-[600px] h-full flex flex-col border-r border-border bg-card shrink-0 shadow-xl z-10">
        <div className="p-4 border-b border-border flex items-center gap-4 bg-background">
          <button 
            onClick={() => setLocation('/')}
            className="w-10 h-10 flex items-center justify-center rounded-md hover:bg-accent text-muted-foreground transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Room Layout</h1>
            <p className="text-sm text-muted-foreground">Configure the physical room dimensions</p>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-6 space-y-8">
          {/* Row Counts */}
          <section className="space-y-4">
            <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Rows</h2>
            <div className="grid grid-cols-3 gap-4">
              <Field label="Left" value={form.leftRows} onChange={set('leftRows')} min={1} max={40} />
              <Field label="Center" value={form.centerRows} onChange={set('centerRows')} min={1} max={40} />
              <Field label="Right" value={form.rightRows} onChange={set('rightRows')} min={1} max={40} />
            </div>
            
            <div className="bg-background rounded-lg border border-border p-4 mt-2">
              <div className="text-sm font-medium mb-1 flex items-center justify-between">
                <span>Baseline (Normal) Rows</span>
                <button
                  onClick={onSetBaseline}
                  disabled={saveBaseline.isPending}
                  className="text-xs bg-secondary hover:bg-accent text-secondary-foreground px-2 py-1 rounded transition-colors"
                >
                  Set current as baseline
                </button>
              </div>
              {baseline ? (
                <div className="text-sm text-muted-foreground">
                  L: {baseline.left?.rows} &middot; C: {baseline.center?.rows} &middot; R: {baseline.right?.rows}
                  {baselineDiffers && <span className="text-amber-500 ml-2 block sm:inline mt-1 sm:mt-0">Current layout differs</span>}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">Not set yet.</div>
              )}
            </div>
          </section>

          {/* Seats Per Row */}
          <section className="space-y-4">
            <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Seats per Row</h2>
            <div className="grid grid-cols-3 gap-4">
              <Field label="Left" value={form.leftSeats} onChange={set('leftSeats')} />
              <Field label="Center" value={form.centerSeats} onChange={set('centerSeats')} />
              <Field label="Right" value={form.rightSeats} onChange={set('rightSeats')} />
            </div>
          </section>

          {/* Angles & Spacing */}
          <section className="space-y-4">
            <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Angles & Spacing</h2>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Left Angle" value={form.leftAngle} onChange={set('leftAngle')} min={0} max={45} suffix="deg" />
              <Field label="Right Angle" value={form.rightAngle} onChange={set('rightAngle')} min={0} max={45} suffix="deg" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Aisle Width" value={form.aisleSlots} onChange={set('aisleSlots')} min={0} max={10} suffix="seats" />
              <Field label="Row Gap" value={form.rowGap} onChange={set('rowGap')} min={0} max={2} step={0.25} suffix="depth" />
            </div>
            <Field label="Stage Clearance" value={form.stageGap} onChange={set('stageGap')} min={0} max={5} step={0.25} suffix="depth" />
          </section>

          {/* Display Settings */}
          <section className="space-y-4">
            <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">TV Display</h2>
            <div className="space-y-3">
              <label className="text-sm font-medium">Welcome Message</label>
              {form.welcomeLines.map((line, idx) => (
                <div key={idx} className="flex flex-wrap items-center gap-2 bg-background border border-border rounded-lg p-2">
                  <input
                    type="text"
                    value={line.text}
                    onChange={(e) => updateLine(idx, { text: e.target.value })}
                    placeholder={idx === 0 ? 'Line 1' : 'Line 2'}
                    className="flex-1 min-w-[150px] bg-transparent px-2 py-1.5 text-sm outline-none font-medium placeholder:font-normal"
                  />
                  <select
                    value={line.fontSize}
                    onChange={(e) => updateLine(idx, { fontSize: Number(e.target.value) })}
                    className="bg-card border border-border rounded px-2 py-1.5 text-sm outline-none"
                  >
                    <option value={16}>Sm</option>
                    <option value={20}>Md</option>
                    <option value={26}>Lg</option>
                    <option value={34}>XL</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => updateLine(idx, { bold: !line.bold })}
                    className={`w-8 h-8 rounded font-bold text-sm transition-colors ${
                      line.bold ? 'bg-primary text-primary-foreground' : 'bg-secondary hover:bg-accent text-secondary-foreground'
                    }`}
                  >
                    B
                  </button>
                  <button
                    type="button"
                    onClick={() => updateLine(idx, { italic: !line.italic })}
                    className={`w-8 h-8 rounded italic text-sm transition-colors ${
                      line.italic ? 'bg-primary text-primary-foreground' : 'bg-secondary hover:bg-accent text-secondary-foreground'
                    }`}
                  >
                    I
                  </button>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-4 pt-2">
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">Open Color</span>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={form.openColor}
                    onChange={(e) => setForm((f) => ({ ...f, openColor: e.target.value }))}
                    className="h-10 w-16 bg-card border border-border p-1 rounded-md cursor-pointer"
                  />
                  <span className="text-muted-foreground font-mono text-xs">{form.openColor}</span>
                </div>
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">Unavailable Color</span>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={form.unavailableColor}
                    onChange={(e) => setForm((f) => ({ ...f, unavailableColor: e.target.value }))}
                    className="h-10 w-16 bg-card border border-border p-1 rounded-md cursor-pointer"
                  />
                  <span className="text-muted-foreground font-mono text-xs">{form.unavailableColor}</span>
                </div>
              </label>
            </div>
          </section>

          {/* Gatherings */}
          <section className="space-y-4">
            <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Gathering Names</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {form.gatheringNames.map((name, idx) => (
                <input
                  key={idx}
                  type="text"
                  value={name}
                  onChange={(e) => updateGatheringName(idx, e.target.value)}
                  className="bg-background border border-border rounded-md px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary font-medium"
                />
              ))}
            </div>
          </section>
        </div>

        <div className="p-4 border-t border-border bg-background flex items-center justify-between">
          <button 
            onClick={() => setLocation('/')}
            className="px-4 py-2 text-muted-foreground hover:text-foreground font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={saveLayout.isPending}
            className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold px-6 py-2.5 rounded-md shadow-sm flex items-center gap-2 transition-colors"
          >
            <Check size={18} /> {saveLayout.isPending ? 'Saving...' : 'Save Layout'}
          </button>
        </div>
      </div>

      {/* Right Pane: Live Preview */}
      <div className="flex-1 h-full bg-background relative overflow-hidden flex flex-col hidden md:flex">
        <div className="absolute top-4 left-4 z-10 px-3 py-1.5 rounded-full bg-card/80 backdrop-blur border border-border text-xs font-bold tracking-widest text-muted-foreground uppercase shadow-sm">
          Live Preview
        </div>
        <div ref={containerRef} className="flex-1 w-full h-full flex items-center justify-center p-8 relative">
          {/* We wrap RoomCanvas in a scaled div */}
          <div 
            style={{
              width: geometry.totalWidth,
              height: geometry.totalHeight,
              transform: `scale(${scale})`,
              transformOrigin: 'center center'
            }}
          >
            <RoomCanvas 
              layout={previewLayout}
              geometry={geometry}
              seatStatus={dummySeatStatus}
              editable={false}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
