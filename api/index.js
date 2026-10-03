// La app Express que atiende /api/*. Mismo rol que la sección "http" de
// server.js, pero sin `http.createServer` ni socket.io: cada pedido es una
// invocación de función serverless independiente, así que el estado se carga
// de Postgres al principio y se guarda al final de cada acción (ver lib/db.js).
//
// Contrato de error: un string de una acción de lib/estado.js se traduce acá
// a `{ error }` con 400; el éxito es `{}` o `{ aviso }` — mismo criterio que
// el `accion()` de server.js, adaptado de eventos de socket a respuestas HTTP.

import express from 'express';
import * as db from '../lib/db.js';
import * as estado from '../lib/estado.js';
import * as realtime from '../lib/realtime.js';
import * as auth from '../lib/auth.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// Envuelve una acción sobre UN ring: carga estado + pila de deshacer de ese
// ring, corre `fn`, y si no fue un error guarda todo y difunde por Realtime.
// `fn` recibe (state, undoPila, req) y devuelve lo mismo que las funciones de
// lib/estado.js: null | string de error | { aviso }.
function accionRing(fn) {
  return async (req, res) => {
    const ringId = req.params.ringId;
    try {
      const r = await db.conLock(async client => {
        const state = await db.leerEstado(client);
        const undo = await db.cargarUndo(client, ringId);
        const resultado = fn(state, undo, req);
        if (typeof resultado === 'string') return { error: resultado };
        await db.guardarEstado(client, state);
        await db.guardarUndo(client, ringId, undo);
        return { resultado, state };
      });
      if (r.error) return res.status(400).json({ error: r.error });
      await realtime.difundirRing(r.state, ringId);
      res.json(r.resultado && r.resultado.aviso ? { aviso: r.resultado.aviso } : {});
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Error interno.' });
    }
  };
}

/* -------------------------------------------------------------- config --- */

// La URL y la anon key de Supabase son públicas por diseño (protegidas por
// RLS, no por secreto) pero no están hardcodeadas en public/ para no atarlas
// a un proyecto de Supabase específico en el repo: se sirven desde acá, leídas
// de las mismas variables de entorno que ya usa el servidor para hablarle a
// Postgres.
app.get('/api/config', (_req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null
  });
});

/* ------------------------------------------------------------- lectura --- */

app.get('/api/resumen', async (_req, res) => {
  try {
    const state = await db.conLock(client => db.leerEstado(client));
    res.json(estado.resumen(state));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error interno.' });
  }
});

app.get('/api/ring/:ringId', async (req, res) => {
  try {
    const state = await db.conLock(client => db.leerEstado(client));
    const snap = estado.snapshot(state, req.params.ringId, req.query.pista || undefined);
    if (!snap) return res.status(404).json({ error: 'Ring inexistente' });
    res.json(snap);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error interno.' });
  }
});

/* --------------------------------------------------------------- mesa --- */

app.post('/api/mesa/entrar', async (req, res) => {
  const { ringId, pin } = req.body || {};
  if (!ringId || !pin) return res.status(400).json({ error: 'Falta el ring o el PIN.' });
  const r = await auth.entrar(auth.ipDe(req), ringId, pin);
  if (!r.ok) {
    if (r.mensaje) return res.status(429).json({ error: r.mensaje });
    return res.status(401).json({ ok: false });
  }
  res.json({ ok: true, token: r.token });
});

app.post('/api/ring/:ringId/siguiente', auth.requiereMesa, accionRing(
  (state, undo, req) => estado.siguiente(state, undo, req.params.ringId)));

app.post('/api/ring/:ringId/ausente', auth.requiereMesa, accionRing(
  (state, undo, req) => estado.marcarAusente(state, undo, req.params.ringId, req.body?.id)));

app.post('/api/ring/:ringId/mover', auth.requiereMesa, accionRing(
  (state, undo, req) => estado.mover(
    state, undo, req.params.ringId, req.body?.id, req.body?.delta === -1 ? -1 : 1)));

app.post('/api/ring/:ringId/abrir_pista', auth.requiereMesa, accionRing(
  (state, undo, req) => estado.abrirPista(state, undo, req.params.ringId, req.body?.id)));

app.post('/api/ring/:ringId/mover_pista', auth.requiereMesa, accionRing(
  (state, undo, req) => estado.moverPista(state, undo, req.params.ringId, {
    id: req.body?.id, delta: req.body?.delta === -1 ? -1 : 1
  })));

app.post('/api/ring/:ringId/cargar_orden', auth.requiereMesa, accionRing(
  (state, undo, req) => estado.cargarOrden(state, undo, req.params.ringId, req.body)));

app.post('/api/ring/:ringId/resultado', auth.requiereMesa, accionRing(
  (state, undo, req) => estado.cargarResultado(state, undo, req.params.ringId, req.body)));

app.post('/api/ring/:ringId/trs', auth.requiereMesa, accionRing(
  (state, undo, req) => estado.fijarTrs(state, undo, req.params.ringId, req.body)));

app.post('/api/ring/:ringId/deshacer', auth.requiereMesa, accionRing(
  (state, undo) => estado.deshacer(state, undo)));

// No pasa por `accionRing`: no es una acción sobre un ring en particular —
// después de esto los rings y las pistas son otros, así que en vez de
// difundir un snapshot hay que avisar que todos recarguen.
app.post('/api/nueva_competencia', auth.requiereMesaGlobal, async (req, res) => {
  try {
    const r = await db.conLock(async client => {
      const state = await db.leerEstado(client);
      const plan = estado.nuevaCompetencia(state, req.body);
      if (typeof plan === 'string') return { error: plan };
      await db.respaldar(client, plan.estadoAnterior, 'nueva competencia');
      await db.guardarEstado(client, plan.estadoNuevo);
      await db.setSeedActual(client, plan.csv);
      await db.borrarTodoUndo(client);
      return { ringId: plan.ringId, aviso: plan.aviso };
    });
    if (r.error) return res.status(400).json({ error: r.error });
    await realtime.avisarRecarga();
    res.json({ ringId: r.ringId, aviso: r.aviso });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error interno.' });
  }
});

// Sin esto, un body que no es JSON válido cae en la página de error HTML por
// defecto de Express — rompe el contrato de "todo error es { error }" que
// asume el cliente.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: 'Pedido inválido.' });
});

export default app;
