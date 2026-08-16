import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

// Simple key-value store for seating app data.
// All seating state (layout, seat status, baseline, history) is stored here
// as JSONB values. This mirrors the file-backed KV store from the original
// Claude artifact but uses PostgreSQL for reliability and crash safety.
export const seatingStore = pgTable("seating_store", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
