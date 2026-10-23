import { Line, LineChart } from 'recharts';

const TREND_UP = 'var(--signal-green)';
const TREND_DOWN = 'var(--signal-red)';
const TREND_FLAT = 'var(--muted-foreground)';

interface SparklineProps {
  data: number[];
  change?: number | null;
  width?: number;
  height?: number;
}

/**
 * Minimal inline trend chart with no axes, grid, tooltip, or legend to keep
 * the data-ink ratio maximal. Color is deterministic: signal green for a positive
 * 24h change, signal red for negative, and neutral gray for missing/flat data.
 */
export function Sparkline({
  data,
  change = null,
  width = 80,
  height = 30,
}: Readonly<SparklineProps>) {
  const points = data.map((value) => ({ value }));
  const isUp = change != null && change > 0;
  const isDown = change != null && change < 0;
  let stroke = TREND_FLAT;
  if (isUp) stroke = TREND_UP;
  else if (isDown) stroke = TREND_DOWN;

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
