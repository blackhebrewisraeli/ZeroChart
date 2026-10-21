import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDevAuthUser } from '@/lib/authStore';

function at(url: string, env: { DEV?: boolean; MODE?: string } = {}) {
  vi.stubGlobal('location', new URL(url));
  vi.stubEnv('DEV', env.DEV ?? true);
  vi.stubEnv('MODE', env.MODE ?? 'development');
}

describe('readDevAuthUser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('returns a Basic stub user on localhost with ?devAuth=1', () => {
    at('http://localhost:8080/?devAuth=1');
    const user = readDevAuthUser();
    expect(user?.id).toBe('00000000-0000-4000-8000-000000000001');
    expect(user?.app_metadata['is_pro']).toBe(false);
  });

  it('grants Pro with ?devAuth=pro', () => {
    at('http://127.0.0.1:8080/?devAuth=pro');
    expect(readDevAuthUser()?.app_metadata['is_pro']).toBe(true);
  });

  it('accepts the IPv6 loopback host', () => {
    at('http://[::1]:8080/?devAuth=1');
    expect(readDevAuthUser()?.id).toBe('00000000-0000-4000-8000-000000000001');
  });

  it.each([
    ['production build', 'http://localhost:8080/?devAuth=1', { DEV: false, MODE: 'production' }],
    ['vitest run', 'http://localhost:8080/?devAuth=1', { MODE: 'test' }],
    ['non-localhost host', 'https://zerochart.vercel.app/?devAuth=1', {}],
    ['missing flag', 'http://localhost:8080/', {}],
    ['unknown flag value', 'http://localhost:8080/?devAuth=true', {}],
  ])('stays off for %s', (_label, url, env) => {
    at(url, env);
    expect(readDevAuthUser()).toBeNull();
  });
});
