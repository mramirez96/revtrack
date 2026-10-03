import { vi } from 'vitest';
// Los snapshots de prueba los arma el servidor de verdad (lib/estado.js), así
// las pantallas ven exactamente los campos que llegan por Realtime: res,
// puesto, podio, clasificacion, trs.
import * as estado from '../../../lib/estado.js';

export const perro = (n, dorsal, nombre, guia, altura, categoria, est, resultado = null, pistaId = 'p1') =>
  ({ id: `i${n}`, pistaId, orden: n, dorsal, guia, perro: nombre, raza: '', altura, categoria, estado: est, resultado });

// pistas: [{ id, nombre, estado, trs }] — la primera es la que se pide.
export function armarSnapshot(inscripciones, { pistas, pistaId, trs = {} } = {}) {
  const ps = (pistas || [{ id: 'p1', nombre: 'Jumping 1', estado: 'en_curso', trs }])
    .map((p, n) => ({ ringId: 'ring-1', orden: n + 1, segPerro: 38, marcas: [], trs: {}, ...p }));
  return estado.snapshot({
    evento: { nombre: 'Winter Open', fecha: '2026-07-30' },
    rings: [{ id: 'ring-1', nombre: 'Ring 1' }],
    pistas: ps,
    inscripciones
  }, 'ring-1', pistaId);
}

// useCanal falso: guarda los handlers por tema para poder "mandar" un
// broadcast desde la prueba, y dice si el canal está conectado.
export function canalFalso(conectado = true) {
  const handlers = {};
  return {
    handlers,
    useCanal: vi.fn((topic, eventos) => { handlers[topic] = eventos; return conectado; }),
    emitir: (topic, evento, payload) => handlers[topic]?.[evento]?.(payload)
  };
}

// fetch falso: `rutas` es una función (url, opciones) → { status, json }.
export function fetchFalso(rutas) {
  return vi.fn(async (url, op) => {
    const r = await rutas(String(url), op);
    if (!r) throw new Error('sin red');
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json ?? {} };
  });
}

// Token de mesa con el formato de lib/auth.js; la firma no importa del lado
// del cliente (no se verifica ahí).
export const tokenDe = ringId =>
  `${btoa(JSON.stringify({ r: ringId, e: Date.now() + 100000 })).replace(/=+$/, '')}.firma`;
