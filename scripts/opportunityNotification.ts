import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Opportunity } from '@/lib/opportunityRadar';
import {
  loadOpportunityCampaign,
  opportunitySlotDirectory,
  readIfPresent,
  serialize,
  type OpportunitySlotArtifact,
} from './opportunityCampaign';
import type { NotificationTransport, TransportResult } from './telegramTransport';

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
  exhausted: number;
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
 * Sends each persisted, unexpired Opportunity at most once. The completed
 * slot files are the immutable outbox; delivery state lives only under
 * notifications/, so no transport outcome can change study evidence. A send
 * whose outcome is unknown is never repeated automatically.
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
    exhausted: 0,
  };
  for (const entry of manifest.slots) {
    if (Date.parse(entry.slot) > now) break;
    const bytes = await readIfPresent(
      resolve(opportunitySlotDirectory(directory, entry.slot), 'slot.json'),
    );
    if (bytes === null) continue;
    const artifact = JSON.parse(bytes) as OpportunitySlotArtifact;
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
      if (now >= opportunity.expiresAt) {
        summary.expired += 1;
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
