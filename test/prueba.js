// Prueba de integración: levanta el servidor real (api/index.js) contra un
// esquema de Postgres exclusivo de esta corrida — nunca toca el proyecto de
// Supabase de producción, ni el de otra corrida concurrente.
//
// La versión anterior (contra server.js + socket.io) spawneaba un proceso
// hijo por escenario, cada uno con su propia carpeta data/ en un sandbox de
// disco, para probar que el estado sobrevive a un reinicio. Acá no hace falta
// esa coreografía: cada pedido HTTP relee el estado entero de Postgres, sin
// caché en memoria — así que no HAY nada que un reinicio pudiera revelar que
// un simple GET no revele ya. Donde igual vale la pena, se reinicia el
// servidor HTTP en el mismo proceso (server.close() + uno nuevo) para
// confirmar que no quedó ningún estado escondido en el módulo.
//
// Lo que se cayó respecto de la versión anterior, y por qué:
//   - "Latido" (heartbeat): no existe más — ver la nota en el plan de
//     migración sobre por qué "en vivo" ahora se lee del estado de la
//     conexión de Realtime, no de un pulso de servidor. No hay nada de eso
//     para probar del lado del servidor.
//   - "Estado corrupto" (state.json truncado / de forma vieja): eran fallas
//     de un archivo en disco. Postgres con columnas tipadas no puede quedar
//     "a medio escribir" de esa manera — la escritura es una transacción.
//   - DATA_DIR / arranque sin ningún CSV en el disco: ya no hay filesystem
//     que apuntar. Lo que sí se prueba (más abajo) es el equivalente real:
//     con la base vacía, se siembra sola desde data/seed.example.csv.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import * as dominio from '../lib/dominio.js';
import * as Resultados from '../shared/resultados.mjs';

const DB_BASE = process.env.TEST_DATABASE_URL || process.env.SUPABASE_DB_URL;
if (!DB_BASE) {
  console.error('Falta TEST_DATABASE_URL (o SUPABASE_DB_URL) apuntando a un Postgres de prueba.');
  console.error('Ejemplo: docker run -d -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine');
  process.exit(1);
}

// Esquema exclusivo de esta corrida — dos corridas en paralelo, o una vieja
// que no se limpió, no se pisan entre sí. Se crea antes de requerir lib/db.js
// (que abre el pool de conexiones al cargarse) y se borra al final.
const ESQUEMA = `revtrack_test_${process.pid}_${Date.now().toString(36)}`;
process.env.SUPABASE_DB_URL =
  DB_BASE + (DB_BASE.includes('?') ? '&' : '?') + `options=-c%20search_path%3D${ESQUEMA}`;
process.env.MESA_PIN = '9999';
process.env.MESA_SECRET = 'secreto-de-prueba';
delete process.env.EVENTO;
delete process.env.FECHA;

// Import dinámico, y recién acá: lib/db.js abre el pool (y lib/auth.js lee
// MESA_SECRET) al cargarse, así que tienen que ver el entorno de arriba.
const { Pool } = pg;
const db = await import('../lib/db.js');
const { default: app } = await import('../api/index.js');

const PIN = process.env.MESA_PIN;
let PUERTO = 3400 + (process.pid % 500);
let base = `http://127.0.0.1:${PUERTO}`;

let ok = 0, fallos = [];
function chequear(nombre, cond, detalle) {
  if (cond) { ok++; console.log(`  ok    ${nombre}`); }
  else { fallos.push(nombre); console.log(`  FALLA ${nombre}${detalle ? ' → ' + detalle : ''}`); }
}

/* ── arnés: servidor + Postgres, en vez de socket.io ─────────────────── */

let server = null;
function arrancarServidor() {
  return new Promise((res, rej) => {
    server = http.createServer(app);
    server.on('error', rej);
    server.listen(PUERTO, () => res());
  });
}
function reiniciarServidor() {
  // Nada en el módulo debería sobrevivir a esto: si algo lo hace, es una
  // fuga de estado en memoria que un GET normal no detectaría. Un puerto
  // nuevo evita la carrera de Windows tardando en soltar el viejo.
  return new Promise((res, rej) => server.close(() => {
    PUERTO++;
    base = `http://127.0.0.1:${PUERTO}`;
    arrancarServidor().then(res, rej);
  }));
}

async function crearEsquema() {
  const admin = new Pool({ connectionString: DB_BASE, max: 1 });
  await admin.query(`create schema if not exists "${ESQUEMA}"`);
  await admin.end();
  // Todas las migraciones, en orden, igual que en un proyecto real.
  const dir = path.join(import.meta.dirname, '..', 'supabase', 'migrations');
  for (const archivo of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    await db.pool.query(fs.readFileSync(path.join(dir, archivo), 'utf8'));
  }
}
async function borrarEsquema() {
  const admin = new Pool({ connectionString: DB_BASE, max: 1 });
  await admin.query(`drop schema if exists "${ESQUEMA}" cascade`);
  await admin.end();
}
async function truncarTodo() {
  await db.pool.query(
    'truncate rings, evento, seed_actual, undo_pila, pin_intentos, respaldos restart identity cascade');
}

// Siembra directa (sin pasar por el archivo data/seed.csv de antes): arma el
// estado con la misma función que usa la app y lo guarda, para que cada
// escenario arranque con exactamente el fixture que necesita.
async function sembrarFixture(csv, { nombreEvento = 'Copa de Otoño', fecha } = {}) {
  await truncarTodo();
  const { state } = dominio.sembrar(csv, { nombreEvento, fecha });
  await db.conLock(client => db.guardarEstado(client, state));
  return state;
}

async function get(ruta) {
  const r = await fetch(base + ruta);
  const cuerpo = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  return { status: r.status, cuerpo };
}
const resumen = async () => (await get('/api/resumen')).cuerpo;
const snapshot = async (ringId, pistaId) =>
  (await get(`/api/ring/${encodeURIComponent(ringId)}${pistaId ? `?pista=${encodeURIComponent(pistaId)}` : ''}`)).cuerpo;

async function entrar(ringId, pin) {
  const r = await fetch(`${base}/api/mesa/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ringId, pin })
  });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, autorizado: r.ok && d.ok === true, token: d.token, error: d.error };
}

// Acción de mesa + el snapshot resultante (por defecto, la pista activa del
// ring) — junta en un solo helper lo que antes eran `accionar`/`accionarAviso`
// escuchando eventos de socket, porque acá la respuesta HTTP ya trae todo.
async function accion(ringId, ruta, token, body) {
  const r = await fetch(`${base}/api/ring/${encodeURIComponent(ringId)}/${ruta}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {})
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { error: d.error };
  return { aviso: d.aviso, snap: await snapshot(ringId) };
}

async function nuevaCompetencia(token, body) {
  const r = await fetch(`${base}/api/nueva_competencia`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {})
  });
  const d = await r.json().catch(() => ({}));
  return r.ok ? d : { error: d.error };
}

/* ── fixtures ─────────────────────────────────────────────────────────── */

// Alturas mezcladas adrede dentro de la misma pista, para probar el reorden.
const ALTURAS = ['Large', 'Small', 'Large', 'Medium', 'XS', 'Intermediate'];
const FIXTURE = ['ring,pista,categoria,altura,dorsal,guia,perro,raza']
  .concat([41, 42, 43, 44, 45, 46].map((d, n) =>
    `Ring 1,Jumping 1,G${(n % 3) + 1},${ALTURAS[n]},${d},Guía ${d},Perro ${d},Border Collie`))
  .concat([12, 13, 14].map(d => `Ring 2,Agility 1,G1,Small,${d},Guía ${d},Perro ${d},Sheltie`))
  .join('\n') + '\n';

(async () => {
  try {
    await crearEsquema();
    await arrancarServidor();

    /* ── 1. arranque y forma del snapshot ────────────────────────────── */
    console.log('\n1. Arranque y forma de los datos');
    await sembrarFixture(FIXTURE);
    for (const ruta of ['/api/resumen', '/api/ring/ring-1', '/api/ring/ring-2']) {
      const r = await get(ruta);
      chequear(`GET ${ruta} → 200`, r.status === 200, `status ${r.status}`);
    }
    const res1 = await resumen();
    chequear('el resumen trae los 2 rings del CSV',
      res1.rings.length === 2 && res1.rings[0].id === 'ring-1', JSON.stringify(res1.rings.map(r => r.id)));
    const snapIni = await snapshot('ring-1');
    chequear('cada inscripción trae su altura y su grado',
      snapIni.lista.every(i => i.altura && i.categoria),
      JSON.stringify(snapIni.lista.map(i => [i.altura, i.categoria])));
    chequear('una pista = una sola lista, con alturas y grados mezclados',
      snapIni.pistas.length === 1 && snapIni.lista.length === 6,
      `${snapIni.pistas.length} pistas, ${snapIni.lista.length} perros`);
    chequear('la pista se llama por el recorrido, sin altura pegada',
      snapIni.pista.nombre === 'Jumping 1' && snapIni.pista.altura === undefined,
      JSON.stringify(snapIni.pista));
    // El CSV viene Large, Small, Large, Medium, XS, Intermediate: desordenado a
    // propósito. El sembrado tiene que acomodarlo.
    chequear('las alturas quedan de menor a mayor, aunque el CSV venga mezclado',
      snapIni.lista.map(i => i.altura).join(',') === 'XS,Small,Medium,Intermediate,Large,Large',
      snapIni.lista.map(i => i.altura).join(','));
    chequear('dentro de cada altura se respeta el orden del CSV',
      snapIni.lista.map(i => i.dorsal).join(',') === '45,42,44,46,41,43',
      snapIni.lista.map(i => i.dorsal).join(','));
    chequear('la portada lista todas las pistas de cada ring',
      res1.rings[0].pistas.length === 1 && res1.rings[0].pistas[0].nombre === 'Jumping 1',
      JSON.stringify(res1.rings.map(r => r.pistas.map(p => p.nombre))));

    /* ── 2. PIN y permisos ────────────────────────────────────────────── */
    console.log('\n2. PIN y permisos');
    const rechazo = await accion('ring-1', 'siguiente', null);
    chequear('sin token no se puede avanzar', /PIN de mesa/.test(String(rechazo.error)), JSON.stringify(rechazo));

    const malPin = await entrar('ring-1', '0000');
    chequear('PIN incorrecto → no autoriza', malPin.autorizado === false && malPin.status === 401, JSON.stringify(malPin));

    const mesa1 = await entrar('ring-1', PIN);
    chequear('PIN correcto → token', mesa1.autorizado === true && !!mesa1.token, JSON.stringify(mesa1));

    /* ── 3. avanzar el orden ──────────────────────────────────────────── */
    console.log('\n3. Avanzar');
    let r1 = (await accion('ring-1', 'siguiente', mesa1.token)).snap;
    const enPista = r1.lista.find(i => i.estado === 'en_pista');
    chequear('el primer perro de la lista entra a pista (el más chico)',
      enPista?.dorsal === snapIni.lista[0].dorsal && enPista?.altura === 'XS', JSON.stringify(enPista));
    chequear('quedan 5 pendientes', r1.lista.filter(i => i.estado === 'pendiente').length === 5,
      String(r1.lista.filter(i => i.estado === 'pendiente').length));

    /* ── 4. aislamiento entre rings ───────────────────────────────────── */
    console.log('\n4. Aislamiento entre rings');
    const snapR2 = await snapshot('ring-2');
    const ajeno = snapR2.lista[0].id;
    // El token es válido para ring-1: se llama con la URL de ring-1 pero un id
    // que pertenece al Ring 2 — el guard tiene que estar en la acción, no sólo
    // en la ruta.
    const cruce = await accion('ring-1', 'ausente', mesa1.token, { id: ajeno });
    chequear('la mesa del Ring 1 NO puede marcar ausente en el Ring 2',
      cruce.error === 'Esa inscripción no es de esta competencia.', JSON.stringify(cruce));
    const cruceMover = await accion('ring-1', 'mover', mesa1.token, { id: ajeno, delta: 1 });
    chequear('la mesa del Ring 1 NO puede reordenar el Ring 2',
      cruceMover.error === 'Esa inscripción no es de esta competencia.', JSON.stringify(cruceMover));
    const cruceRuta = await accion('ring-2', 'siguiente', mesa1.token);
    chequear('un token de ring-1 no sirve en la URL de ring-2',
      /PIN de mesa/.test(String(cruceRuta.error)), JSON.stringify(cruceRuta));

    /* ── 5. deshacer por ring ─────────────────────────────────────────── */
    console.log('\n5. Deshacer por ring');
    const mesa2 = await entrar('ring-2', PIN);
    await accion('ring-2', 'siguiente', mesa2.token);
    const r2Antes = (await accion('ring-2', 'siguiente', mesa2.token)).snap;
    const pistaR2 = r2Antes.lista.find(i => i.estado === 'en_pista')?.dorsal;
    const corridosR2 = r2Antes.lista.filter(i => i.estado === 'corrido').length;
    chequear('el Ring 2 avanzó dos perros', corridosR2 === 1 && !!pistaR2, `${corridosR2} corridos, pista ${pistaR2}`);

    for (let i = 0; i < 5; i++) await accion('ring-1', 'deshacer', mesa1.token);
    const r2Despues = await snapshot('ring-2');
    chequear('Ctrl+Z en el Ring 1 no toca el Ring 2',
      r2Despues.lista.find(i => i.estado === 'en_pista')?.dorsal === pistaR2 &&
      r2Despues.lista.filter(i => i.estado === 'corrido').length === corridosR2,
      `pista ${r2Despues.lista.find(i => i.estado === 'en_pista')?.dorsal}, ` +
      `${r2Despues.lista.filter(i => i.estado === 'corrido').length} corridos`);

    const r1Despues = await snapshot('ring-1');
    chequear('el Ring 1 sí volvió atrás',
      r1Despues.lista.every(i => i.estado === 'pendiente'),
      JSON.stringify(r1Despues.lista.filter(i => i.estado !== 'pendiente').map(i => [i.dorsal, i.estado])));

    /* ── 6. reordenar con un ausente en el medio ──────────────────────── */
    console.log('\n6. Reordenar con un ausente en el medio');
    r1 = (await accion('ring-1', 'siguiente', mesa1.token)).snap;   // el primero a pista
    const pista0 = r1.lista.find(i => i.estado === 'en_pista');
    let pend = r1.lista.filter(i => i.estado === 'pendiente');
    const [p0, p1, p2] = pend;

    r1 = (await accion('ring-1', 'ausente', mesa1.token, { id: p1.id })).snap;
    pend = r1.lista.filter(i => i.estado === 'pendiente');
    chequear('el ausente sale de la lista de pendientes',
      pend.slice(0, 2).map(i => i.dorsal).join() === `${p0.dorsal},${p2.dorsal}`,
      pend.map(i => i.dorsal).join());

    // p2 tiene el ausente entre él y p0: la flecha tiene que saltárselo.
    r1 = (await accion('ring-1', 'mover', mesa1.token, { id: p2.id, delta: -1 })).snap;
    pend = r1.lista.filter(i => i.estado === 'pendiente');
    chequear('la flecha ↑ salta por encima del ausente y reordena de verdad',
      pend[0].dorsal === p2.dorsal && pend[1].dorsal === p0.dorsal, pend.map(i => i.dorsal).join());

    const enPistaAhora = r1.lista.find(i => i.estado === 'en_pista');
    chequear('el perro en pista sigue en pista', enPistaAhora?.dorsal === pista0.dorsal, JSON.stringify(enPistaAhora));

    // Sobrevive a un reinicio del servidor HTTP (nada quedaba cacheado).
    await reiniciarServidor();
    const trasReinicio = await snapshot('ring-1');
    chequear('el reorden sobrevive a un reinicio del servidor',
      trasReinicio.lista.filter(i => i.estado === 'pendiente')[0].dorsal === p2.dorsal,
      trasReinicio.lista.filter(i => i.estado === 'pendiente').slice(0, 2).map(i => i.dorsal).join(','));

    /* ── 6b. pista terminada: nadie desaparece ────────────────────────── */
    console.log('\n6b. Pista terminada');
    // Ring 2 tiene 3 perros y ya avanzó 2 en el paso 5: dos "siguiente" más y cierra.
    await accion('ring-2', 'siguiente', mesa2.token);
    const r2Fin = (await accion('ring-2', 'siguiente', mesa2.token)).snap;
    chequear('la pista queda cerrada', r2Fin.pista?.estado === 'cerrada', JSON.stringify(r2Fin.pista));
    chequear('la lista NO se vacía: siguen los 3 corredores en pantalla',
      r2Fin.lista.length === 3, `${r2Fin.lista.length} en la lista`);
    chequear('todos quedan como corridos (grisados en la vista)',
      r2Fin.lista.every(i => i.estado === 'corrido'),
      JSON.stringify(r2Fin.lista.map(i => i.estado)));
    chequear('ya no hay nadie en pista ni pendiente',
      !r2Fin.lista.some(i => i.estado === 'en_pista' || i.estado === 'pendiente'));
    const otroIntento = await accion('ring-2', 'siguiente', mesa2.token);
    chequear('avanzar de nuevo avisa que terminó, sin romper nada',
      otroIntento.error === 'La pista ya terminó. Abrí la siguiente.', JSON.stringify(otroIntento));
    const resumenFin = await resumen();
    const r2Card = resumenFin.rings.find(r => r.id === 'ring-2').pistas[0];
    chequear('la portada sigue nombrando la pista terminada',
      r2Card.nombre === 'Agility 1' && r2Card.faltan === 0 && r2Card.total === 3,
      JSON.stringify(r2Card));

    /* ── 6c. cargar orden desde CSV ───────────────────────────────────── */
    console.log('\n6c. Cargar orden desde archivo');
    const snapR1c = await snapshot('ring-1');
    chequear('el snapshot dice qué pistas ya arrancaron',
      snapR1c.pistas.every(p => typeof p.arrancada === 'boolean'), JSON.stringify(snapR1c.pistas));

    // El Ring 2 tiene su pista terminada; no se puede importar sobre ella.
    const pistaCerrada = snapR2.pistas[0].id;
    const yaArranco = await accion('ring-2', 'cargar_orden', mesa2.token,
      { pistaId: pistaCerrada, csv: 'dorsal\n12\n13\n14\n' });
    chequear('no deja importar sobre una pista que ya arrancó',
      yaArranco.error === 'Esa pista ya arrancó: el orden no se cambia desde un archivo.',
      JSON.stringify(yaArranco));

    // Fixture aparte, sin arrancar, para probar la importación de verdad.
    await sembrarFixture(FIXTURE);
    const mesaImp = await entrar('ring-1', PIN);
    const snapImp0 = await snapshot('ring-1');
    const pistaId = snapImp0.pista.id;
    chequear('arranca con el orden del seed',
      snapImp0.lista.map(i => i.dorsal).join(',') === '45,42,44,46,41,43',
      snapImp0.lista.map(i => i.dorsal).join(','));

    // Archivo con tiempos: se ignoran, sólo cuenta la columna dorsal y el orden.
    const csvTiempos = 'puesto,dorsal,perro,tiempo\n1,43,Perro 43,31.20\n2,41,Perro 41,32.80\n' +
      '3,46,Perro 46,33.10\n4,44,Perro 44,35.40\n5,42,Perro 42,36.90\n6,45,Perro 45,40.00\n';
    const imp = await accion('ring-1', 'cargar_orden', mesaImp.token, { pistaId, csv: csvTiempos });
    chequear('la importación no da error', !imp.error, JSON.stringify(imp).slice(0, 160));
    let impSnap = imp.snap;
    // El archivo pide 43,41,46,44,42,45; la regla de alturas manda, así que queda
    // XS, Small, Medium, Intermediate y recién ahí los dos Large en orden del archivo.
    chequear('la altura manda y el archivo ordena adentro',
      impSnap.lista.map(i => i.dorsal).join(',') === '45,42,44,46,43,41',
      impSnap.lista.map(i => i.dorsal).join(','));
    chequear('las alturas siguen de menor a mayor después de importar',
      impSnap.lista.map(i => i.altura).join(',') === 'XS,Small,Medium,Intermediate,Large,Large',
      impSnap.lista.map(i => i.altura).join(','));
    // Dentro de Large (41 y 43) el archivo pone 43 antes que 41: eso sí cambia.
    let larges = impSnap.lista.filter(i => i.altura === 'Large').map(i => i.dorsal).join(',');
    chequear('dentro de una altura sí reordena según el archivo', larges === '43,41', larges);

    // Invertir: el mismo archivo al revés.
    const impInv = await accion('ring-1', 'cargar_orden', mesaImp.token, { pistaId, csv: csvTiempos, invertir: true });
    chequear('la opción invertir no da error', !impInv.error, JSON.stringify(impInv).slice(0, 120));
    const largesInv = impInv.snap.lista.filter(i => i.altura === 'Large').map(i => i.dorsal).join(',');
    chequear('invertir da vuelta el orden dentro de la altura', largesInv === '41,43', largesInv);

    // Dorsales que no corren esta pista, y perros que el archivo no menciona.
    const csvParcial = 'dorsal\n9999\n43\n8888\n43\n';
    const impParcial = await accion('ring-1', 'cargar_orden', mesaImp.token, { pistaId, csv: csvParcial });
    chequear('reporta los dorsales ajenos, los faltantes y los repetidos',
      /no corren esta pista/.test(JSON.stringify(impParcial)) &&
      /no estaban en el archivo/.test(JSON.stringify(impParcial)) &&
      /repetido/.test(JSON.stringify(impParcial)),
      JSON.stringify(impParcial));
    chequear('los que el archivo no menciona no se pierden',
      impParcial.snap.lista.length === 6, `${impParcial.snap.lista.length} en la lista`);
    chequear('el mencionado queda primero dentro de su altura',
      impParcial.snap.lista.filter(i => i.altura === 'Large').map(i => i.dorsal).join(',') === '43,41',
      impParcial.snap.lista.filter(i => i.altura === 'Large').map(i => i.dorsal).join(','));

    // Undo
    const impUndo = await accion('ring-1', 'deshacer', mesaImp.token);
    chequear('Ctrl+Z revierte una importación', !impUndo.error, JSON.stringify(impUndo).slice(0, 120));
    chequear('vuelve al orden anterior a la importación',
      impUndo.snap.lista.filter(i => i.altura === 'Large').map(i => i.dorsal).join(',') === '41,43',
      impUndo.snap.lista.filter(i => i.altura === 'Large').map(i => i.dorsal).join(','));

    // Archivos inválidos
    const soloNombres = await accion('ring-1', 'cargar_orden', mesaImp.token,
      { pistaId, csv: 'puesto,perro,tiempo\n1,Perro 43,31.20\n' });
    chequear('en una pista con dorsales, un archivo de nombres avisa qué falta',
      soloNombres.error === 'El archivo trae nombres pero esta pista se ordena por dorsal: le falta la columna "dorsal".',
      JSON.stringify(soloNombres));
    const nadaCoincide = await accion('ring-1', 'cargar_orden', mesaImp.token, { pistaId, csv: 'dorsal\n7777\n8888\n' });
    chequear('si ningún dorsal coincide, no toca el orden',
      nadaCoincide.error === 'Ningún perro del archivo coincide con los de esta pista.',
      JSON.stringify(nadaCoincide));
    const vacio = await accion('ring-1', 'cargar_orden', mesaImp.token, { pistaId, csv: '   ' });
    chequear('un archivo vacío se rechaza', vacio.error === 'El archivo llegó vacío.', JSON.stringify(vacio));
    const gigante = await accion('ring-1', 'cargar_orden', mesaImp.token,
      { pistaId, csv: 'dorsal\n' + '43\n'.repeat(200000) });   // ~600 KB: pasa el transporte, no mi tope
    chequear('un archivo gigante se rechaza con mensaje, no en silencio',
      gigante.error === 'El archivo es demasiado grande.', JSON.stringify(gigante).slice(0, 120));
    const ajena = await accion('ring-1', 'cargar_orden', mesaImp.token, { pistaId: 'ring-2--agility-1', csv: 'dorsal\n12\n' });
    chequear('no se puede importar a la pista de otro ring',
      ajena.error === 'Esa pista no es de esta competencia.', JSON.stringify(ajena));

    // Un archivo con ring y pista adentro: se usan sólo las filas que tocan.
    const csvMulti = 'ring,pista,dorsal\nRing 2,Agility 1,12\nRing 1,Jumping 1,41\nRing 1,Jumping 1,43\n';
    const impMulti = await accion('ring-1', 'cargar_orden', mesaImp.token, { pistaId, csv: csvMulti });
    chequear('un archivo con varias pistas usa sólo las filas de esta',
      !impMulti.error && /2 en el orden del archivo/.test(String(impMulti.aviso)), String(impMulti.aviso));

    // Sin token no se puede importar.
    const sinPin = await accion('ring-1', 'cargar_orden', null, { pistaId, csv: 'dorsal\n41\n' });
    chequear('sin token no se puede importar el orden', /PIN de mesa/.test(String(sinPin.error)), JSON.stringify(sinPin));

    /* ── 6d. importar una pista sin dorsales (G0) ─────────────────────── */
    console.log('\n6d. Importar una pista sin dorsales (G0)');
    const FIX_G0 = ['ring,pista,categoria,altura,dorsal,guia,perro,raza']
      .concat([
        'Revamp,Iniciante 1,G0,Small,,Marieli Sanoja,OREO,',
        'Revamp,Iniciante 1,G0,Small,,Guía G0,PERRO4,',
        'Revamp,Iniciante 1,G0,Medium,,Sofía Benitez,PERRO2,',
        'Revamp,Iniciante 1,G0,Large,,Victoria del Val,PERRO5,'
      ]).join('\n') + '\n';
    await sembrarFixture(FIX_G0);
    const mesaG0 = await entrar('revamp', PIN);
    const snapG0_0 = await snapshot('revamp');
    const pistaG0 = snapG0_0.pista.id;
    chequear('siembra bien una pista donde nadie tiene dorsal',
      snapG0_0.lista.length === 4 && snapG0_0.lista.every(i => !i.dorsal),
      JSON.stringify(snapG0_0.lista.map(i => [i.dorsal, i.perro])));
    chequear('el orden inicial es por altura',
      snapG0_0.lista.map(i => i.perro).join(',') === 'OREO,PERRO4,PERRO2,PERRO5',
      snapG0_0.lista.map(i => i.perro).join(','));

    // Archivo con nombres en vez de dorsales, en otro orden y en minúscula.
    const csvNombres = 'puesto,perro,tiempo\n1,perro5,28.4\n2,perro2,30.1\n3,perro4,31.7\n4,oreo,33.0\n';
    const impG0 = await accion('revamp', 'cargar_orden', mesaG0.token, { pistaId: pistaG0, csv: csvNombres });
    chequear('acepta un archivo con columna "perro" y sin "dorsal"', !impG0.error, JSON.stringify(impG0).slice(0, 140));
    chequear('reordena por nombre, respetando la altura',
      impG0.snap.lista.map(i => i.perro).join(',') === 'PERRO4,OREO,PERRO2,PERRO5',
      impG0.snap.lista.map(i => i.perro).join(','));
    chequear('los 4 entraron por nombre', /4 en el orden del archivo/.test(String(impG0.aviso)), String(impG0.aviso));

    const csvAcento = 'perro\nPERRO2\nPERRO5\nPERRO4\nOREO\n';
    const impAcento = await accion('revamp', 'cargar_orden', mesaG0.token, { pistaId: pistaG0, csv: csvAcento });
    chequear('el archivo en mayúsculas matchea igual',
      impAcento.snap.lista.map(i => i.perro).join(',') === 'PERRO4,OREO,PERRO2,PERRO5',
      impAcento.snap.lista.map(i => i.perro).join(','));

    const impDesc = await accion('revamp', 'cargar_orden', mesaG0.token, { pistaId: pistaG0, csv: 'perro\nFANTASMA\nPERRO5\n' });
    chequear('un nombre que no corre la pista se reporta', /FANTASMA/.test(String(impDesc.aviso)), String(impDesc.aviso));

    const sinNada = await accion('revamp', 'cargar_orden', mesaG0.token, { pistaId: pistaG0, csv: 'puesto,tiempo\n1,28.4\n' });
    chequear('sin columna dorsal ni perro, lo dice',
      sinNada.error === 'El archivo necesita una columna "dorsal" o "perro".', JSON.stringify(sinNada));

    /* ── 6e. mirar y reordenar una pista que no está corriendo ────────── */
    console.log('\n6e. Mirar y reordenar una pista que no está corriendo');
    const FIX_VER = ['ring,pista,categoria,altura,dorsal,guia,perro,raza']
      .concat([1, 2, 3].map(d => `Cancha 1,Jumping 1,G1,Large,${d},Guía ${d},Perro ${d},`))
      .concat([4, 5, 6].map(d => `Cancha 1,Jumping 2,G1,Large,${d},Guía ${d},Perro ${d},`))
      .concat([7, 8].map(d => `Cancha 1,Final,G1,Large,${d},Guía ${d},Perro ${d},`))
      .join('\n') + '\n';
    await sembrarFixture(FIX_VER);

    const snapDef = await snapshot('cancha-1');
    chequear('sin pedir pista, se manda la que está corriendo',
      snapDef.pista.nombre === 'Jumping 1' && snapDef.esActiva === true, JSON.stringify(snapDef.pista));
    chequear('el snapshot dice cuál es la que corre',
      snapDef.activa?.nombre === 'Jumping 1', JSON.stringify(snapDef.activa));
    chequear('lista las 3 pistas del ring', snapDef.pistas.length === 3, snapDef.pistas.map(p => p.nombre).join(','));

    const snapFinal = await snapshot('cancha-1', 'cancha-1--final');
    chequear('se puede pedir el orden de otra pista por query string',
      snapFinal.pista.nombre === 'Final' && snapFinal.lista.length === 2, JSON.stringify(snapFinal.pista));
    chequear('y avisa que NO es la que está corriendo',
      snapFinal.esActiva === false && snapFinal.activa.nombre === 'Jumping 1',
      `esActiva=${snapFinal.esActiva} activa=${snapFinal.activa?.nombre}`);
    chequear('la pista que no largó viene marcada como no arrancada',
      snapFinal.pista.arrancada === false, String(snapFinal.pista.arrancada));

    const pistaAjena = await snapshot('cancha-1', 'otro-ring--x');
    chequear('una pista de otro ring se ignora y cae en la activa',
      pistaAjena.pista.nombre === 'Jumping 1', JSON.stringify(pistaAjena.pista));

    // La mesa reordena una pista que no está corriendo, sin abrirla.
    const mesaVer = await entrar('cancha-1', PIN);
    const primeroFinal = snapFinal.lista[0];
    const movida = await accion('cancha-1', 'mover', mesaVer.token, { id: snapFinal.lista[1].id, delta: -1 });
    chequear('la mesa reordena una pista que no está corriendo (el id ya la ubica)', !movida.error, JSON.stringify(movida).slice(0, 120));
    const finalDespues = await snapshot('cancha-1', 'cancha-1--final');
    chequear('el reorden se aplicó a esa pista',
      finalDespues.lista[0].dorsal !== primeroFinal.dorsal, finalDespues.lista.map(i => i.dorsal).join(','));
    const sigueActiva = await snapshot('cancha-1');
    chequear('y la pista en curso no cambió', sigueActiva.pista.nombre === 'Jumping 1', sigueActiva.pista.nombre);

    /* ── 6f. cambiar el orden del programa ────────────────────────────── */
    console.log('\n6f. Cambiar el orden del programa');
    const FIX_PROG = ['pista,categoria,altura,dorsal,guia,perro']
      .concat(['Agility 1', 'Agility 2', 'Jumping 1', 'Final'].flatMap((p, n) =>
        [1, 2].map(d => `${p},G1,Large,${n * 10 + d},Guía ${n}${d},PERRO ${n}${d}`)))
      .join('\n') + '\n';
    await sembrarFixture(FIX_PROG);
    const mesaP = await entrar('copa-de-otono', PIN);
    let snapP = await snapshot('copa-de-otono');
    const prog = s => s.pistas.map(p => p.nombre).join(',');
    chequear('el programa arranca en el orden del CSV',
      prog(snapP) === 'Agility 1,Agility 2,Jumping 1,Final', prog(snapP));

    // Bajar la Final no tiene efecto: ya es la última.
    let r = await accion('copa-de-otono', 'mover_pista', mesaP.token, { id: 'copa-de-otono--final', delta: 1 });
    chequear('bajar la última no rompe ni cambia nada',
      !r.error && prog(r.snap) === 'Agility 1,Agility 2,Jumping 1,Final', `${r.error || ''} ${prog(r.snap)}`);

    // Subir Jumping 1 dos veces: queda primera.
    r = await accion('copa-de-otono', 'mover_pista', mesaP.token, { id: 'copa-de-otono--jumping-1', delta: -1 });
    chequear('subir una pista la adelanta en el programa',
      prog(r.snap) === 'Agility 1,Jumping 1,Agility 2,Final', prog(r.snap));
    r = await accion('copa-de-otono', 'mover_pista', mesaP.token, { id: 'copa-de-otono--jumping-1', delta: -1 });
    chequear('y se puede seguir subiendo hasta el principio',
      prog(r.snap) === 'Jumping 1,Agility 1,Agility 2,Final', prog(r.snap));

    // Al reordenar, la que queda primera es la que la vista muestra por defecto.
    chequear('la primera del programa nuevo es la que se muestra', r.snap.pista.nombre === 'Jumping 1', r.snap.pista.nombre);

    // Ctrl+Z lo revierte.
    r = await accion('copa-de-otono', 'deshacer', mesaP.token);
    chequear('Ctrl+Z revierte el cambio de programa',
      prog(r.snap) === 'Agility 1,Jumping 1,Agility 2,Final', prog(r.snap));

    // Una pista que ya arrancó no se mueve, y las demás se mueven entre ellas.
    await accion('copa-de-otono', 'siguiente', mesaP.token);   // arranca la primera del programa
    snapP = await snapshot('copa-de-otono');
    const arrancada = snapP.pistas.find(p => p.arrancada);
    chequear('la primera del programa quedó arrancada', !!arrancada, JSON.stringify(snapP.pistas));
    const rMal = await accion('copa-de-otono', 'mover_pista', mesaP.token, { id: arrancada.id, delta: 1 });
    chequear('una pista que ya arrancó no se puede mover',
      rMal.error === 'Esa pista ya arrancó: su lugar en el programa no se cambia.', JSON.stringify(rMal));

    r = await accion('copa-de-otono', 'mover_pista', mesaP.token, { id: 'copa-de-otono--final', delta: -1 });
    chequear('las que no arrancaron se siguen moviendo entre ellas',
      prog(r.snap) === 'Agility 1,Jumping 1,Final,Agility 2', prog(r.snap));
    chequear('la que arrancó no se movió de su lugar',
      r.snap.pistas[0].nombre === 'Agility 1' && r.snap.pistas[0].arrancada === true,
      JSON.stringify(r.snap.pistas.map(p => [p.nombre, p.arrancada])));

    // El orden del programa sobrevive a un reinicio del servidor.
    await reiniciarServidor();
    const trasP = await snapshot('copa-de-otono');
    chequear('el programa reordenado sobrevive al reinicio',
      prog(trasP) === 'Agility 1,Jumping 1,Final,Agility 2', prog(trasP));

    // Sin token no se toca el programa.
    const sinPinP = await accion('copa-de-otono', 'mover_pista', null, { id: 'copa-de-otono--final', delta: -1 });
    chequear('sin token no se puede cambiar el programa', /PIN de mesa/.test(String(sinPinP.error)), JSON.stringify(sinPinP));

    /* ── 6g. cargar otra competencia (borrar y sembrar de cero) ───────── */
    console.log('\n6g. Cargar otra competencia (borrar y sembrar de cero)');
    await sembrarFixture(FIXTURE);
    const mesaN = await entrar('ring-1', PIN);
    await accion('ring-1', 'siguiente', mesaN.token);   // deja avances para verificar que se borran

    // Sin la palabra tipeada, no pasa nada.
    const sinConf = await nuevaCompetencia(mesaN.token, { csv: 'pista,perro\nFinal,PERRO A\n' });
    chequear('sin la confirmación tipeada no borra nada', sinConf.error === 'Falta la confirmación.', JSON.stringify(sinConf));

    // Sin token tampoco.
    const sinPinN = await nuevaCompetencia(null, { csv: 'pista,perro\nFinal,PERRO A\n', confirmar: 'BORRAR' });
    chequear('sin token no se puede cargar otra competencia', /PIN de mesa/.test(String(sinPinN.error)), JSON.stringify(sinPinN));

    // Un archivo sin las columnas mínimas se rechaza sin tocar nada.
    const basura = await nuevaCompetencia(mesaN.token, { csv: 'a,b,c\n1,2,3\n', confirmar: 'BORRAR' });
    chequear('un CSV sin pista ni perro se rechaza', /ninguna inscripción usable/.test(String(basura.error)), JSON.stringify(basura));
    const intacto = await snapshot('ring-1');
    chequear('y la competencia anterior sigue intacta', intacto.lista.length === 6, `${intacto.lista.length} inscripciones`);

    // La carga de verdad. Sin columna `ring`: una sola cancha.
    const csvNueva = ['pista,categoria,altura,dorsal,guia,perro']
      .concat(['Agility 1,G1,Large,201,Guía A,PERRO A', 'Agility 1,G2,Small,202,Guía B,PERRO B'])
      .concat(['Final,G1,Large,201,Guía A,PERRO A'])
      .concat([',G1,Large,203,Guía C,SIN PISTA', 'Final,G1,Large,204,Guía D,'])
      .join('\n') + '\n';
    const fechaMala = await nuevaCompetencia(mesaN.token, { csv: csvNueva, confirmar: 'BORRAR', fecha: '3/10/2026' });
    chequear('una fecha que no es AAAA-MM-DD se rechaza', /fecha no es válida/.test(String(fechaMala.error)), JSON.stringify(fechaMala));
    const irA = await nuevaCompetencia(mesaN.token, {
      csv: csvNueva, confirmar: 'BORRAR', nombre: '  Copa de Otoño ', fecha: '2026-10-04'
    });
    chequear('reporta lo que cargó', /Competencia nueva cargada/.test(String(irA.aviso)), String(irA.aviso));
    chequear('cuenta las filas salteadas sin pista o sin perro', /2 fila\(s\) salteada/.test(String(irA.aviso)), String(irA.aviso));
    // Sin esto la mesa recarga su URL vieja, que apunta a un ring que ya no existe.
    chequear('dice a qué mesa ir, la de la competencia nueva', irA.ringId === 'copa-de-otono', JSON.stringify(irA));

    const resN = await resumen();
    chequear('la competencia vieja desapareció',
      resN.rings.length === 1 && resN.rings[0].id !== 'ring-1', JSON.stringify(resN.rings.map(r => r.id)));
    chequear('sin columna "ring", la cancha toma el nombre del evento', resN.rings[0].nombre === 'Copa de Otoño', resN.rings[0].nombre);
    chequear('el nombre y la fecha que puso la mesa quedan en el evento',
      resN.evento.nombre === 'Copa de Otoño' && resN.evento.fecha === '2026-10-04', JSON.stringify(resN.evento));
    // Sin nombre: el evento se llama como la (única) cancha del archivo, no
    // con un nombre por defecto que nadie eligió.
    chequear('sin nombre, el evento toma el de la cancha del archivo',
      dominio.sembrar(['ring,pista,perro', 'Regional Ejemplo,Agility 1 G1,PERRO'].join('\n'))
        .state.evento.nombre === 'Regional Ejemplo');
    chequear('sin nombre ni cancha, queda "Competencia"',
      dominio.sembrar(['pista,perro', 'Agility 1,PERRO'].join('\n')).state.evento.nombre === 'Competencia');
    // Corregir nombre y fecha después, sin recargar: lo corrido no se toca.
    const ringE = resN.rings[0].id;
    const mesaE = await entrar(ringE, PIN);
    const sinNombre = await accion(ringE, 'evento', mesaE.token, { nombre: '  ', fecha: '2026-10-05' });
    chequear('renombrar sin nombre se rechaza', /Falta el nombre/.test(String(sinNombre.error)), JSON.stringify(sinNombre));
    const fechaMalaE = await accion(ringE, 'evento', mesaE.token, { nombre: 'X', fecha: '5/10' });
    chequear('renombrar con fecha inválida se rechaza', /fecha no es válida/.test(String(fechaMalaE.error)), JSON.stringify(fechaMalaE));
    const ren = await accion(ringE, 'evento', mesaE.token, { nombre: ' Nacional Ejemplo ', fecha: '2026-10-05' });
    chequear('la mesa renombra el evento', !ren.error, JSON.stringify(ren));
    const resR = await resumen();
    chequear('el evento queda con el nombre y la fecha nuevos, y las pistas siguen',
      resR.evento.nombre === 'Nacional Ejemplo' && resR.evento.fecha === '2026-10-05' && resR.rings[0].pistas.length === 2,
      JSON.stringify(resR.evento));
    const conOrg = await accion(ringE, 'evento', mesaE.token, { nombre: 'Nacional Ejemplo', fecha: '2026-10-05', organizador: ' Club Ejemplo ' });
    chequear('el organizador de las planillas se guarda en la base',
      conOrg.snap.evento.organizador === 'Club Ejemplo' && (await snapshot(ringE)).evento.organizador === 'Club Ejemplo',
      JSON.stringify(conOrg.snap.evento));
    const sinOrg = await accion(ringE, 'evento', mesaE.token, { nombre: 'Nacional Ejemplo', fecha: '2026-10-05' });
    chequear('renombrar sin mandar organizador no lo borra', sinOrg.snap.evento.organizador === 'Club Ejemplo',
      JSON.stringify(sinOrg.snap.evento));
    chequear('cargó las 2 pistas nuevas',
      resN.rings[0].pistas.map(p => p.nombre).join(',') === 'Agility 1,Final',
      resN.rings[0].pistas.map(p => p.nombre).join(','));

    const ringN = resN.rings[0].id;
    const snapN = await snapshot(ringN);
    chequear('nadie arrastra estado de la competencia anterior',
      snapN.lista.every(i => i.estado === 'pendiente'), JSON.stringify(snapN.lista.map(i => i.estado)));
    chequear('la primera pista queda abierta', snapN.pista.nombre === 'Agility 1', snapN.pista.nombre);
    chequear('las alturas de la pista nueva también van de menor a mayor',
      snapN.lista.map(i => i.altura).join(',') === 'Small,Large', snapN.lista.map(i => i.altura).join(','));

    const { rows: resp } = await db.pool.query('select motivo from respaldos order by id desc limit 1');
    chequear('el estado anterior quedó respaldado', resp[0]?.motivo === 'nueva competencia', JSON.stringify(resp));
    const { rows: seedRow } = await db.pool.query('select csv from seed_actual');
    chequear('el CSV nuevo pasó a ser la semilla', seedRow[0]?.csv === csvNueva);
    const { rows: undoRestante } = await db.pool.query('select count(*) from undo_pila');
    chequear('el deshacer de la competencia anterior se limpió', Number(undoRestante[0].count) === 0);

    // Y sobrevive a un reinicio.
    await reiniciarServidor();
    const trasR = await resumen();
    chequear('la competencia nueva sobrevive al reinicio', trasR.rings[0].pistas.length === 2, JSON.stringify(trasR.rings[0].pistas.map(p => p.nombre)));

    /* ── 6g2. combinados: de a pares, opcionales ──────────────────────── */
    console.log('\n6g2. Combinados');
    {
      const mesaC = await entrar(ringN, PIN);
      const [ag, fin] = trasR.rings[0].pistas.map(p => p.id);
      let sc = await snapshot(ringN);
      chequear('de entrada ninguna pista combina', sc.combinado === null && sc.pistas.every(p => !p.combinaCon),
        JSON.stringify(sc.pistas));
      const consigo = await accion(ringN, 'combinar', mesaC.token, { pistaId: ag, con: ag });
      chequear('una pista no combina consigo misma', !!consigo.error, JSON.stringify(consigo));
      const ajena = await accion(ringN, 'combinar', mesaC.token, { pistaId: ag, con: 'otro-ring--x' });
      chequear('no combina con una pista de otra cancha', !!ajena.error, JSON.stringify(ajena));
      sc = (await accion(ringN, 'combinar', mesaC.token, { pistaId: ag, con: fin })).snap;
      chequear('se arma el par, y las dos se apuntan',
        sc.pistas.find(p => p.id === ag).combinaCon === fin && sc.pistas.find(p => p.id === fin).combinaCon === ag,
        JSON.stringify(sc.pistas));
      chequear('el snapshot trae el combinado, con las pistas en el orden en que se corren',
        sc.combinado?.pistas.map(p => p.nombre).join(' + ') === 'Agility 1 + Final', JSON.stringify(sc.combinado?.pistas));
      chequear('sin nadie corrido, todos quedan como faltan',
        sc.combinado.clasificacion.reduce((n, p) => n + p.faltan, 0) === 2 &&
        sc.combinado.clasificacion.every(p => !p.filas.length), JSON.stringify(sc.combinado.clasificacion));
      const desdeLaOtra = await snapshot(ringN, fin);
      chequear('desde la otra pista se ve el mismo combinado', desdeLaOtra.combinado?.pistas[1].id === fin);
      sc = (await accion(ringN, 'deshacer', mesaC.token)).snap;
      chequear('deshacer desarma el combinado', sc.combinado === null && sc.pistas.every(p => !p.combinaCon),
        JSON.stringify(sc.pistas));
      sc = (await accion(ringN, 'combinar', mesaC.token, { pistaId: fin, con: ag })).snap;
      sc = (await accion(ringN, 'combinar', mesaC.token, { pistaId: ag, con: null })).snap;
      chequear('"no combina" suelta a las dos', sc.pistas.every(p => !p.combinaCon), JSON.stringify(sc.pistas));
    }

    /* ── 6h. base vacía: se siembra sola desde el ejemplo ─────────────── */
    console.log('\n6h. Con la base vacía, se siembra desde data/seed.example.csv');
    await truncarTodo();
    const snapVacio = await resumen();
    chequear('sembró solo, sin que nadie le pasara un CSV', snapVacio.rings.length === 1, JSON.stringify(snapVacio.rings.map(r => r.id)));
    chequear('es el ejemplo versionado, no un estado vacío',
      snapVacio.rings[0].id === 'copa-ejemplo', JSON.stringify(snapVacio.rings.map(r => r.id)));
    const rPortada = await get('/');
    chequear('la portada igual se sirve (estático, no pasa por acá)', rPortada.status === 200 || rPortada.status === 404,
      `status ${rPortada.status}`);   // servido por Vercel en producción; acá sólo corre /api

    /* ── 7. CSV con comas entre comillas ──────────────────────────────── */
    console.log('\n7. CSV con comillas');
    await sembrarFixture(FIXTURE.trimEnd() +
      '\nRing 3,Agility 1,G2,Large,90,"Ruiz, Marta",Nala,"Border Collie, tricolor"\n');
    const ring3 = await snapshot('ring-3');
    chequear('el ring con campos entrecomillados existe', !!ring3 && !ring3.error, JSON.stringify(ring3).slice(0, 80));
    chequear('la coma dentro de comillas no parte la columna', ring3?.lista?.[0]?.guia === 'Ruiz, Marta', JSON.stringify(ring3?.lista?.[0]));
    chequear('la raza entrecomillada también', ring3?.lista?.[0]?.raza === 'Border Collie, tricolor', ring3?.lista?.[0]?.raza);

    /* ── 7a. alturas con el nombre que usa el club ───────────────────── */
    console.log('\n7a. Mini / Midi / Intermediate/Large');
    {
      // Como vienen en el orden de salida de un regional: Mini y Midi, y en Iniciantes
      // Intermediate/Large en un solo bloque. Desordenado a propósito.
      const { state } = dominio.sembrar(['ring,pista,categoria,altura,dorsal,guia,perro',
        'R,G0,G0,Intermediate/Large,,Ana,PERRO1', 'R,G0,G0,Midi,,Bea,PERRO2',
        'R,G0,G0,XS,,Caro,PERRO3', 'R,G0,G0,Mini,,Dani,PERRO4'].join('\n'));
      const orden = state.inscripciones.sort((a, b) => a.orden - b.orden).map(i => i.altura).join(',');
      chequear('Mini y Midi se ordenan como Small y Medium, no al final',
        orden === 'XS,Mini,Midi,Intermediate/Large', orden);
      const grupos = ['Mini', 'Midi', 'Intermediate/Large'].map(a => Resultados.grupoDeAltura(a).nombre).join(',');
      chequear('y caen en sus podios de siempre', grupos === 'Mini/Midi,Mini/Midi,Intermediate/Large', grupos);
      chequear('un bloque "Mini/Midi" también cae en Mini/Midi',
        Resultados.grupoDeAltura('Mini/Midi').id === 'small-midi', Resultados.grupoDeAltura('Mini/Midi').id);
    }

    /* ── 7a'. Iniciantes (el viejo G0) ───────────────────────────────── */
    console.log('\n7a\'. Iniciantes');
    {
      const nombres = ['G0', 'Iniciantes', 'iniciante', 'INI', 'Grado 0'].map(c => Resultados.gradoDe(c).nombre);
      chequear('G0 y sus variantes se leen como Iniciantes',
        nombres.every(n => n === 'Iniciantes'), nombres.join(','));
      chequear('un grado desconocido queda con su nombre', Resultados.gradoDe('Open').nombre === 'Open');
      // Mezcla de los dos nombres: es un solo podio, y va antes que G1 (por
      // texto, "Iniciantes" quedaría después de "G3").
      const bloques = Resultados.clasificar([
        { id: 'a', altura: 'Small', categoria: 'G3', estado: 'corrido', resultado: { tiempo: 30, faltas: 0, rehuses: 0 } },
        { id: 'b', altura: 'Small', categoria: 'Iniciantes', estado: 'corrido', resultado: { tiempo: 31, faltas: 0, rehuses: 0 } },
        { id: 'c', altura: 'Small', categoria: 'G0', estado: 'corrido', resultado: { tiempo: 29, faltas: 0, rehuses: 0 } },
        { id: 'd', altura: 'Small', categoria: 'G1', estado: 'corrido', resultado: { tiempo: 32, faltas: 0, rehuses: 0 } }
      ], {}, { separarG3: true });
      const orden = bloques.map(p => p.nombre).join(' / ');
      chequear('Iniciantes va primero y junta G0 con Iniciantes',
        orden === 'Mini/Midi Iniciantes / Mini/Midi G1 / Mini/Midi G3', orden);
      chequear('el G0 y el Iniciantes compiten entre ellos',
        bloques[0].filas.map(f => f.id).join(',') === 'c,b', bloques[0].filas.map(f => f.id).join(','));
      const juntos = Resultados.clasificar([
        { id: 'a', altura: 'Large', categoria: 'G3', estado: 'corrido', resultado: { tiempo: 30, faltas: 0, rehuses: 0 } },
        { id: 'b', altura: 'Large', categoria: 'G2', estado: 'corrido', resultado: { tiempo: 29, faltas: 0, rehuses: 0 } },
        { id: 'c', altura: 'Large', categoria: 'G2/G3', estado: 'corrido', resultado: { tiempo: 31, faltas: 0, rehuses: 0 } }
      ], {});
      chequear('sin separar, G2, G3 y un "G2/G3" del CSV comparten podio',
        juntos.length === 1 && juntos[0].nombre === 'Intermediate/Large G2/G3' &&
        juntos[0].filas.map(f => f.id).join(',') === 'b,a,c',
        juntos.map(p => `${p.nombre}: ${p.filas.map(f => f.id)}`).join(' / '));
      chequear('la etiqueta del perro sigue diciendo su grado', Resultados.gradoDe('G3').nombre === 'G3');
    }

    /* ── 7b. resultados: tiempo, faltas, rehúses, TRS y clasificación ──── */
    console.log('\n7b. Resultados y clasificación');
    await sembrarFixture(FIXTURE);
    // Orden sembrado: 45 XS G2, 42 Small G2, 44 Medium G1, 46 Intermediate G3,
    // 41 Large G1, 43 Large G3. Podios: Mini/Midi junta XS/Small/Medium;
    // Intermediate/Large junta esas dos; cada uno abierto por grado.
    const mesaRes = await entrar('ring-1', PIN);
    const PISTA = 'ring-1--jumping-1';
    const idDe = (snap, dorsal) => snap.lista.find(i => i.dorsal === dorsal).id;
    const de = (snap, dorsal) => snap.lista.find(i => i.dorsal === dorsal);
    let rs = (await accion('ring-1', 'siguiente', mesaRes.token)).snap;   // 45 a pista

    const sinToken = await accion('ring-1', 'resultado', null, { id: idDe(rs, '45'), tiempo: 30 });
    chequear('sin token de mesa no se carga un resultado', !!sinToken.error, JSON.stringify(sinToken));
    const noCorrio = await accion('ring-1', 'resultado', mesaRes.token, { id: idDe(rs, '42'), tiempo: 30 });
    chequear('a un perro que no corrió no se le carga resultado',
      /todavía no corrió/.test(String(noCorrio.error)), JSON.stringify(noCorrio));
    const sinTiempo = await accion('ring-1', 'resultado', mesaRes.token, { id: idDe(rs, '45'), faltas: 1 });
    chequear('sin tiempo (y sin eliminar) se rechaza', /Falta el tiempo/.test(String(sinTiempo.error)), JSON.stringify(sinTiempo));
    const tiempoMalo = await accion('ring-1', 'resultado', mesaRes.token, { id: idDe(rs, '45'), tiempo: 'abc' });
    chequear('un tiempo que no es número se rechaza', /no es un número/.test(String(tiempoMalo.error)), JSON.stringify(tiempoMalo));
    const faltasMalas = await accion('ring-1', 'resultado', mesaRes.token, { id: idDe(rs, '45'), tiempo: 30, faltas: 1.5 });
    chequear('faltas no enteras se rechazan', /faltas/.test(String(faltasMalas.error)), JSON.stringify(faltasMalas));

    // Se le carga resultado al que está en pista, con coma decimal como en el teclado.
    rs = (await accion('ring-1', 'resultado', mesaRes.token, { id: idDe(rs, '45'), tiempo: '38,52', faltas: 1 })).snap;
    chequear('el que está en pista ya puede tener resultado; la coma decimal se entiende',
      de(rs, '45').resultado?.tiempo === 38.52 && de(rs, '45').res?.total === 5,
      JSON.stringify(de(rs, '45')));
    chequear('XS cae en el podio Mini/Midi de su grado (G2, unificado con G3)',
      de(rs, '45').podio === 'Mini/Midi G2/G3', de(rs, '45').podio);
    chequear('con un solo resultado es 1º', de(rs, '45').puesto === 1, String(de(rs, '45').puesto));

    rs = (await accion('ring-1', 'siguiente', mesaRes.token)).snap;   // 45 corrido, 42 a pista
    rs = (await accion('ring-1', 'resultado', mesaRes.token, { id: idDe(rs, '42'), tiempo: 40 })).snap;
    chequear('Small y XS comparten podio: el limpio le gana al de 1 falta aunque sea más lento',
      de(rs, '42').puesto === 1 && de(rs, '45').puesto === 2,
      JSON.stringify([de(rs, '42').puesto, de(rs, '45').puesto]));
    // Son G2: sin TRS del juez vale el del más rápido limpio + 18% (40 s → 47,2 s).
    const reglaSM = rs.clasificacion.find(p => p.nombre === 'Mini/Midi G2/G3').regla;
    chequear('en G2/G3, sin TRS del juez, vale el del más rápido limpio + 18%',
      reglaSM.trs === 47.2 && reglaSM.juez === null && reglaSM.masRapido.tiempo === 40 && de(rs, '42').res.sinTrs === false,
      JSON.stringify(reglaSM));

    // TRS: uno para toda la pista (abajo, uno por grupo de altura).
    const trsMalo = await accion('ring-1', 'trs', mesaRes.token, { pistaId: PISTA, trs: 'cuarenta' });
    chequear('un TRS que no es número se rechaza', /no es un número/.test(String(trsMalo.error)), JSON.stringify(trsMalo));
    const sinVel = await accion('ring-1', 'trs', mesaRes.token, { pistaId: PISTA, largo: 191 });
    chequear('largo sin velocidad se rechaza', /hace falta la velocidad/.test(String(sinVel.error)), JSON.stringify(sinVel));
    const trsAjeno = await accion('ring-1', 'trs', mesaRes.token, { pistaId: 'ring-2--agility-1', trs: 39 });
    chequear('no se le carga TRS a una pista de otro ring', !!trsAjeno.error, JSON.stringify(trsAjeno));

    rs = (await accion('ring-1', 'trs', mesaRes.token, { pistaId: PISTA, trs: '39' })).snap;
    chequear('con TRS 39, 40 s suma 1 punto de tiempo', de(rs, '42').res.exceso === 1 && de(rs, '42').res.total === 1,
      JSON.stringify(de(rs, '42').res));
    chequear('el exceso se calcula con centésimas',
      Resultados.calcular({ tiempo: 41.48, faltas: 0, rehuses: 0 }, { trs: 39 }).total === 2.48);
    const open = Resultados.clasificar([
      { id: 'g1', altura: 'Large', categoria: 'G1', estado: 'corrido', resultado: { tiempo: 42, faltas: 0, rehuses: 0 } },
      { id: 'g2', altura: 'Large', categoria: 'G2', estado: 'corrido', resultado: { tiempo: 42, faltas: 0, rehuses: 0 } }
    ], { trs: 40 });
    chequear('en un open, G1 y G2 usan el mismo TRS (cada uno en su podio)',
      open.length === 2 && open.every(p => p.filas[0].res.exceso === 2), JSON.stringify(open.map(p => [p.nombre, p.filas[0].res.exceso])));

    rs = (await accion('ring-1', 'trs', mesaRes.token, { pistaId: PISTA, juez: ' Juez Ejemplo ', trs: '39' })).snap;
    chequear('el juez de la pista se guarda con el TRS', rs.pista.juez === 'Juez Ejemplo' &&
      (await snapshot('ring-1')).pista.juez === 'Juez Ejemplo', JSON.stringify(rs.pista));
    rs = (await accion('ring-1', 'trs', mesaRes.token, { pistaId: PISTA, largo: '191', velocidad: '4,5' })).snap;
    chequear('cambiar el TRS sin mandar juez no lo borra', rs.pista.juez === 'Juez Ejemplo', JSON.stringify(rs.pista));
    chequear('con largo y velocidad, el TRS sale de dividir (191 m ÷ 4,5 m/s = 42,44 s)',
      Math.abs(rs.trs.trs - 42.444444) < 1e-5 && rs.trs.largo === 191 && rs.trs.velocidad === 4.5,
      JSON.stringify(rs.trs));
    chequear('y 38,52 s queda dentro: sólo cuenta la falta', de(rs, '45').res.total === 5 && de(rs, '45').res.calif === 'Exc',
      JSON.stringify(de(rs, '45').res));

    // El juez da otro: el TRS tipeado manda, el largo se conserva (para la velocidad).
    rs = (await accion('ring-1', 'trs', mesaRes.token, { pistaId: PISTA, largo: '191', velocidad: '4,5', trs: '36' })).snap;
    chequear('un TRS tipeado manda sobre largo ÷ velocidad',
      rs.trs.trs === 36 && rs.trs.largo === 191 && rs.trs.ajustado === undefined, JSON.stringify(rs.trs));
    chequear('y recalcula a todos: 38,52 s ahora suma 2,52 de tiempo',
      Math.abs(de(rs, '45').res.exceso - 2.52) < 1e-6 && Math.abs(de(rs, '45').res.total - 7.52) < 1e-6,
      JSON.stringify(de(rs, '45').res));

    // Un TRS por grupo de altura: Mini/Midi e Intermediate/Large a velocidades distintas.
    const grupoMalo = await accion('ring-1', 'trs', mesaRes.token, { pistaId: PISTA, grupos: { 'Small Midi!': { trs: 40 } } });
    chequear('un grupo de altura inválido se rechaza', /grupos de altura/.test(String(grupoMalo.error)), JSON.stringify(grupoMalo));
    const velSinLargo = await accion('ring-1', 'trs', mesaRes.token, { pistaId: PISTA, grupos: { 'small-midi': { velocidad: 4 } } });
    chequear('velocidad de un grupo sin largo se rechaza', /hace falta el largo/.test(String(velSinLargo.error)), JSON.stringify(velSinLargo));
    rs = (await accion('ring-1', 'trs', mesaRes.token, {
      pistaId: PISTA, largo: '191',
      grupos: { 'small-midi': { velocidad: '4', trs: '' }, 'intermediate-large': { velocidad: '4,5', trs: '40' } }
    })).snap;
    chequear('por grupo: Mini/Midi sale de la cuenta (191 ÷ 4 = 47,75), Intermediate/Large toma el tipeado',
      rs.trs.largo === 191 && rs.trs.grupos['small-midi'].trs === 47.75 && rs.trs.grupos['intermediate-large'].trs === 40,
      JSON.stringify(rs.trs));
    chequear('el XS usa el TRS de Mini/Midi: 38,52 s queda dentro', de(rs, '45').res.exceso === 0, JSON.stringify(de(rs, '45').res));
    const podiosSM = rs.clasificacion.find(p => p.grupo === 'small-midi');
    chequear('cada podio dice su TRS', podiosSM.regla.trs === 47.75 && podiosSM.regla.largo === 191, JSON.stringify(podiosSM.regla));
    const porGrupo = Resultados.clasificar([
      { id: 's', altura: 'Small', categoria: 'G2', estado: 'corrido', resultado: { tiempo: 42, faltas: 0, rehuses: 0 } },
      { id: 'l', altura: 'Large', categoria: 'G2', estado: 'corrido', resultado: { tiempo: 42, faltas: 0, rehuses: 0 } }
    ], { largo: 160, grupos: { 'small-midi': { trs: 45 }, 'intermediate-large': { trs: 40 } } });
    chequear('misma pista, mismo tiempo: el Small entra en su TRS y el Large se pasa 2 s del suyo',
      porGrupo.find(p => p.grupo === 'small-midi').filas[0].res.exceso === 0 &&
      porGrupo.find(p => p.grupo === 'intermediate-large').filas[0].res.exceso === 2,
      JSON.stringify(porGrupo.map(p => [p.nombre, p.filas[0].res.exceso])));
    chequear('un TRS de antes (uno para todos) se sigue leyendo para cualquier altura',
      Resultados.reglaDe({ trs: 39 }, 'Large').trs === 39 && Resultados.reglaDe({ trs: 39 }, 'Mini').trs === 39);
    chequear('un grupo sin TRS queda sin TRS, pero con el largo para la velocidad',
      Resultados.reglaDe({ largo: 160, grupos: { 'small-midi': { trs: 45 } } }, 'Large').trs === undefined &&
      Resultados.reglaDe({ largo: 160, grupos: { 'small-midi': { trs: 45 } } }, 'Large').largo === 160);
    rs = (await accion('ring-1', 'trs', mesaRes.token, { pistaId: PISTA, trs: '39' })).snap;

    // Filas reales de las planillas del club: la app tiene que dar lo mismo.
    const fila = (tiempo, faltas, rehuses, trs) => Resultados.calcular({ tiempo, faltas, rehuses, eliminado: false }, { trs });
    const trsReg3 = Resultados.trsDe(191, 4.5);   // Regional 3, G2 Agility: 191 m a 4,5 m/s
    const nuit = fila(37.81, 0, 0, trsReg3);
    chequear('planilla: Perro A, limpia en 37,81 → 0,00 Cero Exc', nuit.total === 0 && nuit.calif === 'Cero Exc', JSON.stringify(nuit));
    const aluen = fila(39.5, 1, 1, trsReg3);
    chequear('planilla: Perro B, "fn" en 39,5 → 10,00 MB', aluen.total === 10 && aluen.calif === 'MB', JSON.stringify(aluen));
    const awka = fila(54.41, 2, 2, trsReg3);
    chequear('planilla: Perro C, "nfnf" en 54,41 → 31,97 No clasifica',
      Resultados.fmt(awka.total) === '31,97' && awka.calif === 'No clasifica', JSON.stringify(awka));
    const qoyai = fila(49.82, 0, 0, 49.37);
    chequear('planilla: Perro D, limpia pero 0,45 s sobre el TRS → 0,45 Exc (no es cero)',
      qoyai.total === 0.45 && qoyai.calif === 'Exc', JSON.stringify(qoyai));
    const ordenReg4 = Resultados.clasificar([
      { id: 'z', altura: 'Large', categoria: 'G2', estado: 'corrido', resultado: { tiempo: 38.72, faltas: 1, rehuses: 0 } },
      { id: 'q', altura: 'Large', categoria: 'G2', estado: 'corrido', resultado: { tiempo: 49.82, faltas: 0, rehuses: 0 } }
    ], { trs: 49.37 })[0].filas.map(f => f.id).join(',');
    chequear('planilla Regional 4: Perro D (0,45) queda arriba de Perro E (1 falta, 11 s más rápida)', ordenReg4 === 'q,z', ordenReg4);

    // TRS de G2/G3 según el Reglamento Nacional 2026 (Art. 33-C-e y D-e).
    {
      const corrio = (id, categoria, tiempo, faltas = 0, extra = {}) =>
        ({ id, altura: 'Large', categoria, estado: 'corrido', resultado: { tiempo, faltas, rehuses: 0, ...extra } });
      const podio = (lista, trs = {}, opciones) => Resultados.clasificar(lista, trs, opciones)[0];
      const p1 = podio([corrio('a', 'G2', 35.2), corrio('b', 'G2', 30, 1), corrio('c', 'G3', 44)]);
      chequear('G2/G3: el más rápido limpio + 18%, sin redondear (35,20 → 41,536)',
        p1.regla.trs === 41.536 && p1.regla.masRapido.pct === 18 && p1.regla.masRapido.conFaltas === false, JSON.stringify(p1.regla));
      chequear('el que tiene una falta no cuenta como más rápido aunque lo sea', p1.regla.masRapido.tiempo === 35.2);
      const c = p1.filas.find(f => f.id === 'c').res;
      chequear('y los demás se pasan de ese TRS: 44 s limpio → 2,464 Exc', c.total === 2.464 && c.calif === 'Exc', JSON.stringify(c));
      const p2 = podio([corrio('a', 'G2', 35.2)], { largo: 160, grupos: { 'intermediate-large': { velocidad: 4, trs: 40 } } });
      chequear('si el del juez es menor, manda el del juez', p2.regla.trs === 40 && p2.regla.juez === 40 && p2.regla.masRapido.trs === 41.536,
        JSON.stringify(p2.regla));
      const p3 = podio([corrio('a', 'G2', 30), corrio('b', 'G2', 60)], { trs: 45 });
      chequear('si el del más rápido es menor, manda ése', p3.regla.trs === 35.4, JSON.stringify(p3.regla));
      const p4 = podio([corrio('a', 'G3', 35.2)], {}, { separarG3: true });
      chequear('G3 con podio propio: + 15% (35,20 → 40,48)', p4.regla.trs === 40.48 && p4.regla.masRapido.pct === 15,
        JSON.stringify(p4.regla));
      const p5 = podio([corrio('a', 'G2', 35.2)], {}, { separarG3: true });
      chequear('G2 con podio propio sigue con + 18%', p5.regla.trs === 41.536, JSON.stringify(p5.regla));
      const p6 = podio([corrio('a', 'G2', 30, 1), corrio('b', 'G2', 28, 2), corrio('c', 'G2', 20, 0, { eliminado: true })]);
      chequear('nadie limpio: el más rápido de los de menos faltas (30 s, 1 falta → 35,4), sin contar eliminados',
        p6.regla.trs === 35.4 && p6.regla.masRapido.conFaltas === true, JSON.stringify(p6.regla));
      chequear('planilla Nacional 2026, Jumping final S/M: 42,21 s + 18% = 49,8078 s',
        Resultados.trsDelMasRapido(42.21, 18) === 49.8078, String(Resultados.trsDelMasRapido(42.21, 18)));
      chequear('planilla Nacional 2026, Agility 1 I/L: 45,66 s + 18% = 53,88 s (redondeado a centésimas en la planilla)',
        Resultados.fmt(Resultados.trsDelMasRapido(45.66, 18)) === '53,88', String(Resultados.trsDelMasRapido(45.66, 18)));
      const p7 = podio([corrio('a', 'G1', 35.2)]);
      chequear('G1 no usa el más rápido: sin TRS del juez no hay TRS', p7.regla === null && p7.filas[0].res.sinTrs === true,
        JSON.stringify(p7.regla));
      const p8 = podio([{ id: 'a', altura: 'Large', categoria: 'G2', estado: 'pendiente', resultado: null }], { trs: 45 });
      chequear('G2/G3 sin nadie corrido: vale el del juez', p8.regla.trs === 45 && !p8.regla.masRapido, JSON.stringify(p8.regla));
    }

    // Puntos de ranking por pista (Anexo I.A): sólo G2/G3, por puesto y calificación.
    {
      chequear('tabla del Anexo I.A: 1º Cero 25, Exc 21, MB 18, B 16',
        [Resultados.puntosRanking(1, 'Cero Exc'), Resultados.puntosRanking(1, 'Exc'),
          Resultados.puntosRanking(1, 'MB'), Resultados.puntosRanking(1, 'B')].join() === '25,21,18,16');
      chequear('3º Exc 16, 10º MB 8, 20º Cero 1',
        Resultados.puntosRanking(3, 'Exc') === 16 && Resultados.puntosRanking(10, 'MB') === 8 &&
        Resultados.puntosRanking(20, 'Cero Exc') === 1);
      chequear('después del 20º, 1 punto; No clasifica, 0',
        Resultados.puntosRanking(27, 'B') === 1 && Resultados.puntosRanking(2, 'No clasifica') === 0);
      const l = (id, categoria, tiempo, faltas = 0, extra = {}) =>
        ({ id, altura: 'Large', categoria, estado: 'corrido', resultado: { tiempo, faltas, rehuses: 0, ...extra } });
      const pG2 = Resultados.clasificar([
        l('a', 'G2', 30), l('b', 'G2', 31, 1), l('c', 'G2', 31, 1), l('d', 'G3', 32, 6), l('e', 'G2', 20, 0, { eliminado: true })
      ], { trs: 45 }, { ranking: true })[0];
      const pts = pG2.filas.map(f => `${f.id}:${f.puesto ?? '-'}:${f.puntos}`).join(' ');
      chequear('G2/G3: 1º Cero 25; empatados 2º Exc 18 cada uno; 4º No clasifica 0; eliminado 0',
        pts === 'a:1:25 b:2:18 c:2:18 d:4:0 e:-:0', pts);
      const pG1 = Resultados.clasificar([l('a', 'G1', 30)], { trs: 45 }, { ranking: true })[0];
      chequear('G1 no suma ranking: sin puntos', pG1.filas[0].puntos === undefined, JSON.stringify(pG1.filas[0]));
      const pIni = Resultados.clasificar([l('a', 'Iniciantes', 30)], { trs: 45 }, { ranking: true })[0];
      chequear('Iniciantes tampoco', pIni.filas[0].puntos === undefined);
      const pInd = Resultados.clasificar([l('a', 'G2', 30), l('e', 'G2', 20, 0, { eliminado: true })], { trs: 45 })[0];
      chequear('una fecha independiente no da puntos, ni siquiera en G2/G3',
        pInd.filas.every(f => f.puntos === undefined), JSON.stringify(pInd.filas));
    }
    chequear('cortes de calificación de la planilla',
      ['Exc', 'MB', 'MB', 'B', 'B', 'No clasifica'].join() ===
      [5.99, 6, 15.99, 16, 25.99, 26].map(Resultados.calificacion).join(),
      [5.99, 6, 15.99, 16, 25.99, 26].map(Resultados.calificacion).join());

    // Sin TMR: pasarse mucho del TRS no elimina, sólo suma.
    rs = (await accion('ring-1', 'resultado', mesaRes.token, { id: idDe(rs, '42'), tiempo: 99 })).snap;
    chequear('pasarse mucho del TRS suma los segundos, no elimina (no hay TMR)',
      de(rs, '42').res.eliminado === false && de(rs, '42').res.total === 60, JSON.stringify(de(rs, '42').res));
    chequear('y el de 1 falta en tiempo le gana', de(rs, '45').puesto === 1 && de(rs, '42').puesto === 2,
      JSON.stringify([de(rs, '45').puesto, de(rs, '42').puesto]));
    rs = (await accion('ring-1', 'trs', mesaRes.token, { pistaId: PISTA, trs: '' })).snap;
    chequear('vaciar el TRS lo saca', !rs.trs.trs && de(rs, '42').res.exceso === 0,
      JSON.stringify(rs.trs));

    rs = (await accion('ring-1', 'resultado', mesaRes.token, { id: idDe(rs, '42'), tiempo: 40, rehuses: 3 })).snap;
    chequear('la tercera negativa elimina', de(rs, '42').res.eliminado && /3 negativas/.test(de(rs, '42').res.motivo),
      JSON.stringify(de(rs, '42').res));
    rs = (await accion('ring-1', 'resultado', mesaRes.token, { id: idDe(rs, '42'), eliminado: true })).snap;
    chequear('un eliminado puede no tener tiempo', de(rs, '42').res.eliminado && de(rs, '42').resultado.tiempo === null,
      JSON.stringify(de(rs, '42').resultado));

    rs = (await accion('ring-1', 'deshacer', mesaRes.token)).snap;
    chequear('deshacer vuelve al resultado anterior', de(rs, '42').resultado.rehuses === 3, JSON.stringify(de(rs, '42').resultado));
    rs = (await accion('ring-1', 'resultado', mesaRes.token, { id: idDe(rs, '42'), borrar: true })).snap;
    chequear('borrar el resultado lo saca de la clasificación',
      de(rs, '42').resultado === null && de(rs, '42').puesto === undefined, JSON.stringify(de(rs, '42')));

    const nombres = rs.clasificacion.map(p => p.nombre).join(' / ');
    chequear('podios en orden: Mini/Midi antes que Intermediate/Large, y por grado (G2 y G3 juntos)',
      nombres === 'Mini/Midi G1 / Mini/Midi G2/G3 / Intermediate/Large G1 / Intermediate/Large G2/G3', nombres);
    const smG2 = rs.clasificacion.find(p => p.nombre === 'Mini/Midi G2/G3');
    chequear('el podio cuenta los que faltan cargar (clasificación provisoria)',
      smG2.clasificados === 1 && smG2.faltan === 1, JSON.stringify(smG2));

    // G3 con podio propio (Art. 34): es del evento, y se puede volver atrás.
    chequear('de entrada G2 y G3 van juntos', rs.evento.separarG3 === false, JSON.stringify(rs.evento));
    const sinDato = await accion('ring-1', 'separar_g3', mesaRes.token, {});
    chequear('separar G3 sin decir sí o no se rechaza', !!sinDato.error, JSON.stringify(sinDato));
    rs = (await accion('ring-1', 'separar_g3', mesaRes.token, { separar: true })).snap;
    const separados = rs.clasificacion.map(p => p.nombre).join(' / ');
    chequear('con G3 separado, cada grado tiene su podio',
      separados === 'Mini/Midi G1 / Mini/Midi G2 / Intermediate/Large G1 / Intermediate/Large G3', separados);
    chequear('y el XS G2 queda en Mini/Midi G2', de(rs, '45').podio === 'Mini/Midi G2', de(rs, '45').podio);
    chequear('el ajuste es del evento: la otra cancha también lo ve',
      (await snapshot('ring-2')).evento.separarG3 === true);
    rs = (await accion('ring-1', 'separar_g3', mesaRes.token, { separar: false })).snap;

    // Fecha de ranking: de entrada no, y sin eso no hay puntos.
    chequear('de entrada la fecha es independiente: sin puntos',
      rs.evento.ranking === false && de(rs, '45').puntos === undefined, JSON.stringify(rs.evento));
    const sinDatoR = await accion('ring-1', 'ranking', mesaRes.token, {});
    chequear('fecha de ranking sin decir sí o no se rechaza', !!sinDatoR.error, JSON.stringify(sinDatoR));
    rs = (await accion('ring-1', 'ranking', mesaRes.token, { ranking: true })).snap;
    chequear('fecha de ranking: el G2 suma puntos (1º con Exc → 21)', de(rs, '45').puntos === 21, JSON.stringify(de(rs, '45')));
    chequear('y la otra cancha también ve la fecha como de ranking', (await snapshot('ring-2')).evento.ranking === true);
    rs = (await accion('ring-1', 'ranking', mesaRes.token, { ranking: false })).snap;
    chequear('volver a independiente saca los puntos', de(rs, '45').puntos === undefined);
    chequear('volver a juntarlos los deja como estaban',
      rs.clasificacion.map(p => p.nombre).join(' / ') === nombres, rs.clasificacion.map(p => p.nombre).join(' / '));

    // Un perro de otro ring, y un ausente.
    const ajenoRes = (await snapshot('ring-2')).lista[0].id;
    const cruceRes = await accion('ring-1', 'resultado', mesaRes.token, { id: ajenoRes, tiempo: 30 });
    chequear('no se carga resultado a un perro de otro ring', !!cruceRes.error, JSON.stringify(cruceRes));
    rs = (await accion('ring-1', 'ausente', mesaRes.token, { id: idDe(rs, '44') })).snap;
    const alAusente = await accion('ring-1', 'resultado', mesaRes.token, { id: idDe(rs, '44'), tiempo: 30 });
    chequear('a un ausente no se le carga resultado', /ausente/.test(String(alAusente.error)), JSON.stringify(alAusente));

    // Guardar el del que está en pista con `avanzar` larga al próximo, en el
    // mismo paso de deshacer. Acá: 42 en pista, 44 ausente, después 46.
    chequear('antes de avanzar, 42 está en pista', de(rs, '42').estado === 'en_pista', de(rs, '42').estado);
    rs = (await accion('ring-1', 'resultado', mesaRes.token, { id: idDe(rs, '42'), tiempo: '41,2', avanzar: true })).snap;
    chequear('guardar con avanzar deja al que corrió como corrido, con su resultado',
      de(rs, '42').estado === 'corrido' && de(rs, '42').resultado?.tiempo === 41.2, JSON.stringify(de(rs, '42')));
    chequear('y entra el próximo pendiente (saltando al ausente)', de(rs, '46').estado === 'en_pista',
      rs.lista.map(i => `${i.dorsal}:${i.estado}`).join(' '));
    rs = (await accion('ring-1', 'deshacer', mesaRes.token)).snap;
    chequear('un solo "deshacer" revierte el resultado y el avance juntos',
      de(rs, '42').estado === 'en_pista' && de(rs, '42').resultado === null && de(rs, '46').estado === 'pendiente',
      rs.lista.map(i => `${i.dorsal}:${i.estado}:${i.resultado ? 'r' : '-'}`).join(' '));
    rs = (await accion('ring-1', 'resultado', mesaRes.token, { id: idDe(rs, '45'), tiempo: '38,52', faltas: 1, avanzar: true })).snap;
    chequear('corregir a uno que ya corrió no avanza a nadie', de(rs, '42').estado === 'en_pista',
      rs.lista.map(i => `${i.dorsal}:${i.estado}`).join(' '));

    // Persistido en Postgres, no sólo en el snapshot de la respuesta.
    await reiniciarServidor();
    rs = await snapshot('ring-1');
    chequear('el resultado sobrevive al reinicio', de(rs, '45').resultado?.tiempo === 38.52, JSON.stringify(de(rs, '45').resultado));

    /* ── 7z. combinado: la planilla del Nacional 2026 ─────────────────── */
    console.log('\n7z. Combinado (planilla del Combinado Final G2, Small/Medium)');
    {
      // Los mismos tiempos y faltas que la planilla real, con nombres
      // inventados. P1 es el Jumping (TRS 49,8078), P2 el Agility (56,345).
      const fila = (n, altura, p1, p2) => ({ dorsal: String(100 + n), perro: `PERRO ${n}`, guia: `Guía ${n}`, altura, p1, p2 });
      const DESC = 'desc';
      const filas = [
        fila(1, 'Medium', [42.5, 1], [47.75, 0]), fila(2, 'Small', [41.06, 1], [43.63, 1]),
        fila(3, 'Medium', [61, 0], [62, 0]), fila(4, 'Medium', [48.72, 1], [66, 1]),
        fila(5, 'Small', [46, 3], [46.38, 1]), fila(6, 'Small', [51.25, 3], [44.62, 1]),
        fila(7, 'Medium', [57.94, 3], [47.66, 1]), fila(8, 'Medium', [42.21, 0], DESC),
        fila(9, 'Small', [44.72, 0], DESC), fila(10, 'Medium', DESC, DESC), fila(11, 'Small', DESC, DESC)
      ];
      const lista = (cual, pistaId) => filas.map((f, n) => ({
        id: `${pistaId}-${n}`, pistaId, dorsal: f.dorsal, perro: f.perro, guia: f.guia, altura: f.altura,
        categoria: 'G2', estado: 'corrido',
        resultado: f[cual] === DESC ? { tiempo: null, faltas: 0, rehuses: 0, eliminado: true }
          : { tiempo: f[cual][0], faltas: f[cual][1], rehuses: 0, eliminado: false }
      }));
      const comb = Resultados.clasificarCombinado(
        { lista: lista('p1', 'j'), trs: { trs: 49.8078 } },
        { lista: lista('p2', 'a'), trs: { trs: 56.345 } },
        { ranking: true });
      chequear('un solo podio: Mini/Midi G2/G3', comb.length === 1 && comb[0].nombre === 'Mini/Midi G2/G3',
        comb.map(p => p.nombre).join());
      const r = comb[0].filas.map(f => [f.perro.replace('PERRO ', ''), f.puesto ?? '-', Resultados.fmt(f.faltas),
        Resultados.fmt(f.tiempo), f.calif, f.puntos].join(' '));
      const esperado = [
        '1 1 5,00 90,25 Exc 9', '2 2 10,00 84,69 MB 7', '3 3 16,85 123,00 B 5', '4 4 19,66 114,72 B 4',
        '5 5 20,00 92,38 B 3', '6 6 21,44 95,87 B 2', '7 7 28,13 105,60 No clasifica 0',
        '8 - 100,00 42,21 No clasifica 0', '9 - 100,00 44,72 No clasifica 0',
        '10 - 200,00 0,00 No clasifica 0', '11 - 200,00 0,00 No clasifica 0'
      ];
      chequear('igual que la planilla: puesto, faltas, tiempo, calificación y puntos (Anexo I.B)',
        r.join(' | ') === esperado.join(' | '), r.join(' | '));
      chequear('cada parte guarda su detalle (P1 del 3: 11,19 de tiempo)',
        Resultados.fmt(comb[0].filas[2].partes[0].faltas) === '11,19', JSON.stringify(comb[0].filas[2].partes));

      // Intermediate/Large de la misma planilla: el 1º en cero, 10 puntos.
      const dos = (lst, res) => lst.slice(0, 2).map((i, n) => ({ ...i, altura: 'Large', resultado: res[n] }));
      const il = Resultados.clasificarCombinado(
        { lista: dos(lista('p1', 'j'), [{ tiempo: 39.4, faltas: 0, rehuses: 0 }, { tiempo: 37.13, faltas: 1, rehuses: 0 }]), trs: { trs: 50 } },
        { lista: dos(lista('p2', 'a'), [{ tiempo: 41.22, faltas: 0, rehuses: 0 }, { tiempo: 38.94, faltas: 1, rehuses: 0 }]), trs: { trs: 50 } },
        { ranking: true })[0];
      chequear('I/L: 1º Cero Exc → 10, 2º MB → 7',
        il.filas.map(f => `${f.puesto}:${f.calif}:${f.puntos}`).join(' ') === '1:Cero Exc:10 2:MB:7',
        il.filas.map(f => `${f.puesto}:${f.calif}:${f.puntos}`).join(' '));

      const sinRanking = Resultados.clasificarCombinado(
        { lista: lista('p1', 'j'), trs: { trs: 49.8078 } }, { lista: lista('p2', 'a'), trs: { trs: 56.345 } });
      chequear('fecha independiente: el combinado tiene puestos, pero no puntos',
        sinRanking[0].filas.every(f => f.puntos === undefined) && sinRanking[0].filas[0].puesto === 1);

      const aMedias = Resultados.clasificarCombinado(
        { lista: lista('p1', 'j'), trs: { trs: 49.8078 } },
        { lista: lista('p2', 'a').map((i, n) => (n === 0 ? { ...i, estado: 'pendiente', resultado: null } : i)), trs: { trs: 56.345 } });
      chequear('el que todavía no corrió la segunda no entra, pero se cuenta',
        aMedias[0].faltan === 1 && !aMedias[0].filas.some(f => f.perro === 'PERRO 1'), JSON.stringify(aMedias[0].faltan));
    }

    /* ── 8. bloqueo de PIN ─────────────────────────────────────────────── */
    console.log('\n8. Fuerza bruta del PIN');
    await sembrarFixture(FIXTURE);
    for (let i = 0; i < 5; i++) await entrar('ring-1', `000${i}`);
    const bloqueo = await entrar('ring-1', PIN);
    chequear('tras 5 intentos fallidos el PIN queda bloqueado (aunque sea el correcto)',
      bloqueo.status === 429 && /Demasiados intentos/.test(String(bloqueo.error)), JSON.stringify(bloqueo));

    /* ── resultado ─────────────────────────────────────────────────────── */
    console.log(`\n${'─'.repeat(60)}`);
    console.log(fallos.length ? `${ok} ok, ${fallos.length} FALLAS:\n  - ${fallos.join('\n  - ')}` : `${ok} de ${ok} pruebas ok`);
    process.exitCode = fallos.length ? 1 : 0;
  } catch (e) {
    console.error('\nLa prueba se cayó:', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    try { await new Promise(res => server?.close(res)); } catch { /* ya cerrado */ }
    try { await borrarEsquema(); } catch (e) { console.error('no pude borrar el esquema de prueba:', e.message); }
    try { await db.pool.end(); } catch { /* ya cerrado */ }
    console.log('(esquema de prueba borrado; el Postgres real nunca se tocó)');
    process.exit(process.exitCode ?? 0);
  }
})();
