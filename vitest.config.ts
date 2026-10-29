import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.{test,spec}.{ts,tsx}'],
    // `npm test -- --coverage` (CI): lcov feeds SonarQube Cloud, text-summary prints in the log.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts', 'supabase/functions/**/*.ts'],
      exclude: [
        'src/test/**',
        'scripts/**/*.test.ts',
        'src/**/*.d.ts',
        'src/routeTree.gen.ts',
        // Deno-only `npm:` imports: Vite can't load these to measure them.
        'supabase/functions/_shared/feed.ts',
        'supabase/functions/tv-webhook/index.ts',
      ],
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
