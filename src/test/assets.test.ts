import { beforeEach, describe, expect, it, vi } from 'vitest';
const { response, range } = vi.hoisted(() => ({ response: vi.fn(), range: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({ select: () => ({ order: () => ({ range: (...args: number[]) => { range(...args); return { abortSignal: response }; } }) }) }) } }));
import { fetchAssets, formatPrice, formatReward, formatRisk, formatVolume } from '@/lib/assets';

describe('asset data', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('paginates until all rows have been fetched', async () => {
    response.mockResolvedValueOnce({ data: Array.from({ length: 1000 }, (_, i) => ({ ticker: `T${i}` })), error: null }).mockResolvedValueOnce({ data: [{ ticker: 'T1000' }], error: null });
    expect(await fetchAssets()).toHaveLength(1001);
    expect(range.mock.calls).toEqual([[0, 999], [1000, 1999]]);
  });
  it('returns empty live data without substituting samples', async () => {
    response.mockResolvedValueOnce({ data: [], error: null });
    expect(await fetchAssets()).toEqual([]);
  });
  it('surfaces read failures', async () => {
    response.mockResolvedValueOnce({ data: null, error: { message: 'Permission denied' } });
    await expect(fetchAssets()).rejects.toThrow('Permission denied');
  });
  it('formats percent points and handles missing values', () => {
    expect(formatRisk(3.2)).toBe('3.2%');
    expect(formatRisk(null)).toBe('—');
    expect(formatPrice(null)).toBe('—');
    expect(formatPrice(67432.8)).toBe('$67,432.80');
  });
  it('formats reward percentages and volume spikes', () => {
    expect(formatReward(0.052)).toBe('5.2%');
    expect(formatReward(0)).toBe('0.0%');
    expect(formatReward(null)).toBe('—');
    expect(formatVolume(1.8)).toBe('1.8x');
    expect(formatVolume(null)).toBe('—');
  });
});
