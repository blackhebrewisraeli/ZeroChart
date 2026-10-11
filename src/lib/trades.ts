import { supabase } from '@/lib/supabase';

export type TradeStatus = 'open' | 'closed';

export interface VirtualTrade {
  id: string;
  ticker: string;
  entry_price: number | null;
  entry_date: string | null;
  status: TradeStatus | null;
}

export const openTradesQueryKey = ['virtual-trades', 'open'] as const;

export async function fetchOpenTrades(): Promise<VirtualTrade[]> {
  const { data, error } = await supabase
    .from('virtual_trades')
    .select('id,ticker,entry_price,entry_date,status')
    .eq('status', 'open')
    .order('entry_date', { ascending: false })
    .abortSignal(AbortSignal.timeout(15000));
  if (error) throw new Error(error.message);
  return (data ?? []) as VirtualTrade[];
}

export async function openTrade(ticker: string, entryPrice: number): Promise<void> {
  const { error } = await supabase.from('virtual_trades').insert({
    ticker,
    entry_price: entryPrice,
    entry_date: new Date().toISOString(),
    status: 'open',
  });
  if (error) throw new Error(error.message);
}

export async function closeTrade(id: string): Promise<void> {
  const { error } = await supabase.from('virtual_trades').update({ status: 'closed' }).eq('id', id);
  if (error) throw new Error(error.message);
}

export function formatDate(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export interface TradePnl {
  dollar: number | null;
  percent: number | null;
}

export function calcPnl(entryPrice: number | null, currentPrice: number | null): TradePnl {
  if (
    entryPrice === null ||
    currentPrice === null ||
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(currentPrice) ||
    entryPrice === 0
  ) {
    return { dollar: null, percent: null };
  }
  const dollar = currentPrice - entryPrice;
  const percent = (dollar / entryPrice) * 100;
  return { dollar, percent };
}

export function formatPnlDollar(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: abs > 0 && abs < 1 ? 4 : 2,
  }).format(abs);
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${formatted}`;
}

export function formatPnlPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}
