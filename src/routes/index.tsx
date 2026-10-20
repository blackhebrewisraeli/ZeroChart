import { createFileRoute } from '@tanstack/react-router';
import { Workspace } from '@/components/Workspace';

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'ZeroChart — Quant research and paper trading' },
      {
        name: 'description',
        content:
          'A quantitative research and paper trading environment. Understand, backtest, and simulate multifactor signals with live charts.',
      },
      { property: 'og:title', content: 'ZeroChart — Quant research and paper trading' },
      {
        property: 'og:description',
        content: 'Understand, backtest, and simulate multifactor signals.',
      },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
  }),
  component: Workspace,
});
