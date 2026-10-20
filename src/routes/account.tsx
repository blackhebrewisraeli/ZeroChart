import { createFileRoute } from '@tanstack/react-router';
import { Workspace } from '@/components/Workspace';

export const Route = createFileRoute('/account')({
  head: () => ({
    meta: [
      { title: 'Account — ZeroChart' },
      {
        name: 'description',
        content: 'Subscription, TradingView webhook keys, data export and tracked holdings.',
      },
    ],
  }),
  // Same component as `/`, so switching zones keeps the shell (and its live feed) mounted.
  component: Workspace,
});
