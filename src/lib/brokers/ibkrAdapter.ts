import type { BrokerAdapter } from '@/lib/brokers/brokerInterface';

/**
 * Interactive Brokers credentials. Server-side only: set `IBKR_*` on the
 * deployment, never as `VITE_*`, which Vite inlines into every browser bundle.
 */
export interface IbkrCredentials {
  accountId: string;
  apiKey: string;
  /** Base URL of the IBKR Client Portal Web API gateway. */
  gatewayUrl: string;
}

/** Reads the IBKR credentials from a server env; null until all three are set. */
export function ibkrCredentialsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): IbkrCredentials | null {
  const { IBKR_ACCOUNT_ID: accountId, IBKR_API_KEY: apiKey, IBKR_GATEWAY_URL: gatewayUrl } = env;
  return accountId && apiKey && gatewayUrl ? { accountId, apiKey, gatewayUrl } : null;
}

/**
 * Interactive Brokers, not live yet: every call refuses, and nothing here can
 * place a real order. Fill in the Client Portal calls once the account is funded.
 */
export function ibkrAdapter(credentials: IbkrCredentials | null): BrokerAdapter {
  const error = credentials
    ? 'Interactive Brokers execution is not implemented yet.'
    : 'Interactive Brokers is not configured: set IBKR_ACCOUNT_ID, IBKR_API_KEY and IBKR_GATEWAY_URL.';
  const refuse = () => Promise.resolve({ ok: false as const, error });
  const unavailable = () => Promise.reject(new Error(error));
  return {
    name: 'Interactive Brokers',
    placeOrder: refuse,
    cancelOrder: refuse,
    getBalances: unavailable,
    getPositions: unavailable,
  };
}
