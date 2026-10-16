import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Authoritative Drizzle schema for every table the application queries
 * (M1-T1, finding F-3.1a).
 *
 * This file was previously an intentionally blank stub while hand-written
 * migrations drifted from the live schema (`symbol` vs `ticker`, missing
 * indicator columns). It now defines `assets_status`, `user_portfolios`, and
 * `user_alerts` as the single source of truth; the idempotent reconciliation
 * migration `drizzle/migrations/0002_reconcile_schema_baseline.sql` mirrors it
 * for existing/fresh databases.
 *
 * NOTE: foreign keys to `auth.users(id)` (and the owner-scoped RLS policies)
 * are defined in the SQL migration only — the auth schema is managed by
 * Supabase and is intentionally not represented here.
 */

export const assetsStatus = pgTable(
  'assets_status',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ticker: text('ticker').notNull(),
    name: text('name'),
    currentPrice: numeric('current_price'),
    stableSignal: text('stable_signal'),
    stableExplanation: text('stable_explanation'),
    radarSignal: text('radar_signal'),
    radarExplanation: text('radar_explanation'),
    riskPct: numeric('risk_pct'),
    rewardPct: numeric('reward_pct'),
    volumeSpike: numeric('volume_spike'),
    rsi14: numeric('rsi_14'),
    sma50: numeric('sma_50'),
    sma200: numeric('sma_200'),
    change24h: numeric('change_24h'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tickerUnique: unique('assets_status_ticker_key').on(t.ticker),
    stableSignalCheck: check(
      'assets_status_stable_signal_check',
      sql`stable_signal IN ('Green', 'Yellow', 'Red')`,
    ),
    radarSignalCheck: check(
      'assets_status_radar_signal_check',
      sql`radar_signal IN ('Green', 'Yellow', 'Red')`,
    ),
  }),
);

export const userPortfolios = pgTable(
  'user_portfolios',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull(), // REFERENCES auth.users(id) — see 0002 migration
    positions: jsonb('positions')
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdUnique: unique('user_portfolios_user_id_key').on(t.userId),
  }),
);

export const userAlerts = pgTable(
  'user_alerts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull(), // REFERENCES auth.users(id) ON DELETE CASCADE — see 0002
    ticker: text('ticker').notNull(),
    targetPrice: numeric('target_price').notNull(),
    condition: text('condition').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userActiveIdx: index('user_alerts_user_id_active_idx').on(t.userId, t.isActive),
    targetPriceCheck: check('user_alerts_target_price_check', sql`target_price > 0`),
    conditionCheck: check('user_alerts_condition_check', sql`condition IN ('above', 'below')`),
  }),
);
