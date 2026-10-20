import { createFileRoute } from '@tanstack/react-router';
import { Workspace } from '@/components/Workspace';

export const Route = createFileRoute('/paper-trading')({
  head: () => ({
    meta: [
      { title: 'Paper Trading Terminal — ZeroChart' },
      {
        name: 'description',
        content:
          'Simulation mode: trade tactical signals with simulated fills, track paper P&L and backtest a simulated portfolio. No real money.',
      },
    ],
  }),
  // Same component as `/`, so switching zones keeps the shell (and its live feed) mounted.
  component: Workspace,
});
