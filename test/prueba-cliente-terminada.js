'use strict';
// Renderiza live.js con una pista YA TERMINADA: nadie tiene que desaparecer,
// todos grisados. Mismo arnés que prueba-cliente.js, otro escenario.

const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'live.js'), 'utf8');

const perro = (n, dorsal, nombre, guia, altura, cat, estado) =>
  ({ id: `i${n}`, dorsal, perro: nombre, guia, raza: '', altura, categoria: cat, estado });

// Pista cerrada: 4 corridos y 1 ausente. Ninguna otra pista pendiente en el ring.
const guardado = {
  snap: {
    ts: Date.now(),
    evento: { nombre: 'Winter Open', fecha: '2026-07-30' },
    ring: { id: 'ring-1', nombre: 'Ring 1' },
    pista: { id: 'p1', nombre: 'Jumping 1', estado: 'cerrada', arrancada: true },
    activa: { id: 'p1', nombre: 'Jumping 1' }, esActiva: true,
    pistas: [{ id: 'p1', nombre: 'Jumping 1', estado: 'cerrada', total: 5 }],
    segPerro: 40, estimadoRealista: true,
    lista: [
      perro(1, '976', 'ROCKY', 'Gastón Cossano', 'XS', 'G1', 'corrido'),
      perro(2, '941', 'FURIA', 'Cristian Pace', 'Small', 'G2', 'corrido'),
      perro(3, '1004', 'LOLA', 'Mariela Ramirez', 'Small', 'G1', 'ausente'),
      perro(4, '994', 'RUNA', 'Karina Mauriño', 'Medium', 'G2', 'corrido'),
      perro(5, '1013', 'TRISHA', 'Micaela Ramirez', 'Intermediate', 'G2', 'corrido')
    ]
  },
  recibidoEn: Date.now()
};

const store = { 'snap:ring-1:activa': JSON.stringify(guardado), miDorsal: '1013' };
const nodos = new Map();
const nodo = id => {
  if (!nodos.has(id)) nodos.set(id, { id, textContent: '', innerHTML: '', className: '', hidden: true });
  return nodos.get(id);
};

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
  if (cond) { ok++; console.log(`  ok    ${n}`); }
  else { fallos.push(n); console.log(`  FALLA ${n}${det ? ' → ' + det : ''}`); }
};

let error = null;
try { vm.runInNewContext(src, vm.createContext(ctx), { filename: 'live.js' }); }
catch (e) { error = e; }

console.log('\nPista terminada: nadie desaparece');
chequear('live.js corre sin excepción', !error, error?.message);

const html = nodo('cola').innerHTML;
const filas = new Map();
for (const m of html.matchAll(/<li class="([^"]*)">\s*<span class="dorsal">(\d+)<\/span>/g)) filas.set(m[2], m[1]);

chequear('siguen los 5 corredores en pantalla', filas.size === 5,
  `${filas.size} filas: ${[...filas.keys()].join(',')}`);
chequear('los 4 que corrieron están grisados',
  ['976', '941', '994', '1013'].every(d => filas.get(d)?.includes('corrido')),
  JSON.stringify([...filas]));
chequear('el ausente se distingue del que corrió',
  filas.get('1004')?.includes('ausente') && !filas.get('1004')?.includes('corrido'), filas.get('1004'));
chequear('nadie queda marcado como en pista', ![...filas.values()].some(c => c.includes('corriendo')));
chequear('el orden de salida se mantiene',
  [...filas.keys()].join(',') === '976,941,1004,994,1013', [...filas.keys()].join(','));
chequear('tu dorsal sigue resaltado aunque ya hayas corrido',
  filas.get('1013')?.includes('vos'), filas.get('1013'));

chequear('el encabezado nombra la pista, no "sin pista abierta"',
  nodo('pistaNombre').textContent === 'Jumping 1', nodo('pistaNombre').textContent);
chequear('el bloque de arriba dice "Pista terminada"',
  nodo('pistaCuerpo').innerHTML.includes('Pista terminada'), nodo('pistaCuerpo').innerHTML.slice(0, 120));
chequear('sin otra pista pendiente, no promete una siguiente',
  nodo('pistaCuerpo').innerHTML.includes('No queda nada más por correr'),
  nodo('pistaCuerpo').innerHTML.slice(-140));
chequear('"Tu turno" dice que ya corriste esta pista',
  nodo('turnoCuerpo').innerHTML.includes('Ya corriste esta pista'),
  nodo('turnoCuerpo').innerHTML.slice(0, 160));

console.log(`\n${'─'.repeat(60)}`);
console.log(fallos.length ? `${ok} ok, ${fallos.length} FALLAS` : `${ok} de ${ok} pruebas ok`);
process.exitCode = fallos.length ? 1 : 0;
