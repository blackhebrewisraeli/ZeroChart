import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = (name: string) =>
  readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8');
const classification = migration('20261024040000_signal_classification.sql');
const latest = migration('20261027120000_accept_pine_pw200.sql');
const sql = [latest, classification, migration('20261022090000_execute_tactical_signal.sql')].join(
  '\n',
);
/** The function definition, from `create or replace` to the grants. */
const definition = (text: string) =>
  text.slice(text.indexOf('create or replace function public.execute_tactical_signal('));

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
    expect(sql).toMatch(/server_price \* 0\.005/i);
  });

  it('rejects transport tests and unverified or unsupported strategy provenance', () => {
    expect(sql).toMatch(/signal_kind is distinct from 'strategy'/i);
    expect(latest).toMatch(/model_version = '1\.0\.0'\n/i);
    expect(sql).toMatch(/signal_kind is null or signal_kind in \('strategy', 'transport_test'\)/i);
  });

  it('accepts 1.0.0-pw200 on daily alerts only and changes nothing else', () => {
    expect(latest).toContain(
      "(tactical_signal.model_version = '1.0.0-pw200' and tactical_signal.timeframe in ('1D', 'D'))",
    );
    const versionCheck = /or not \(\n[\s\S]*?\n {5}\) then/;
    expect(
      definition(latest).replace(versionCheck, "or tactical_signal.model_version <> '1.0.0' then"),
    ).toBe(definition(classification));
  });
});
