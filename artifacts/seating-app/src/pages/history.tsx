import React, { useState } from 'react';
import { useLocation } from 'wouter';
import { useListHistory, useDeleteGathering, useAnalyzeGathering } from '@workspace/api-client-react';
import { ArrowLeft, Trash2, Sparkles, Loader2, Calendar } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

export default function History() {
  const [_, setLocation] = useLocation();
  const { data: history, isLoading } = useListHistory();
  const deleteGathering = useDeleteGathering();
  const analyzeGathering = useAnalyzeGathering();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [analysisResult, setAnalysisResult] = useState<string | null>(null);

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const onDelete = (id: string) => {
    if (!confirm('Are you sure you want to delete this record?')) return;
    deleteGathering.mutate({ id }, {
      onSuccess: () => {
        toast.success("Record deleted");
        const next = new Set(selectedIds);
        next.delete(id);
        setSelectedIds(next);
      }
    });
  };

  const onAnalyze = () => {
    if (selectedIds.size === 0) return;
    setAnalysisResult(null);

    const context = Array.from(selectedIds).map(id => {
      const record = history?.find(h => h.id === id);
      if (!record) return '';
      return `Date: ${record.date}, Gathering: ${record.gathering}, Open: ${record.overallOpen}/${record.overallTotal} (${Math.round((record.overallOpen/record.overallTotal)*100)}%), Extra Rows: L:${record.extraRows.left} C:${record.extraRows.center} R:${record.extraRows.right}`;
    }).join('\n');

    const prompt = `Analyze these gathering seating records and provide a brief, insightful summary focusing on attendance trends, row usage, and capacity. Data:\n${context}`;

    analyzeGathering.mutate({ data: { prompt } }, {
      onSuccess: (res) => {
        setAnalysisResult(res.text);
      },
      onError: () => {
        toast.error("Analysis failed");
      }
    });
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col md:flex-row">
      {/* Sidebar: Header & Action */}
      <div className="w-full md:w-80 border-r border-border bg-card flex flex-col shrink-0">
        <div className="p-6 border-b border-border space-y-4">
          <button 
            onClick={() => setLocation('/')}
            className="w-10 h-10 flex items-center justify-center rounded-md hover:bg-accent text-muted-foreground transition-colors -ml-2"
          >
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Gathering History</h1>
            <p className="text-sm text-muted-foreground mt-1">Archived capacity records</p>
          </div>
        </div>

        <div className="p-6 flex-1 flex flex-col gap-6">
          <div className="bg-background border border-border rounded-xl p-5 shadow-sm">
            <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-4">AI Analysis</h2>
            <p className="text-sm text-muted-foreground mb-4">
              Select one or more gatherings from the list to analyze trends, capacity, and extra row usage.
            </p>
            <button
              onClick={onAnalyze}
              disabled={selectedIds.size === 0 || analyzeGathering.isPending}
              className={`w-full py-2.5 rounded-md font-bold flex items-center justify-center gap-2 transition-colors ${
                selectedIds.size > 0 
                  ? 'bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm' 
                  : 'bg-secondary text-muted-foreground cursor-not-allowed'
              }`}
            >
              {analyzeGathering.isPending ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <Sparkles size={18} />
              )}
              {analyzeGathering.isPending ? 'Analyzing...' : `Analyze ${selectedIds.size} Selected`}
            </button>
          </div>

          {analysisResult && (
            <div className="bg-secondary/50 border border-border rounded-xl p-5 shadow-sm text-sm leading-relaxed animate-in fade-in slide-in-from-bottom-2">
              <h3 className="font-bold mb-2 flex items-center gap-2 text-primary">
                <Sparkles size={16} /> Insights
              </h3>
              <div className="text-secondary-foreground space-y-2 whitespace-pre-wrap">
                {analysisResult}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Main Content: List */}
      <div className="flex-1 p-6 md:p-8 lg:p-12 overflow-auto bg-background">
        <div className="max-w-4xl mx-auto space-y-4">
          {isLoading && (
            <div className="text-muted-foreground text-sm flex items-center gap-2">
              <Loader2 size={16} className="animate-spin" /> Loading history...
            </div>
          )}

          {!isLoading && history?.length === 0 && (
            <div className="text-center py-20 bg-card rounded-xl border border-border border-dashed">
              <Calendar className="mx-auto h-12 w-12 text-muted-foreground mb-4 opacity-50" />
              <h3 className="text-lg font-medium">No history yet</h3>
              <p className="text-muted-foreground text-sm mt-1">Submit a final gathering from the host controls to save it here.</p>
            </div>
          )}

          {history?.map((record) => {
            const fillPct = Math.round(((record.overallTotal - record.overallOpen) / record.overallTotal) * 100);
            
            return (
              <div 
                key={record.id}
                className="bg-card border border-border rounded-xl p-4 flex flex-col sm:flex-row gap-4 sm:items-center justify-between shadow-sm hover:border-primary/30 transition-colors"
              >
                <div className="flex items-start gap-4">
                  <input 
                    type="checkbox"
                    checked={selectedIds.has(record.id)}
                    onChange={() => toggleSelect(record.id)}
                    className="mt-1 w-5 h-5 rounded border-border bg-background text-primary focus:ring-primary focus:ring-offset-background"
                  />
                  <div>
                    <h3 className="font-bold text-lg">{record.gathering}</h3>
                    <div className="text-sm text-muted-foreground mt-0.5">
                      {format(new Date(record.date), 'EEEE, MMM d, yyyy')}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap sm:flex-nowrap items-center gap-6 sm:gap-10 pl-9 sm:pl-0">
                  <div className="flex flex-col">
                    <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Filled</span>
                    <span className="font-bold tabular-nums text-lg">{fillPct}%</span>
                  </div>
                  
                  <div className="flex flex-col">
                    <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Open</span>
                    <span className="font-medium tabular-nums text-foreground">{record.overallOpen} / {record.overallTotal}</span>
                  </div>

                  <div className="flex flex-col">
                    <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Extra Rows</span>
                    <span className="font-medium text-foreground">
                      L:{record.extraRows.left > 0 ? `+${record.extraRows.left}` : record.extraRows.left} &middot;{' '}
                      C:{record.extraRows.center > 0 ? `+${record.extraRows.center}` : record.extraRows.center} &middot;{' '}
                      R:{record.extraRows.right > 0 ? `+${record.extraRows.right}` : record.extraRows.right}
                    </span>
                  </div>

                  <button
                    onClick={() => onDelete(record.id)}
                    disabled={deleteGathering.isPending}
                    className="w-10 h-10 flex items-center justify-center rounded-md bg-secondary hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors ml-auto sm:ml-0"
                    title="Delete record"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
