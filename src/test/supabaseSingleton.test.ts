import { describe, expect, it, vi } from 'vitest';

/**
 * M1-T1 (F-4.2a / F-4.2b): every browser-side entry point must share ONE
 * canonical Supabase client. A second `createClient` in the same browser
 * context produces the "Multiple GoTrueClient instances detected" warning
 * (auth-js counts constructions per storage key via a module-level static),
 * so a fresh module graph with the former second-client entry points
 * (assets data, serverFn auth attacher) imported must stay silent.
 */
describe('Supabase client consolidation', () => {
  it('constructs one client across all entry points with zero GoTrueClient warnings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.resetModules(); // fresh module graph => fresh GoTrueClient static counters
      await import('@/lib/supabaseClient');
      await import('@/lib/assets');
      await import('@/integrations/supabase/auth-attacher');

      const calls = [...warn.mock.calls, ...error.mock.calls];
      const duplicateWarnings = calls.filter((args) =>
        args.some((arg) => String(arg).includes('Multiple GoTrueClient')),
      );
      expect(duplicateWarnings).toEqual([]);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
