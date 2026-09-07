'use strict';
// Pistas sin dorsal (los G0): el corredor se reconoce por el nombre del perro.
// La propiedad clave: un perro CON dorsal nunca se matchea por nombre, así los
// dos que se llaman igual no se confunden.

const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'live.js'), 'utf8');

const perro = (n, dorsal, nombre, guia, altura, cat, estado) =>
  ({ id: `i${n}`, dorsal, perro: nombre, guia, raza: '', altura, categoria: cat, estado });

function correr(lista, clave, ph = {}) {
  const guardado = {
    snap: {
      ts: Date.now(),
      evento: { nombre: 'Revamp Agility', fecha: '2026-07-30' },
      ring: { id: 'revamp-agility', nombre: 'Revamp Agility' },
      pista: { id: 'p1', nombre: ph.pista || 'Iniciante 1', estado: 'en_curso', arrancada: lista.some(i => i.estado === 'corrido' || i.estado === 'en_pista') },
      activa: { id: 'p1', nombre: ph.pista || 'Iniciante 1' }, esActiva: true,
      pistas: [{ id: 'p1', nombre: ph.pista || 'Iniciante 1', estado: 'en_curso', total: lista.length }],
      segPerro: 40, estimadoRealista: false,
      lista
    },
    recibidoEn: Date.now()
  };
  const store = { 'snap:revamp-agility:activa': JSON.stringify(guardado) };
  if (clave) store.miClave = clave;
  const nodos = new Map();
  const nodo = id => {
    if (!nodos.has(id)) nodos.set(id, { id, textContent: '', innerHTML: '', className: '', hidden: true, value: '' });
    return nodos.get(id);
  };
  const ctx = {
    console,
    location: { pathname: '/ring/revamp-agility', search: '', href: 'http://x/ring/revamp-agility' },
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
  let error = null;
  try { vm.runInNewContext(src, vm.createContext(ctx), { filename: 'live.js' }); }
  catch (e) { error = e; }
  return { error, nodo, cola: nodo('cola').innerHTML, turno: nodo('turnoCuerpo').innerHTML, pista: nodo('pistaCuerpo').innerHTML };
}

let ok = 0; const fallos = [];
const chequear = (n, cond, det) => {
  if (cond) { ok++; console.log(`  ok    ${n}`); }
  else { fallos.push(n); console.log(`  FALLA ${n}${det ? ' → ' + det : ''}`); }
};

// Pista G0: los 8 de Iniciante 1, sin dorsal. Uno con acento para la normalización.
const g0 = [
  perro(1, '', 'OREO', 'Marieli Sanoja', 'Small', 'G0', 'corrido'),
  perro(2, '', 'TIAGO', 'Fabiana Balsano', 'Small', 'G0', 'en_pista'),
  perro(3, '', 'ÑAÑA', 'Sofía Benitez', 'Medium', 'G0', 'pendiente'),
  perro(4, '', 'BRANCA', 'Victoria del Val', 'Large', 'G0', 'pendiente')
];

console.log('\nPista sin dorsales (G0)');
let r = correr(g0, null);
chequear('live.js corre sin excepción', !r.error, r.error?.message);
chequear('no dibuja recuadros de dorsal vacíos', !/class="dorsal/.test(r.cola), r.cola.slice(0, 120));
chequear('tampoco en el bloque "En pista"', !/class="dorsal/.test(r.pista), r.pista.slice(0, 140));
chequear('pide el nombre del perro, no el dorsal',
  /Poné el nombre de tu perro/.test(r.turno) && !/Poné tu dorsal/.test(r.turno), r.turno.slice(0, 150));
chequear('el placeholder sugiere un nombre', /placeholder="OREO"/.test(r.turno));

console.log('\nReconocerse por nombre');
r = correr(g0, 'branca');   // en minúscula, distinto de como está en el CSV
chequear('matchea sin importar mayúsculas', /cola-item vos/.test(r.cola),
  (r.cola.match(/<li class="[^"]*"/g) || []).join(' '));
chequear('cuenta los perros que faltan', /perros? antes que vos|Sos el próximo/.test(r.turno), r.turno.slice(0, 200));
r = correr(g0, 'nana');     // sin la eñe
chequear('matchea ignorando acentos y eñes', /cola-item vos/.test(r.cola),
  (r.cola.match(/<li class="[^"]*"/g) || []).join(' '));
r = correr(g0, 'TIAGO');
chequear('el que está en pista se reconoce igual', /Estás en pista/.test(r.turno), r.turno.slice(0, 140));
r = correr(g0, 'no existe este perro');
chequear('un nombre que no está lo dice', /no está en esta pista/.test(r.turno), r.turno.slice(0, 160));

console.log('\nLa propiedad importante: con dorsal NO se matchea por nombre');
// Los dos ROCKY: 976 (con dorsal) y uno de G0 sin dorsal, mismo nombre.
const mixta = [
  perro(1, '976', 'ROCKY', 'Gastón Cossano', 'XS', 'G1', 'pendiente'),
  perro(2, '928', 'ROCKY', 'Leila Amigo', 'Intermediate', 'G2', 'pendiente'),
  perro(3, '', 'ROCKY', 'Otra Persona', 'Large', 'G0', 'pendiente')
];
r = correr(mixta, 'rocky', { pista: 'Mixta' });
const marcados = (r.cola.match(/<li class="[^"]*"/g) || []).filter(c => /\bvos\b/.test(c));
chequear('escribir "rocky" marca exactamente un perro', marcados.length === 1,
  `${marcados.length} marcados: ${marcados.join(' ')}`);
// La fila marcada, aislada: tiene que ser la del perro sin número.
const filaVos = r.cola.replace(/\n\s*/g, ' ').split('<li ').find(f => /class="cola-item vos"/.test(f)) || '';
chequear('y es el que NO tiene dorsal',
  /Otra Persona/.test(filaVos) && !/class="dorsal"/.test(filaVos), filaVos.slice(0, 130));
r = correr(mixta, '976');
const porNumero = (r.cola.match(/<li class="[^"]*"/g) || []).filter(c => /\bvos\b/.test(c));
chequear('el dorsal 976 marca sólo a su perro', porNumero.length === 1, `${porNumero.length}`);
chequear('en una pista mixta el texto aclara las dos opciones',
  /Poné tu dorsal, o el nombre de tu perro/.test(correr(mixta, null, { pista: 'Mixta' }).turno));

console.log('\nCompatibilidad con lo que ya estaba guardado');
const conDorsales = [
  perro(1, '976', 'ROCKY', 'Gastón Cossano', 'XS', 'G1', 'pendiente'),
  perro(2, '1013', 'TRISHA', 'Micaela Ramirez', 'Intermediate', 'G2', 'pendiente')
];
// El celular que ya tenía `miDorsal` de antes no tiene que volver a cargarlo.
const guardado = {
  snap: {
    ts: Date.now(), evento: { nombre: 'x', fecha: '2026-07-30' },
    ring: { id: 'revamp-agility', nombre: 'R' },
    pista: { id: 'p1', nombre: 'Agility 1', estado: 'en_curso', arrancada: true },
    activa: { id: 'p1', nombre: 'Agility 1' }, esActiva: true,
    pistas: [{ id: 'p1', nombre: 'Agility 1', estado: 'en_curso', total: 2 }],
    segPerro: 40, estimadoRealista: false, lista: conDorsales
  },
  recibidoEn: Date.now()
};
const store = { 'snap:revamp-agility:activa': JSON.stringify(guardado), miDorsal: '1013' };
const nodos = new Map();
const nodo = id => {
  if (!nodos.has(id)) nodos.set(id, { id, textContent: '', innerHTML: '', className: '', hidden: true, value: '' });
  return nodos.get(id);
};
const ctx = {
  console, location: { pathname: '/ring/revamp-agility', search: '', href: 'http://x/ring/revamp-agility' },
    URLSearchParams, URL, history: { replaceState: () => {} }, navigator: {},
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } },
  document: { getElementById: nodo, addEventListener: () => {}, hidden: false, title: '' },
  fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  RT: { suscribir: async () => ({}) },
  setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}
};
ctx.globalThis = ctx;
try { vm.runInNewContext(src, vm.createContext(ctx), { filename: 'live.js' }); } catch (e) { /* */ }
chequear('el dorsal viejo del localStorage sigue valiendo',
  /cola-item vos/.test(nodo('cola').innerHTML), nodo('cola').innerHTML.slice(0, 100));

console.log(`\n${'─'.repeat(60)}`);
console.log(fallos.length ? `${ok} ok, ${fallos.length} FALLAS` : `${ok} de ${ok} pruebas ok`);
process.exitCode = fallos.length ? 1 : 0;
