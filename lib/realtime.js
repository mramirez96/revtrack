'use strict';

// Reemplaza a `difundir()` de server.js. Ahí un único proceso mantenía un
// socket por celular conectado y le hacía `emit` directo; acá no hay
// conexión que sostener entre pedidos, así que se publica un mensaje de
// Supabase Realtime Broadcast y quien esté escuchando el canal lo recibe.
// El servidor sigue siendo el único que calcula `snapshot`/`resumen` — la
// única diferencia es el transporte de salida.
//
// Se usa la API REST de broadcast (POST .../realtime/v1/api/broadcast) en vez
// del cliente `@supabase/supabase-js`: cada función serverless vive un solo
// pedido, así que no hay ninguna ventaja en abrir y mantener una conexión de
// socket sólo para publicar un mensaje y cortar.

const estado = require('./estado');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function publicar(mensajes) {
  // Sin Supabase configurado (tests locales, dev sin Realtime) la acción
  // sigue funcionando igual — sólo no hay "en vivo" para nadie más.
  if (!SUPABASE_URL || !SERVICE_KEY || !mensajes.length) return;
  try {
    await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ messages: mensajes })
    });
  } catch (e) {
    console.error('No pude publicar por Realtime:', e.message);
  }
}

// Después de una acción sobre un ring: un mensaje por cada pista de ese ring
// (los clientes filtran por la que están mirando) más el resumen al lobby —
// mismo criterio que `difundir()`, adaptado de "un emit por conexión" a "un
// mensaje por pista, por tema".
async function difundirRing(state, ringId) {
  const mensajes = estado.pistasDe(state, ringId).map(p => ({
    topic: `ring:${ringId}`,
    event: 'snapshot',
    payload: estado.snapshot(state, ringId, p.id)
  }));
  mensajes.push({ topic: 'lobby', event: 'resumen', payload: estado.resumen(state) });
  await publicar(mensajes);
}

// La mesa cargó otra competencia entera: no hay snapshot puntual que mandar,
// todas las pantallas tienen que recargar. Va al canal `global`, que todas
// las vistas escuchan sin importar qué ring estén mirando.
async function avisarRecarga() {
  await publicar([{ topic: 'global', event: 'recargar', payload: {} }]);
}

module.exports = { difundirRing, avisarRecarga };
