import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';
// Relative, not `@/`: vite.config.ts loads this file before the alias exists.
import {
  TRADINGVIEW_DEV_SCAN_FILE,
  TRADINGVIEW_DEV_SCAN_ROUTE,
} from '../src/lib/tradingViewDevScan';

/** This machine's loopback addresses, from its own interface table. */
function loopbackAddresses(): Set<string> {
  return new Set(
    Object.values(networkInterfaces()).flatMap((list) =>
      (list ?? []).filter((address) => address.internal).map((address) => address.address),
    ),
  );
}

/** A dual-stack listener reports IPv4 peers as IPv4-mapped IPv6 addresses, hence the prefix strip. */
export function isLoopback(remote: string | undefined, loopback = loopbackAddresses()): boolean {
  return remote !== undefined && loopback.has(remote.replace(/^::ffff:/, ''));
}

/** One request for the dev scan file: 403 from another machine, 404 when nothing was imported. */
export async function serveDevScan(
  remote: string | undefined,
  store: string,
  read: (path: string, encoding: 'utf8') => Promise<string> = readFile,
): Promise<{ status: number; body?: string }> {
  // The dev server listens on every interface; fetched market data stays on this machine.
  if (!isLoopback(remote)) return { status: 403 };
  try {
    return { status: 200, body: await read(join(store, TRADINGVIEW_DEV_SCAN_FILE), 'utf8') };
  } catch {
    return { status: 404 };
  }
}

/**
 * `vite dev` only (`apply: 'serve'`): hands the local TradingView development
 * scan (src/lib/tradingViewDevScan.ts) from the git-ignored scan store to a
 * browser on this machine. Production builds have no such route.
 */
export function tradingViewDevScanPlugin(store = '.zerochart-scans'): Plugin {
  return {
    name: 'zerochart-tradingview-dev-scan',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(TRADINGVIEW_DEV_SCAN_ROUTE, (req, res) => {
        void serveDevScan(req.socket.remoteAddress, store).then(({ status, body }) => {
          res.statusCode = status;
          if (body !== undefined) {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
          }
          res.end(body);
        });
      });
    },
  };
}
