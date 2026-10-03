#!/usr/bin/env node
'use strict';

// Servidor de desarrollo local: lo mismo que vercel.json describe —api/index.js
// bajo /api y la SPA de React para todo lo demás— en un solo proceso y sin
// necesitar el CLI de Vercel ni una cuenta. El front lo sirve Vite como
// middleware (con recarga en caliente), para probar el stack end-to-end contra
// un Supabase local (`supabase start`).
//
// Uso:
//   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//   SUPABASE_URL=http://127.0.0.1:54321 \
//   SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
//   MESA_SECRET=cualquier-string-largo \
//     npm run dev

const path = require('path');
const express = require('express');
const api = require('../api/index.js');

const PORT = process.env.PORT || 3000;

async function main() {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: path.join(__dirname, '..', 'vite.config.mjs'),
    server: { middlewareMode: true },
    // 'spa': cualquier ruta que no sea un archivo (/ring/x, /mesa/x) devuelve
    // index.html, igual que el rewrite de vercel.json.
    appType: 'spa'
  });

  const app = express();
  app.use(api);
  app.use(vite.middlewares);
  app.listen(PORT, () => {
    console.log(`\n  RevTrack (dev) escuchando en http://localhost:${PORT}\n`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
