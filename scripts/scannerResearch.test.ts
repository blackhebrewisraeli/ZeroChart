import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { stableSerialize } from './evaluationStore';
import { RESEARCH_SPECIFICATION, RESEARCH_SPECIFICATION_ID } from './scannerResearch';

describe('retrospective scanner study specification', () => {
  it('keeps the frozen machine-readable specification aligned with code', async () => {
    const documented = JSON.parse(
      await readFile('docs/scanner-research.v1.json', 'utf8'),
    ) as unknown;
    expect(stableSerialize(documented)).toBe(stableSerialize(RESEARCH_SPECIFICATION));
    expect(RESEARCH_SPECIFICATION_ID).toBe(
      'ab0d42aa14413cd2f05a2b29a516c85502aa0ff410652375a8390eb0860bebdf',
    );
  });
});
