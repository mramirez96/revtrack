'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MESA_PIN = process.env.MESA_PIN || '1234';
// Dónde vive lo que cambia. Configurable porque en un deploy hay que apuntarlo a
// un volumen: el disco de la máquina es efímero y se borra en cada deploy.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SEED_FILE = path.join(DATA_DIR, 'seed.csv');

// El ejemplo se lee SIEMPRE de la carpeta del proyecto, nunca de DATA_DIR: si el
// volumen se monta encima de ./data, tapa el archivo de la imagen y el servidor
// quedaría sin ningún CSV del que sembrar.
// `data/seed.csv` tiene nombres de gente real, así que no se versiona. Un clon
// nuevo arranca con el ejemplo inventado y funciona sin configurar nada.
const SEED_EJEMPLO = path.join(__dirname, 'data', 'seed.example.csv');

// Cada cuánto le confirmamos a los celulares que lo que están viendo sigue
// vigente. Sin esto el encabezado dice "hace 3 min" en una pista lenta aunque
// la conexión esté perfecta.
const LATIDO_MS = 30000;

// Intentos de PIN por IP antes de un bloqueo corto. Un PIN de 4 dígitos sin
// esto se agota por fuerza bruta en segundos.
const PIN_INTENTOS = 5;
const PIN_BLOQUEO_MS = 60000;

// Cuántos avances guardamos por pista para calcular el ritmo. Se leen los
// últimos 9; el resto es peso muerto en el JSON.
const MARCAS_TOPE = 20;

// Tope del CSV de orden que manda la mesa por el websocket. Un orden de 4 pistas
// no llega ni a 50 KB; esto es para que nadie mande un archivo enorme.
// Tiene que quedar por debajo del `maxHttpBufferSize` de Socket.IO (1 MB): si se
// pasa de ese, el mensaje se descarta en la capa de transporte y la mesa se queda
// esperando sin ver nunca el motivo.
const ORDEN_MAX_CHARS = 500_000;

// Guardado a disco: se juntan los cambios seguidos, con un techo para que una
// ráfaga no posponga la escritura indefinidamente.
const GUARDAR_MS = 120;
const GUARDAR_TOPE_MS = 1000;

/* ---------------------------------------------------------------- estado --- */

let state = null;
const undo = new Map();   // ringId -> pila de snapshots de ese ring

function slug(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const clon = v => JSON.parse(JSON.stringify(v));

// Para comparar nombres de perro escritos a mano o exportados de otro sistema:
// sin mayúsculas, sin acentos, sin espacios de sobra. Igual que en la vista.
const normalizar = s => String(s ?? '').trim().toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// CSV con comillas: hace falta para nombres como "Ruiz, Marta" o razas con
// coma. Respeta comas y saltos de línea entre comillas, y "" como comilla.
function parseCsv(text) {
  const filas = [];
  let fila = [], celda = '', enComillas = false;
  const limpio = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

  for (let i = 0; i < limpio.length; i++) {
    const c = limpio[i];
    if (enComillas) {
      if (c === '"') {
        if (limpio[i + 1] === '"') { celda += '"'; i++; }
        else enComillas = false;
      } else celda += c;
    } else if (c === '"' && celda.trim() === '') {
      enComillas = true;
      celda = '';
    } else if (c === ',') {
      fila.push(celda); celda = '';
    } else if (c === '\n') {
      fila.push(celda); filas.push(fila); fila = []; celda = '';
    } else celda += c;
  }
  fila.push(celda);
  if (fila.some(x => x.trim() !== '')) filas.push(fila);

  const head = (filas.shift() || []).map(h => h.trim());
  return filas
    .filter(f => f.some(x => x.trim() !== ''))
    .map(f => Object.fromEntries(head.map((h, i) => [h, (f[i] ?? '').trim()])));
}

// Las alturas corren siempre de menor a mayor. Es regla de la competencia, no un
// detalle de cómo quedó el archivo, así que se aplica al sembrar: si el CSV viene
// desordenado, se acomoda igual (y se avisa por consola).
const ORDEN_ALTURA = ['xs', 'small', 'medium', 'intermediate', 'large'];

// Rango de cada altura. Las que no están en la lista estándar van después, en el
// orden en que aparecen: no inventamos una jerarquía que no conocemos, pero
// tampoco las perdemos. Sirve igual para filas del CSV que para inscripciones:
// sólo mira `.altura`.
function rangosDeAltura(filas) {
  const rango = new Map();
  for (const r of filas) {
    const a = slug(r.altura || '');
    if (rango.has(a)) continue;
    const i = ORDEN_ALTURA.indexOf(a);
    rango.set(a, i >= 0 ? i : ORDEN_ALTURA.length + rango.size);
  }
  return rango;
}

// Ordena una lista de inscripciones por altura (menor a mayor) conservando el
// orden relativo que ya traía dentro de cada altura, y renumera `orden`.
function aplicarOrden(secuencia) {
  const rango = rangosDeAltura(secuencia);
  const pos = new Map(secuencia.map((i, n) => [i.id, n]));
  secuencia.sort((a, b) =>
    rango.get(slug(a.altura || '')) - rango.get(slug(b.altura || '')) ||
    pos.get(a.id) - pos.get(b.id));
  secuencia.forEach((i, n) => { i.orden = n + 1; });
  return secuencia;
}

// Arma un estado nuevo desde el texto de un CSV. Lo usa el sembrado inicial y
// también la carga de una competencia nueva desde la mesa.
// Devuelve { state, saltadas } — las filas sin pista o sin perro no se cuelan
// mudas: se cuentan y se informan.
function sembrar(texto) {
  const rows = parseCsv(texto);
  const nombreEvento = process.env.EVENTO || 'Copa de Otoño';
  const s = {
    evento: {
      nombre: nombreEvento,
      fecha: process.env.FECHA || new Date().toISOString().slice(0, 10)
    },
    rings: [],
    pistas: [],
    inscripciones: [],
    marcas: {}
  };
  let nId = 1;
  let saltadas = 0;
  for (const r of rows) {
    // `ring` es la cancha y es opcional: en una competencia de una sola cancha
    // —lo normal— no hace falta la columna, y el ring pasa a ser el evento.
    const nombreRing = r.ring || nombreEvento;
    if (!r.pista || !r.perro) { saltadas++; continue; }
    const ringId = slug(nombreRing);
    if (!s.rings.find(x => x.id === ringId)) {
      s.rings.push({ id: ringId, nombre: nombreRing });
    }
    // Una pista es la competencia corriendo un recorrido. Ni la altura ni el
    // grado la parten, porque corren todos seguidos, mezclados: esos dos datos
    // van por perro, y se muestran.
    const nombrePista = r.pista;
    const pistaId = `${ringId}--${slug(nombrePista)}`;
    let pista = s.pistas.find(x => x.id === pistaId);
    if (!pista) {
      pista = {
        id: pistaId, ringId, nombre: nombrePista,
        orden: s.pistas.filter(m => m.ringId === ringId).length + 1,
        estado: 'pendiente', segPerro: 35
      };
      s.pistas.push(pista);
    }
    s.inscripciones.push({
      id: `i${nId++}`, pistaId,
      orden: s.inscripciones.filter(i => i.pistaId === pistaId).length + 1,
      dorsal: r.dorsal, guia: r.guia, perro: r.perro, raza: r.raza,
      altura: r.altura, categoria: r.categoria,
      estado: 'pendiente'
    });
  }
  // Cada pista se ordena por altura de menor a mayor y, dentro de cada altura,
  // respetando el orden de las filas del CSV.
  let reordenadas = 0;
  for (const pista of s.pistas) {
    const lista = s.inscripciones
      .filter(i => i.pistaId === pista.id)
      .sort((a, b) => a.orden - b.orden);
    const antes = lista.map(i => i.id).join();
    if (aplicarOrden(lista).map(i => i.id).join() !== antes) reordenadas++;
  }
  if (reordenadas) {
    console.log(`Reordené ${reordenadas} pista(s): las alturas van de menor a mayor ` +
      `(${ORDEN_ALTURA.join(' → ')}).`);
  }

  // Se corre de a una pista por vez: arranca abierta la primera de cada cancha.
  for (const ring of s.rings) {
    const primera = s.pistas.filter(m => m.ringId === ring.id).sort((a, b) => a.orden - b.orden)[0];
    if (primera) primera.estado = 'en_curso';
  }
  return { state: s, saltadas };
}

// Estado vacío: sin competencia cargada. Es preferible arrancar así que no
// arrancar — la competencia se puede subir después desde la mesa.
function estadoVacio() {
  return {
    evento: {
      nombre: process.env.EVENTO || 'Sin competencia cargada',
      fecha: process.env.FECHA || new Date().toISOString().slice(0, 10)
    },
    rings: [], pistas: [], inscripciones: [], marcas: {}
  };
}

function seedFromCsv() {
  const archivo = fs.existsSync(SEED_FILE) ? SEED_FILE : SEED_EJEMPLO;
  if (!fs.existsSync(archivo)) {
    console.warn('\n  No encontré ningún CSV para sembrar.');
    console.warn(`  Busqué en ${SEED_FILE} y en ${SEED_EJEMPLO}.`);
    console.warn('  Arranco sin competencia cargada.\n');
    return estadoVacio();
  }
  if (archivo === SEED_EJEMPLO) {
    console.log('No hay data/seed.csv: sembrando con data/seed.example.csv (datos inventados).');
    console.log('Para cargar tu evento, poné tu propio data/seed.csv y corré `npm run reset`.');
  }
  const { state: s, saltadas } = sembrar(fs.readFileSync(archivo, 'utf8'));
  if (saltadas) console.log(`Salté ${saltadas} fila(s) del CSV sin pista o sin perro.`);
  console.log(`Estado nuevo sembrado desde data/${path.basename(archivo)}`);
  return s;
}

function cargar() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      // Un JSON válido no garantiza un estado usable: si le faltan colecciones, el
      // servidor arrancaría igual y recién explotaría en el primer pedido. Se
      // aparta y se siembra de nuevo, que es lo único sensato sin un migrador.
      const completo = ['rings', 'pistas', 'inscripciones'].every(k => Array.isArray(state[k]));
      if (!completo) {
        const viejo = `${STATE_FILE}.incompatible-${Date.now()}`;
        fs.renameSync(STATE_FILE, viejo);
        console.log('data/state.json no tiene la forma que espera esta versión.');
        console.log(`Lo guardé como ${path.basename(viejo)} y siembro de nuevo desde el CSV.`);
      } else {
        if (!state.marcas) state.marcas = {};
        if (process.env.EVENTO) state.evento.nombre = process.env.EVENTO;
        if (process.env.FECHA) state.evento.fecha = process.env.FECHA;
        return;
      }
    } catch (e) {
      // Preferimos arrancar sembrando de cero antes que no arrancar, pero el
      // archivo roto se guarda: puede tener los avances del día adentro.
      const roto = `${STATE_FILE}.roto-${Date.now()}`;
      fs.renameSync(STATE_FILE, roto);
      console.error(`\n  ¡OJO! data/state.json está ilegible (${e.message}).`);
      console.error(`  Lo guardé como ${path.basename(roto)} y siembro de nuevo desde el CSV.`);
      console.error('  Si el evento estaba en curso, ese archivo es lo único que tiene los avances.\n');
    }
  }
  state = seedFromCsv();   // avisa desde qué archivo sembró
  escribir();
}

// Escritura atómica: tmp + rename. Un corte de luz a media escritura dejaba el
// JSON truncado, y con eso el servidor no volvía a levantar.
function escribir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

let guardarPendiente = null;
let esperandoDesde = 0;

// Junta cambios seguidos en una sola escritura, pero con techo: el timer se
// reinicia con cada cambio, así que una ráfaga (alguien reordenando el programa a
// repetición) podía posponer la escritura todo lo que durara la ráfaga. Con el
// tope, nunca hay más de GUARDAR_TOPE_MS de trabajo sin escribir a disco.
function guardar() {
  if (!esperandoDesde) esperandoDesde = Date.now();
  const vencido = Date.now() - esperandoDesde >= GUARDAR_TOPE_MS;
  clearTimeout(guardarPendiente);
  guardarPendiente = setTimeout(() => {
    guardarPendiente = null;
    esperandoDesde = 0;
    escribir();
  }, vencido ? 0 : GUARDAR_MS);
}

// Sin esperar nada. Para lo que no se puede perder aunque el proceso muera al
// instante: sembrar una competencia nueva deja el seed.csv ya reemplazado, así que
// un estado a medio guardar resucitaría la anterior.
function guardarAhora() {
  clearTimeout(guardarPendiente);
  guardarPendiente = null;
  esperandoDesde = 0;
  escribir();
}

// Al cerrar: lo que quedó pendiente se escribe antes de salir.
function guardarYa() {
  if (!guardarPendiente) return;
  try { guardarAhora(); } catch (e) { console.error('No pude guardar el estado:', e.message); }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { guardarYa(); process.exit(0); });
}
process.on('exit', guardarYa);

/* --------------------------------------------------------------- consultas --- */

const pistasDe = ringId => state.pistas.filter(m => m.ringId === ringId).sort((a, b) => a.orden - b.orden);
const listaDe = pistaId => state.inscripciones.filter(i => i.pistaId === pistaId).sort((a, b) => a.orden - b.orden);

// La pista a la que pertenece una inscripción, sólo si es del ring que pide.
// Sin este chequeo una mesa autenticada en un ring podía reordenar o marcar
// ausente a alguien de otro ring: los ids de inscripción son secuenciales.
function pistaDeInscripcion(ringId, insc) {
  const pista = state.pistas.find(m => m.id === insc.pistaId);
  return pista && pista.ringId === ringId ? pista : null;
}

// La pista que la vista tiene que mostrar. Si ya terminó y no hay otra abierta,
// devuelve la última cerrada en vez de null: así el orden queda en pantalla,
// todo grisado, en lugar de desaparecer y dejar la lista vacía.
function pistaActiva(ringId) {
  const ms = pistasDe(ringId);
  return ms.find(m => m.estado === 'en_curso')
    || ms.find(m => m.estado === 'pendiente')
    || [...ms].reverse().find(m => m.estado === 'cerrada')
    || null;
}

function marcarAvance(pistaId) {
  const ms = (state.marcas[pistaId] ||= []);
  ms.push(Date.now());
  if (ms.length > MARCAS_TOPE) ms.splice(0, ms.length - MARCAS_TOPE);
}

// Segundos por perro: promedio real de los últimos avances, con piso y techo.
// Devuelve `real: false` cuando todavía no hay datos suficientes y se usa el
// valor por defecto de la pista.
function ritmo(pista) {
  const porDefecto = { seg: pista?.segPerro || 35, real: false };
  if (!pista) return porDefecto;
  const ts = (state.marcas[pista.id] || []).slice(-9);
  if (ts.length < 3) return porDefecto;
  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 1000);
  const ok = gaps.filter(g => g >= 10 && g <= 240);
  if (ok.length < 2) return porDefecto;
  const avg = ok.reduce((a, b) => a + b, 0) / ok.length;
  return { seg: Math.round(Math.min(90, Math.max(15, avg))), real: true };
}

// Una pista arrancó cuando ya corrió alguien o hay alguien en pista. `estado` no
// alcanza: la primera de cada ring nace 'en_curso' sin que nadie haya largado.
const arrancó = pistaId => listaDe(pistaId).some(i => i.estado === 'corrido' || i.estado === 'en_pista');

// `pistaIdPedida` deja mirar una pista que no es la que está corriendo: el
// corredor que quiere saber cuándo le toca en el Jumping 3, o la mesa que quiere
// reordenar una pista sin abrirla (abrirla pausaría la que está en curso).
function snapshot(ringId, pistaIdPedida) {
  const ring = state.rings.find(r => r.id === ringId);
  if (!ring) return null;
  const activa = pistaActiva(ringId);
  const pedida = pistaIdPedida &&
    state.pistas.find(p => p.id === pistaIdPedida && p.ringId === ringId);
  const pista = pedida || activa;
  const r = ritmo(pista);
  return {
    ts: Date.now(),
    evento: state.evento,
    ring,
    pista: pista && {
      id: pista.id, nombre: pista.nombre, estado: pista.estado,
      arrancada: arrancó(pista.id)
    },
    // Cuál es la que está corriendo, para poder avisar "estás mirando otra".
    activa: activa && { id: activa.id, nombre: activa.nombre },
    esActiva: !!pista && !!activa && pista.id === activa.id,
    pistas: pistasDe(ringId).map(m => ({
      id: m.id, nombre: m.nombre, estado: m.estado,
      total: listaDe(m.id).length, arrancada: arrancó(m.id)
    })),
    segPerro: r.seg,
    estimadoRealista: r.real,
    lista: pista ? listaDe(pista.id) : []
  };
}

// La portada lista los rings y, dentro de cada uno, TODAS sus pistas: con 12
// pistas en un solo ring, mostrar sólo la activa escondía el programa del día.
function resumen() {
  return {
    evento: state.evento,
    rings: state.rings.map(ring => {
      const activa = pistaActiva(ring.id);
      return {
        id: ring.id, nombre: ring.nombre,
        activaId: activa ? activa.id : null,
        pistas: pistasDe(ring.id).map(p => {
          const lista = listaDe(p.id);
          const enPista = lista.find(i => i.estado === 'en_pista');
          return {
            id: p.id, nombre: p.nombre, estado: p.estado,
            esActiva: !!activa && p.id === activa.id,
            enPista: enPista
              ? { dorsal: enPista.dorsal, guia: enPista.guia, perro: enPista.perro }
              : null,
            faltan: lista.filter(i => i.estado === 'pendiente').length,
            corridos: lista.filter(i => i.estado === 'corrido').length,
            total: lista.length
          };
        })
      };
    })
  };
}

/* --------------------------------------------------------------- acciones --- */

// El deshacer es por ring y guarda sólo lo de ese ring. Cuando era una pila
// global que reemplazaba los arrays completos, la mesa del Ring 1 apretando
// Ctrl+Z revertía perros que ya habían corrido en el Ring 2.
function marcarUndo(ringId, etiqueta) {
  const pistas = pistasDe(ringId);
  const ids = new Set(pistas.map(m => m.id));
  const pila = undo.get(ringId) || [];
  pila.push({
    etiqueta,
    inscripciones: clon(state.inscripciones.filter(i => ids.has(i.pistaId))),
    pistas: clon(pistas),
    marcas: clon(Object.fromEntries(pistas.map(m => [m.id, state.marcas[m.id] || []])))
  });
  if (pila.length > 25) pila.shift();
  undo.set(ringId, pila);
}

function siguiente(ringId) {
  const pista = pistaActiva(ringId);
  if (!pista) return 'No hay ninguna pista abierta.';
  const lista = listaDe(pista.id);
  const pendientes = lista.filter(i => i.estado === 'pendiente');
  const actual = lista.find(i => i.estado === 'en_pista');
  if (!actual && pendientes.length === 0) return 'La pista ya terminó. Abrí la siguiente.';

  marcarUndo(ringId, 'siguiente');
  if (actual) actual.estado = 'corrido';
  if (pendientes.length) {
    pendientes[0].estado = 'en_pista';
    pista.estado = 'en_curso';
    marcarAvance(pista.id);
  } else {
    pista.estado = 'cerrada';
    const prox = pistasDe(ringId).find(m => m.estado === 'pendiente');
    if (prox) prox.estado = 'en_curso';
  }
  guardar();
  return null;
}

function marcarAusente(ringId, inscripcionId) {
  const insc = state.inscripciones.find(i => i.id === inscripcionId);
  if (!insc) return 'No encontré esa inscripción.';
  const pista = pistaDeInscripcion(ringId, insc);
  if (!pista) return 'Esa inscripción no es de esta competencia.';
  if (insc.estado === 'ausente') return null;

  marcarUndo(ringId, 'ausente');
  const eraActual = insc.estado === 'en_pista';
  insc.estado = 'ausente';
  if (eraActual) {
    const prox = listaDe(pista.id).find(i => i.estado === 'pendiente');
    if (prox) { prox.estado = 'en_pista'; marcarAvance(pista.id); }
    else pista.estado = 'cerrada';
  }
  guardar();
  return null;
}

// Intercambia con el pendiente de al lado, no con el vecino crudo de la lista.
// Antes, con un ausente o un corrido en el medio, el intercambio caía sobre él
// y el orden visible no cambiaba: la flecha parecía no hacer nada.
function mover(ringId, inscripcionId, delta) {
  const insc = state.inscripciones.find(i => i.id === inscripcionId);
  if (!insc) return 'No encontré esa inscripción.';
  const pista = pistaDeInscripcion(ringId, insc);
  if (!pista) return 'Esa inscripción no es de esta competencia.';
  if (insc.estado !== 'pendiente') return 'Sólo se reordena a los que todavía no corrieron.';

  const pendientes = listaDe(pista.id).filter(i => i.estado === 'pendiente');
  const otro = pendientes[pendientes.indexOf(insc) + delta];
  if (!otro) return null;   // ya está en la punta o en el fondo

  marcarUndo(ringId, 'mover');
  [insc.orden, otro.orden] = [otro.orden, insc.orden];
  guardar();
  return null;
}

// Carga el orden de salida de una pista desde un CSV: el que sale del
// cronometraje de la pista anterior, sin tener que tipear nada. Lo único que se
// mira es la columna `dorsal` y el orden de las filas; los tiempos, si vienen,
// se ignoran. Si el archivo trae `ring` y `pista`, un mismo archivo puede traer
// el orden de las cuatro y se usan sólo las filas de esta.
function cargarOrden(ringId, { pistaId, csv, invertir } = {}) {
  const pista = state.pistas.find(p => p.id === pistaId && p.ringId === ringId);
  if (!pista) return 'Esa pista no es de esta competencia.';
  if (typeof csv !== 'string' || !csv.trim()) return 'El archivo llegó vacío.';
  if (csv.length > ORDEN_MAX_CHARS) return 'El archivo es demasiado grande.';

  const lista = listaDe(pista.id);
  if (lista.some(i => i.estado === 'corrido' || i.estado === 'en_pista')) {
    return 'Esa pista ya arrancó: el orden no se cambia desde un archivo.';
  }

  let filas;
  try { filas = parseCsv(csv); } catch { return 'No pude leer el archivo como CSV.'; }
  if (!filas.length) return 'El archivo no tiene filas.';
  const tieneDorsal = 'dorsal' in filas[0];
  const tienePerro = 'perro' in filas[0];
  if (!tieneDorsal && !tienePerro) return 'El archivo necesita una columna "dorsal" o "perro".';

  const esDeEstaPista = f => {
    if (f.ring && slug(f.ring) !== ringId) return false;
    const nombre = f.pista;
    if (nombre && `${ringId}--${slug(nombre)}` !== pista.id) return false;
    return true;
  };
  // Cada fila se identifica por dorsal; si no trae, por nombre de perro. Es la
  // misma regla que usa la vista: donde no se reparten números (los G0), el
  // nombre es lo único que hay.
  let claves = filas.filter(esDeEstaPista)
    .map(f => String(f.dorsal ?? '').trim() || String(f.perro ?? '').trim())
    .filter(Boolean);
  if (!claves.length) return 'El archivo no tiene ningún perro de esta pista.';
  if (invertir) claves.reverse();

  const yaVisto = new Set();
  const repetidos = [];
  claves = claves.filter(c => {
    const k = normalizar(c);
    if (yaVisto.has(k)) { repetidos.push(c); return false; }
    yaVisto.add(k);
    return true;
  });

  // Índice de la pista: los que tienen dorsal se buscan por dorsal, los que no,
  // por nombre. Un nombre que apunte a dos inscripciones sin dorsal es ambiguo y
  // se reporta en vez de adivinar.
  const porClave = new Map();
  const ambiguas = new Set();
  for (const i of lista) {
    const k = i.dorsal ? String(i.dorsal).trim() : normalizar(i.perro);
    if (porClave.has(k)) ambiguas.add(k);
    else porClave.set(k, i);
  }

  // Los del archivo primero, en su orden; los que no figuran quedan al final
  // como estaban. Nadie se borra por no aparecer.
  const delArchivo = [];
  const ajenos = [];
  const dudosas = [];
  for (const c of claves) {
    // Se prueba primero como dorsal y después como nombre, así un dorsal que no
    // sea numérico también entra.
    const comoDorsal = c.trim();
    const k = porClave.has(comoDorsal) || ambiguas.has(comoDorsal) ? comoDorsal : normalizar(c);
    if (ambiguas.has(k)) { dudosas.push(c); continue; }
    const insc = porClave.get(k);
    if (!insc) { ajenos.push(c); continue; }
    delArchivo.push(insc);
    porClave.delete(k);
  }
  const usados = new Set(delArchivo.map(i => i.id));
  const sinArchivo = lista.filter(i => !usados.has(i.id));

  // Si no coincidió nadie, no se toca el orden: aplicar un no-op se ve igual que
  // una importación exitosa, y encima gasta un paso del deshacer.
  if (!delArchivo.length) {
    return lista.some(i => i.dorsal) && !tieneDorsal
      ? 'El archivo trae nombres pero esta pista se ordena por dorsal: le falta la columna "dorsal".'
      : 'Ningún perro del archivo coincide con los de esta pista.';
  }

  marcarUndo(ringId, 'cargar orden');
  aplicarOrden([...delArchivo, ...sinArchivo]);
  guardar();

  // El reporte importa tanto como el reordenamiento: un dorsal mal tipeado tiene
  // que cantar, no desaparecer sin que nadie se entere.
  const partes = [`${delArchivo.length} en el orden del archivo`];
  if (sinArchivo.length) partes.push(`${sinArchivo.length} no estaban en el archivo y quedaron al final`);
  if (ajenos.length) {
    partes.push(`${ajenos.length} del archivo no corren esta pista (${ajenos.slice(0, 6).join(', ')}${ajenos.length > 6 ? '…' : ''})`);
  }
  if (dudosas.length) {
    partes.push(`${dudosas.length} sin dorsal con nombre repetido en la pista, no se movieron (${dudosas.slice(0, 4).join(', ')})`);
  }
  if (repetidos.length) partes.push(`${repetidos.length} repetido(s) en el archivo, se tomó la primera aparición`);
  return {
    aviso: `${pista.nombre}: ${partes.join(' · ')}. Alturas de menor a mayor. Ctrl+Z lo revierte.`
  };
}

// Cambia el lugar de una pista en el programa: el orden en que se van corriendo.
// Sólo se mueven las que todavía no arrancaron, y sólo entre ellas: lo que ya
// corrió se queda donde está, igual que con el orden de los perros.
function moverPista(ringId, { id, delta } = {}) {
  const pista = state.pistas.find(p => p.id === id && p.ringId === ringId);
  if (!pista) return 'Esa pista no es de esta competencia.';
  if (arrancó(pista.id)) return 'Esa pista ya arrancó: su lugar en el programa no se cambia.';

  const movibles = pistasDe(ringId).filter(p => !arrancó(p.id));
  const otra = movibles[movibles.indexOf(pista) + delta];
  if (!otra) return null;   // ya está en la punta

  marcarUndo(ringId, 'mover pista');
  [pista.orden, otra.orden] = [otra.orden, pista.orden];

  // Mientras no arrancó nada, la pista abierta tiene que ser la primera del
  // programa. Si no, la mesa reordena, ve otra primera en la lista y la app sigue
  // con la vieja abierta.
  const abierta = pistasDe(ringId).find(p => p.estado === 'en_curso');
  if (abierta && !arrancó(abierta.id)) {
    const primera = pistasDe(ringId).find(p => !arrancó(p.id));
    if (primera && primera.id !== abierta.id) {
      abierta.estado = 'pendiente';
      primera.estado = 'en_curso';
    }
  }

  guardar();
  return null;
}

function abrirPista(ringId, pistaId) {
  const pista = state.pistas.find(m => m.id === pistaId && m.ringId === ringId);
  if (!pista) return 'Esa pista no es de esta competencia.';
  marcarUndo(ringId, 'abrir pista');
  for (const m of pistasDe(ringId)) {
    if (m.estado !== 'en_curso') continue;
    // Un perro en pista cuenta como pendiente: si no, la pista quedaba
    // "cerrada" con alguien todavía corriendo adentro.
    const queda = listaDe(m.id).some(i => i.estado === 'pendiente' || i.estado === 'en_pista');
    m.estado = queda ? 'pendiente' : 'cerrada';
  }
  pista.estado = 'en_curso';
  guardar();
  return null;
}

// Tira TODO y siembra de cero desde un CSV: la competencia siguiente, sin tocar
// la consola ni reiniciar el servidor. Es irreversible por diseño (para eso está
// la confirmación tipeada en la mesa), pero el estado anterior se guarda igual:
// un toque de más durante un evento en curso no puede ser el fin del día.
function nuevaCompetencia({ csv, confirmar } = {}) {
  if (confirmar !== 'BORRAR') return 'Falta la confirmación.';
  if (typeof csv !== 'string' || !csv.trim()) return 'El archivo llegó vacío.';
  if (csv.length > ORDEN_MAX_CHARS) return 'El archivo es demasiado grande.';

  let armado;
  try { armado = sembrar(csv); } catch (e) { return `No pude leer el archivo: ${e.message}`; }
  const nuevo = armado.state;
  if (!nuevo.pistas.length || !nuevo.inscripciones.length) {
    return 'Ese archivo no tiene ninguna inscripción usable: hacen falta las columnas "pista" y "perro".';
  }

  const previo = {
    pistas: state.pistas.length,
    inscripciones: state.inscripciones.length,
    corridos: state.inscripciones.filter(i => i.estado === 'corrido').length
  };

  try {
    if (fs.existsSync(STATE_FILE)) {
      fs.copyFileSync(STATE_FILE, `${STATE_FILE}.anterior-${Date.now()}`);
    }
    // El CSV nuevo pasa a ser la semilla: si mañana se borra el state.json, tiene
    // que volver esta competencia y no la anterior.
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SEED_FILE, csv);
  } catch (e) {
    return `No pude guardar el respaldo ni la semilla nueva: ${e.message}`;
  }

  state = nuevo;
  undo.clear();
  try {
    guardarAhora();
  } catch (e) {
    return `Cargué la competencia en memoria pero no pude escribir data/state.json: ${e.message}`;
  }

  const partes = [
    `${nuevo.inscripciones.length} inscripciones en ${nuevo.pistas.length} pista(s)`,
    `${nuevo.rings.length} cancha(s)`
  ];
  if (armado.saltadas) partes.push(`${armado.saltadas} fila(s) salteada(s) sin pista o sin perro`);
  console.log(`Competencia nueva cargada desde la mesa: ${partes.join(', ')}.`);
  console.log(`  (lo anterior: ${previo.inscripciones} inscripciones, ${previo.corridos} corridos, respaldado)`);

  return {
    aviso: `Competencia nueva cargada: ${partes.join(' · ')}. El estado anterior quedó respaldado en data/.`
  };
}

function deshacer(ringId) {
  const pila = undo.get(ringId) || [];
  const prev = pila.pop();
  if (!prev) return 'No hay nada para deshacer.';

  const insc = new Map(prev.inscripciones.map(i => [i.id, i]));
  state.inscripciones = state.inscripciones.map(i => insc.get(i.id) || i);
  const pistas = new Map(prev.pistas.map(m => [m.id, m]));
  state.pistas = state.pistas.map(m => pistas.get(m.id) || m);
  Object.assign(state.marcas, prev.marcas);
  guardar();
  return null;
}

/* ------------------------------------------------------------------- http --- */

cargar();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/ring/:ringId', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'ring.html')));
app.get('/mesa/:ringId', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'mesa.html')));

app.get('/api/resumen', (_req, res) => res.json(resumen()));
app.get('/api/ring/:ringId', (req, res) => {
  const snap = snapshot(req.params.ringId, req.query.pista);
  if (!snap) return res.status(404).json({ error: 'Ring inexistente' });
  res.json(snap);
});

/* ------------------------------------------------------------- PIN de mesa --- */

// Sigue siendo un PIN, no autenticación. Pero con un tope de intentos por IP
// adivinar 4 dígitos pasa de segundos a más de un día.
const intentos = new Map();   // ip -> { n, hasta }

function pinBloqueado(ip) {
  const e = intentos.get(ip);
  if (!e || e.hasta <= Date.now()) return 0;
  return Math.ceil((e.hasta - Date.now()) / 1000);
}

function pinFallado(ip) {
  const e = intentos.get(ip) || { n: 0, hasta: 0 };
  e.n++;
  if (e.n >= PIN_INTENTOS) { e.n = 0; e.hasta = Date.now() + PIN_BLOQUEO_MS; }
  intentos.set(ip, e);
  if (intentos.size > 500) {
    for (const [k, v] of intentos) if (v.hasta <= Date.now() && v.n === 0) intentos.delete(k);
  }
}

/* --------------------------------------------------------------- sockets --- */

// Cada conexión puede estar mirando una pista distinta del mismo ring, así que la
// difusión ya no es un emit único a la sala: se le manda a cada uno el snapshot de
// lo que tiene en pantalla. Los snapshots se calculan una vez por pista y se
// reparten, para no recalcular lo mismo por cada celular conectado.
const mirando = new Map();   // socket.id -> { ringId, pistaId, socket }

function difundir(ringId) {
  const cache = new Map();
  for (const v of mirando.values()) {
    if (v.ringId !== ringId) continue;
    const clave = v.pistaId || '';
    if (!cache.has(clave)) cache.set(clave, snapshot(ringId, v.pistaId));
    v.socket.emit('snapshot', cache.get(clave));
  }
  io.to('lobby').emit('resumen', resumen());
}

// "Seguís viendo lo último": el cliente mide frescura desde el último mensaje
// del servidor, y sin cambios en la pista no llegaba ninguno.
setInterval(() => {
  for (const ring of state.rings) io.to(`ring:${ring.id}`).emit('latido');
}, LATIDO_MS).unref();

io.on('connection', socket => {
  let ringId = null;
  let esMesa = false;
  const ip = socket.handshake.address;

  socket.on('lobby', () => {
    socket.join('lobby');
    socket.emit('resumen', resumen());
  });

  socket.on('disconnect', () => mirando.delete(socket.id));

  // Cambiar de pista sin cambiar de ring: mirar el orden de otra pista, o
  // reordenarla desde la mesa sin abrirla.
  socket.on('ver_pista', pistaId => {
    if (!ringId) return socket.emit('error_app', 'Primero entrá a un ring.');
    const snap = snapshot(ringId, pistaId || undefined);
    if (!snap) return;
    const v = mirando.get(socket.id);
    if (v) v.pistaId = pistaId || null;
    socket.emit('snapshot', snap);
  });

  socket.on('join', payload => {
    const id = typeof payload === 'string' ? payload : payload?.ringId;
    const pistaId = typeof payload === 'object' && payload?.pistaId ? payload.pistaId : null;
    const snap = snapshot(id, pistaId || undefined);
    if (!snap) return socket.emit('error_app', 'Ring inexistente');
    if (ringId && ringId !== id) socket.leave(`ring:${ringId}`);
    ringId = id;
    socket.join(`ring:${ringId}`);
    mirando.set(socket.id, { ringId, pistaId, socket });
    socket.emit('snapshot', snap);

    // Un PIN vacío es "todavía no lo tipeó nadie": no gasta intentos.
    const pidioMesa = typeof payload === 'object' && payload?.pin !== undefined;
    const pin = pidioMesa && payload.pin ? String(payload.pin) : null;
    if (!pin) {
      esMesa = false;
      if (pidioMesa) socket.emit('mesa_ok', false);
      return;
    }

    const espera = pinBloqueado(ip);
    if (espera) {
      esMesa = false;
      socket.emit('error_app', `Demasiados intentos. Probá de nuevo en ${espera} s.`);
      return socket.emit('mesa_ok', false);
    }
    esMesa = pin === MESA_PIN;
    if (esMesa) intentos.delete(ip);
    else pinFallado(ip);
    socket.emit('mesa_ok', esMesa);
  });

  const accion = fn => arg => {
    if (!ringId) return socket.emit('error_app', 'Primero entrá a un ring.');
    if (!esMesa) return socket.emit('error_app', 'Necesitás el PIN de mesa para cambiar el orden.');
    // Un string de vuelta es un error; un objeto con `aviso` es el reporte de una
    // acción que salió bien y tiene algo que contar.
    const r = fn(arg);
    if (typeof r === 'string') return socket.emit('error_app', r);
    difundir(ringId);
    if (r && r.aviso) socket.emit('aviso_app', r.aviso);
  };

  socket.on('siguiente', accion(() => siguiente(ringId)));
  socket.on('ausente', accion(id => marcarAusente(ringId, id)));
  socket.on('mover', accion(p => mover(ringId, p?.id, p?.delta === -1 ? -1 : 1)));
  socket.on('abrir_pista', accion(id => abrirPista(ringId, id)));
  socket.on('mover_pista', accion(p => moverPista(ringId, { id: p?.id, delta: p?.delta === -1 ? -1 : 1 })));
  socket.on('cargar_orden', accion(p => cargarOrden(ringId, p)));

  // No pasa por `accion` porque no es una acción sobre un ring: después de esto
  // los rings y las pistas son otros, así que en vez de difundir un snapshot hay
  // que hacer que todos vuelvan a cargar.
  socket.on('nueva_competencia', p => {
    if (!esMesa) return socket.emit('error_app', 'Necesitás el PIN de mesa para cargar una competencia.');
    const r = nuevaCompetencia(p);
    if (typeof r === 'string') return socket.emit('error_app', r);
    socket.emit('aviso_app', r.aviso);
    socket.broadcast.emit('recargar');
    io.to('lobby').emit('resumen', resumen());
  });
  socket.on('deshacer', accion(() => deshacer(ringId)));
});

server.listen(PORT, () => {
  console.log(`\n  RevTrack escuchando en http://localhost:${PORT}`);
  console.log(`  Rings: ${state.rings.map(r => `/ring/${r.id}`).join('  ')}`);
  console.log(`  Mesa:  ${state.rings.map(r => `/mesa/${r.id}`).join('  ')}   PIN: ${MESA_PIN}\n`);
});
