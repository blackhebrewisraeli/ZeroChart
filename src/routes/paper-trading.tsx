import { createFileRoute } from '@tanstack/react-router';
import { Workspace } from '@/components/Workspace';

export const Route = createFileRoute('/paper-trading')({
  head: () => ({
    meta: [
      { title: 'Paper Trading Terminal — ZeroChart' },
      {
        name: 'description',
        content:
          'Trade tactical signals with simulated fills: realized and open P&L, positions and fills in one paper terminal.',
      },
    ],
  }),
  // Same component as `/`, so switching workspaces keeps the shell (and its live feed) mounted.
  component: Workspace,
});
