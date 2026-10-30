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
  type LoadedOpportunityCampaign,
  type OpportunityReproduction,
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
  /** Its own slot, or the slot its transition was judged against, is unverified: held, never claimed. */
  originUnverified: number;
  /** A later slot on record is unverified, so it is no evidence either way: held, not cancelled. */
  evidenceUnverified: number;
  /** Each slot that failed verification while deciding a send, once, by reason. */
  unverifiedSlots: Record<SlotVerificationFailure, number>;
  exhausted: number;
}

/** Why an undelivered Opportunity is not sent now; each is a NotificationSummary count. */
export type DeliveryHold =
  'expired' | 'invalidated' | 'marketGateFailed' | 'evidenceUnavailable' | 'evidenceUnverified';

/** Checked in this order; the first that applies is reported. */
export type SlotVerificationFailure =
  | 'UNSUPPORTED_SCHEMA'
  | 'NOT_REPRODUCED'
  | 'REPRODUCTION_MISMATCH'
  | 'PREDECESSOR_CHANGED'
  | 'PREDECESSOR_UNVERIFIED';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * The latest network-blocked reproduction of exactly these slot bytes that the
 * manifest's own implementation commit wrote and that was on record at `now`.
 * Receipts for other bytes, slots, campaigns or code are not about this
 * evidence. At equal times a MISMATCH wins.
 */
async function reproduced(
  { directory, manifest }: LoadedOpportunityCampaign,
  slot: string,
  bytes: string,
  now: number,
): Promise<OpportunityReproduction['status'] | null> {
  const digest = sha256(bytes);
  const receipts = await readRecords<OpportunityReproduction>(
    resolve(opportunitySlotDirectory(directory, slot), 'reproductions'),
    /\.json$/,
  );
  return (
    receipts
      .filter(
        (receipt) =>
          receipt.campaignId === manifest.campaignId &&
          receipt.slot === slot &&
          receipt.slotSha256 === digest &&
          receipt.networkBlocked === true &&
          receipt.reproducerCommit === manifest.implementationCommit &&
          Date.parse(receipt.reproducedAt) <= now,
      )
      .sort(
        (a, b) =>
          a.reproducedAt.localeCompare(b.reproducedAt) ||
          Number(a.status === 'MISMATCH') - Number(b.status === 'MISMATCH'),
      )
      .at(-1)?.status ?? null
  );
}

/**
 * Whether a completed slot may be read as delivery evidence: its current bytes
 * are a supported schema and reproduced MATCH offline (see `reproduced`), and
 * the calendar-previous slot its transitions were judged against still has the
 * bytes it links to, themselves reproduced MATCH. The frozen implementation
 * writes the receipts; reproducing here would be a second evaluator at another
 * commit. Nothing is fetched or written.
 */
async function slotVerificationFailure(
  campaign: LoadedOpportunityCampaign,
  slot: string,
  bytes: string,
  now: number,
): Promise<SlotVerificationFailure | null> {
  const artifact = JSON.parse(bytes) as OpportunitySlotArtifact;
  if (artifact.schemaVersion !== OPPORTUNITY_SLOT_SCHEMA_VERSION) return 'UNSUPPORTED_SCHEMA';
  const status = await reproduced(campaign, slot, bytes, now);
  if (status === null) return 'NOT_REPRODUCED';
  if (status === 'MISMATCH') return 'REPRODUCTION_MISMATCH';
  const previousSlot = new Date(Date.parse(slot) - DAY_MS).toISOString();
  const previous = await readIfPresent(
    resolve(opportunitySlotDirectory(campaign.directory, previousSlot), 'slot.json'),
  );
  if ((previous === null ? null : sha256(previous)) !== (artifact.previous?.sha256 ?? null)) {
    return 'PREDECESSOR_CHANGED';
  }
  if (previous !== null && (await reproduced(campaign, previousSlot, previous, now)) !== 'MATCH') {
    return 'PREDECESSOR_UNVERIFIED';
  }
  return null;
}

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
 * the day. Cancelling needs positive evidence; a gap only holds delivery, and
 * an UNVERIFIED slot is read as neither.
 */
export function deliveryHold(
  opportunity: Opportunity,
  laterSlots: ReadonlyArray<OpportunitySlotArtifact | 'UNVERIFIED' | null>,
  now: number,
): DeliveryHold | null {
  if (now >= opportunity.expiresAt) return 'expired';
  // The anchor is the last candle that closed before the observation's UTC day.
  const afterAnchor = Math.floor(opportunity.evaluationTime / DAY_MS) * DAY_MS;
  let unavailable = false;
  let unverified = false;
  for (const slot of laterSlots) {
    if (slot === 'UNVERIFIED') {
      unverified = true;
      continue;
    }
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
  if (unverified) return 'evidenceUnverified';
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
 * Sends each persisted Opportunity at most once, only from a verified slot
 * (`slotVerificationFailure`) and while `deliveryHold` finds it still valid on
 * verified later slots. Verification comes before any claim or transport call,
 * so a refused slot is never sent, whichever run or command reaches it. The
 * completed slot files are the immutable outbox; delivery state lives only
 * under notifications/, so no transport outcome, hold or verification can
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
  const campaign = await loadOpportunityCampaign(
    options.store,
    options.campaignId,
    options.specificationPath,
  );
  const { directory, manifest, runtime } = campaign;
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
    originUnverified: 0,
    evidenceUnverified: 0,
    unverifiedSlots: {
      UNSUPPORTED_SCHEMA: 0,
      NOT_REPRODUCED: 0,
      REPRODUCTION_MISMATCH: 0,
      PREDECESSOR_CHANGED: 0,
      PREDECESSOR_UNVERIFIED: 0,
    },
    exhausted: 0,
  };
  interface Recorded {
    slot: string;
    time: number;
    bytes: string;
    artifact: OpportunitySlotArtifact;
  }
  const recorded: Array<Recorded | { slot: string; time: number; artifact: null }> = [];
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
    recorded.push(
      bytes !== null && artifact !== null && onRecord
        ? { slot: entry.slot, time, bytes, artifact }
        : { slot: entry.slot, time, artifact: null },
    );
  }
  // Each slot is verified at most once per run, and only when a send depends on it.
  const verifications = new Map<string, SlotVerificationFailure | null>();
  const verified = async (item: Recorded) => {
    if (!verifications.has(item.slot)) {
      const failure = await slotVerificationFailure(campaign, item.slot, item.bytes, now);
      if (failure !== null) summary.unverifiedSlots[failure] += 1;
      verifications.set(item.slot, failure);
    }
    return verifications.get(item.slot) === null;
  };
  for (const origin of recorded) {
    const { time, artifact } = origin;
    if (artifact === null) continue;
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
      // Expiry first: an unverified slot stops being reported once nothing could be sent.
      if (now >= opportunity.expiresAt) {
        summary.expired += 1;
        continue;
      }
      if (!(await verified(origin))) {
        summary.originUnverified += 1;
        continue;
      }
      const laterSlots: Array<OpportunitySlotArtifact | 'UNVERIFIED' | null> = [];
      for (const item of recorded.filter((entry) => entry.time > time)) {
        if (item.artifact === null) laterSlots.push(null);
        else laterSlots.push((await verified(item)) ? item.artifact : 'UNVERIFIED');
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
            messageSha256: sha256(text),
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
