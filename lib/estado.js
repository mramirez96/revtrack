// Las mismas consultas y acciones de server.js, portadas para tomar `state`
// como parámetro explícito en vez de cerrar sobre una variable de módulo — en
// serverless no hay un proceso persistente que la sostenga entre llamadas.
// `state` se carga entero desde Postgres al principio de cada acción
// (lib/db.js:cargarEstado) y se vuelve a escribir entero al final
// (lib/db.js:guardarEstado), dentro de una misma transacción con lock global:
// exactamente la misma serialización que hoy da un único proceso Node, sólo
// que explícita en vez de implícita en el event loop.
//
// `marcas` (los timestamps de avance) vive en `pista.marcas`, no en una
// colección aparte — ver supabase/migrations/0001_init.sql.

import {
  clon, normalizar, parseCsv, aplicarOrden, slug, sembrar, MARCAS_TOPE, ORDEN_MAX_CHARS
} from './dominio.js';
// Las reglas de puntaje viven en shared/ porque la mesa también las usa para
// mostrar la penalización mientras se tipea — ver el comentario de ese archivo.
import * as Resultados from '../shared/resultados.mjs';

const pistasDe = (state, ringId) =>
  state.pistas.filter(m => m.ringId === ringId).sort((a, b) => a.orden - b.orden);
const listaDe = (state, pistaId) =>
  state.inscripciones.filter(i => i.pistaId === pistaId).sort((a, b) => a.orden - b.orden);

// La pista a la que pertenece una inscripción, sólo si es del ring que pide.
// Sin este chequeo una mesa autenticada en un ring podía reordenar o marcar
// ausente a alguien de otro ring: los ids de inscripción son secuenciales.
function pistaDeInscripcion(state, ringId, insc) {
  const pista = state.pistas.find(m => m.id === insc.pistaId);
  return pista && pista.ringId === ringId ? pista : null;
}

// La pista que la vista tiene que mostrar. Si ya terminó y no hay otra abierta,
// devuelve la última cerrada en vez de null: así el orden queda en pantalla,
// todo grisado, en lugar de desaparecer y dejar la lista vacía.
function pistaActiva(state, ringId) {
  const ms = pistasDe(state, ringId);
  return ms.find(m => m.estado === 'en_curso')
    || ms.find(m => m.estado === 'pendiente')
    || [...ms].reverse().find(m => m.estado === 'cerrada')
    || null;
}

function marcarAvance(state, pistaId) {
  const pista = state.pistas.find(p => p.id === pistaId);
  const ms = pista.marcas || (pista.marcas = []);
  ms.push(Date.now());
  if (ms.length > MARCAS_TOPE) ms.splice(0, ms.length - MARCAS_TOPE);
}

// Segundos por perro: promedio real de los últimos avances, con piso y techo.
// Devuelve `real: false` cuando todavía no hay datos suficientes y se usa el
// valor por defecto de la pista.
function ritmo(pista) {
  const porDefecto = { seg: pista?.segPerro || 35, real: false };
  if (!pista) return porDefecto;
  const ts = (pista.marcas || []).slice(-9);
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
const arrancó = (state, pistaId) =>
  listaDe(state, pistaId).some(i => i.estado === 'corrido' || i.estado === 'en_pista');

// `pistaIdPedida` deja mirar una pista que no es la que está corriendo: el
// corredor que quiere saber cuándo le toca en el Jumping 3, o la mesa que quiere
// reordenar una pista sin abrirla (abrirla pausaría la que está en curso).
function snapshot(state, ringId, pistaIdPedida) {
  const ring = state.rings.find(r => r.id === ringId);
  if (!ring) return null;
  const activa = pistaActiva(state, ringId);
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
      arrancada: arrancó(state, pista.id)
    },
    // Cuál es la que está corriendo, para poder avisar "estás mirando otra".
    activa: activa && { id: activa.id, nombre: activa.nombre },
    esActiva: !!pista && !!activa && pista.id === activa.id,
    pistas: pistasDe(state, ringId).map(m => ({
      id: m.id, nombre: m.nombre, estado: m.estado,
      total: listaDe(state, m.id).length, arrancada: arrancó(state, m.id)
    })),
    segPerro: r.seg,
    estimadoRealista: r.real,
    ...conResultados(pista, pista ? listaDe(state, pista.id) : [])
  };
}

// La lista de la pista con el resultado calculado de cada perro (`res`) y su
// puesto en el podio, más la clasificación entera. Se calcula acá, en el
// servidor, y viaja hecha: el celular del corredor no hace cuentas.
function conResultados(pista, lista) {
  const trs = (pista && pista.trs) || {};
  const clasificacion = Resultados.clasificar(lista, trs);
  const puestos = new Map();
  for (const p of clasificacion) {
    for (const f of p.filas) puestos.set(f.id, { puesto: f.puesto, podio: p.nombre, res: f.res });
  }
  return {
    trs,
    clasificacion,
    lista: lista.map(i => {
      const pu = puestos.get(i.id);
      return pu ? { ...i, res: pu.res, puesto: pu.puesto, podio: pu.podio } : i;
    })
  };
}

// La portada lista los rings y, dentro de cada uno, TODAS sus pistas: con 12
// pistas en un solo ring, mostrar sólo la activa escondía el programa del día.
function resumen(state) {
  return {
    evento: state.evento,
    rings: state.rings.map(ring => {
      const activa = pistaActiva(state, ring.id);
      return {
        id: ring.id, nombre: ring.nombre,
        activaId: activa ? activa.id : null,
        pistas: pistasDe(state, ring.id).map(p => {
          const lista = listaDe(state, p.id);
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

// El deshacer es por ring y guarda sólo lo de ese ring. `undoPila` es el array
// ya cargado de ese ring (lib/db.js:cargarUndo) — se muta acá y el caller lo
// vuelve a escribir entero al final de la transacción.
function marcarUndo(state, undoPila, ringId, etiqueta) {
  const pistas = pistasDe(state, ringId);
  const ids = new Set(pistas.map(m => m.id));
  undoPila.push({
    etiqueta,
    inscripciones: clon(state.inscripciones.filter(i => ids.has(i.pistaId))),
    pistas: clon(pistas)
  });
  if (undoPila.length > 25) undoPila.shift();
}

// El avance de "Siguiente" en dos tiempos: primero se valida (devuelve un
// string de error o lo que hace falta para avanzar), y recién después de
// marcar el deshacer se aplica. Así cargarResultado puede avanzar en el mismo
// paso de deshacer que el resultado.
function prepararAvance(state, ringId) {
  const pista = pistaActiva(state, ringId);
  if (!pista) return 'No hay ninguna pista abierta.';
  const lista = listaDe(state, pista.id);
  const pendientes = lista.filter(i => i.estado === 'pendiente');
  const actual = lista.find(i => i.estado === 'en_pista');
  if (!actual && pendientes.length === 0) return 'La pista ya terminó. Abrí la siguiente.';
  return { pista, pendientes, actual };
}

function siguiente(state, undoPila, ringId) {
  const avance = prepararAvance(state, ringId);
  if (typeof avance === 'string') return avance;
  marcarUndo(state, undoPila, ringId, 'siguiente');
  aplicarAvance(state, ringId, avance);
  return null;
}

function aplicarAvance(state, ringId, { pista, pendientes, actual }) {
  if (actual) actual.estado = 'corrido';
  if (pendientes.length) {
    pendientes[0].estado = 'en_pista';
    pista.estado = 'en_curso';
    marcarAvance(state, pista.id);
  } else {
    pista.estado = 'cerrada';
    const prox = pistasDe(state, ringId).find(m => m.estado === 'pendiente');
    if (prox) prox.estado = 'en_curso';
  }
}

function marcarAusente(state, undoPila, ringId, inscripcionId) {
  const insc = state.inscripciones.find(i => i.id === inscripcionId);
  if (!insc) return 'No encontré esa inscripción.';
  const pista = pistaDeInscripcion(state, ringId, insc);
  if (!pista) return 'Esa inscripción no es de esta competencia.';
  if (insc.estado === 'ausente') return null;

  marcarUndo(state, undoPila, ringId, 'ausente');
  const eraActual = insc.estado === 'en_pista';
  insc.estado = 'ausente';
  if (eraActual) {
    const prox = listaDe(state, pista.id).find(i => i.estado === 'pendiente');
    if (prox) { prox.estado = 'en_pista'; marcarAvance(state, pista.id); }
    else pista.estado = 'cerrada';
  }
  return null;
}

// Intercambia con el pendiente de al lado, no con el vecino crudo de la lista.
// Antes, con un ausente o un corrido en el medio, el intercambio caía sobre él
// y el orden visible no cambiaba: la flecha parecía no hacer nada.
function mover(state, undoPila, ringId, inscripcionId, delta) {
  const insc = state.inscripciones.find(i => i.id === inscripcionId);
  if (!insc) return 'No encontré esa inscripción.';
  const pista = pistaDeInscripcion(state, ringId, insc);
  if (!pista) return 'Esa inscripción no es de esta competencia.';
  if (insc.estado !== 'pendiente') return 'Sólo se reordena a los que todavía no corrieron.';

  const pendientes = listaDe(state, pista.id).filter(i => i.estado === 'pendiente');
  const otro = pendientes[pendientes.indexOf(insc) + delta];
  if (!otro) return null;   // ya está en la punta o en el fondo

  marcarUndo(state, undoPila, ringId, 'mover');
  [insc.orden, otro.orden] = [otro.orden, insc.orden];
  return null;
}

// Carga el orden de salida de una pista desde un CSV: el que sale del
// cronometraje de la pista anterior, sin tener que tipear nada. Lo único que se
// mira es la columna `dorsal` y el orden de las filas; los tiempos, si vienen,
// se ignoran. Si el archivo trae `ring` y `pista`, un mismo archivo puede traer
// el orden de las cuatro y se usan sólo las filas de esta.
function cargarOrden(state, undoPila, ringId, { pistaId, csv, invertir } = {}) {
  const pista = state.pistas.find(p => p.id === pistaId && p.ringId === ringId);
  if (!pista) return 'Esa pista no es de esta competencia.';
  if (typeof csv !== 'string' || !csv.trim()) return 'El archivo llegó vacío.';
  if (csv.length > ORDEN_MAX_CHARS) return 'El archivo es demasiado grande.';

  const lista = listaDe(state, pista.id);
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

  marcarUndo(state, undoPila, ringId, 'cargar orden');
  aplicarOrden([...delArchivo, ...sinArchivo]);

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
function moverPista(state, undoPila, ringId, { id, delta } = {}) {
  const pista = state.pistas.find(p => p.id === id && p.ringId === ringId);
  if (!pista) return 'Esa pista no es de esta competencia.';
  if (arrancó(state, pista.id)) return 'Esa pista ya arrancó: su lugar en el programa no se cambia.';

  const movibles = pistasDe(state, ringId).filter(p => !arrancó(state, p.id));
  const otra = movibles[movibles.indexOf(pista) + delta];
  if (!otra) return null;   // ya está en la punta

  marcarUndo(state, undoPila, ringId, 'mover pista');
  [pista.orden, otra.orden] = [otra.orden, pista.orden];

  // Mientras no arrancó nada, la pista abierta tiene que ser la primera del
  // programa. Si no, la mesa reordena, ve otra primera en la lista y la app sigue
  // con la vieja abierta.
  const abierta = pistasDe(state, ringId).find(p => p.estado === 'en_curso');
  if (abierta && !arrancó(state, abierta.id)) {
    const primera = pistasDe(state, ringId).find(p => !arrancó(state, p.id));
    if (primera && primera.id !== abierta.id) {
      abierta.estado = 'pendiente';
      primera.estado = 'en_curso';
    }
  }
  return null;
}

function abrirPista(state, undoPila, ringId, pistaId) {
  const pista = state.pistas.find(m => m.id === pistaId && m.ringId === ringId);
  if (!pista) return 'Esa pista no es de esta competencia.';
  marcarUndo(state, undoPila, ringId, 'abrir pista');
  for (const m of pistasDe(state, ringId)) {
    if (m.estado !== 'en_curso') continue;
    // Un perro en pista cuenta como pendiente: si no, la pista quedaba
    // "cerrada" con alguien todavía corriendo adentro.
    const queda = listaDe(state, m.id).some(i => i.estado === 'pendiente' || i.estado === 'en_pista');
    m.estado = queda ? 'pendiente' : 'cerrada';
  }
  pista.estado = 'en_curso';
  return null;
}

function deshacer(state, undoPila) {
  const prev = undoPila.pop();
  if (!prev) return 'No hay nada para deshacer.';

  const insc = new Map(prev.inscripciones.map(i => [i.id, i]));
  state.inscripciones = state.inscripciones.map(i => insc.get(i.id) || i);
  const pistas = new Map(prev.pistas.map(m => [m.id, m]));
  state.pistas = state.pistas.map(m => pistas.get(m.id) || m);
  return null;
}

const vacio = v => v === null || v === undefined || v === '';

// El resultado de un perro: lo que tipea la mesa, crudo. La penalización no
// se guarda — se calcula al leer, así un TRS corregido después recalcula a
// todos sin tener que volver a cargar nada.
// `borrar: true` lo saca (un resultado cargado al perro equivocado).
// `avanzar: true` además avanza el orden si el perro es el que está en pista
// de la pista que corre: cargar el tiempo del que acaba de terminar y largar
// al próximo es un solo gesto en la mesa. Va en el mismo paso de deshacer.
function cargarResultado(state, undoPila, ringId, { id, tiempo, faltas, rehuses, eliminado, borrar, avanzar } = {}) {
  const insc = state.inscripciones.find(i => i.id === id);
  if (!insc) return 'No encontré esa inscripción.';
  if (!pistaDeInscripcion(state, ringId, insc)) return 'Esa inscripción no es de esta competencia.';

  if (borrar) {
    if (!insc.resultado) return null;
    marcarUndo(state, undoPila, ringId, 'borrar resultado');
    insc.resultado = null;
    return null;
  }

  if (insc.estado !== 'corrido' && insc.estado !== 'en_pista') {
    return insc.estado === 'ausente'
      ? 'Ese perro figura como ausente: no tiene resultado.'
      : 'Ese perro todavía no corrió.';
  }

  // Un eliminado puede no tener tiempo (se retiró, lo pararon): ahí es opcional.
  const elim = eliminado === true;
  const t = vacio(tiempo) ? null : Resultados.leerNumero(tiempo);
  if (!vacio(tiempo) && t === null) return 'El tiempo no es un número.';
  if (t === null && !elim) return 'Falta el tiempo.';
  if (t !== null && (t <= 0 || t >= 1000)) return 'El tiempo tiene que estar entre 0 y 999,99 segundos.';
  const entero = v => {
    const n = vacio(v) ? 0 : Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 50 ? n : null;
  };
  const f = entero(faltas);
  if (f === null) return 'Las faltas tienen que ser un número entero entre 0 y 50.';
  const r = entero(rehuses);
  if (r === null) return 'Las negativas tienen que ser un número entero entre 0 y 50.';

  // Sólo avanza si es el que está en pista de la que corre: corregir a uno
  // que ya corrió, o a uno de una pista en pausa, no larga a nadie.
  const activa = pistaActiva(state, ringId);
  const avance = avanzar === true && insc.estado === 'en_pista' && activa && activa.id === insc.pistaId
    ? prepararAvance(state, ringId) : null;

  marcarUndo(state, undoPila, ringId, avance && typeof avance !== 'string' ? 'resultado y siguiente' : 'resultado');
  insc.resultado = {
    tiempo: t === null ? null : Math.round(t * 100) / 100,
    faltas: f, rehuses: r, eliminado: elim
  };
  if (avance && typeof avance !== 'string') aplicarAvance(state, ringId, avance);
  return null;
}

// TRS de una pista: uno solo, el mismo para todos los que la corren (en un
// open con G1 y G2 juntos, también). Se carga como en la planilla —largo y
// velocidad, y el TRS sale de dividir— o, si ya lo traen calculado, directo.
// Todo vacío = sacarlo: sin TRS no se suman faltas de tiempo, sólo las de
// recorrido.
function fijarTrs(state, undoPila, ringId, { pistaId, largo, velocidad, trs } = {}) {
  const pista = state.pistas.find(p => p.id === pistaId && p.ringId === ringId);
  if (!pista) return 'Esa pista no es de esta competencia.';

  const leer = (v, max) => {
    if (vacio(v)) return null;
    const n = Resultados.leerNumero(v);
    return n > 0 && n < max ? n : NaN;
  };
  const vLargo = leer(largo, 10000);
  const vVel = leer(velocidad, 100);
  const vTrs = leer(trs, 1000);
  if (Number.isNaN(vLargo)) return 'El largo no es un número de metros válido.';
  if (Number.isNaN(vVel)) return 'La velocidad no es un número de m/s válido.';
  if (Number.isNaN(vTrs)) return 'El TRS no es un número de segundos válido.';
  if ((vLargo === null) !== (vVel === null)) {
    return vLargo === null ? 'Con la velocidad hace falta el largo.' : 'Con el largo hace falta la velocidad.';
  }

  let regla = null;
  if (vLargo !== null) regla = { largo: vLargo, velocidad: vVel, trs: Resultados.trsDe(vLargo, vVel) };
  else if (vTrs !== null) regla = { trs: vTrs };

  marcarUndo(state, undoPila, ringId, 'trs');
  pista.trs = regla || {};
  return null;
}

// Tira TODO y siembra de cero desde un CSV: la competencia siguiente, sin
// tocar nada a mano. A diferencia de las otras acciones, no muta `state` in
// place — devuelve un plan (estado viejo y nuevo, aviso, a qué ring ir) para
// que el caller (lib/db.js) haga el respaldo y reemplace las tablas enteras
// dentro de la misma transacción. Es irreversible por diseño (para eso está
// la confirmación tipeada en la mesa), pero el estado anterior se respalda
// igual: un toque de más durante un evento en curso no puede ser el fin del día.
// `nombre` y `fecha` (AAAA-MM-DD) son opcionales: sin nombre, el evento
// toma el de la cancha del archivo (ver dominio.sembrar).
function nuevaCompetencia(state, { csv, confirmar, nombre, fecha } = {}) {
  if (confirmar !== 'BORRAR') return 'Falta la confirmación.';
  if (typeof csv !== 'string' || !csv.trim()) return 'El archivo llegó vacío.';
  if (csv.length > ORDEN_MAX_CHARS) return 'El archivo es demasiado grande.';

  const f = String(fecha ?? '').trim();
  if (f && !/^\d{4}-\d{2}-\d{2}$/.test(f)) return 'La fecha no es válida (tiene que ser AAAA-MM-DD).';
  let armado;
  try {
    armado = sembrar(csv, {
      nombreEvento: String(nombre ?? '').trim().slice(0, 120) || process.env.EVENTO,
      fecha: f || process.env.FECHA
    });
  } catch (e) { return `No pude leer el archivo: ${e.message}`; }
  const nuevo = armado.state;
  if (!nuevo.pistas.length || !nuevo.inscripciones.length) {
    return 'Ese archivo no tiene ninguna inscripción usable: hacen falta las columnas "pista" y "perro".';
  }

  const previo = {
    pistas: state.pistas.length,
    inscripciones: state.inscripciones.length,
    corridos: state.inscripciones.filter(i => i.estado === 'corrido').length
  };

  const partes = [
    `${nuevo.inscripciones.length} inscripciones en ${nuevo.pistas.length} pista(s)`,
    `${nuevo.rings.length} cancha(s)`
  ];
  if (armado.saltadas) partes.push(`${armado.saltadas} fila(s) salteada(s) sin pista o sin perro`);

  return {
    estadoAnterior: state,
    estadoNuevo: nuevo,
    previo,
    csv,
    // A dónde tiene que ir la mesa: su URL vieja apunta a un ring que puede no
    // existir más, y ahí la pantalla queda en "Ring inexistente".
    ringId: nuevo.rings[0]?.id || null,
    aviso: `Competencia nueva cargada: ${partes.join(' · ')}.`
  };
}

export {
  pistasDe, listaDe, pistaDeInscripcion, pistaActiva, arrancó, ritmo,
  snapshot, resumen,
  siguiente, marcarAusente, mover, cargarOrden, moverPista, abrirPista, deshacer,
  cargarResultado, fijarTrs, nuevaCompetencia
};
