# Church Seating Availability

A real-time church seating availability system with two linked screens: an iPad "Host Controls" screen where the seating team marks seats open/unavailable, and a TV "Seating Availability" display at the entrance that updates live.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080, proxied at /api)
- `pnpm --filter @workspace/seating-app run dev` — run the frontend (port 24581, proxied at /)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Optional env: `ANTHROPIC_API_KEY` — for AI analysis on the History screen (add in Replit Secrets)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 (in artifacts/api-server)
- DB: PostgreSQL + Drizzle ORM (seating_store table — JSONB key-value store)
- Frontend: React + Vite + Tailwind v4, wouter routing, TanStack Query
- Validation: Zod (v4), drizzle-zod
- API codegen: Orval (from OpenAPI spec in lib/api-spec/openapi.yaml)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — API contract (single source of truth)
- `lib/db/src/schema/seating.ts` — seating_store JSONB KV table
- `artifacts/api-server/src/routes/seating.ts` — all seating endpoints
- `artifacts/seating-app/src/` — React frontend
  - `src/context/seating-context.tsx` — global state (layout, seatStatus, eventLog refs)
  - `src/components/seating-canvas.tsx` — RoomCanvas, ZoomPane, Legend
  - `src/lib/geometry.ts` — computeGeometry, seatId, allSeatIds helpers
  - `src/pages/host.tsx` — iPad host controls
  - `src/pages/display.tsx` — TV display (fullscreen, auto-fit)
  - `src/pages/setup.tsx` — room layout editor with live preview
  - `src/pages/history.tsx` — gathering history + AI analysis

## Architecture decisions

- **PostgreSQL JSONB as KV store**: All seating data (layout, state, baseline, history index + records) stored as keyed JSONB rows in `seating_store`. Simpler than a full relational schema for this use case; survives restarts unlike the original file-based store.
- **Seat ID format**: `"L-r0-s0"` (section letter L/C/R, row index, seat index within row). Used as keys in the seatStatus map.
- **Save debounce + in-flight serialization**: Seat toggle writes to a ref immediately (never a stale state closure), then debounces 350ms before actually saving. Only one save in flight at a time; if edits arrive while saving, we re-send with the latest ref value after the current save finishes. Prevents rapid-tap race conditions.
- **Native touch scrolling on iPad**: ZoomPane uses `touch-action: pan-x pan-y` so single-finger panning is compositor-driven (hardware-accelerated). Custom pointer logic only handles two-finger pinch-zoom and mouse drag, since those have no native equivalent.
- **Real-time sync via polling**: Both host and display screens poll `/api/seating/state` every 2500ms. `skipNextPoll` ref prevents the poll right after a local save from overwriting the just-committed local state.
- **AI analysis server-side**: ANTHROPIC_API_KEY stays in Replit Secrets; the `/api/seating/analyze` endpoint proxies to Anthropic's API. The browser never sees the key.

## Product

- **Host Controls** (`/`): iPad screen. Visual room map with 3 sections (left/center/right, outer sections angled inward). Tap any seat to toggle open (green) ↔ unavailable (gray). Bulk "Mark all open / full" buttons. "Submit Final" archives the gathering and resets seats for the next service.
- **TV Display** (`/display`): Fullscreen, read-only. Shows room map scaled to fit any TV, open seat count, legend, welcome message, and last-updated timestamp. Small hidden button to switch to Host Controls.
- **Room Layout Editor** (`/setup`): Split-panel — controls on left (±buttons for rows, seats/row, angles, aisle width, spacing), live visual preview on right that updates as you type. Baseline row count management for tracking extra rows added on busy weeks.
- **Gathering History** (`/history`): Archives every submitted gathering (date, name, fill %, extra rows vs. baseline). Select 1 for detailed analysis or multiple for trend analysis using Claude.

## User preferences

- Dark theme preferred (better for TV and iPad in bright rooms)
- No emojis in UI
- Replit Secrets used for ANTHROPIC_API_KEY (not hardcoded)

## Gotchas

- The `Field` component in setup.tsx MUST be defined at module scope (not inside a component body). If defined inside a component, React recreates the DOM input on every re-render, yanking iPad keyboard focus. 
- Never use `setPointerCapture` on a touch-start before confirming it's a drag (not a seat tap). Only capture after the pointer moves past the `DRAG_THRESHOLD`.
- Sections can have different row counts — geometry math accounts for this. Don't assume left.rows === center.rows === right.rows.
- After codegen changes, run `pnpm run typecheck:libs` before artifact typechecks so declarations are fresh.
