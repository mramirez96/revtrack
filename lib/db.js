'use strict';

// Toda la persistencia vive acá. `server.js` tenía un `state` en memoria y lo
// volcaba entero a un archivo; acá no hay proceso persistente entre llamadas,
// así que cada acción de mesa carga el estado entero desde Postgres, lo muta
// con las mismas funciones de lib/estado.js y lo vuelve a escribir entero —
// mismo espíritu que la escritura atómica de antes, adentro de una
// transacción con un advisory lock global en vez de tmp+rename.
//
// El lock es global, no por ring: como cada acción carga y reescribe el
// estado COMPLETO (todas las canchas), dos acciones en paralelo sobre rings
// distintos podrían pisarse la una a la otra si no se serializan entre sí.
// Es exactamente la misma serialización que ya daba el único proceso Node de
// hoy — no es una regresión, es la misma garantía hecha explícita.

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const dominio = require('./dominio');

const connectionString = process.env.SUPABASE_DB_URL;
const esLocal = /localhost|127\.0\.0\.1/.test(connectionString || '');
const pool = new Pool({
  connectionString,
  max: 5,
  ssl: esLocal ? false : { rejectUnauthorized: false }
});

const LOCK_GLOBAL = 'revtrack:global';
const SEED_EJEMPLO = path.join(__dirname, '..', 'data', 'seed.example.csv');

// Toda acción entra por acá: agarra un cliente dedicado del pool, abre
// transacción, toma el lock, corre `fn(client)` y hace commit. `pg_advisory_
// xact_lock` es de transacción — se libera solo al hacer commit/rollback, así
// que funciona bien con el pooler de Supabase en modo transacción, sin dejar
// sesiones colgadas.
async function conLock(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_GLOBAL]);
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function leerEstadoCrudo(client) {
  // `to_char` en vez de dejar que `pg` parsee la columna `date` a un objeto
  // Date de JS: ese objeto se stringifica como "Fri Sep 04" (no ISO), y
  // guardarlo de vuelta rompe el insert. Un string ya formateado no tiene ese
  // problema en ninguna de las dos direcciones.
  const { rows: eventos } = await client.query(
    "select nombre, to_char(fecha, 'YYYY-MM-DD') as fecha from evento where id");
  if (!eventos.length) return null;
  const { rows: rings } = await client.query('select id, nombre from rings order by id');
  const { rows: pistas } = await client.query(
    `select id, ring_id as "ringId", nombre, orden, estado, seg_perro as "segPerro", marcas, trs
     from pistas order by ring_id, orden`);
  const { rows: inscripciones } = await client.query(
    `select id, pista_id as "pistaId", orden, dorsal, guia, perro, raza, altura, categoria, estado, resultado
     from inscripciones order by pista_id, orden`);
  return {
    evento: { nombre: eventos[0].nombre, fecha: eventos[0].fecha },
    rings, pistas, inscripciones
  };
}

// Con la base recién creada no hay ninguna fila en `evento`: se siembra desde
// data/seed.example.csv (datos inventados), igual que hoy hace `cargar()` sin
// data/seed.csv. Se llama siempre adentro de `conLock`, así que no hace falta
// preocuparse por dos primeros pedidos sembrando en simultáneo.
async function leerEstado(client) {
  const existente = await leerEstadoCrudo(client);
  if (existente) return existente;

  const nombreEvento = process.env.EVENTO || 'Copa de Otoño';
  const fecha = process.env.FECHA;
  const csv = fs.existsSync(SEED_EJEMPLO) ? fs.readFileSync(SEED_EJEMPLO, 'utf8') : '';
  const armado = csv.trim()
    ? dominio.sembrar(csv, { nombreEvento, fecha })
    : { state: dominio.estadoVacio({ nombreEvento, fecha }), saltadas: 0 };

  await guardarEstado(client, armado.state);
  await client.query(
    `insert into seed_actual (id, csv) values (true, $1)
     on conflict (id) do update set csv = excluded.csv`, [csv]);
  return armado.state;
}

// Reescribe el estado entero: upsert de todo lo que sigue existiendo y borrado
// de lo que ya no está en `state` (rings/pistas/inscripciones eliminados por
// una competencia nueva). El borrado de un ring arrastra en cascada sus
// pistas e inscripciones (ver FK ON DELETE CASCADE en la migración).
async function guardarEstado(client, state) {
  await client.query(
    `insert into evento (id, nombre, fecha) values (true, $1, $2)
     on conflict (id) do update set nombre = excluded.nombre, fecha = excluded.fecha`,
    [state.evento.nombre, state.evento.fecha]);

  const ringIds = state.rings.map(r => r.id);
  const pistaIds = state.pistas.map(p => p.id);
  const inscripcionIds = state.inscripciones.map(i => i.id);

  await client.query('delete from rings where not (id = any($1::text[]))', [ringIds.length ? ringIds : ['']]);
  if (pistaIds.length || ringIds.length) {
    await client.query(
      'delete from pistas where ring_id = any($1::text[]) and not (id = any($2::text[]))',
      [ringIds, pistaIds.length ? pistaIds : ['']]);
  }
  if (inscripcionIds.length || pistaIds.length) {
    await client.query(
      'delete from inscripciones where pista_id = any($1::text[]) and not (id = any($2::text[]))',
      [pistaIds, inscripcionIds.length ? inscripcionIds : ['']]);
  }

  if (ringIds.length) {
    await client.query(
      `insert into rings (id, nombre)
       select * from unnest($1::text[], $2::text[])
       on conflict (id) do update set nombre = excluded.nombre`,
      [ringIds, state.rings.map(r => r.nombre)]);
  }
  if (pistaIds.length) {
    await client.query(
      `insert into pistas (id, ring_id, nombre, orden, estado, seg_perro, marcas, trs)
       select * from unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[], $6::int[], $7::jsonb[], $8::jsonb[])
       on conflict (id) do update set ring_id = excluded.ring_id, nombre = excluded.nombre,
         orden = excluded.orden, estado = excluded.estado, seg_perro = excluded.seg_perro,
         marcas = excluded.marcas, trs = excluded.trs`,
      [
        pistaIds, state.pistas.map(p => p.ringId), state.pistas.map(p => p.nombre),
        state.pistas.map(p => p.orden), state.pistas.map(p => p.estado),
        state.pistas.map(p => p.segPerro), state.pistas.map(p => JSON.stringify(p.marcas || [])),
        state.pistas.map(p => JSON.stringify(p.trs || {}))
      ]);
  }
  if (inscripcionIds.length) {
    await client.query(
      `insert into inscripciones
         (id, pista_id, orden, dorsal, guia, perro, raza, altura, categoria, estado, resultado)
       select * from unnest(
         $1::text[], $2::text[], $3::int[], $4::text[], $5::text[],
         $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::jsonb[])
       on conflict (id) do update set pista_id = excluded.pista_id, orden = excluded.orden,
         dorsal = excluded.dorsal, guia = excluded.guia, perro = excluded.perro,
         raza = excluded.raza, altura = excluded.altura, categoria = excluded.categoria,
         estado = excluded.estado, resultado = excluded.resultado`,
      [
        inscripcionIds, state.inscripciones.map(i => i.pistaId), state.inscripciones.map(i => i.orden),
        state.inscripciones.map(i => i.dorsal ?? null), state.inscripciones.map(i => i.guia ?? null),
        state.inscripciones.map(i => i.perro), state.inscripciones.map(i => i.raza ?? null),
        state.inscripciones.map(i => i.altura ?? null), state.inscripciones.map(i => i.categoria ?? null),
        state.inscripciones.map(i => i.estado),
        state.inscripciones.map(i => (i.resultado ? JSON.stringify(i.resultado) : null))
      ]);
  }
}

async function cargarUndo(client, ringId) {
  const { rows } = await client.query(
    'select etiqueta, snapshot from undo_pila where ring_id = $1 order by id asc', [ringId]);
  return rows.map(r => ({ etiqueta: r.etiqueta, inscripciones: r.snapshot.inscripciones, pistas: r.snapshot.pistas }));
}

// Reemplaza entera la pila de ese ring — ya viene recortada a 25 por
// lib/estado.js:marcarUndo, así que no hace falta un límite acá también.
async function guardarUndo(client, ringId, pila) {
  await client.query('delete from undo_pila where ring_id = $1', [ringId]);
  if (!pila.length) return;
  await client.query(
    `insert into undo_pila (ring_id, etiqueta, snapshot)
     select $1, e, s::jsonb from unnest($2::text[], $3::text[]) as t(e, s)`,
    [
      ringId,
      pila.map(p => p.etiqueta),
      pila.map(p => JSON.stringify({ inscripciones: p.inscripciones, pistas: p.pistas }))
    ]);
}

async function borrarTodoUndo(client) {
  await client.query('delete from undo_pila');
}

// Respaldo completo antes de "cargar otra competencia" — equivalente a la
// copia state.json.anterior-<timestamp> de hoy.
async function respaldar(client, state, motivo) {
  await client.query(
    'insert into respaldos (motivo, snapshot) values ($1, $2::jsonb)',
    [motivo, JSON.stringify(state)]);
}

async function setSeedActual(client, csv) {
  await client.query(
    `insert into seed_actual (id, csv) values (true, $1)
     on conflict (id) do update set csv = excluded.csv`, [csv]);
}

module.exports = {
  pool, conLock, leerEstado, leerEstadoCrudo, guardarEstado,
  cargarUndo, guardarUndo, borrarTodoUndo,
  respaldar, setSeedActual
};
