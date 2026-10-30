import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Opportunity, OpportunityMarketGateReason } from '@/lib/opportunityRadar';
import {
  loadOpportunityCampaign,
  OPPORTUNITY_SLOT_SCHEMA_VERSION,
  opportunitySlotDirectory,
  readIfPresent,
  serialize,
  type OpportunitySlotArtifact,
} from './opportunityCampaign';
import type { NotificationTransport, TransportResult } from './telegramTransport';

const DAY_MS = 86_400_000;

/** Definite rejections (Telegram answered "not sent") retried at most this many times. */
export const MAX_NOTIFICATION_ATTEMPTS = 3;

/** Written before a send; an attempt without a result means delivery is unknown. */
export interface NotificationAttempt {
  schemaVersion: '1';
  opportunityId: string;
  channel: string;
  attempt: number;
  startedAt: string;
  messageSha256: string;
}

export interface NotificationResult {
  schemaVersion: '1';
  opportunityId: string;
  channel: string;
  attempt: number;
  finishedAt: string;
  result: TransportResult;
}

/** Counts only: never tickers, prices or message text. */
export interface NotificationSummary {
  delivered: number;
  rejected: number;
  unknown: number;
  alreadyDelivered: number;
  /** An earlier send may have arrived; never resent automatically. Check the chat. */
  unresolved: number;
  expired: number;
  /** A later recorded daily low reached the invalidation level. */
  invalidated: number;
  /** A later completed slot's BTC market gate failed. */
  marketGateFailed: number;
  /** A later due slot, or its BTC or member data, is not on record: held, not cancelled. */
  evidenceUnavailable: number;
  /** From a slot of another schema version; never sent. */
  incompatible: number;
  exhausted: number;
}

/** Why an undelivered Opportunity is not sent now; each is a NotificationSummary count. */
export type DeliveryHold = 'expired' | 'invalidated' | 'marketGateFailed' | 'evidenceUnavailable';

/** The gate could not be judged on that slot, which is no evidence either way. */
const GATE_NOT_JUDGED: ReadonlySet<OpportunityMarketGateReason> = new Set([
  'MARKET_NOT_EVALUATED',
  'MARKET_INSUFFICIENT_HISTORY',
]);

/**
 * The contract's `opportunity.expires`, judged only from evidence on record at
 * `now`: one entry per campaign slot after observedAt that is due by `now`, null
 * when that slot had not completed by then. A slot holds only candles that
 * closed before it, so no later candle is read. A daily low at or below the
 * invalidation level proves a touch by that candle's close, never when within
 * the day. Cancelling needs positive evidence; a gap only holds delivery.
 */
export function deliveryHold(
  opportunity: Opportunity,
  laterSlots: ReadonlyArray<OpportunitySlotArtifact | null>,
  now: number,
): DeliveryHold | null {
  if (now >= opportunity.expiresAt) return 'expired';
  // The anchor is the last candle that closed before the observation's UTC day.
  const afterAnchor = Math.floor(opportunity.evaluationTime / DAY_MS) * DAY_MS;
  let unavailable = false;
  for (const slot of laterSlots) {
    if (slot === null) {
      unavailable = true;
      continue;
    }
    const { marketGate, assets } = slot.result;
    if (marketGate.reasons.some((reason) => GATE_NOT_JUDGED.has(reason))) unavailable = true;
    else if (!marketGate.passed) return 'marketGateFailed';
    const evaluated = assets.some(
      (asset) => asset.ticker === opportunity.ticker && asset.scannerStatus === 'EVALUATED',
    );
    const candles = slot.inputs.find((input) => input.ticker === opportunity.ticker)?.candles;
    if (!evaluated || candles === undefined) unavailable = true;
    else if (
      candles.some(
        (candle) => candle.timestamp >= afterAnchor && candle.low <= opportunity.invalidation,
      )
    ) {
      return 'invalidated';
    }
  }
  return unavailable ? 'evidenceUnavailable' : null;
}

const iso = (time: number) => new Date(time).toISOString();
const utc = (time: number) => `${iso(time).slice(0, 16).replace('T', ' ')} UTC`;
const price = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : String(Number(value.toPrecision(6)));

/** Every field docs/opportunity-radar.v1.json requires of an alert, as plain text. */
export function opportunityMessage(
  artifact: OpportunitySlotArtifact,
  opportunity: Opportunity,
  benchmark: string,
): string {
  const scanned = artifact.result.scan.results.find((item) => item.ticker === opportunity.ticker);
  const gate = artifact.result.assets.find((item) => item.ticker === benchmark);
  const regime = (value: string | null | undefined) =>
    (value ?? 'unknown').replaceAll('_', ' ').toLowerCase();
  return [
    'ZeroChart Opportunity Radar · research signal',
    `${opportunity.ticker} (${opportunity.instrument}) · score ${opportunity.score} · ${regime(opportunity.regime)} regime`,
    `Entry zone ${price(opportunity.entryZone.low)} – ${price(opportunity.entryZone.high)} (first ${opportunity.validDailyOpens} daily opens)`,
    `Invalidation ${price(opportunity.invalidation)}`,
    `Primary horizon ${opportunity.primaryHorizonDays} days · expires ${utc(opportunity.expiresAt)}`,
    `Observed ${utc(opportunity.evaluationTime)} · data as of ${scanned?.dataAsOf ? utc(scanned.dataAsOf) : '—'}`,
    `Why: ${scanned?.model?.rationale ?? '—'}`,
    `Market gate (${benchmark}): close ${price(gate?.close)} > SMA200 ${price(gate?.smaSlow)}; SMA50 ${price(gate?.smaFast)} > SMA200; ${regime(gate?.regime)} regime · ${artifact.result.marketGate.passed ? 'passed' : 'closed'}`,
    `Model ${artifact.result.scan.modelVersion} · specification ${opportunity.specificationId.slice(0, 12)} · ${opportunity.id}`,
    'Research signal only, not financial advice. No order is placed.',
  ].join('\n');
}

async function readRecords<T>(directory: string, pattern: RegExp): Promise<T[]> {
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  const records: T[] = [];
  for (const name of names.filter((item) => pattern.test(item))) {
    records.push(JSON.parse((await readIfPresent(resolve(directory, name)))!) as T);
  }
  return records;
}

/**
 * Sends each persisted Opportunity at most once, while `deliveryHold` finds it
 * still valid. The completed slot files are the immutable outbox; delivery
 * state lives only under notifications/, so no transport outcome or hold can
 * change study evidence or which Opportunities the study counts. A send whose
 * outcome is unknown is never repeated automatically.
 */
export async function deliverOpportunityNotifications(options: {
  campaignId: string;
  store: string;
  transport: NotificationTransport;
  now?: () => number;
  specificationPath?: string;
}): Promise<NotificationSummary> {
  const clock = options.now ?? Date.now;
  const { directory, manifest, runtime } = await loadOpportunityCampaign(
    options.store,
    options.campaignId,
    options.specificationPath,
  );
  const now = clock();
  const summary: NotificationSummary = {
    delivered: 0,
    rejected: 0,
    unknown: 0,
    alreadyDelivered: 0,
    unresolved: 0,
    expired: 0,
    invalidated: 0,
    marketGateFailed: 0,
    evidenceUnavailable: 0,
    incompatible: 0,
    exhausted: 0,
  };
  const recorded: Array<{ time: number; artifact: OpportunitySlotArtifact | null }> = [];
  for (const entry of manifest.slots) {
    const time = Date.parse(entry.slot);
    if (time > now) break;
    const bytes = await readIfPresent(
      resolve(opportunitySlotDirectory(directory, entry.slot), 'slot.json'),
    );
    const artifact = bytes === null ? null : (JSON.parse(bytes) as OpportunitySlotArtifact);
    // A slot whose collection finished after `now` was not yet evidence at `now`.
    const finishedAt = artifact?.attempts.at(-1)?.finishedAt;
    const onRecord = finishedAt !== undefined && Date.parse(finishedAt) <= now;
    recorded.push({ time, artifact: onRecord ? artifact : null });
  }
  for (const { time, artifact } of recorded) {
    if (artifact === null) continue;
    const laterSlots = recorded.filter((item) => item.time > time).map((item) => item.artifact);
    for (const opportunity of artifact.result.opportunities) {
      const folder = resolve(
        directory,
        'notifications',
        opportunity.id.replace('|', '_').replaceAll(':', '-'),
      );
      const attempts = await readRecords<NotificationAttempt>(folder, /^attempt-\d+\.json$/);
      const results = await readRecords<NotificationResult>(folder, /^result-\d+\.json$/);
      if (results.some((item) => item.result.status === 'DELIVERED')) {
        summary.alreadyDelivered += 1;
        continue;
      }
      if (
        attempts.length > results.length ||
        results.some((item) => item.result.status === 'UNKNOWN')
      ) {
        summary.unresolved += 1;
        continue;
      }
      if (artifact.schemaVersion !== OPPORTUNITY_SLOT_SCHEMA_VERSION) {
        summary.incompatible += 1;
        continue;
      }
      const hold = deliveryHold(opportunity, laterSlots, now);
      if (hold !== null) {
        summary[hold] += 1;
        continue;
      }
      if (results.length >= MAX_NOTIFICATION_ATTEMPTS) {
        summary.exhausted += 1;
        continue;
      }

      const text = opportunityMessage(artifact, opportunity, runtime.marketGate.benchmark);
      const attempt = attempts.length + 1;
      await mkdir(folder, { recursive: true });
      try {
        // Exclusive: a second runner reaching the same attempt must not send again.
        await writeFile(
          resolve(folder, `attempt-${attempt}.json`),
          serialize({
            schemaVersion: '1',
            opportunityId: opportunity.id,
            channel: options.transport.channel,
            attempt,
            startedAt: iso(clock()),
            messageSha256: createHash('sha256').update(text).digest('hex'),
          } satisfies NotificationAttempt),
          { flag: 'wx', mode: 0o600 },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        summary.unresolved += 1;
        continue;
      }
      let result: TransportResult;
      try {
        result = await options.transport.send(text);
      } catch {
        result = { status: 'UNKNOWN', reason: 'NETWORK_ERROR' };
      }
      await writeFile(
        resolve(folder, `result-${attempt}.json`),
        serialize({
          schemaVersion: '1',
          opportunityId: opportunity.id,
          channel: options.transport.channel,
          attempt,
          finishedAt: iso(clock()),
          result,
        } satisfies NotificationResult),
        { flag: 'wx', mode: 0o600 },
      );
      if (result.status === 'DELIVERED') summary.delivered += 1;
      else if (result.status === 'REJECTED') summary.rejected += 1;
      else summary.unknown += 1;
    }
  }
  return summary;
}

/** The owner's manual delivery check: clearly synthetic, touches no campaign. */
export const SYNTHETIC_NOTIFICATION =
  'ZeroChart Opportunity Radar · SYNTHETIC DELIVERY TEST\nNot a signal. If you can read this, Telegram delivery works.';
