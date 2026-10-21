import { afterEach, describe, expect, it } from 'vitest';
import { authStorage, setRememberMe } from '@/lib/supabaseClient';

const KEY = 'sb-test-auth-token';

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('Keep me signed in', () => {
  it('persists the session in localStorage by default and when remembered', () => {
    authStorage.setItem(KEY, 'default');
    expect(localStorage.getItem(KEY)).toBe('default');

    setRememberMe(true);
    authStorage.setItem(KEY, 'remembered');
    expect(localStorage.getItem(KEY)).toBe('remembered');
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(authStorage.getItem(KEY)).toBe('remembered');
  });

  it('keeps an unremembered session in sessionStorage only', () => {
    localStorage.setItem(KEY, 'stale');
    setRememberMe(false);
    authStorage.setItem(KEY, 'tab-only');

    expect(sessionStorage.getItem(KEY)).toBe('tab-only');
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(authStorage.getItem(KEY)).toBe('tab-only');
  });

  it('keeps a tab-only session tab-only when another tab later picks remember', () => {
    setRememberMe(false);
    authStorage.setItem(KEY, 'tab-only');
    setRememberMe(true); // another tab signs in with the box checked
    authStorage.setItem(KEY, 'refreshed');

    expect(sessionStorage.getItem(KEY)).toBe('refreshed');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('never hides a session that sits in the other store', () => {
    localStorage.setItem(KEY, 'remembered');
    setRememberMe(false);
    expect(authStorage.getItem(KEY)).toBe('remembered');
  });

  it('clears both stores on sign-out', () => {
    localStorage.setItem(KEY, 'a');
    sessionStorage.setItem(KEY, 'b');
    authStorage.removeItem(KEY);

    expect(localStorage.getItem(KEY)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
});
