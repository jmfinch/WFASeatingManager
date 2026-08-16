import React from 'react';

export function Field({ 
  label, 
  value, 
  onChange, 
  min = 0, 
  max = 60, 
  step = 1, 
  suffix 
}: { 
  label: string; 
  value: number; 
  onChange: (e: any) => void; 
  min?: number; 
  max?: number; 
  step?: number; 
  suffix?: string;
}) {
  const setTo = (n: number) => {
    const clamped = Math.min(max, Math.max(min, n));
    onChange({ target: { value: String(clamped) } });
  };
  
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="text-muted-foreground font-medium">{label}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setTo((Number(value) || 0) - step)}
          className="w-10 h-10 shrink-0 rounded-md bg-secondary hover:bg-accent text-secondary-foreground text-xl leading-none flex items-center justify-center shadow-sm border border-border active:scale-95 transition-transform"
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
          className="bg-card border border-border rounded-md px-3 py-2 h-10 w-16 text-center outline-none focus:ring-2 focus:ring-primary shadow-sm font-medium"
        />
        <button
          type="button"
          onClick={() => setTo((Number(value) || 0) + step)}
          className="w-10 h-10 shrink-0 rounded-md bg-secondary hover:bg-accent text-secondary-foreground text-xl leading-none flex items-center justify-center shadow-sm border border-border active:scale-95 transition-transform"
          aria-label={`Increase ${label}`}
        >
          +
        </button>
        {suffix && <span className="text-muted-foreground text-xs ml-1">{suffix}</span>}
      </div>
    </label>
  );
}
