import { createFileRoute } from '@tanstack/react-router';
import { Workspace } from '@/components/Workspace';

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): { view?: 'scanner' } =>
    search['view'] === 'scanner' ? { view: 'scanner' } : {},
  head: () => ({
    meta: [
      { title: 'ZeroChart — Signal over noise' },
      {
        name: 'description',
        content:
          'An algorithmic signal terminal with live charts for long-term conviction and asymmetric opportunities. Track clear asset signals with ZeroChart.',
      },
      { property: 'og:title', content: 'ZeroChart — Signal over noise' },
      {
        property: 'og:description',
        content:
          'Stable and radar asset signals in one focused, algorithmic signal terminal with live charts.',
      },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
  }),
  component: Workspace,
});
