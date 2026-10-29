// @vitest-environment node

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRADINGVIEW_DEV_SCAN_FILE, TRADINGVIEW_DEV_SCAN_ROUTE } from '@/lib/tradingViewDevScan';
import { isLoopback, serveDevScan, tradingViewDevScanPlugin } from './tradingViewDevRoute';

const LOOPBACK = new Set(['127.0.0.1', '::1']);

describe('isLoopback', () => {
  it('accepts this machine, including an IPv4 peer on a dual-stack listener, and nothing else', () => {
    expect(isLoopback('127.0.0.1', LOOPBACK)).toBe(true);
    expect(isLoopback('::1', LOOPBACK)).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1', LOOPBACK)).toBe(true);
    expect(isLoopback('10.100.102.6', LOOPBACK)).toBe(false);
    expect(isLoopback('::ffff:10.100.102.6', LOOPBACK)).toBe(false);
    expect(isLoopback(undefined, LOOPBACK)).toBe(false);
  });

  it('reads the loopback addresses from the interface table', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
  });
});

describe('serveDevScan', () => {
  it('serves the file locally, 404s without one and 403s another machine without reading', async () => {
    const reads: string[] = [];
    const read = async (path: string) => {
      reads.push(path);
      return '{"kind":"tradingview-dev-scan"}';
    };
    expect(await serveDevScan('127.0.0.1', 'store', read)).toEqual({
      status: 200,
      body: '{"kind":"tradingview-dev-scan"}',
    });
    expect(reads).toEqual([join('store', TRADINGVIEW_DEV_SCAN_FILE)]);
    const missing = async () => Promise.reject(new Error('ENOENT'));
    expect(await serveDevScan('127.0.0.1', 'store', missing)).toEqual({ status: 404 });
    expect(await serveDevScan('10.100.102.6', 'store', read)).toEqual({ status: 403 });
    expect(reads).toHaveLength(1);
  });
});

describe('tradingViewDevScanPlugin', () => {
  type Handler = (
    req: { socket: { remoteAddress?: string } },
    res: Response & { headers: Record<string, string> },
  ) => void;
  interface Response {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string): void;
  }

  async function request(plugin: ReturnType<typeof tradingViewDevScanPlugin>, remote: string) {
    const routes: Array<[string, Handler]> = [];
    const configure = plugin.configureServer as (server: unknown) => void;
    configure({
      middlewares: { use: (route: string, handler: Handler) => routes.push([route, handler]) },
    });
    expect(routes.map(([route]) => route)).toEqual([TRADINGVIEW_DEV_SCAN_ROUTE]);
    return new Promise<{
      status: number;
      headers: Record<string, string>;
      body: string | undefined;
    }>((done) => {
      const res = {
        statusCode: 0,
        headers: {} as Record<string, string>,
        setHeader(name: string, value: string) {
          this.headers[name] = value;
        },
        end(body?: string) {
          done({ status: this.statusCode, headers: this.headers, body });
        },
      };
      routes[0]![1]({ socket: { remoteAddress: remote } }, res);
    });
  }

  it('exists only on the dev server and answers from the store', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-route-'));
    const plugin = tradingViewDevScanPlugin(store);
    expect(plugin.apply).toBe('serve');
    expect(await request(plugin, '::ffff:127.0.0.1')).toEqual({
      status: 404,
      headers: {},
      body: undefined,
    });
    await writeFile(join(store, TRADINGVIEW_DEV_SCAN_FILE), '{}');
    expect(await request(plugin, '127.0.0.1')).toEqual({
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: '{}',
    });
    expect((await request(plugin, '192.168.1.20')).status).toBe(403);
  });
});
