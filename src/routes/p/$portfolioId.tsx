import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, LoaderCircle } from 'lucide-react';
import { SharedPortfolioView } from '@/components/SharedPortfolioView';
import { fetchSharedPortfolio } from '@/lib/sharedPortfolio';

export const Route = createFileRoute('/p/$portfolioId')({
  head: () => ({
    meta: [
      { title: 'Public Quant Portfolio — ZeroChart' },
      {
        name: 'description',
        content: 'View a read-only ZeroChart portfolio snapshot with allocation and quant scores.',
      },
      { property: 'og:title', content: 'Public Quant Portfolio — ZeroChart' },
      {
        property: 'og:description',
        content: 'A public, read-only portfolio snapshot built with ZeroChart.',
      },
    ],
  }),
  component: SharedPortfolioRoute,
});

function SharedPortfolioRoute() {
  const { portfolioId } = Route.useParams();
  const portfolio = useQuery({
    queryKey: ['shared-portfolio', portfolioId],
    queryFn: () => fetchSharedPortfolio(portfolioId),
    retry: 1,
  });

  if (portfolio.isPending) {
    return (
      <main className="shared-route-state" aria-live="polite">
        <LoaderCircle className="shared-route-spinner" size={28} aria-hidden="true" />
        <h1>Loading portfolio snapshot</h1>
        <p>Retrieving the public, read-only view.</p>
      </main>
    );
  }

  if (portfolio.isError || portfolio.data === null) {
    return (
      <main className="shared-route-state">
        <AlertTriangle size={30} aria-hidden="true" />
        <h1>Portfolio link unavailable</h1>
        <p>This link may be invalid, expired, or temporarily unavailable.</p>
        <Link to="/" className="shared-portfolio-cta">
          Built with ZeroChart - Create your own Quant Portfolio
        </Link>
      </main>
    );
  }

  return <SharedPortfolioView record={portfolio.data} />;
}
