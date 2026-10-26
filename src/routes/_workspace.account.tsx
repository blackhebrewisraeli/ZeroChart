import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_workspace/account')({
  head: () => ({
    meta: [
      { title: 'Account — ZeroChart' },
      {
        name: 'description',
        content: 'Subscription, TradingView webhook keys, data export and tracked holdings.',
      },
    ],
  }),
});
