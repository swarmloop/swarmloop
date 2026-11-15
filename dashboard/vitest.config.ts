import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const contractDir = fileURLToPath(new URL('../server/src/contract/', import.meta.url));

const slowestFilesReporter = fileURLToPath(new URL('../scripts/vitest-slowest-files.mjs', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [{ find: /^@contract\/(.*)/, replacement: `${contractDir}$1` }],
  },
  test: {
    environment: 'jsdom',
    reporters: ['default', ...(process.env.GITHUB_ACTIONS === 'true' ? ['github-actions'] : []), slowestFilesReporter],
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/.next/**'],
  },
});
