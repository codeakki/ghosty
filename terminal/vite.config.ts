/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * Every route the terminal calls on the Ghosty server. In dev, Vite proxies these to VITE_GHOSTY_URL
 * so the browser stays same-origin (no CORS on the server). In production the server serves dist/ at `/`.
 */
const SERVER_ROUTES = [
  '/state',
  '/events',
  '/health',
  '/access',
  '/guest/',
  '/pod/',
  '/news',
  '/alerts',
  '/voice',
  '/button',
  '/sim/',
  '/episodes',
  '/signal',
  '/zerog',
  '/x402',
  '/execution',
  '/providers',
  '/market',
];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const target = env.VITE_GHOSTY_URL || 'http://localhost:3000';
  const proxy = Object.fromEntries(SERVER_ROUTES.map((route) => [route, { target, changeOrigin: true }]));
  return {
    plugins: [react()],
    server: { port: 5173, proxy },
    preview: { proxy },
    build: { outDir: 'dist', sourcemap: true },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  };
});
