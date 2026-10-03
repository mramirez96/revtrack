// Funciones puras, sin estado ni I/O: se llevan de server.js sin cambios.
// Es la parte más probada y menos riesgosa de portar tal cual.

// Tope del CSV de orden/competencia que se manda por HTTP. Un orden de 4
// pistas no llega ni a 50 KB; esto es para que nadie mande un archivo enorme.
const ORDEN_MAX_CHARS = 500_000;

// Cuántos avances guardamos por pista para calcular el ritmo. Se leen los
// últimos 9; el resto es peso muerto.
const MARCAS_TOPE = 20;

function slug(s) {
  return s.toLowerCase().normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const clon = v => JSON.parse(JSON.stringify(v));

// Para comparar nombres de perro escritos a mano o exportados de otro sistema:
// sin mayúsculas, sin acentos, sin espacios de sobra. Igual que en la vista.
const normalizar = s => String(s ?? '').trim().toLowerCase()
  .normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '');

// CSV con comillas: hace falta para nombres como "Ruiz, Marta" o razas con
// coma. Respeta comas y saltos de línea entre comillas, y "" como comilla.
function parseCsv(text) {
  const filas = [];
  let fila = [], celda = '', enComillas = false;
  const limpio = text.replace(new RegExp('^\\uFEFF'), '').replace(/\r\n?/g, '\n');

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
// desordenado, se acomoda igual.
const ORDEN_ALTURA = ['xs', 'small', 'medium', 'intermediate', 'large'];

// Cómo las llaman en las planillas del club: Mini es Small, Midi es Medium, y
// en G0 Intermediate y Large pueden venir juntas en un mismo bloque.
const ALIAS_ALTURA = {
  mini: 'small', midi: 'medium',
  'intermediate-large': 'intermediate', 'small-midi': 'small', 'small-medium': 'small'
};

// Rango de cada altura. Las que no están en la lista estándar van después, en el
// orden en que aparecen: no inventamos una jerarquía que no conocemos, pero
// tampoco las perdemos. Sirve igual para filas del CSV que para inscripciones:
// sólo mira `.altura`.
function rangosDeAltura(filas) {
  const rango = new Map();
  for (const r of filas) {
    const a = slug(r.altura || '');
    if (rango.has(a)) continue;
    const i = ORDEN_ALTURA.indexOf(ALIAS_ALTURA[a] || a);
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
function sembrar(texto, { nombreEvento = 'Copa de Otoño', fecha } = {}) {
  const rows = parseCsv(texto);
  const s = {
    evento: {
      nombre: nombreEvento,
      fecha: fecha || new Date().toISOString().slice(0, 10)
    },
    rings: [],
    pistas: [],
    inscripciones: []
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
        estado: 'pendiente', segPerro: 35, marcas: []
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
  for (const pista of s.pistas) {
    const lista = s.inscripciones
      .filter(i => i.pistaId === pista.id)
      .sort((a, b) => a.orden - b.orden);
    aplicarOrden(lista);
  }

  // Se corre de a una pista por vez: arranca abierta la primera de cada cancha.
  for (const ring of s.rings) {
    const primera = s.pistas.filter(m => m.ringId === ring.id).sort((a, b) => a.orden - b.orden)[0];
    if (primera) primera.estado = 'en_curso';
  }
  return { state: s, saltadas };
}

// Estado vacío: sin competencia cargada.
function estadoVacio({ nombreEvento = 'Sin competencia cargada', fecha } = {}) {
  return {
    evento: { nombre: nombreEvento, fecha: fecha || new Date().toISOString().slice(0, 10) },
    rings: [], pistas: [], inscripciones: []
  };
}

export {
  ORDEN_MAX_CHARS, MARCAS_TOPE, ORDEN_ALTURA,
  slug, clon, normalizar, parseCsv, rangosDeAltura, aplicarOrden,
  sembrar, estadoVacio
};
