// Corre las dos suites y devuelve un exit code distinto de 0 si alguna falla.
// `npm test`.
//
//   test/prueba.js           integración: levanta el servidor real contra un
//                            esquema de Postgres descartable y ejercita cada
//                            acción y cada guarda
//   web/src/**/*.test.jsx    interfaz: la vista del corredor y la mesa en React,
//                            con Vitest + Testing Library sobre jsdom (sin
//                            navegador)

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const raiz = path.join(import.meta.dirname, '..');
const SUITES = [
  ['integración', [path.join(import.meta.dirname, 'prueba.js')]],
  ['interfaz (React)', [path.join(raiz, 'node_modules', 'vitest', 'vitest.mjs'), 'run']]
];

const resultados = [];
for (const [nombre, args] of SUITES) {
  console.log(`\n${'═'.repeat(64)}\n  ${nombre}\n${'═'.repeat(64)}`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: raiz });
  resultados.push({ nombre, ok: r.status === 0 });
}

console.log(`\n${'═'.repeat(64)}`);
for (const r of resultados) console.log(`  ${r.ok ? 'ok   ' : 'FALLA'}  ${r.nombre}`);
const fallaron = resultados.filter(r => !r.ok);
console.log(fallaron.length
  ? `\n${fallaron.length} de ${resultados.length} suites con fallas.`
  : `\nLas ${resultados.length} suites pasaron.`);
process.exit(fallaron.length ? 1 : 0);
