import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, seatingStore } from "@workspace/db";
import {
  SaveLayoutBody,
  SaveSeatStateBody,
  SaveBaselineBody,
  SaveGatheringBody,
  GetGatheringParams,
  DeleteGatheringParams,
  AnalyzeGatheringBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

// ---------- tiny KV helpers backed by PostgreSQL JSONB ----------
async function kvGet(key: string): Promise<unknown | null> {
  const [row] = await db
    .select()
    .from(seatingStore)
    .where(eq(seatingStore.key, key));
  return row?.value ?? null;
}

async function kvSet(key: string, value: unknown): Promise<void> {
  await db
    .insert(seatingStore)
    .values({ key, value: value as Record<string, unknown> })
    .onConflictDoUpdate({
      target: seatingStore.key,
      set: { value: value as Record<string, unknown>, updatedAt: new Date() },
    });
}

async function kvDelete(key: string): Promise<void> {
  await db.delete(seatingStore).where(eq(seatingStore.key, key));
}

// ---------- seating-specific helpers ----------
const LAYOUT_KEY = "layout";
const STATE_KEY = "state";
const BASELINE_KEY = "baseline";
const HISTORY_INDEX_KEY = "history-index";
const historyRecordKey = (id: string) => `history:${id}`;

function seatId(section: string, row: number, idx: number) {
  return `${section}-r${row}-s${idx}`;
}

function allSeatIds(layout: {
  left: { seats: number; rows: number };
  center: { seats: number; rows: number };
  right: { seats: number; rows: number };
}): string[] {
  const ids: string[] = [];
  for (let r = 0; r < layout.left.rows; r++)
    for (let i = 0; i < layout.left.seats; i++) ids.push(seatId("L", r, i));
  for (let r = 0; r < layout.center.rows; r++)
    for (let i = 0; i < layout.center.seats; i++) ids.push(seatId("C", r, i));
  for (let r = 0; r < layout.right.rows; r++)
    for (let i = 0; i < layout.right.seats; i++) ids.push(seatId("R", r, i));
  return ids;
}

// ---------- routes ----------

// GET /seating/layout
router.get("/seating/layout", async (req, res): Promise<void> => {
  const layout = await kvGet(LAYOUT_KEY);
  res.json({ layout: layout ?? null });
});

// PUT /seating/layout
router.put("/seating/layout", async (req, res): Promise<void> => {
  const parsed = SaveLayoutBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await kvSet(LAYOUT_KEY, parsed.data);
  res.json(parsed.data);
});

// GET /seating/state
router.get("/seating/state", async (req, res): Promise<void> => {
  const state = (await kvGet(STATE_KEY)) as {
    seatStatus: Record<string, string>;
    lastUpdated: string | null;
  } | null;
  res.json({
    seatStatus: state?.seatStatus ?? {},
    lastUpdated: state?.lastUpdated ?? null,
  });
});

// PUT /seating/state
router.put("/seating/state", async (req, res): Promise<void> => {
  const parsed = SaveSeatStateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const lastUpdated = parsed.data.lastUpdated ?? new Date().toISOString();
  const saved = { seatStatus: parsed.data.seatStatus, lastUpdated };
  await kvSet(STATE_KEY, saved);
  res.json(saved);
});

// GET /seating/baseline
router.get("/seating/baseline", async (req, res): Promise<void> => {
  const baseline = await kvGet(BASELINE_KEY);
  res.json({ baseline: baseline ?? null });
});

// PUT /seating/baseline
router.put("/seating/baseline", async (req, res): Promise<void> => {
  const parsed = SaveBaselineBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await kvSet(BASELINE_KEY, parsed.data);
  res.json(parsed.data);
});

// GET /seating/summary — quick open/total count computed server-side
router.get("/seating/summary", async (req, res): Promise<void> => {
  const [layout, state] = await Promise.all([
    kvGet(LAYOUT_KEY) as Promise<{
      left: { seats: number; rows: number };
      center: { seats: number; rows: number };
      right: { seats: number; rows: number };
    } | null>,
    kvGet(STATE_KEY) as Promise<{
      seatStatus: Record<string, string>;
      lastUpdated: string | null;
    } | null>,
  ]);

  if (!layout) {
    res.json({ open: 0, total: 0, lastUpdated: null });
    return;
  }

  const seatStatus = state?.seatStatus ?? {};
  const ids = allSeatIds(layout);
  const open = ids.filter((id) => (seatStatus[id] ?? "open") === "open").length;
  res.json({ open, total: ids.length, lastUpdated: state?.lastUpdated ?? null });
});

// GET /seating/history
router.get("/seating/history", async (req, res): Promise<void> => {
  const index = ((await kvGet(HISTORY_INDEX_KEY)) ?? []) as unknown[];
  res.json(index);
});

// POST /seating/history — save a gathering record and update index
router.post("/seating/history", async (req, res): Promise<void> => {
  const parsed = SaveGatheringBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const record = parsed.data;
  await kvSet(historyRecordKey(record.id), record);

  const existingIndex = ((await kvGet(HISTORY_INDEX_KEY)) ?? []) as Array<{
    id: string;
  }>;
  const summary = {
    id: record.id,
    date: record.date,
    gathering: record.gathering,
    savedAt: record.savedAt,
    overallOpen: record.overallOpen,
    overallTotal: record.overallTotal,
    extraRows: record.extraRows,
  };
  const newIndex = [
    ...existingIndex.filter((r) => r.id !== record.id),
    summary,
  ];
  await kvSet(HISTORY_INDEX_KEY, newIndex);

  res.status(201).json(summary);
});

// GET /seating/history/:id
router.get("/seating/history/:id", async (req, res): Promise<void> => {
  const params = GetGatheringParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const record = await kvGet(historyRecordKey(params.data.id));
  if (!record) {
    res.status(404).json({ error: "Gathering record not found" });
    return;
  }
  res.json(record);
});

// DELETE /seating/history/:id
router.delete("/seating/history/:id", async (req, res): Promise<void> => {
  const params = DeleteGatheringParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await kvDelete(historyRecordKey(params.data.id));

  const existingIndex = ((await kvGet(HISTORY_INDEX_KEY)) ?? []) as Array<{
    id: string;
  }>;
  await kvSet(
    HISTORY_INDEX_KEY,
    existingIndex.filter((r) => r.id !== params.data.id)
  );

  res.sendStatus(204);
});

// POST /seating/analyze — server-side Anthropic proxy
router.post("/seating/analyze", async (req, res): Promise<void> => {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    res
      .status(400)
      .json({ error: "ANTHROPIC_API_KEY is not set. Add it in Replit Secrets." });
    return;
  }
  const parsed = AnalyzeGatheringBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1000,
        messages: [{ role: "user", content: parsed.data.prompt }],
      }),
    });
    const data = (await r.json()) as {
      content?: { type: string; text: string }[];
      error?: { message?: string };
    };
    if (!r.ok) {
      res.status(r.status).json({ error: data.error?.message ?? "Anthropic API error" });
      return;
    }
    const text = (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    res.json({ text });
  } catch (e) {
    const err = e as Error;
    res.status(500).json({ error: err.message });
  }
});

export default router;
