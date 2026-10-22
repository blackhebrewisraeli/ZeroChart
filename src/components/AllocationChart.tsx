import { useMemo } from 'react';
import { Cell, Pie, PieChart, Tooltip } from 'recharts';
import { formatPrice, type Asset } from '@/lib/assets';
import { computeAllocation, type AllocationSlice } from '@/lib/allocation';
import type { Position } from '@/lib/portfolioManager';

interface TooltipEntry {
  name?: string;
  value?: number;
  payload?: AllocationSlice;
}

function AllocationTooltip({
  active,
  payload,
}: Readonly<{
  active?: boolean;
  payload?: ReadonlyArray<TooltipEntry>;
}>) {
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

export function AllocationChart({
  positions,
  assets,
}: Readonly<{ positions: Position[]; assets: Asset[] }>) {
  const data = useMemo<AllocationSlice[]>(
    () => computeAllocation(positions, assets),
    [positions, assets],
  );

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
            isAnimationActive={false}
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
            <span className="allocation-legend-label">
              <span className="allocation-legend-dot" style={{ backgroundColor: slice.color }} />
              <span className="allocation-legend-ticker">{slice.ticker}</span>
            </span>
            <span className="allocation-legend-pct">{slice.percent.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
