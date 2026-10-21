import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261022090000_execute_tactical_signal.sql'),
  'utf8',
);

describe('execute_tactical_signal migration contract', () => {
  it('serializes a signal and uniquely links it to one paper fill', () => {
    expect(sql).toMatch(/for update;/i);
    expect(sql).toMatch(/create unique index[\s\S]*paper_transactions \(signal_id\)/i);
  });

  it('authorizes the caller and prevents direct client EXECUTED updates', () => {
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/auth\.uid\(\)[\s\S]*<> \$2/i);
    expect(sql).toMatch(/with check[\s\S]*status = 'DISMISSED'/i);
    expect(sql).toMatch(/grant execute[\s\S]*to authenticated/i);
  });

  it('inserts the fill before resolving the signal inside the function transaction', () => {
    const insert = sql.indexOf('insert into public.paper_transactions');
    const execute = sql.indexOf("set status = 'EXECUTED'");
    expect(insert).toBeGreaterThan(-1);
    expect(execute).toBeGreaterThan(insert);
  });

  it('enforces the 0.5% server-price band', () => {
    expect(sql).toContain('tolerance constant numeric := 0.005');
    expect(sql).toMatch(/server_price \* 0\.005/i);
  });
});
