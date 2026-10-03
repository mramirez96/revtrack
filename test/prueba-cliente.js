'use strict';
// Verifica que el render desde caché de live.js llegue hasta frescura() sin
// tirar la excepción que antes se tragaba el catch de "caché corrupta".

const fs = require('fs');
const vm = require('vm');
// Como en el navegador: resultados.js se carga antes, en el mismo global.
const src = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'resultados.js'), 'utf8') + '\n' +
  fs.readFileSync(process.argv[2] || require('path').join(__dirname, '..', 'public', 'live.js'), 'utf8');

const guardado = {
  snap: {
    ts: Date.now() - 200000,
    evento: { nombre: 'Copa', fecha: '2026-07-30' },
    ring: { id: 'ring-1', nombre: 'Ring 1' },
    pista: { id: 'm1', nombre: 'Agility 1', estado: 'en_curso', arrancada: true },
    activa: { id: 'm1', nombre: 'Agility 1' }, esActiva: true,
    pistas: [{ id: 'm1', nombre: 'Agility 1', estado: 'en_curso', total: 4, arrancada: true }], segPerro: 35, estimadoRealista: true,
    lista: [
      { id: 'i1', dorsal: '41', guia: "O'Brien, Marta", perro: 'Nala', raza: 'Border', altura: 'Large', categoria: 'G1', estado: 'corrido' },
      { id: 'i2', dorsal: '42', guia: 'Diego Sosa', perro: 'Tango', raza: 'Kelpie', altura: 'Small', categoria: 'G2', estado: 'en_pista' },
      { id: 'i3', dorsal: '47', guia: 'Sofía Bustos', perro: 'Kira', raza: 'Border', altura: 'Intermediate', categoria: 'G3', estado: 'pendiente' },
      { id: 'i4', dorsal: '48', guia: 'Martín L.', perro: 'Toby', raza: 'Pastor', altura: 'Medium', categoria: '', estado: 'pendiente' }
    ]
  },
  recibidoEn: Date.now() - 200000   // el dato tiene 3 min y medio
};

const store = { 'snap:ring-1:activa': JSON.stringify(guardado), miDorsal: '47' };
const nodos = new Map();
const nodo = id => {
  if (!nodos.has(id)) nodos.set(id, { id, textContent: '', innerHTML: '', className: '', hidden: true });
  return nodos.get(id);
};
nodo('frescura').textContent = 'conectando';

let errorNoTragado = null;
const ctx = {
  console,
  location: { pathname: '/ring/ring-1', search: '', href: 'http://x/ring/ring-1' },
  URLSearchParams, URL, history: { replaceState: () => {} },
  navigator: {},
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: k => { delete store[k]; }
  },
  document: { getElementById: nodo, addEventListener: () => {}, hidden: false, title: '' },
  fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  RT: { suscribir: async () => ({}) },
  setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}
};
ctx.globalThis = ctx;

let ok = 0; const fallos = [];
const chequear = (n, cond, det) => {
  if (cond) { ok++; console.log(`  ok    ${n}`); } else { fallos.push(n); console.log(`  FALLA ${n}${det ? ' → ' + det : ''}`); }
};

try {
  vm.runInNewContext(src, vm.createContext(ctx), { filename: 'live.js' });
} catch (e) {
  errorNoTragado = e;
}

console.log('\nRender desde caché (sin conexión, dato de 3 min)');
chequear('live.js corre sin excepción', !errorNoTragado, errorNoTragado?.message);
chequear('pinta el nombre del ring', nodo('ringNombre').textContent === 'Ring 1', nodo('ringNombre').textContent);
chequear('pinta el perro en pista', nodo('pistaCuerpo').innerHTML.includes('Diego Sosa'));
chequear('pinta la cola', nodo('cola').innerHTML.includes('Sofía Bustos'));
chequear('marca tu dorsal en la cola', nodo('cola').innerHTML.includes('cola-item vos'));

// Lo que antes fallaba: frescura() leía `socket` antes de su inicialización.
chequear('el encabezado NO queda en "conectando"',
  nodo('frescura').textContent !== 'conectando', nodo('frescura').textContent);
chequear('dice que el dato es viejo, no "en vivo"',
  /sin señal/.test(nodo('frescura').textContent), nodo('frescura').textContent);
chequear('el pulso queda en rojo', nodo('pulso').className === 'pulso muerto', nodo('pulso').className);
chequear('escapa la comilla simple del guía',
  nodo('cola').innerHTML.includes('&#39;') || !nodo('cola').innerHTML.includes("O'Brien"));

/* ── la lista completa con sus estados ─────────────────────────────────── */
console.log('\nLista completa en la vista de ring');
const html = nodo('cola').innerHTML;
const filas = new Map();
for (const m of html.matchAll(/<li class="([^"]*)">\s*<span class="dorsal">(\d+)<\/span>/g)) {
  filas.set(m[2], m[1]);
}
const nota = d => {
  const trozo = html.split(`<span class="dorsal">${d}</span>`)[1] || '';
  return (trozo.match(/cola-eta mono">([^<]*)</) || [, ''])[1].trim();
};

chequear('se ven los 4 perros de la pista, no sólo los que faltan',
  filas.size === 4, `${filas.size} filas: ${[...filas.keys()].join(',')}`);
chequear('el que ya corrió (41) está grisado', filas.get('41')?.includes('corrido'), filas.get('41'));
chequear('el que corre (42) está marcado distinto', filas.get('42')?.includes('corriendo'), filas.get('42'));
chequear('el que corre NO está grisado', !filas.get('42')?.includes('corrido'), filas.get('42'));
chequear('los pendientes quedan como estaban',
  filas.get('47') === 'cola-item vos' && filas.get('48') === 'cola-item',
  `47="${filas.get('47')}" 48="${filas.get('48')}"`);
chequear('el orden de salida se respeta',
  [...filas.keys()].join(',') === '41,42,47,48', [...filas.keys()].join(','));
chequear('el que corrió dice "corrió"', nota('41') === 'corrió', nota('41'));
chequear('el que corre dice "en pista"', nota('42') === 'en pista', nota('42'));
chequear('el pendiente muestra hora estimada', /^\d{1,2}:\d{2}/.test(nota('47')), nota('47'));

/* ── altura y grado visibles en cada perro ─────────────────────────────── */
console.log('\nAltura y grado por perro');
const etiqDe = d => {
  const trozo = (html.split(`<span class="dorsal">${d}</span>`)[1] || '').split('</li>')[0];
  return [...trozo.matchAll(/class="etiq">([^<]*)</g)].map(m => m[1]);
};
chequear('el que ya corrió muestra altura y grado', etiqDe('41').join(' ') === 'Large G1', etiqDe('41').join(' '));
chequear('el que está corriendo muestra altura y grado', etiqDe('42').join(' ') === 'Small G2', etiqDe('42').join(' '));
chequear('el pendiente muestra altura y grado', etiqDe('47').join(' ') === 'Intermediate G3', etiqDe('47').join(' '));
chequear('sin grado en el CSV queda sólo la altura, sin recuadro vacío',
  etiqDe('48').join(' ') === 'Medium', JSON.stringify(etiqDe('48')));
chequear('también salen en el bloque "En pista"',
  /class="etiq">Small</.test(nodo('pistaCuerpo').innerHTML) && /class="etiq">G2</.test(nodo('pistaCuerpo').innerHTML),
  nodo('pistaCuerpo').innerHTML.slice(-120));
chequear('las etiquetas van con el guía, en la línea secundaria',
  /Sofía Bustos\s*<span class="etiq">/.test(html), html.match(/Sofía Bustos.{0,40}/)?.[0]);

/* ── el perro manda, el guía es secundario ─────────────────────────────── */
console.log('\nJerarquía: nombre del perro primero');
chequear('en la cola el perro va en la línea primaria',
  /<span class="cola-nombre">Kira</.test(html), html.match(/cola-nombre">[^<]*/g)?.join(' | '));
chequear('en la cola el guía va en la secundaria',
  /<span class="cola-sub">Sofía Bustos/.test(html), html.match(/cola-sub">[^<]*/g)?.join(' | '));
chequear('en "En pista" el perro va en la línea primaria',
  /<span class="pista-nombre">Tango</.test(nodo('pistaCuerpo').innerHTML),
  nodo('pistaCuerpo').innerHTML.match(/pista-nombre">[^<]*/)?.[0]);
chequear('en "En pista" el guía va en la secundaria',
  /<span class="pista-sub">Diego Sosa/.test(nodo('pistaCuerpo').innerHTML),
  nodo('pistaCuerpo').innerHTML.match(/pista-sub">[^<]*/)?.[0]);
chequear('el badge "vos" cuelga del nombre del perro, no del guía',
  /class="[^"]*\bvos\b/.test(html) && /<span class="cola-nombre">Kira</.test(html));

/* ── la pista es una sola lista ─────────────────────────────────────────── */
console.log('\nUna pista, una lista');
chequear('el encabezado ya no pega la altura a la pista',
  nodo('pistaNombre').textContent === 'Agility 1', nodo('pistaNombre').textContent);
chequear('conviven 4 alturas distintas en la misma lista',
  new Set([...html.matchAll(/class="etiq">([^<]*)</g)].map(m => m[1])
    .filter(t => !/^G\d$/.test(t))).size === 4,
  [...new Set([...html.matchAll(/class="etiq">([^<]*)</g)].map(m => m[1]))].join(','));

/* ── el broadcast trae TODAS las pistas del ring, el cliente filtra ────── */
console.log('\nFiltrado del broadcast por pista');
// El servidor manda un snapshot por cada pista del ring (lib/realtime.js);
// sin mirar ninguna en particular (pistaId=null en la URL) sólo importa el de
// la que sea la activa en este momento.
const otraPista = {
  ...guardado.snap, ts: Date.now(),
  pista: { id: 'm2', nombre: 'Otra Pista', estado: 'pendiente', arrancada: false },
  esActiva: false, lista: []
};
ctx.alRecibirSnapshot(otraPista);
chequear('un snapshot de una pista que no es la activa se ignora',
  nodo('pistaNombre').textContent === 'Agility 1', nodo('pistaNombre').textContent);

const actualizado = { ...guardado.snap, ts: Date.now(), pista: { ...guardado.snap.pista, nombre: 'Agility 1 bis' } };
ctx.alRecibirSnapshot(actualizado);
chequear('un snapshot de la pista activa sí se aplica',
  nodo('pistaNombre').textContent === 'Agility 1 bis', nodo('pistaNombre').textContent);

/* ── resultados y clasificación ────────────────────────────────────────── */
console.log('\nResultados y clasificación');
{
  // Armado por el servidor de verdad, para ver los mismos campos que llegan.
  const estado = require('../lib/estado');
  const base = guardado.snap;
  const resDe = { '41': { tiempo: 38.2, faltas: 0, rehuses: 0, eliminado: false } };
  const conRes = estado.snapshot({
    evento: base.evento, rings: [base.ring],
    pistas: [{ id: base.pista.id, ringId: base.ring.id, nombre: 'Agility 1', orden: 1, estado: 'en_curso',
      segPerro: 35, marcas: [], trs: {} }],
    inscripciones: base.lista.map(i => ({ ...i, pistaId: base.pista.id, resultado: resDe[i.dorsal] || null }))
  }, base.ring.id);
  chequear('el snapshot de prueba es de la pista activa', conRes.esActiva === true);
  ctx.alRecibirSnapshot(conRes);

  const cola = nodo('cola').innerHTML;
  const trozo41 = (cola.split('<span class="dorsal">41</span>')[1] || '').split('</li>')[0];
  chequear('el que corrió muestra su penalización y su tiempo en vez de "corrió"',
    /<b>0,00<\/b>/.test(trozo41) && /38,20 s/.test(trozo41), trozo41.slice(-160));
  chequear('aparecen las pestañas de orden y clasificación', /id="tabClasif"/.test(nodo('vistaTabs').innerHTML));
  chequear('arranca mostrando el orden de salida', nodo('cola').hidden === false && nodo('clasif').hidden === true);

  nodo('tabClasif').onclick();
  const clasif = nodo('clasif').innerHTML;
  chequear('la pestaña muestra la clasificación', nodo('clasif').hidden === false && nodo('cola').hidden === true);
  chequear('cada podio con su nombre (Large va con Intermediate)', /Intermediate\/Large G1/.test(clasif),
    clasif.match(/podio-tit">[^<]*/g)?.join(' | '));
  chequear('el podio sin resultados no aparece vacío', !/Small\/Midi G2/.test(clasif));
  chequear('sin TRS cargado se aclara', /sin TRS/.test(clasif));
  chequear('la clasificación muestra la calificación (limpio = Cero Exc, destacado)',
    /etiq calif cero">Cero Exc</.test(clasif), clasif.match(/etiq calif[^<]*/)?.[0]);
  chequear('la elección de pestaña se recuerda', store.vista === 'clasif', String(store.vista));
  nodo('tabOrden').onclick();
}

console.log(`\n${'─'.repeat(60)}`);
console.log(fallos.length ? `${ok} ok, ${fallos.length} FALLAS` : `${ok} de ${ok} pruebas ok`);
process.exitCode = fallos.length ? 1 : 0;
