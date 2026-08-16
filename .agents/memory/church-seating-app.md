---
name: Church Seating App
description: Architecture, geometry math rules, and critical gotchas for the church seating availability system (artifacts/seating-app + artifacts/api-server).
---

# Church Seating App

## Architecture
- **Frontend**: `artifacts/seating-app` — React + Vite + Tailwind v4, wouter, TanStack Query, Orval-generated hooks
- **Backend**: `artifacts/api-server` — Express 5, PostgreSQL JSONB KV store via `seating_store` table
- **OpenAPI contract**: `lib/api-spec/openapi.yaml` → run `pnpm --filter @workspace/api-spec run codegen` after edits

## Storage keys in seating_store
- `'layout'` → RoomLayout
- `'state'` → `{ seatStatus: Record<string,string>, lastUpdated: string }`
- `'baseline'` → BaselineLayout
- `'history-index'` → GatheringSummary[]
- `'history:{id}'` → GatheringRecord

## Seat ID format
`"L-r0-s0"` — section letter (L/C/R), zero-based row index, zero-based seat-within-row index. Used as keys in seatStatus map. Default (missing key) = open.

## Critical rules

**Why:** These tripped up the original app and the rewrite.

1. **Field component at module scope** — input fields in the Setup screen MUST be defined outside any component function. Defining them inside causes React to remount the DOM input on every re-render, yanking iPad keyboard focus mid-typing.

2. **Save debounce + serialized in-flight** — seat toggles write to a `seatStatusRef` immediately (avoids stale closure), then debounce 350ms before saving. Only one save in flight; if edits arrive during a save, queue one re-save with the latest ref value. This prevents rapid-tap race conditions losing data.

3. **skipNextPoll** — set a ref flag right after a local save to skip the next poll result. Without this, the poll immediately overwrites the just-saved local state.

4. **Touch scrolling on iPad** — Use `touch-action: pan-x pan-y` (Tailwind: `touch-pan-x touch-pan-y` or `touch-auto`) on the scroll container so single-finger pan is compositor-driven. Custom pointer logic only handles two-finger pinch (no native equivalent). Capturing pointer before the drag threshold will swallow seat taps.

5. **Layout change → state reconciliation** — When the layout changes (rows/seats), the stored seatStatus has orphan IDs and misses new IDs. Need to reconcile in the PUT /seating/layout handler: remove dead IDs, default new IDs to 'open'. (Currently a known gap — Task #3.)

## Geometry
`src/lib/geometry.ts` has `computeGeometry(layout)` returning `{ rowH, stageClearance, centerLeft, centerWidth, rightLeft, totalWidth, totalHeight, offsetX, offsetY, sections }`. The `sections` object maps section keys to their center point for snap-to-section navigation. Always destructure `centerWidth` from geometry; it is easy to forget and causes a runtime ReferenceError.

## AI analysis
Server-side via `/api/seating/analyze` — proxies to Anthropic API. Requires `ANTHROPIC_API_KEY` in Replit Secrets. Returns `{ text: string }`. The frontend never sees the key.

## Polling
2500ms interval (`POLL_MS = 2500`). Both Host and Display poll `/api/seating/state`. Summary comes from `/api/seating/summary` (server-computes open/total from layout + state so the browser doesn't need the full layout to show counts).
