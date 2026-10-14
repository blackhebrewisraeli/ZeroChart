import { Line, LineChart } from 'recharts';

const TREND_UP = '#00ff41';
const TREND_DOWN = '#ff003c';
const TREND_FLAT = '#6b7280';

interface SparklineProps {
  data: number[];
  change?: number | null;
  width?: number;
  height?: number;
}

/**
 * Minimal inline trend chart with no axes, grid, tooltip, or legend to keep
 * the data-ink ratio maximal. Color is deterministic: neon green for a positive
 * 24h change, neon red for negative, and neutral gray for missing/flat data.
 */
export function Sparkline({ data, change = null, width = 80, height = 30 }: SparklineProps) {
  const points = data.map((value) => ({ value }));
  const isUp = change != null && change > 0;
  const isDown = change != null && change < 0;
  const stroke = isUp ? TREND_UP : isDown ? TREND_DOWN : TREND_FLAT;

  return (
    <div className="sparkline" style={{ width, height }} aria-hidden="true">
      <LineChart
        width={width}
        height={height}
        data={points}
        margin={{ top: 3, right: 0, bottom: 3, left: 0 }}
      >
        <Line
          type="monotone"
          dataKey="value"
          stroke={stroke}
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </div>
  );
}
