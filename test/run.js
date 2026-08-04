'use strict';
// Corre las cinco suites y devuelve un exit code distinto de 0 si alguna falla.
// `npm test`.
//
//   prueba.js                    integración: levanta el servidor real en un
//                                sandbox y ejercita cada acción y cada guarda
//   prueba-cliente.js            render de la vista de corredor
//   prueba-cliente-terminada.js  ídem, con una pista ya terminada
//   prueba-cliente-g0.js         ídem, en pistas sin dorsal (G0)
//   prueba-mesa.js               render de la mesa
//
// Las de cliente ejecutan live.js / mesa.js dentro de un `node:vm` con un DOM
// mínimo: no hace falta navegador ni headless.

const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  ['integración', 'prueba.js'],
  ['vista de corredor', 'prueba-cliente.js'],
  ['pista terminada', 'prueba-cliente-terminada.js'],
  ['pistas sin dorsal', 'prueba-cliente-g0.js'],
  ['mesa', 'prueba-mesa.js']
];

const resultados = [];
for (const [nombre, archivo] of SUITES) {
  console.log(`\n${'═'.repeat(64)}\n  ${nombre}  (test/${archivo})\n${'═'.repeat(64)}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, archivo)], { stdio: 'inherit' });
  resultados.push({ nombre, ok: r.status === 0 });
}

console.log(`\n${'═'.repeat(64)}`);
for (const r of resultados) console.log(`  ${r.ok ? 'ok   ' : 'FALLA'}  ${r.nombre}`);
const fallaron = resultados.filter(r => !r.ok);
console.log(fallaron.length
  ? `\n${fallaron.length} de ${resultados.length} suites con fallas.`
  : `\nLas ${resultados.length} suites pasaron.`);
process.exit(fallaron.length ? 1 : 0);
