// Reglas de puntaje y armado de la clasificación. Un solo módulo para los dos
// lados: el servidor (lib/estado.js) calcula lo que se difunde, y la mesa
// (web/) lo importa para mostrar la penalización mientras se tipea, antes de
// guardar.
//
// Reglas, verificadas contra la planilla de resultados del club (las fórmulas
// de "PLANILLA PARA RTDOS G2 COMBINADO" y los PDF de los Regionales CEACAN):
//   - 5 puntos por falta y 5 por negativa (rehúse; en el código, `rehuses`).
//   - 1 punto por segundo (con centésimas) por encima del TRS, sumado al
//     total: por eso pasarse del TRS también saca el "cero".
//   - TRS = largo ÷ velocidad, uno por pista: el mismo número para todos los
//     que la corren, aunque sea un open con G1 y G2 mezclados.
//   - La tercera negativa elimina. No hay TMR (tiempo máximo): el club no lo usa,
//     por más que se pase del TRS el perro no queda eliminado, sólo suma.
//   - Se clasifica por menor penalización total y, a igualdad, menor tiempo.
//   - Calificación por total: Cero Exc / Exc / MB / B / No clasifica.
//   - Los podios juntan alturas: XS/Small/Midi corren por uno, Intermediate/
//     Large por otro, y cada uno se abre por grado (G0 incluido).

export const PEN_FALTA = 5;
export const PEN_REHUSE = 5;
export const REHUSES_ELIMINAN = 3;

// Grupo de podio de cada altura. Incluye cómo las llaman en las planillas del
// club: "Mini" es Small, y en G0 "Intermediate/Large" puede venir como un
// solo bloque.
export const GRUPOS = [
  { id: 'small-midi', nombre: 'Small/Midi',
    alturas: ['xs', 'x-small', 'toy', 'small', 's', 'mini', 'medium', 'midi', 'm', 'small-midi', 'small-medium'] },
  { id: 'intermediate-large', nombre: 'Intermediate/Large',
    alturas: ['intermediate', 'inter', 'i', 'large', 'l', 'intermediate-large'] }
];

const clave = s => String(s ?? '').trim().toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Una altura que no está en la lista no se mete a la fuerza en un grupo:
// queda en el suyo propio, con su nombre, para no inventar un podio.
export function grupoDeAltura(altura) {
  const a = clave(altura);
  const g = GRUPOS.find(x => x.alturas.includes(a));
  if (g) return { id: g.id, nombre: g.nombre };
  return a ? { id: a, nombre: String(altura).trim() } : { id: 'sin-altura', nombre: 'Sin altura' };
}

const rangoGrupo = id => {
  const i = GRUPOS.findIndex(g => g.id === id);
  return i >= 0 ? i : GRUPOS.length;
};

// Sin redondear a centésimas: la planilla del club compara el valor exacto
// (un TRS de 191 m ÷ 4,5 m/s es 42,444…), y redondear antes podía cambiar
// una calificación justo en el borde. Sólo se limpia el ruido de punto
// flotante (41,48 − 39 = 2,4799999…); las centésimas son cosa de mostrar.
const limpio = n => Math.round(n * 1e6) / 1e6;

// Calificación, con los mismos cortes que la planilla (columna K):
// 0 → Cero Exc; hasta 5,99 → Exc; hasta 15,99 → MB; hasta 25,99 → B.
export function calificacion(total) {
  if (total === 0) return 'Cero Exc';
  if (total <= 5.99) return 'Exc';
  if (total <= 15.99) return 'MB';
  if (total <= 25.99) return 'B';
  return 'No clasifica';
}

// Lo que tipea la mesa, crudo, más la regla del podio ({ trs }, puede
// faltar) → la penalización calculada.
export function calcular(res, regla) {
  if (!res) return null;
  const faltas = res.faltas || 0;
  const rehuses = res.rehuses || 0;
  const tiempo = typeof res.tiempo === 'number' ? res.tiempo : null;
  const trs = regla && regla.trs > 0 ? regla.trs : null;

  const motivo = res.eliminado ? 'eliminado'
    : rehuses >= REHUSES_ELIMINAN ? `${REHUSES_ELIMINAN} negativas`
    : null;
  if (motivo) return { eliminado: true, motivo, tiempo, faltas, rehuses, calif: 'No clasifica' };

  const recorrido = PEN_FALTA * faltas + PEN_REHUSE * rehuses;
  const exceso = trs && tiempo !== null ? limpio(Math.max(0, tiempo - trs)) : 0;
  const total = limpio(recorrido + exceso);
  return {
    eliminado: false, tiempo, faltas, rehuses,
    recorrido, exceso, total, calif: calificacion(total),
    sinTrs: !trs
  };
}

const grados = (a, b) => String(a || '').localeCompare(String(b || ''), 'es', { numeric: true });

// El podio de una inscripción: grupo de altura × grado.
export function podioDe(i) {
  const g = grupoDeAltura(i.altura);
  const cat = String(i.categoria || '').trim();
  return {
    id: `${g.id}--${clave(cat) || 'sin-grado'}`,
    grupo: g.id,
    categoria: cat,
    nombre: [g.nombre, cat].filter(Boolean).join(' ')
  };
}

const ordenPodios = (a, b) => rangoGrupo(a.grupo) - rangoGrupo(b.grupo) ||
  a.grupo.localeCompare(b.grupo) || grados(a.categoria, b.categoria);

// TRS = largo ÷ velocidad, como en la planilla (191 m ÷ 4,5 m/s = 42,44 s).
export function trsDe(largo, velocidad) {
  return largo > 0 && velocidad > 0 ? limpio(largo / velocidad) : null;
}

// Clasificación de una pista. `lista` son las inscripciones (con `resultado`
// crudo), `regla` el TRS de la pista ({ trs, largo?, velocidad? }, o nada).
// Devuelve un bloque por podio, en orden de alturas y de grados,
// con los clasificados primero y los eliminados al final. Los que todavía
// no tienen resultado no entran, pero se cuentan: una clasificación con
// perros por correr es provisoria y hay que decirlo.
export function clasificar(lista, regla) {
  const podios = new Map();
  for (const i of lista) {
    const pd = podioDe(i);
    if (!podios.has(pd.id)) {
      podios.set(pd.id, { ...pd, filas: [], eliminados: [], faltan: 0 });
    }
    const p = podios.get(pd.id);
    if (i.estado === 'ausente') continue;
    const calc = (i.estado === 'corrido' || i.estado === 'en_pista') && i.resultado
      ? calcular(i.resultado, regla) : null;
    if (!calc) { p.faltan++; continue; }
    const fila = { id: i.id, dorsal: i.dorsal, perro: i.perro, guia: i.guia, altura: i.altura, res: calc };
    (calc.eliminado ? p.eliminados : p.filas).push(fila);
  }

  const bloques = [...podios.values()];
  for (const p of bloques) {
    p.filas.sort((a, b) => a.res.total - b.res.total || (a.res.tiempo ?? Infinity) - (b.res.tiempo ?? Infinity));
    // Empate exacto (misma penalización y mismo tiempo) comparte puesto:
    // 1, 1, 3 — como en cualquier tabla deportiva.
    p.filas.forEach((f, n) => {
      const prev = p.filas[n - 1];
      f.puesto = prev && prev.res.total === f.res.total && prev.res.tiempo === f.res.tiempo
        ? prev.puesto : n + 1;
    });
    p.clasificados = p.filas.length;
    p.filas = p.filas.concat(p.eliminados.map(f => ({ ...f, puesto: null })));
    delete p.eliminados;
  }
  return bloques.filter(p => p.filas.length || p.faltan).sort(ordenPodios);
}

// "38,52" → 38.52. Acepta coma o punto, porque en un teclado de celular
// argentino la coma es lo que está a mano. null si no es un número.
export function leerNumero(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').trim().replace(',', '.');
  if (!s || !/^\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

export const fmt = n => (n ?? 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Velocidad del recorrido (m/s), como la columna de la planilla: largo ÷
// tiempo. null si la pista no tiene el largo cargado o no hay tiempo.
export function velocidad(largo, tiempo) {
  return largo > 0 && tiempo > 0 ? largo / tiempo : null;
}

// Cómo se muestra un resultado, en dos partes con el mismo peso: la
// penalización ("F: 5,00", o "DESC" si quedó descalificado) y el recorrido
// ("38,52 s | 4,96 m/s"; la velocidad sólo si la pista tiene largo).
export function lineasResultado(calc, regla) {
  if (!calc) return null;
  const vel = calc.tiempo !== null ? velocidad(regla?.largo, calc.tiempo) : null;
  return {
    faltas: calc.eliminado ? 'DESC' : `F: ${fmt(calc.total)}`,
    recorrido: [calc.tiempo !== null ? `${fmt(calc.tiempo)} s` : '', vel ? `${fmt(vel)} m/s` : '']
      .filter(Boolean).join(' | ')
  };
}

// Una línea corta para mostrar al lado de un perro.
export function resumenCorto(calc) {
  if (!calc) return '';
  const t = calc.tiempo !== null ? ` · ${fmt(calc.tiempo)} s` : '';
  if (calc.eliminado) return `DESC${t}`;
  return `F: ${fmt(calc.total)}${t} · ${calc.calif}`;
}

// El desglose de dónde salió la penalización: "1 falta · 1 negativa · 2,48 de tiempo".
export function desglose(calc) {
  if (!calc) return '';
  if (calc.eliminado) return calc.motivo === 'eliminado' ? 'Descalificado' : `Descalificado (${calc.motivo})`;
  const partes = [];
  if (calc.faltas) partes.push(`${calc.faltas} ${calc.faltas === 1 ? 'falta' : 'faltas'}`);
  if (calc.rehuses) partes.push(`${calc.rehuses} ${calc.rehuses === 1 ? 'negativa' : 'negativas'}`);
  if (calc.exceso) partes.push(`${fmt(calc.exceso)} de tiempo`);
  return partes.length ? partes.join(' · ') : 'Limpio';
}
