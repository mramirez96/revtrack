'use strict';
// Renderiza mesa.js en un DOM mínimo. Sin esto, un error en el render de la mesa
// deja la pantalla en blanco y ningún test del servidor se entera.
//
// La autorización ya no llega por un evento de socket: se simula con un token
// de mesa fabricado a mano (mismo formato que emite lib/auth.js, sin firma
// real — mesa.js no la verifica del lado del cliente, sólo lee el payload
// para decidir qué pantalla mostrar). El chequeo de la firma en sí está
// cubierto en test/prueba.js, contra el servidor de verdad.

const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'mesa.js'), 'utf8');

const perro = (n, dorsal, nombre, guia, altura, cat, estado) =>
  ({ id: `i${n}`, dorsal, perro: nombre, guia, raza: '', altura, categoria: cat, estado });

const snap = {
  ts: Date.now(),
  evento: { nombre: 'Winter Open', fecha: '2026-07-30' },
  ring: { id: 'ring-1', nombre: 'Ring 1' },
  pista: { id: 'p1', nombre: 'Jumping 1', estado: 'en_curso', arrancada: true },
  activa: { id: 'p1', nombre: 'Jumping 1' }, esActiva: true,
  pistas: [
    { id: 'p1', nombre: 'Jumping 1', estado: 'en_curso', total: 3, arrancada: true },
    { id: 'p2', nombre: 'Jumping 2', estado: 'pendiente', total: 3, arrancada: false },
    { id: 'p3', nombre: 'Agility 1', estado: 'pendiente', total: 2, arrancada: false }
  ],
  segPerro: 38, estimadoRealista: true,
  lista: [
    perro(1, '976', 'ROCKY', 'Gastón Cossano', 'XS', 'G1', 'corrido'),
    perro(2, '941', 'FURIA', 'Cristian Pace', 'Small', 'G2', 'en_pista'),
    perro(3, '1013', 'TRISHA', 'Micaela Ramirez', 'Intermediate', 'G2', 'pendiente')
  ]
};

const nodos = new Map();
const nodo = id => {
  if (!nodos.has(id)) {
    nodos.set(id, {
      id, textContent: '', innerHTML: '', className: '', hidden: true,
      value: '', checked: false, files: [],
      querySelectorAll: () => []
    });
  }
  return nodos.get(id);
};

// Token de mesa "válido" para ring-1: mismo formato que lib/auth.js emite
// (cuerpo base64url + firma), pero la firma no importa acá — mesa.js no la
// verifica, sólo lee `r`/`e` del payload para decidir la pantalla inicial.
const payload = Buffer.from(JSON.stringify({ r: 'ring-1', e: Date.now() + 100000 })).toString('base64url');
const tokenFalso = `${payload}.firma-no-verificada-del-lado-del-cliente`;

const ctx = {
  console,
  location: { pathname: '/mesa/ring-1' },
  localStorage: {
    getItem: k => (k === 'mesaToken' ? tokenFalso : null),
    setItem: () => {}, removeItem: () => {}
  },
  document: { getElementById: nodo, addEventListener: () => {} },
  // Sin red real: cualquier fetch que dispare la carga automática al arrancar
  // se resuelve en un no-op inofensivo. El snapshot de la prueba se inyecta
  // directo por `alRecibirSnapshot`, igual que antes se inyectaba por el
  // socket falso.
  fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  RT: { suscribir: async () => ({}) },
  confirm: () => false,
  FileReader: class { readAsText() {} },
  setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
  atob: s => Buffer.from(s, 'base64').toString('binary')
};
ctx.globalThis = ctx;

let ok = 0; const fallos = [];
const chequear = (n, cond, det) => {
  if (cond) { ok++; console.log(`  ok    ${n}`); }
  else { fallos.push(n); console.log(`  FALLA ${n}${det ? ' → ' + det : ''}`); }
};

let error = null;
try {
  vm.runInNewContext(src, vm.createContext(ctx), { filename: 'mesa.js' });
  ctx.alRecibirSnapshot(snap);   // llega el estado por Realtime
} catch (e) { error = e; }

console.log('\nRender de la mesa');
chequear('mesa.js corre y renderiza sin excepción', !error, error?.message);

const html = nodo('app').innerHTML;
chequear('el token guardado autoriza sin pedir el PIN de nuevo', !html.includes('Control de mesa'), html.slice(0, 60));
chequear('muestra el perro en pista, con el nombre primero',
  /mesa-actual-nombre">FURIA</.test(html), html.match(/mesa-actual-nombre">[^<]*/)?.[0]);
chequear('el guía y las etiquetas van de secundario',
  /mesa-actual-sub">Cristian Pace/.test(html) && /class="etiq">Small</.test(html),
  html.match(/mesa-actual-sub">.{0,80}/)?.[0]);
chequear('los próximos traen altura y grado (para acomodar los saltos)',
  /TRISHA/.test(html) && /class="etiq">Intermediate</.test(html));
chequear('lista las 3 pistas del ring', (html.match(/data-ver=/g) || []).length === 3,
  String((html.match(/data-ver=/g) || []).length));

console.log('\nCargar orden desde archivo');
chequear('aparece la sección de importar', /Cargar orden desde archivo/.test(html));
chequear('sólo ofrece las pistas que no arrancaron',
  /<option value="p2"/.test(html) && /<option value="p3"/.test(html) && !/<option value="p1"/.test(html),
  html.match(/<option[^>]*>[^<]*/g)?.join(' | '));
chequear('tiene el selector de archivo', /id="ordenArchivo"[^>]*type="file"|type="file"[^>]*id="ordenArchivo"/.test(html));
chequear('tiene la opción de invertir', /id="ordenInvertir"/.test(html));
chequear('tiene el botón de aplicar', /id="btnOrden"/.test(html));
chequear('explica que sólo necesita la columna dorsal', /columna <b>dorsal<\/b>/.test(html));

// Con todas las pistas arrancadas, la sección lo dice en vez de ofrecer un form.
const snapTodoArrancado = {
  ...snap,
  pistas: snap.pistas.map(p => ({ ...p, arrancada: true }))
};
ctx.alRecibirSnapshot(snapTodoArrancado);
const html2 = nodo('app').innerHTML;
chequear('si todas arrancaron, no ofrece importar', !/id="btnOrden"/.test(html2));
chequear('y explica por qué', /sólo se importa antes del primer perro/.test(html2));

console.log('\nToken vencido o de otro ring');
{
  // Payload con `r` de otro ring: no debería autorizar en éste.
  const payloadOtro = Buffer.from(JSON.stringify({ r: 'otro-ring', e: Date.now() + 100000 })).toString('base64url');
  // `getElementById('inPin')` tiene que devolver null hasta que el formulario
  // exista de verdad — si no, el guard de renderPin() ("no pisar lo que están
  // tipeando") lo frena antes de pintar nada, como con un stub siempre-truthy.
  const ctx2 = {
    ...ctx,
    document: {
      getElementById: id => (id === 'inPin' && !nodo('xapp').innerHTML.includes('id="inPin"') ? null : nodo('x' + id)),
      addEventListener: () => {}
    }
  };
  ctx2.localStorage = { getItem: k => (k === 'mesaToken' ? `${payloadOtro}.firma` : null), setItem: () => {}, removeItem: () => {} };
  ctx2.globalThis = ctx2;
  vm.runInNewContext(src, vm.createContext(ctx2), { filename: 'mesa.js' });
  ctx2.alRecibirSnapshot(snap);
  chequear('con token de otro ring pide el PIN, no muestra la mesa',
    nodo('xapp').innerHTML.includes('Control de mesa') && !nodo('xapp').innerHTML.includes('FURIA'),
    nodo('xapp').innerHTML.slice(0, 80));
}

console.log(`\n${'─'.repeat(60)}`);
console.log(fallos.length ? `${ok} ok, ${fallos.length} FALLAS` : `${ok} de ${ok} pruebas ok`);
process.exitCode = fallos.length ? 1 : 0;
