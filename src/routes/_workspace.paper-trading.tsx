import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_workspace/paper-trading')({
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
});
