#!/usr/bin/env node
// Carga (o reemplaza) la competencia en Supabase desde un CSV — para preparar
// un evento real antes del día de la competencia, sin pasar por la mesa.
// Equivalente a poner el archivo en data/seed.csv y correr `npm run reset` en
// la versión de Fly.
//
// Uso: SUPABASE_DB_URL=postgres://... node scripts/seed.js data/seed.csv

import fs from 'node:fs';
import * as dominio from '../lib/dominio.js';
import * as db from '../lib/db.js';

async function main() {
  const archivo = process.argv[2];
  if (!archivo) {
    console.error('Uso: node scripts/seed.js <archivo.csv>');
    process.exit(1);
  }
  const csv = fs.readFileSync(archivo, 'utf8');
  const nombreEvento = process.env.EVENTO || 'Copa de Otoño';
  const fecha = process.env.FECHA;
  const { state, saltadas } = dominio.sembrar(csv, { nombreEvento, fecha });
  if (!state.pistas.length || !state.inscripciones.length) {
    console.error('Ese archivo no tiene ninguna inscripción usable: hacen falta las columnas "pista" y "perro".');
    process.exit(1);
  }

  await db.conLock(async client => {
    const anterior = await db.leerEstadoCrudo(client);
    if (anterior && anterior.inscripciones.length) {
      await db.respaldar(client, anterior, 'scripts/seed.js');
    }
    await db.guardarEstado(client, state);
    await db.setSeedActual(client, csv);
    await db.borrarTodoUndo(client);
  });

  console.log(`Sembrado: ${state.inscripciones.length} inscripciones en ${state.pistas.length} pista(s), ${state.rings.length} cancha(s).`);
  if (saltadas) console.log(`Salté ${saltadas} fila(s) sin pista o sin perro.`);
  await db.pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
