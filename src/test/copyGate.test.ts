import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Copy gate (M1-T4, F-6.1c): user-facing surfaces describing the Robo-Advisor
 * must not brand the deterministic multi-factor engine as "AI". "AI" is
 * reserved for a future, PO-gated explanation layer (roadmap M2-11).
 */
const SURFACES = [
  'src/components/LandingPage.tsx',
  'src/components/RoboAdvisor.tsx',
  'src/routes/index.tsx',
  'src/lib/tourSteps.ts',
  'README.md',
];

describe('Robo-Advisor branding copy gate', () => {
  it.each(SURFACES)('%s contains no standalone "AI" branding', (file) => {
    const source = readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
    expect(source).not.toMatch(/\bAI\b/);
  });
});
