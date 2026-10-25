import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initializeCampaign, runDueCampaign } from './observationCampaign';
import {
  buildCampaignReportModel,
  buildSyntheticReportModel,
  renderDecisionsReport,
} from './decisionsReport';

const day = 24 * 60 * 60 * 1000;

function candles(slot: number) {
  return Array.from({ length: 45 }, (_, index) => {
    const timestamp = slot - (45 - index) * day;
    const close = 100 + index;
    return { timestamp, open: close - 0.5, high: close + 1, low: close - 1, close };
  });
}

async function digestTree(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      hash.update(path.slice(root.length));
      if (entry.isDirectory()) await visit(path);
      else hash.update(await readFile(path));
    }
  }
  await visit(root);
  return hash.digest('hex');
}

async function campaignFixture() {
  const store = await mkdtemp(join(tmpdir(), 'zerochart-report-'));
  const campaignId = 'report-test-campaign';
  const slot = '2027-01-02T06:30:00.000Z';
  await initializeCampaign({
    campaignId,
    start: slot,
    end: slot,
    repositoryCommit: 'a'.repeat(40),
    store,
    now: new Date('2027-01-01T06:30:00.000Z'),
  });
  await runDueCampaign(campaignId, store, {
    now: new Date(slot),
    fetchCandles: async () => candles(Date.parse(slot)),
  });
  return { store, campaignId, slot, root: join(store, campaignId) };
}

describe('Decisions & Evidence report', () => {
  it('provides selected, rejected, and qualified-not-selected synthetic outcomes', () => {
    const model = buildSyntheticReportModel();
    const statuses = model.observations[0]!.decisions.map((decision) => decision.selectionStatus);
    expect(statuses).toContain('SELECTED');
    expect(statuses).toContain('QUALIFIED_NOT_SELECTED');
    expect(statuses).toContain('NOT_ELIGIBLE');
    expect(model.campaign.evidenceType).toBe('synthetic-demonstration');
  });

  it('keeps campaign counts aligned and distinguishes eligibility from selection', async () => {
    const { store, campaignId } = await campaignFixture();
    const model = await buildCampaignReportModel(
      campaignId,
      store,
      new Date('2027-01-02T07:00:00.000Z'),
    );
    expect(model.campaign.counts).toMatchObject({ expected: 1, completed: 1 });
    expect(model.observations).toHaveLength(1);
    const decisions = model.observations[0]!.decisions;
    expect(decisions).toHaveLength(5);
    for (const decision of decisions) {
      expect(decision.status === 'ELIGIBLE').toBe(decision.selectionStatus !== 'NOT_ELIGIBLE');
    }
  });

  it('shows missing reproduction evidence without treating load as reproduction', async () => {
    const { store, campaignId } = await campaignFixture();
    const model = await buildCampaignReportModel(campaignId, store);
    expect(model.observations[0]!.reproduction).toEqual({
      status: 'MISSING',
      reproducedAt: null,
      networkBlocked: null,
    });
    expect(renderDecisionsReport(model)).toContain('Reproduction ');
  });

  it('renders tampered artifacts as visible actionable errors', async () => {
    const { store, campaignId, root } = await campaignFixture();
    const manifestPath = join(root, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      configuration: { configurationId: string };
    };
    manifest.configuration.configurationId = 'tampered';
    await writeFile(manifestPath, JSON.stringify(manifest));
    const model = await buildCampaignReportModel(campaignId, store);
    expect(model.errors[0]).toContain('failed integrity validation');
    expect(model.observations).toEqual([]);
    expect(renderDecisionsReport(model)).toContain('Artifact errors');
  });

  it('escapes untrusted artifact strings so they cannot create scripts', () => {
    const model = buildSyntheticReportModel();
    model.campaign.id = '</script><script>globalThis.pwned=true</script>';
    model.observations[0]!.decisions[0]!.asset = '<img src=x onerror=globalThis.pwned=true>';
    const html = renderDecisionsReport(model);
    expect(html).not.toContain('</script><script>globalThis.pwned=true</script>');
    expect(html).not.toContain('<img src=x onerror=globalThis.pwned=true>');
    expect(html).toContain('\\u003c/script\\u003e');
  });

  it('is self-contained and explicitly blocks network connections', () => {
    const html = renderDecisionsReport(buildSyntheticReportModel());
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toMatch(/<(?:script|link|img)[^>]+(?:src|href)=["']https?:/i);
  });

  it('does not modify source campaign artifacts while generating', async () => {
    const { store, campaignId, root } = await campaignFixture();
    const before = await digestTree(root);
    await buildCampaignReportModel(campaignId, store);
    expect(await digestTree(root)).toBe(before);
  });
});
