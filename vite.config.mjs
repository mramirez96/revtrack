import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// El front es una SPA de React en web/. Se construye a dist/, que es lo que
// sirve Vercel; /api sigue siendo la función serverless de api/index.js.
// En desarrollo no se usa `vite` suelto: scripts/dev.js monta este mismo
// config como middleware de Express, así API y front comparten el :3000.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  // Las reglas de puntaje viven en shared/, fuera de web/: el servidor las usa
  // también, y tiene que ser un solo archivo.
  server: { fs: { allow: ['..'] } },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.jsx']
  }
});
