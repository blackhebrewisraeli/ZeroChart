import { useMemo } from 'react';
import { Cell, Pie, PieChart, Tooltip } from 'recharts';
import { formatPrice, type Asset } from '@/lib/assets';
import type { Position } from '@/lib/portfolioManager';

const PALETTE = [
  '#00E5FF',
  '#6366F1',
  '#22D3EE',
  '#64748B',
  '#0EA5E9',
  '#818CF8',
  '#14B8A6',
  '#38BDF8',
];

interface AllocationSlice {
  ticker: string;
  value: number;
  percent: number;
  color: string;
}

interface TooltipEntry {
  name?: string;
  value?: number;
  payload?: AllocationSlice;
}

function AllocationTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: ReadonlyArray<TooltipEntry>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const slice = payload[0]?.payload;
  if (!slice) return null;
  return (
    <div className="allocation-tooltip">
      <span className="allocation-tooltip-ticker">{slice.ticker}</span>
      <span className="allocation-tooltip-value">{formatPrice(slice.value)}</span>
      <span className="allocation-tooltip-pct">{slice.percent.toFixed(1)}%</span>
    </div>
  );
}

export function AllocationChart({ positions, assets }: { positions: Position[]; assets: Asset[] }) {
  const data = useMemo<AllocationSlice[]>(() => {
    const priceByTicker = new Map<string, number>();
    for (const asset of assets) {
      if (
        asset.current_price != null &&
        Number.isFinite(asset.current_price) &&
        asset.current_price > 0
      ) {
        priceByTicker.set(asset.ticker, asset.current_price);
      }
    }

    const valueByTicker = new Map<string, number>();
    let total = 0;
    for (const position of positions) {
      const price = priceByTicker.get(position.ticker) ?? position.buyPrice;
      const value = price * position.shares;
      valueByTicker.set(position.ticker, (valueByTicker.get(position.ticker) ?? 0) + value);
      total += value;
    }

    if (total <= 0) return [];

    return [...valueByTicker.entries()]
      .map(([ticker, value]) => ({ ticker, value, percent: (value / total) * 100 }))
      .sort((a, b) => b.value - a.value)
      .map((slice, index) => ({
        ...slice,
        color: PALETTE[index % PALETTE.length] ?? '#00E5FF',
      }));
  }, [positions, assets]);

  const total = data.reduce((sum, slice) => sum + slice.value, 0);

  if (data.length === 0) {
    return (
      <div className="allocation-empty">
        <span className="allocation-empty-title">No allocation yet</span>
        <span className="allocation-empty-sub">Add positions to see your portfolio breakdown.</span>
      </div>
    );
  }

  return (
    <div className="allocation-card">
      <div className="allocation-donut">
        <PieChart width={180} height={180}>
          <Pie
            data={data}
            dataKey="value"
            nameKey="ticker"
            innerRadius={56}
            outerRadius={84}
            paddingAngle={2}
            stroke="none"
            isAnimationActive
          >
            {data.map((slice) => (
              <Cell key={slice.ticker} fill={slice.color} />
            ))}
          </Pie>
          <Tooltip content={<AllocationTooltip />} />
        </PieChart>
        <div className="allocation-center">
          <span className="allocation-center-label">TOTAL</span>
          <span className="allocation-center-value">{formatPrice(total)}</span>
        </div>
      </div>
      <div className="allocation-legend">
        {data.map((slice) => (
          <div key={slice.ticker} className="allocation-legend-item">
            <span className="allocation-legend-dot" style={{ backgroundColor: slice.color }} />
            <span className="allocation-legend-ticker">{slice.ticker}</span>
            <span className="allocation-legend-pct">{slice.percent.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
