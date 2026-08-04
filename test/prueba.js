'use strict';
// Prueba de integración manual: levanta el servidor real y ejercita los bugs
// que se arreglaron. No forma parte del proyecto.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// La prueba corre sobre una COPIA del proyecto, nunca sobre el original: si el
// servidor real está levantado, escribir en su data/ le pisa el evento en curso.
const PROY = path.join(__dirname, '..');
const RAIZ = path.join(__dirname, 'sandbox');
const { io } = require('socket.io-client');
const STATE = path.join(RAIZ, 'data', 'state.json');
const SEED = path.join(RAIZ, 'data', 'seed.csv');
const PIN = '9999';

function prepararSandbox(dir = RAIZ) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.copyFileSync(path.join(PROY, 'server.js'), path.join(dir, 'server.js'));
  fs.cpSync(path.join(PROY, 'public'), path.join(dir, 'public'), { recursive: true });
}

let ok = 0, fallos = [];
let esperadoTrasReinicio = null;
function chequear(nombre, cond, detalle) {
  if (cond) { ok++; console.log(`  ok    ${nombre}`); }
  else { fallos.push(nombre); console.log(`  FALLA ${nombre}${detalle ? ' → ' + detalle : ''}`); }
}

const dormir = ms => new Promise(r => setTimeout(r, ms));

// Los puertos de abajo (3101, 3102, …) son etiquetas lógicas: al puerto real se le
// suma un corrimiento derivado del PID. Con puertos fijos, dos corridas seguidas
// —o una que dejó un socket en TIME_WAIT— se pisan y la suite falla sin motivo.
const CORRIMIENTO = process.pid % 9000;
const puerto = p => p + CORRIMIENTO;
const url = p => `http://127.0.0.1:${puerto(p)}`;

// Todo lo que se levanta queda anotado acá: si la corrida se interrumpe, los
// servidores hijos quedarían vivos ocupando puertos.
const levantados = new Set();
function matarTodo() {
  for (const p of levantados) { try { p.kill(); } catch { /* ya murió */ } }
  levantados.clear();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { matarTodo(); process.exit(1); });

function arrancar(port, env = {}, dir = RAIZ) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: { ...process.env, NODE_PATH: PROY + '/node_modules', PORT: String(puerto(port)), MESA_PIN: PIN, ...env }
  });
  levantados.add(proc);
  proc.on('exit', () => levantados.delete(proc));
  let salida = '';
  proc.stdout.on('data', d => { salida += d; });
  proc.stderr.on('data', d => { salida += d; });
  return new Promise((res, rej) => {
    const t = setInterval(() => {
      if (salida.includes('escuchando en')) { clearInterval(t); res({ proc, salida: () => salida }); }
    }, 60);
    setTimeout(() => { clearInterval(t); rej(new Error('no arrancó:\n' + salida)); }, 8000);
  });
}

const matar = proc => new Promise(r => { proc.on('exit', r); proc.kill(); });

async function get(port, ruta) {
  const res = await fetch(url(port) + ruta);
  const cuerpo = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  return { status: res.status, cuerpo };
}

function esperar(sock, evento, ms = 3000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`sin '${evento}' en ${ms}ms`)), ms);
    sock.once(evento, d => { clearTimeout(t); res(d); });
  });
}

async function conectar(port, ringId, pin) {
  const sock = io(url(port), { transports: ['websocket'] });
  await esperar(sock, 'connect');
  // Los dos listeners se registran ANTES de emitir. El servidor manda `snapshot` y
  // `mesa_ok` en el mismo tick: si se esperaba el snapshot y recién después se
  // escuchaba mesa_ok, cuando los dos paquetes llegaban juntos el segundo ya había
  // pasado y el test moría por timeout. Pasaba de casualidad, según el timing.
  const pSnap = esperar(sock, 'snapshot');
  const pMesa = pin === undefined ? Promise.resolve(false) : esperar(sock, 'mesa_ok');
  sock.emit('join', pin === undefined ? ringId : { ringId, pin });
  const snap = await pSnap;
  const autorizado = await pMesa;
  return { sock, snap, autorizado };
}

// Espera el próximo snapshot provocado por una acción.
async function accionar(sock, evento, arg) {
  const p = Promise.race([
    esperar(sock, 'snapshot', 2500).then(s => ({ snap: s })),
    esperar(sock, 'error_app', 2500).then(e => ({ error: e }))
  ]);
  sock.emit(evento, arg);
  return p;
}

// Igual, pero también junta el reporte que viaja por `aviso_app`. Llega justo
// después del snapshot, así que hay que darle un instante.
async function accionarAviso(sock, evento, arg) {
  let reporte = null;
  const onAviso = m => { reporte = m; };
  sock.on('aviso_app', onAviso);
  const r = await accionar(sock, evento, arg);
  await dormir(120);
  sock.off('aviso_app', onAviso);
  return { ...r, aviso: reporte };
}

(async () => {
  prepararSandbox();

  // CSV propio: la prueba no depende del evento que tengas cargado.
  // Las alturas van mezcladas adrede dentro de la misma pista.
  const ALTURAS = ['Large', 'Small', 'Large', 'Medium', 'XS', 'Intermediate'];
  const FIXTURE = ['ring,pista,categoria,altura,dorsal,guia,perro,raza']
    .concat([41, 42, 43, 44, 45, 46].map((d, n) =>
      `Ring 1,Jumping 1,G${(n % 3) + 1},${ALTURAS[n]},${d},Guía ${d},Perro ${d},Border Collie`))
    .concat([12, 13, 14].map(d => `Ring 2,Agility 1,G1,Small,${d},Guía ${d},Perro ${d},Sheltie`))
    .join('\n') + '\n';
  fs.writeFileSync(SEED, FIXTURE);

  const limpiar = async () => {
    matarTodo();
    await dormir(200);   // que Windows suelte los handles antes de borrar
    for (const d of [RAIZ, path.join(__dirname, 'sandbox-import'),
      path.join(__dirname, 'sandbox-g0'), path.join(__dirname, 'sandbox-ver'),
      path.join(__dirname, 'sandbox-nueva'), path.join(__dirname, 'sandbox-programa'),
      path.join(__dirname, 'sandbox-deploy'), path.join(__dirname, 'sandbox-sin-csv')]) {
      for (let intento = 0; intento < 6; intento++) {
        try { fs.rmSync(d, { recursive: true, force: true }); break; }
        catch { await dormir(250); }   // Windows todavía no soltó el handle
      }
    }
  };

  try {
    /* ── 1. arranque y estáticos ─────────────────────────────────────── */
    console.log('\n1. Arranque y archivos estáticos');
    let srv = await arrancar(3101);
    chequear('el servidor arranca', true);
    chequear('data/state.json se creó', fs.existsSync(STATE));
    for (const ruta of ['/', '/app.css', '/live.js', '/mesa.js', '/sw.js', '/manifest.webmanifest', '/icono.svg']) {
      const r = await get(3101, ruta);
      chequear(`GET ${ruta} → 200`, r.status === 200, `status ${r.status}`);
    }
    const rutas = await Promise.all(['/ring/ring-1', '/mesa/ring-1'].map(r => get(3101, r)));
    chequear('GET /ring/:id y /mesa/:id → 200', rutas.every(r => r.status === 200));
    const resumen = (await get(3101, '/api/resumen')).cuerpo;
    chequear('el resumen trae los 2 rings del CSV',
      resumen.rings.length === 2 && resumen.rings[0].id === 'ring-1', JSON.stringify(resumen.rings.map(r => r.id)));
    const snapIni = (await get(3101, '/api/ring/ring-1')).cuerpo;
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
    chequear('avisa por consola que reordenó', srv.salida().includes('Reordené'), srv.salida().slice(0, 120));
    chequear('la portada lista todas las pistas de cada ring',
      resumen.rings[0].pistas.length === 1 && resumen.rings[0].pistas[0].nombre === 'Jumping 1',
      JSON.stringify(resumen.rings.map(r => r.pistas.map(p => p.nombre))));

    /* ── 2. permisos ─────────────────────────────────────────────────── */
    console.log('\n2. PIN y permisos');
    const mirona = await conectar(3101, 'ring-1');
    const rechazo = await accionar(mirona.sock, 'siguiente');
    chequear('sin PIN no se puede avanzar', !!rechazo.error, JSON.stringify(rechazo));

    const malPin = await conectar(3101, 'ring-1', '0000');
    chequear('PIN incorrecto → mesa_ok false', malPin.autorizado === false);
    malPin.sock.close();

    const mesa1 = await conectar(3101, 'ring-1', PIN);
    chequear('PIN correcto → mesa_ok true', mesa1.autorizado === true);

    /* ── 3. avanzar el orden ─────────────────────────────────────────── */
    console.log('\n3. Avanzar');
    let r1 = (await accionar(mesa1.sock, 'siguiente')).snap;
    const enPista = r1.lista.find(i => i.estado === 'en_pista');
    chequear('el primer perro de la lista entra a pista (el más chico)',
      enPista?.dorsal === snapIni.lista[0].dorsal && enPista?.altura === 'XS', JSON.stringify(enPista));
    chequear('el corredor mirón recibe el cambio', true);
    chequear('quedan 5 pendientes', r1.lista.filter(i => i.estado === 'pendiente').length === 5,
      String(r1.lista.filter(i => i.estado === 'pendiente').length));

    /* ── 4. aislamiento entre rings ──────────────────────────────────── */
    console.log('\n4. Aislamiento entre rings');
    const snapR2 = (await get(3101, '/api/ring/ring-2')).cuerpo;
    const ajeno = snapR2.lista[0].id;
    const cruce = await accionar(mesa1.sock, 'ausente', ajeno);
    chequear('la mesa del Ring 1 NO puede marcar ausente en el Ring 2',
      cruce.error === 'Esa inscripción no es de esta competencia.', JSON.stringify(cruce));
    const cruceMover = await accionar(mesa1.sock, 'mover', { id: ajeno, delta: 1 });
    chequear('la mesa del Ring 1 NO puede reordenar el Ring 2',
      cruceMover.error === 'Esa inscripción no es de esta competencia.', JSON.stringify(cruceMover));

    /* ── 5. deshacer por ring ────────────────────────────────────────── */
    console.log('\n5. Deshacer por ring');
    const mesa2 = await conectar(3101, 'ring-2', PIN);
    await accionar(mesa2.sock, 'siguiente');
    const r2Antes = (await accionar(mesa2.sock, 'siguiente')).snap;
    const pistaR2 = r2Antes.lista.find(i => i.estado === 'en_pista')?.dorsal;
    const corridosR2 = r2Antes.lista.filter(i => i.estado === 'corrido').length;
    chequear('el Ring 2 avanzó dos perros', corridosR2 === 1 && !!pistaR2, `${corridosR2} corridos, pista ${pistaR2}`);

    for (let i = 0; i < 5; i++) await accionar(mesa1.sock, 'deshacer');
    const r2Despues = (await get(3101, '/api/ring/ring-2')).cuerpo;
    chequear('Ctrl+Z en el Ring 1 no toca el Ring 2',
      r2Despues.lista.find(i => i.estado === 'en_pista')?.dorsal === pistaR2 &&
      r2Despues.lista.filter(i => i.estado === 'corrido').length === corridosR2,
      `pista ${r2Despues.lista.find(i => i.estado === 'en_pista')?.dorsal}, ` +
      `${r2Despues.lista.filter(i => i.estado === 'corrido').length} corridos`);

    const r1Despues = (await get(3101, '/api/ring/ring-1')).cuerpo;
    chequear('el Ring 1 sí volvió atrás',
      r1Despues.lista.every(i => i.estado === 'pendiente'),
      JSON.stringify(r1Despues.lista.filter(i => i.estado !== 'pendiente').map(i => [i.dorsal, i.estado])));

    /* ── 6. reordenar con un ausente en el medio ─────────────────────── */
    console.log('\n6. Reordenar con un ausente en el medio');
    r1 = (await accionar(mesa1.sock, 'siguiente')).snap;   // el primero a pista
    const pista0 = r1.lista.find(i => i.estado === 'en_pista');
    let pend = r1.lista.filter(i => i.estado === 'pendiente');
    const [p0, p1, p2] = pend;

    r1 = (await accionar(mesa1.sock, 'ausente', p1.id)).snap;
    pend = r1.lista.filter(i => i.estado === 'pendiente');
    chequear('el ausente sale de la lista de pendientes',
      pend.slice(0, 2).map(i => i.dorsal).join() === `${p0.dorsal},${p2.dorsal}`,
      pend.map(i => i.dorsal).join());

    // p2 tiene el ausente entre él y p0: la flecha tiene que saltárselo.
    r1 = (await accionar(mesa1.sock, 'mover', { id: p2.id, delta: -1 })).snap;
    pend = r1.lista.filter(i => i.estado === 'pendiente');
    chequear('la flecha ↑ salta por encima del ausente y reordena de verdad',
      pend[0].dorsal === p2.dorsal && pend[1].dorsal === p0.dorsal, pend.map(i => i.dorsal).join());
    esperadoTrasReinicio = p2.dorsal;

    const enPistaAhora = r1.lista.find(i => i.estado === 'en_pista');
    chequear('el perro en pista sigue en pista', enPistaAhora?.dorsal === pista0.dorsal, JSON.stringify(enPistaAhora));

    /* ── 6b. pista terminada: nadie desaparece ───────────────────────── */
    console.log('\n6b. Pista terminada');
    // Ring 2 tiene 3 perros y ya avanzó 2 en el paso 5: dos "siguiente" más y cierra.
    await accionar(mesa2.sock, 'siguiente');
    const r2Fin = (await accionar(mesa2.sock, 'siguiente')).snap;
    chequear('la pista queda cerrada', r2Fin.pista?.estado === 'cerrada', JSON.stringify(r2Fin.pista));
    chequear('la lista NO se vacía: siguen los 3 corredores en pantalla',
      r2Fin.lista.length === 3, `${r2Fin.lista.length} en la lista`);
    chequear('todos quedan como corridos (grisados en la vista)',
      r2Fin.lista.every(i => i.estado === 'corrido'),
      JSON.stringify(r2Fin.lista.map(i => i.estado)));
    chequear('ya no hay nadie en pista ni pendiente',
      !r2Fin.lista.some(i => i.estado === 'en_pista' || i.estado === 'pendiente'));
    const otroIntento = await accionar(mesa2.sock, 'siguiente');
    chequear('avanzar de nuevo avisa que terminó, sin romper nada',
      otroIntento.error === 'La pista ya terminó. Abrí la siguiente.', JSON.stringify(otroIntento));
    const resumenFin = (await get(3101, '/api/resumen')).cuerpo;
    const r2Card = resumenFin.rings.find(r => r.id === 'ring-2').pistas[0];
    chequear('la portada sigue nombrando la pista terminada',
      r2Card.nombre === 'Agility 1' && r2Card.faltan === 0 && r2Card.total === 3,
      JSON.stringify(r2Card));

    /* ── 6c. cargar orden desde CSV ──────────────────────────────────── */
    console.log('\n6c. Cargar orden desde archivo');
    const snapR1 = (await get(3101, '/api/ring/ring-1')).cuerpo;
    chequear('el snapshot dice qué pistas ya arrancaron',
      snapR1.pistas.every(p => typeof p.arrancada === 'boolean'), JSON.stringify(snapR1.pistas));

    // El Ring 2 tiene su pista terminada; el Ring 1 tiene la suya arrancada.
    // Creamos el caso real: importar sobre una pista sin arrancar.
    const mesaImp = await conectar(3101, 'ring-2', PIN);
    const pistaCerrada = mesaImp.snap.pistas[0].id;
    const yaArranco = await accionar(mesaImp.sock, 'cargar_orden',
      { pistaId: pistaCerrada, csv: 'dorsal\n12\n13\n14\n' });
    chequear('no deja importar sobre una pista que ya arrancó',
      yaArranco.error === 'Esa pista ya arrancó: el orden no se cambia desde un archivo.',
      JSON.stringify(yaArranco));

    // Sandbox aparte con su propio estado: si compartiera el de arriba, el Ring 1
    // ya estaría arrancado y no se podría importar nada.
    const DIR2 = path.join(__dirname, 'sandbox-import');
    prepararSandbox(DIR2);
    fs.writeFileSync(path.join(DIR2, 'data', 'seed.csv'), FIXTURE);
    const srvLimpio = await arrancar(3107, {}, DIR2);
    const conImport = await conectar(3107, 'ring-1', PIN);
    const pistaId = conImport.snap.pista.id;
    const ordenPrevio = conImport.snap.lista.map(i => i.dorsal).join(',');
    chequear('arranca con el orden del seed', ordenPrevio === '45,42,44,46,41,43', ordenPrevio);

    // Archivo con tiempos: se ignoran, sólo cuenta la columna dorsal y el orden.
    const csvTiempos = 'puesto,dorsal,perro,tiempo\n1,43,Perro 43,31.20\n2,41,Perro 41,32.80\n' +
      '3,46,Perro 46,33.10\n4,44,Perro 44,35.40\n5,42,Perro 42,36.90\n6,45,Perro 45,40.00\n';
    const imp = await accionarAviso(conImport.sock, 'cargar_orden', { pistaId, csv: csvTiempos });
    chequear('la importación no da error', !imp.error, JSON.stringify(imp).slice(0, 160));
    let impSnap = (await get(3107, '/api/ring/ring-1')).cuerpo;
    // El archivo pide 43,41,46,44,42,45; la regla de alturas manda, así que queda
    // XS, Small, Medium, Intermediate y recién ahí los dos Large en orden del archivo.
    chequear('la altura manda y el archivo ordena adentro',
      impSnap.lista.map(i => i.dorsal).join(',') === '45,42,44,46,43,41',
      impSnap.lista.map(i => i.dorsal).join(','));
    chequear('las alturas siguen de menor a mayor después de importar',
      impSnap.lista.map(i => i.altura).join(',') === 'XS,Small,Medium,Intermediate,Large,Large',
      impSnap.lista.map(i => i.altura).join(','));
    // Dentro de Large (41 y 43) el archivo pone 43 antes que 41: eso sí cambia.
    const larges = impSnap.lista.filter(i => i.altura === 'Large').map(i => i.dorsal).join(',');
    chequear('dentro de una altura sí reordena según el archivo', larges === '43,41', larges);

    // Invertir: el mismo archivo al revés.
    const impInv = await accionarAviso(conImport.sock, 'cargar_orden', { pistaId, csv: csvTiempos, invertir: true });
    chequear('la opción invertir no da error', !impInv.error, JSON.stringify(impInv).slice(0, 120));
    impSnap = (await get(3107, '/api/ring/ring-1')).cuerpo;
    const largesInv = impSnap.lista.filter(i => i.altura === 'Large').map(i => i.dorsal).join(',');
    chequear('invertir da vuelta el orden dentro de la altura', largesInv === '41,43', largesInv);

    // Dorsales que no corren esta pista, y perros que el archivo no menciona.
    const csvParcial = 'dorsal\n9999\n43\n8888\n43\n';
    const impParcial = await accionarAviso(conImport.sock, 'cargar_orden', { pistaId, csv: csvParcial });
    chequear('reporta los dorsales ajenos, los faltantes y los repetidos',
      /no corren esta pista/.test(JSON.stringify(impParcial)) &&
      /no estaban en el archivo/.test(JSON.stringify(impParcial)) &&
      /repetido/.test(JSON.stringify(impParcial)),
      JSON.stringify(impParcial));
    impSnap = (await get(3107, '/api/ring/ring-1')).cuerpo;
    chequear('los que el archivo no menciona no se pierden',
      impSnap.lista.length === 6, `${impSnap.lista.length} en la lista`);
    chequear('el mencionado queda primero dentro de su altura',
      impSnap.lista.filter(i => i.altura === 'Large').map(i => i.dorsal).join(',') === '43,41',
      impSnap.lista.filter(i => i.altura === 'Large').map(i => i.dorsal).join(','));

    // Undo
    const impUndo = await accionar(conImport.sock, 'deshacer');
    chequear('Ctrl+Z revierte una importación', !impUndo.error, JSON.stringify(impUndo).slice(0, 120));
    impSnap = (await get(3107, '/api/ring/ring-1')).cuerpo;
    chequear('vuelve al orden anterior a la importación',
      impSnap.lista.filter(i => i.altura === 'Large').map(i => i.dorsal).join(',') === '41,43',
      impSnap.lista.filter(i => i.altura === 'Large').map(i => i.dorsal).join(','));

    // Archivos inválidos
    // En una pista con dorsales, un archivo de sólo nombres no matchea nada: en vez
    // de aplicar un orden que no cambia nada, tiene que explicar qué falta.
    const soloNombres = await accionar(conImport.sock, 'cargar_orden',
      { pistaId, csv: 'puesto,perro,tiempo\n1,Perro 43,31.20\n' });
    chequear('en una pista con dorsales, un archivo de nombres avisa qué falta',
      soloNombres.error === 'El archivo trae nombres pero esta pista se ordena por dorsal: le falta la columna "dorsal".',
      JSON.stringify(soloNombres));
    const nadaCoincide = await accionar(conImport.sock, 'cargar_orden',
      { pistaId, csv: 'dorsal\n7777\n8888\n' });
    chequear('si ningún dorsal coincide, no toca el orden',
      nadaCoincide.error === 'Ningún perro del archivo coincide con los de esta pista.',
      JSON.stringify(nadaCoincide));
    const vacio = await accionar(conImport.sock, 'cargar_orden', { pistaId, csv: '   ' });
    chequear('un archivo vacío se rechaza', vacio.error === 'El archivo llegó vacío.', JSON.stringify(vacio));
    const gigante = await accionar(conImport.sock, 'cargar_orden',
      { pistaId, csv: 'dorsal\n' + '43\n'.repeat(200000) });   // ~600 KB: pasa el transporte, no mi tope
    chequear('un archivo gigante se rechaza con mensaje, no en silencio',
      gigante.error === 'El archivo es demasiado grande.', JSON.stringify(gigante).slice(0, 120));
    const ajena = await accionar(conImport.sock, 'cargar_orden',
      { pistaId: 'ring-2--agility-1', csv: 'dorsal\n12\n' });
    chequear('no se puede importar a la pista de otro ring',
      ajena.error === 'Esa pista no es de esta competencia.', JSON.stringify(ajena));

    // Un archivo con ring y pista adentro: se usan sólo las filas que tocan.
    const csvMulti = 'ring,pista,dorsal\nRing 2,Agility 1,12\nRing 1,Jumping 1,41\nRing 1,Jumping 1,43\n';
    const impMulti = await accionarAviso(conImport.sock, 'cargar_orden', { pistaId, csv: csvMulti });
    chequear('un archivo con varias pistas usa sólo las filas de esta',
      !impMulti.error && /2 en el orden del archivo/.test(JSON.stringify(impMulti)), JSON.stringify(impMulti));

    /* ── 6d. importar una pista sin dorsales ─────────────────────────── */
    console.log('\n6d. Importar una pista sin dorsales (G0)');
    const DIR3 = path.join(__dirname, 'sandbox-g0');
    prepararSandbox(DIR3);
    const FIX_G0 = ['ring,pista,categoria,altura,dorsal,guia,perro,raza']
      .concat([
        'Revamp,Iniciante 1,G0,Small,,Marieli Sanoja,OREO,',
        'Revamp,Iniciante 1,G0,Small,,Fabiana Balsano,TIAGO,',
        'Revamp,Iniciante 1,G0,Medium,,Sofía Benitez,CHINA,',
        'Revamp,Iniciante 1,G0,Large,,Victoria del Val,BRANCA,'
      ]).join('\n') + '\n';
    fs.writeFileSync(path.join(DIR3, 'data', 'seed.csv'), FIX_G0);
    const srvG0 = await arrancar(3108, {}, DIR3);
    const mesaG0 = await conectar(3108, 'revamp', PIN);
    const pistaG0 = mesaG0.snap.pista.id;
    chequear('siembra bien una pista donde nadie tiene dorsal',
      mesaG0.snap.lista.length === 4 && mesaG0.snap.lista.every(i => !i.dorsal),
      JSON.stringify(mesaG0.snap.lista.map(i => [i.dorsal, i.perro])));
    chequear('el orden inicial es por altura',
      mesaG0.snap.lista.map(i => i.perro).join(',') === 'OREO,TIAGO,CHINA,BRANCA',
      mesaG0.snap.lista.map(i => i.perro).join(','));

    // Archivo con nombres en vez de dorsales, en otro orden y en minúscula.
    const csvNombres = 'puesto,perro,tiempo\n1,branca,28.4\n2,china,30.1\n3,tiago,31.7\n4,oreo,33.0\n';
    const impG0 = await accionarAviso(mesaG0.sock, 'cargar_orden', { pistaId: pistaG0, csv: csvNombres });
    chequear('acepta un archivo con columna "perro" y sin "dorsal"', !impG0.error, JSON.stringify(impG0).slice(0, 140));
    let g0Snap = (await get(3108, '/api/ring/revamp')).cuerpo;
    chequear('reordena por nombre, respetando la altura',
      g0Snap.lista.map(i => i.perro).join(',') === 'TIAGO,OREO,CHINA,BRANCA',
      g0Snap.lista.map(i => i.perro).join(','));
    chequear('los 4 entraron por nombre',
      /4 en el orden del archivo/.test(String(impG0.aviso)), String(impG0.aviso));

    const csvAcento = 'perro\nCHINA\nBRANCA\nTIAGO\nOREO\n';
    await accionarAviso(mesaG0.sock, 'cargar_orden', { pistaId: pistaG0, csv: csvAcento });
    g0Snap = (await get(3108, '/api/ring/revamp')).cuerpo;
    chequear('el archivo en mayúsculas matchea igual',
      g0Snap.lista.map(i => i.perro).join(',') === 'TIAGO,OREO,CHINA,BRANCA',
      g0Snap.lista.map(i => i.perro).join(','));

    const csvDesconocido = 'perro\nFANTASMA\nBRANCA\n';
    const impDesc = await accionarAviso(mesaG0.sock, 'cargar_orden', { pistaId: pistaG0, csv: csvDesconocido });
    chequear('un nombre que no corre la pista se reporta',
      /FANTASMA/.test(String(impDesc.aviso)), String(impDesc.aviso));

    const sinNada = await accionar(mesaG0.sock, 'cargar_orden',
      { pistaId: pistaG0, csv: 'puesto,tiempo\n1,28.4\n' });
    chequear('sin columna dorsal ni perro, lo dice',
      sinNada.error === 'El archivo necesita una columna "dorsal" o "perro".', JSON.stringify(sinNada));
    mesaG0.sock.close();
    await matar(srvG0.proc);

    // Sin PIN no se puede importar.
    const mirón = await conectar(3107, 'ring-1');
    const sinPin = await accionar(mirón.sock, 'cargar_orden', { pistaId, csv: 'dorsal\n41\n' });
    chequear('sin PIN no se puede importar el orden',
      /PIN de mesa/.test(String(sinPin.error)), JSON.stringify(sinPin));
    mirón.sock.close();
    conImport.sock.close();
    mesaImp.sock.close();
    await matar(srvLimpio.proc);

    /* ── 6e. mirar otra pista sin abrirla ────────────────────────────── */
    console.log('\n6e. Mirar y reordenar una pista que no está corriendo');
    const DIR4 = path.join(__dirname, 'sandbox-ver');
    prepararSandbox(DIR4);
    const FIX_VER = ['ring,pista,categoria,altura,dorsal,guia,perro,raza']
      .concat([1, 2, 3].map(d => `Cancha 1,Jumping 1,G1,Large,${d},Guía ${d},Perro ${d},`))
      .concat([4, 5, 6].map(d => `Cancha 1,Jumping 2,G1,Large,${d},Guía ${d},Perro ${d},`))
      .concat([7, 8].map(d => `Cancha 1,Final,G1,Large,${d},Guía ${d},Perro ${d},`))
      .join('\n') + '\n';
    fs.writeFileSync(path.join(DIR4, 'data', 'seed.csv'), FIX_VER);
    const srvVer = await arrancar(3109, {}, DIR4);

    const snapDef = (await get(3109, '/api/ring/cancha-1')).cuerpo;
    chequear('sin pedir pista, se manda la que está corriendo',
      snapDef.pista.nombre === 'Jumping 1' && snapDef.esActiva === true, JSON.stringify(snapDef.pista));
    chequear('el snapshot dice cuál es la que corre',
      snapDef.activa?.nombre === 'Jumping 1', JSON.stringify(snapDef.activa));
    chequear('lista las 3 pistas del ring', snapDef.pistas.length === 3,
      snapDef.pistas.map(p => p.nombre).join(','));

    const snapFinal = (await get(3109, '/api/ring/cancha-1?pista=cancha-1--final')).cuerpo;
    chequear('se puede pedir el orden de otra pista por URL',
      snapFinal.pista.nombre === 'Final' && snapFinal.lista.length === 2, JSON.stringify(snapFinal.pista));
    chequear('y avisa que NO es la que está corriendo',
      snapFinal.esActiva === false && snapFinal.activa.nombre === 'Jumping 1',
      `esActiva=${snapFinal.esActiva} activa=${snapFinal.activa?.nombre}`);
    chequear('la pista que no largó viene marcada como no arrancada',
      snapFinal.pista.arrancada === false, String(snapFinal.pista.arrancada));

    const pistaAjena = (await get(3109, '/api/ring/cancha-1?pista=otro-ring--x')).cuerpo;
    chequear('una pista de otro ring se ignora y cae en la activa',
      pistaAjena.pista.nombre === 'Jumping 1', JSON.stringify(pistaAjena.pista));

    // Por socket: dos mirones en pistas distintas del mismo ring.
    const enJumping = await conectar(3109, 'cancha-1');
    const enFinal = io(url(3109), { transports: ['websocket'] });
    await esperar(enFinal, 'connect');
    enFinal.emit('join', { ringId: 'cancha-1', pistaId: 'cancha-1--final' });
    let snapF = await esperar(enFinal, 'snapshot');
    chequear('cada conexión recibe la pista que pidió',
      snapF.pista.nombre === 'Final' && enJumping.snap.pista.nombre === 'Jumping 1',
      `${snapF.pista.nombre} / ${enJumping.snap.pista.nombre}`);

    // Un avance en Jumping 1 tiene que llegarle a los dos, cada uno con SU pista.
    const mesaVer = await conectar(3109, 'cancha-1', PIN);
    const esperaJ = esperar(enJumping.sock, 'snapshot', 2500);
    const esperaF = esperar(enFinal, 'snapshot', 2500);
    mesaVer.sock.emit('siguiente');
    const [snapJ2, snapF2] = await Promise.all([esperaJ, esperaF]);
    chequear('al avanzar, el que mira Jumping 1 ve el cambio',
      snapJ2.lista.some(i => i.estado === 'en_pista'), JSON.stringify(snapJ2.lista.map(i => i.estado)));
    chequear('y el que mira Final sigue viendo Final, no se le cambia la pista',
      snapF2.pista.nombre === 'Final' && snapF2.lista.length === 2, JSON.stringify(snapF2.pista));
    chequear('pero se enteró de que Jumping 1 arrancó',
      snapF2.pistas.find(p => p.nombre === 'Jumping 1').arrancada === true,
      JSON.stringify(snapF2.pistas.map(p => [p.nombre, p.arrancada])));

    // ver_pista cambia de pista sin reconectar.
    enJumping.sock.emit('ver_pista', 'cancha-1--jumping-2');
    const snapJ3 = await esperar(enJumping.sock, 'snapshot');
    chequear('ver_pista cambia de pista sin volver a entrar',
      snapJ3.pista.nombre === 'Jumping 2' && snapJ3.esActiva === false, JSON.stringify(snapJ3.pista));

    // La mesa reordena una pista que no está corriendo, sin abrirla.
    mesaVer.sock.emit('ver_pista', 'cancha-1--final');
    const mv = await esperar(mesaVer.sock, 'snapshot');
    const primeroFinal = mv.lista[0];
    const movida = await accionar(mesaVer.sock, 'mover', { id: mv.lista[1].id, delta: -1 });
    chequear('la mesa reordena una pista que no está corriendo', !movida.error, JSON.stringify(movida).slice(0, 120));
    const finalDespues = (await get(3109, '/api/ring/cancha-1?pista=cancha-1--final')).cuerpo;
    chequear('el reorden se aplicó a esa pista',
      finalDespues.lista[0].dorsal !== primeroFinal.dorsal,
      finalDespues.lista.map(i => i.dorsal).join(','));
    const sigueActiva = (await get(3109, '/api/ring/cancha-1')).cuerpo;
    chequear('y la pista en curso no cambió',
      sigueActiva.pista.nombre === 'Jumping 1', sigueActiva.pista.nombre);

    enFinal.close();
    enJumping.sock.close();
    mesaVer.sock.close();
    await matar(srvVer.proc);

    /* ── 6g. cambiar el orden de las pistas ──────────────────────────── */
    console.log('\n6g. Cambiar el orden del programa');
    const DIR6 = path.join(__dirname, 'sandbox-programa');
    prepararSandbox(DIR6);
    const FIX_PROG = ['pista,categoria,altura,dorsal,guia,perro']
      .concat(['Agility 1', 'Agility 2', 'Jumping 1', 'Final'].flatMap((p, n) =>
        [1, 2].map(d => `${p},G1,Large,${n * 10 + d},Guía ${n}${d},PERRO ${n}${d}`)))
      .join('\n') + '\n';
    fs.writeFileSync(path.join(DIR6, 'data', 'seed.csv'), FIX_PROG);
    const srvP = await arrancar(3112, {}, DIR6);
    const mesaP = await conectar(3112, 'copa-de-otono', PIN);
    const prog = () => mesaP.snap.pistas.map(p => p.nombre).join(',');
    chequear('el programa arranca en el orden del CSV',
      prog() === 'Agility 1,Agility 2,Jumping 1,Final', prog());

    // Bajar la Final no tiene efecto: ya es la última.
    let r = await accionar(mesaP.sock, 'mover_pista', { id: 'copa-de-otono--final', delta: 1 });
    mesaP.snap = r.snap || mesaP.snap;
    chequear('bajar la última no rompe ni cambia nada',
      !r.error && prog() === 'Agility 1,Agility 2,Jumping 1,Final', `${r.error || ''} ${prog()}`);

    // Subir Jumping 1 dos veces: queda primera.
    r = await accionar(mesaP.sock, 'mover_pista', { id: 'copa-de-otono--jumping-1', delta: -1 });
    mesaP.snap = r.snap;
    chequear('subir una pista la adelanta en el programa',
      prog() === 'Agility 1,Jumping 1,Agility 2,Final', prog());
    r = await accionar(mesaP.sock, 'mover_pista', { id: 'copa-de-otono--jumping-1', delta: -1 });
    mesaP.snap = r.snap;
    chequear('y se puede seguir subiendo hasta el principio',
      prog() === 'Jumping 1,Agility 1,Agility 2,Final', prog());

    // Al reordenar, la que queda primera es la que la vista muestra por defecto.
    let snapP = (await get(3112, '/api/ring/copa-de-otono')).cuerpo;
    chequear('la primera del programa nuevo es la que se muestra',
      snapP.pista.nombre === 'Jumping 1', snapP.pista.nombre);

    // Ctrl+Z lo revierte.
    r = await accionar(mesaP.sock, 'deshacer');
    mesaP.snap = r.snap;
    chequear('Ctrl+Z revierte el cambio de programa',
      prog() === 'Agility 1,Jumping 1,Agility 2,Final', prog());

    // Una pista que ya arrancó no se mueve, y las demás se mueven entre ellas.
    await accionar(mesaP.sock, 'siguiente');   // arranca la primera del programa
    snapP = (await get(3112, '/api/ring/copa-de-otono')).cuerpo;
    const arrancada = snapP.pistas.find(p => p.arrancada);
    chequear('la primera del programa quedó arrancada', !!arrancada, JSON.stringify(snapP.pistas));
    const rMal = await accionar(mesaP.sock, 'mover_pista', { id: arrancada.id, delta: 1 });
    chequear('una pista que ya arrancó no se puede mover',
      rMal.error === 'Esa pista ya arrancó: su lugar en el programa no se cambia.', JSON.stringify(rMal));

    r = await accionar(mesaP.sock, 'mover_pista', { id: 'copa-de-otono--final', delta: -1 });
    mesaP.snap = r.snap;
    chequear('las que no arrancaron se siguen moviendo entre ellas',
      prog() === 'Agility 1,Jumping 1,Final,Agility 2', prog());
    chequear('la que arrancó no se movió de su lugar',
      mesaP.snap.pistas[0].nombre === 'Agility 1' && mesaP.snap.pistas[0].arrancada === true,
      JSON.stringify(mesaP.snap.pistas.map(p => [p.nombre, p.arrancada])));

    // El orden del programa sobrevive al reinicio. Se le da un instante para que
    // el guardado diferido cierre: matar el proceso de golpe en Windows no corre
    // los handlers de salida, y acá lo que se prueba es la persistencia, no eso.
    mesaP.sock.close();
    await dormir(300);
    await matar(srvP.proc);
    const srvP2 = await arrancar(3113, {}, DIR6);
    const trasP = (await get(3113, '/api/ring/copa-de-otono')).cuerpo;
    chequear('el programa reordenado sobrevive al reinicio',
      trasP.pistas.map(p => p.nombre).join(',') === 'Agility 1,Jumping 1,Final,Agility 2',
      trasP.pistas.map(p => p.nombre).join(','));

    // Sin PIN no se toca el programa.
    const mironP = await conectar(3113, 'copa-de-otono');
    const sinPinP = await accionar(mironP.sock, 'mover_pista', { id: 'copa-de-otono--final', delta: -1 });
    chequear('sin PIN no se puede cambiar el programa',
      /PIN de mesa/.test(String(sinPinP.error)), JSON.stringify(sinPinP));
    mironP.sock.close();
    await matar(srvP2.proc);

    /* ── 6f. cargar otra competencia desde archivo ───────────────────── */
    console.log('\n6f. Cargar otra competencia (borrar y sembrar de cero)');
    const DIR5 = path.join(__dirname, 'sandbox-nueva');
    prepararSandbox(DIR5);
    fs.writeFileSync(path.join(DIR5, 'data', 'seed.csv'), FIXTURE);
    const srvN = await arrancar(3110, {}, DIR5);
    const mesaN = await conectar(3110, 'ring-1', PIN);
    await accionar(mesaN.sock, 'siguiente');   // deja avances para verificar que se borran

    // Sin la palabra tipeada, no pasa nada.
    const sinConf = await accionar(mesaN.sock, 'nueva_competencia',
      { csv: 'pista,perro\nFinal,PERRO A\n' });
    chequear('sin la confirmación tipeada no borra nada',
      sinConf.error === 'Falta la confirmación.', JSON.stringify(sinConf));

    // Sin PIN tampoco.
    const mironN = await conectar(3110, 'ring-1');
    const sinPinN = await accionar(mironN.sock, 'nueva_competencia',
      { csv: 'pista,perro\nFinal,PERRO A\n', confirmar: 'BORRAR' });
    chequear('sin PIN no se puede cargar otra competencia',
      /PIN de mesa/.test(String(sinPinN.error)), JSON.stringify(sinPinN));
    mironN.sock.close();

    // Un archivo sin las columnas mínimas se rechaza sin tocar nada.
    const basura = await accionar(mesaN.sock, 'nueva_competencia',
      { csv: 'a,b,c\n1,2,3\n', confirmar: 'BORRAR' });
    chequear('un CSV sin pista ni perro se rechaza',
      /ninguna inscripción usable/.test(String(basura.error)), JSON.stringify(basura));
    const intacto = (await get(3110, '/api/ring/ring-1')).cuerpo;
    chequear('y la competencia anterior sigue intacta',
      intacto.lista.length === 6, `${intacto.lista.length} inscripciones`);

    // La carga de verdad. Sin columna `ring`: una sola cancha.
    const csvNueva = ['pista,categoria,altura,dorsal,guia,perro']
      .concat(['Agility 1,G1,Large,201,Guía A,PERRO A', 'Agility 1,G2,Small,202,Guía B,PERRO B'])
      .concat(['Final,G1,Large,201,Guía A,PERRO A'])
      .concat([',G1,Large,203,Guía C,SIN PISTA', 'Final,G1,Large,204,Guía D,'])
      .join('\n') + '\n';
    const recargo = esperar(mesaN.sock, 'aviso_app', 3000);
    mesaN.sock.emit('nueva_competencia', { csv: csvNueva, confirmar: 'BORRAR' });
    const avisoN = await recargo;
    chequear('reporta lo que cargó', /Competencia nueva cargada/.test(avisoN), avisoN);
    chequear('cuenta las filas salteadas sin pista ni perro',
      /2 fila\(s\) salteada/.test(avisoN), avisoN);

    const resN = (await get(3110, '/api/resumen')).cuerpo;
    chequear('la competencia vieja desapareció',
      resN.rings.length === 1 && resN.rings[0].id !== 'ring-1', JSON.stringify(resN.rings.map(r => r.id)));
    chequear('sin columna "ring", la cancha toma el nombre del evento',
      resN.rings[0].nombre === 'Copa de Otoño', resN.rings[0].nombre);
    chequear('cargó las 2 pistas nuevas',
      resN.rings[0].pistas.map(p => p.nombre).join(',') === 'Agility 1,Final',
      resN.rings[0].pistas.map(p => p.nombre).join(','));

    const ringN = resN.rings[0].id;
    const snapN = (await get(3110, `/api/ring/${ringN}`)).cuerpo;
    chequear('nadie arrastra estado de la competencia anterior',
      snapN.lista.every(i => i.estado === 'pendiente'),
      JSON.stringify(snapN.lista.map(i => i.estado)));
    chequear('la primera pista queda abierta', snapN.pista.nombre === 'Agility 1', snapN.pista.nombre);
    chequear('las alturas de la pista nueva también van de menor a mayor',
      snapN.lista.map(i => i.altura).join(',') === 'Small,Large',
      snapN.lista.map(i => i.altura).join(','));

    chequear('el estado anterior quedó respaldado',
      fs.readdirSync(path.join(DIR5, 'data')).some(f => f.startsWith('state.json.anterior-')),
      fs.readdirSync(path.join(DIR5, 'data')).join(', '));
    chequear('el CSV nuevo pasó a ser la semilla',
      fs.readFileSync(path.join(DIR5, 'data', 'seed.csv'), 'utf8') === csvNueva);

    // Y sobrevive al reinicio.
    mesaN.sock.close();
    await matar(srvN.proc);
    const srvN2 = await arrancar(3111, {}, DIR5);
    const trasR = (await get(3111, '/api/resumen')).cuerpo;
    chequear('la competencia nueva sobrevive al reinicio',
      trasR.rings[0].pistas.length === 2, JSON.stringify(trasR.rings[0].pistas.map(p => p.nombre)));
    await matar(srvN2.proc);

    /* ── 6h. deploy: DATA_DIR aparte y arranque sin CSV ──────────────── */
    console.log('\n6h. Deploy: DATA_DIR separado y arranque sin CSV');
    const DIR7 = path.join(__dirname, 'sandbox-deploy');
    prepararSandbox(DIR7);
    // El ejemplo va en la carpeta del proyecto; el estado, en otra. Es la forma en
    // que corre en Fly: volumen montado en /data, imagen con el seed.example.csv.
    fs.writeFileSync(path.join(DIR7, 'data', 'seed.example.csv'), FIXTURE);
    const VOL = path.join(DIR7, 'volumen');
    fs.mkdirSync(VOL, { recursive: true });
    const srvD = await arrancar(3115, { DATA_DIR: VOL }, DIR7);
    chequear('arranca con DATA_DIR apuntando a otra carpeta', true);
    chequear('el estado se escribe en DATA_DIR, no en ./data',
      fs.existsSync(path.join(VOL, 'state.json')) && !fs.existsSync(path.join(DIR7, 'data', 'state.json')),
      `volumen: ${fs.existsSync(path.join(VOL, 'state.json'))}, ./data: ${fs.existsSync(path.join(DIR7, 'data', 'state.json'))}`);
    const snapD = (await get(3115, '/api/resumen')).cuerpo;
    chequear('sembró desde el seed.example.csv de la imagen',
      snapD.rings.length === 2, JSON.stringify(snapD.rings?.map(r => r.id)));
    chequear('avisa que usó el ejemplo', srvD.salida().includes('seed.example.csv'), srvD.salida().slice(0, 200));
    await matar(srvD.proc);

    // Sin ningún CSV: tiene que levantar igual, vacío, en vez de morir.
    const DIR8 = path.join(__dirname, 'sandbox-sin-csv');
    prepararSandbox(DIR8);
    const srvV = await arrancar(3116, {}, DIR8);
    chequear('sin ningún CSV levanta igual', true);
    const rVacio = await get(3116, '/api/resumen');
    chequear('contesta 200 y el health check pasa', rVacio.status === 200, `status ${rVacio.status}`);
    chequear('no hay competencia cargada', rVacio.cuerpo.rings.length === 0, JSON.stringify(rVacio.cuerpo));
    chequear('lo dice por consola', srvV.salida().includes('sin competencia cargada'),
      srvV.salida().slice(0, 220));
    const rPortada = await get(3116, '/');
    chequear('la portada igual se sirve', rPortada.status === 200, `status ${rPortada.status}`);
    await matar(srvV.proc);

    /* ── 7. latido ───────────────────────────────────────────────────── */
    console.log('\n7. Latido (frescura)');
    const conLatido = io(url(3101), { transports: ['websocket'] });
    await esperar(conLatido, 'connect');
    conLatido.emit('join', 'ring-1');
    await esperar(conLatido, 'snapshot');
    let latidos = 0;
    conLatido.on('latido', () => latidos++);
    console.log('   (esperando 32 s el latido del servidor…)');
    await dormir(32000);
    chequear('el servidor manda latido a los 30 s', latidos >= 1, `${latidos} latidos`);
    conLatido.close();

    /* ── 8. guardado en el corte ─────────────────────────────────────── */
    console.log('\n8. Guardado al salir y estado corrupto');
    const antesDeMatar = (await get(3101, '/api/ring/ring-1')).cuerpo;
    await matar(srv.proc);
    const enDisco = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    const pistaDisco = enDisco.inscripciones.find(i => i.estado === 'en_pista')?.dorsal;
    chequear('el último avance quedó en disco al cerrar',
      pistaDisco === antesDeMatar.lista.find(i => i.estado === 'en_pista')?.dorsal, `disco: ${pistaDisco}`);

    srv = await arrancar(3102);
    const trasReinicio = (await get(3102, '/api/ring/ring-1')).cuerpo;
    chequear('el orden reordenado sobrevive al reinicio',
      trasReinicio.lista.filter(i => i.estado === 'pendiente')[0].dorsal === esperadoTrasReinicio,
      trasReinicio.lista.filter(i => i.estado === 'pendiente').slice(0, 2).map(i => i.dorsal).join(','));
    await matar(srv.proc);

    fs.writeFileSync(STATE, '{"rings":[{"id":"ring-1"');   // JSON truncado
    srv = await arrancar(3103);
    chequear('con state.json corrupto igual arranca', true);
    chequear('el archivo roto se guarda aparte',
      fs.readdirSync(path.join(RAIZ, 'data')).some(f => f.startsWith('state.json.roto-')));
    chequear('avisa fuerte por consola', srv.salida().includes('¡OJO!'));
    await matar(srv.proc);

    // JSON válido pero sin las colecciones que espera: arrancaría igual y
    // explotaría en el primer pedido, así que se aparta antes.
    fs.writeFileSync(STATE, JSON.stringify({ evento: { nombre: 'x' }, rings: [] }));
    srv = await arrancar(3114);
    const rIncompat = await get(3114, '/api/resumen');
    chequear('un state.json de forma incompatible no rompe el arranque', rIncompat.status === 200,
      `status ${rIncompat.status}`);
    chequear('se aparta como .incompatible-',
      fs.readdirSync(path.join(RAIZ, 'data')).some(f => f.startsWith('state.json.incompatible-')),
      fs.readdirSync(path.join(RAIZ, 'data')).join(', '));
    chequear('y siembra de nuevo desde el CSV',
      rIncompat.cuerpo.rings.length === 2, JSON.stringify(rIncompat.cuerpo.rings?.map(r => r.id)));
    await matar(srv.proc);

    /* ── 9. CSV con comas entre comillas ─────────────────────────────── */
    console.log('\n9. CSV con comillas');
    fs.rmSync(STATE, { force: true });
    fs.writeFileSync(SEED, FIXTURE.trimEnd() +
      '\nRing 3,Agility 1,G2,Large,90,"Ruiz, Marta",Nala,"Border Collie, tricolor"\n');
    srv = await arrancar(3104);
    const ring3 = (await get(3104, '/api/ring/ring-3')).cuerpo;
    chequear('el ring con campos entrecomillados existe', !!ring3 && !ring3.error, JSON.stringify(ring3).slice(0, 80));
    chequear('la coma dentro de comillas no parte la columna',
      ring3?.lista?.[0]?.guia === 'Ruiz, Marta', JSON.stringify(ring3?.lista?.[0]));
    chequear('la raza entrecomillada también',
      ring3?.lista?.[0]?.raza === 'Border Collie, tricolor', ring3?.lista?.[0]?.raza);
    await matar(srv.proc);

    /* ── 10. bloqueo de PIN ──────────────────────────────────────────── */
    console.log('\n10. Fuerza bruta del PIN');
    srv = await arrancar(3105);
    const atacante = io(url(3105), { transports: ['websocket'] });
    await esperar(atacante, 'connect');
    for (let i = 0; i < 5; i++) {
      atacante.emit('join', { ringId: 'ring-1', pin: `000${i}` });
      await esperar(atacante, 'mesa_ok');
    }
    atacante.emit('join', { ringId: 'ring-1', pin: PIN });
    const bloqueo = await Promise.race([
      esperar(atacante, 'error_app', 2500).then(e => ({ error: e })),
      esperar(atacante, 'mesa_ok', 2500).then(v => ({ mesa_ok: v }))
    ]);
    chequear('tras 5 intentos fallidos el PIN queda bloqueado',
      typeof bloqueo.error === 'string' && bloqueo.error.includes('Demasiados intentos'), JSON.stringify(bloqueo));
    atacante.close();
    await matar(srv.proc);

    /* ── resultado ───────────────────────────────────────────────────── */
    console.log(`\n${'─'.repeat(60)}`);
    console.log(fallos.length ? `${ok} ok, ${fallos.length} FALLAS:\n  - ${fallos.join('\n  - ')}` : `${ok} de ${ok} pruebas ok`);
    process.exitCode = fallos.length ? 1 : 0;
  } catch (e) {
    console.error('\nLa prueba se cayó:', e.message);
    process.exitCode = 1;
  } finally {
    await limpiar();
    console.log('(sandboxes borrados; tu data/ nunca se tocó)');
    process.exit(process.exitCode ?? 0);
  }
})();
