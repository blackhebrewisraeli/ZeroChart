import { readFile } from 'node:fs/promises';
import { defineConfig, type Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import tsConfigPaths from 'vite-tsconfig-paths';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { nitro } from 'nitro/vite';
import viteReact from '@vitejs/plugin-react';

/**
 * `vite dev` only (`apply: 'serve'`): hands the local TradingView development
 * scan (src/lib/tradingViewDevScan.ts) from the git-ignored scan store to a
 * browser on this machine. Production builds have no such route. Paths are
 * literal here because Vite loads this file before the `@/` alias exists.
 */
function tradingViewDevScan(): Plugin {
  return {
    name: 'zerochart-tradingview-dev-scan',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__zerochart/tradingview-dev-scan', (req, res) => {
        // The dev server listens on every interface; fetched market data stays on this machine.
        const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
        if (!loopback.includes(req.socket.remoteAddress ?? '')) {
          res.statusCode = 403;
          res.end();
          return;
        }
        readFile('.zerochart-scans/tradingview-dev-scan.json', 'utf8').then(
          (body) => {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.end(body);
          },
          () => {
            res.statusCode = 404;
            res.end();
          },
        );
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  server: { host: '::', port: 8080 },
  css: { transformer: 'lightningcss' },
  plugins: [
    tailwindcss(),
    tsConfigPaths({ projects: ['./tsconfig.json'] }),
    tanstackStart({
      // Keep server-only modules out of the client bundle.
      importProtection: {
        behavior: 'error',
        client: { files: ['**/server/**'], specifiers: ['server-only'] },
      },
      // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
      // nitro/vite builds from this
      server: { entry: 'server' },
    }),
    // Nitro picks the deploy preset from the host (Vercel in production).
    command === 'build' && nitro(),
    viteReact(),
    tradingViewDevScan(),
  ],
}));
