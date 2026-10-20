/**
 * The contract every execution venue implements, so the Paper Desk can move
 * from simulated fills to a live broker by swapping the adapter.
 */

/** A market order, filled at `price`. */
export interface BrokerOrder {
  side: 'buy' | 'sell';
  ticker: string;
  /** Units: coins for crypto, shares for equities. */
  shares: number;
  /** USD per unit. */
  price: number;
  /** USD. */
  fee: number;
}

export interface BrokerRejection {
  ok: false;
  error: string;
}

/** `orderId` is null when the venue fills immediately and leaves nothing to cancel. */
export type PlaceOrderResult = { ok: true; orderId: string | null } | BrokerRejection;

export type CancelOrderResult = { ok: true } | BrokerRejection;

export interface BrokerBalance {
  currency: string;
  available: number;
}

export interface BrokerPosition {
  ticker: string;
  quantity: number;
  /** USD per unit, excluding fees. */
  averagePrice: number;
}

export interface BrokerAdapter {
  readonly name: string;
  placeOrder(order: BrokerOrder): Promise<PlaceOrderResult>;
  cancelOrder(orderId: string): Promise<CancelOrderResult>;
  getBalances(): Promise<BrokerBalance[]>;
  getPositions(): Promise<BrokerPosition[]>;
}
