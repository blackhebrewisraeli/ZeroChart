import { QueryClient } from '@tanstack/react-query';
import { createRouter, rootRouteId } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';

import { routeTree } from '@/routeTree.gen';

// Match routes without running loaders or rendering: loaders may need a server or
// network the test run lacks, and jsdom never loads the stylesheets React waits on.
describe('App routing', () => {
  it('matches a page for / instead of falling back to not found', () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });

    const matches = router.matchRoutes('/');

    expect(matches.at(-1)?.routeId).not.toBe(rootRouteId);
  });

  it('matches each workspace zone as its own route', () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });

    expect(router.matchRoutes('/').at(-1)?.routeId).toBe('/');
    expect(router.matchRoutes('/paper-trading').at(-1)?.routeId).toBe('/paper-trading');
    expect(router.matchRoutes('/account').at(-1)?.routeId).toBe('/account');
  });

  it('matches the public shared portfolio route without an auth-only route wrapper', () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });

    const matches = router.matchRoutes('/p/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    expect(matches.at(-1)?.routeId).toBe('/p/$portfolioId');
  });
});
