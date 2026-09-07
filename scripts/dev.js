#!/usr/bin/env node
'use strict';

// Servidor de desarrollo local: sirve exactamente lo que vercel.json describe
// (los estáticos de public/, las dos rutas de página, y api/index.js bajo
// /api) sin necesitar el CLI de Vercel ni una cuenta — para probar el stack
// nuevo end-to-end contra un Supabase local (`supabase start`).
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
const app = express();

app.use(api);
app.get('/ring/:ringId', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'ring.html')));
app.get('/mesa/:ringId', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'mesa.html')));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`\n  RevTrack (dev) escuchando en http://localhost:${PORT}\n`);
});
