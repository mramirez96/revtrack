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
//   - Los podios juntan alturas: XS/Mini/Midi corren por uno, Intermediate/
//     Large por otro, y cada uno se abre por grado (Iniciantes incluido).
//     G2 y G3 van juntos, "G2/G3", salvo que la mesa los separe (Art. 34).

export const PEN_FALTA = 5;
export const PEN_REHUSE = 5;
export const REHUSES_ELIMINAN = 3;

// Grupo de podio de cada altura. El reglamento dice Small/Medium; acá se le
// dice Mini/Midi, y así se muestra. Incluye cómo las llaman en las planillas
// del club: "Mini" es Small, y en Iniciantes "Intermediate/Large" puede venir
// como un solo bloque. El id queda 'small-midi' porque es la clave del TRS
// guardado en cada pista.
export const GRUPOS = [
  { id: 'small-midi', nombre: 'Mini/Midi',
    alturas: ['xs', 'x-small', 'toy', 'small', 's', 'mini', 'medium', 'midi', 'm',
      'small-midi', 'small-medium', 'mini-midi'] },
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

// Los grados del reglamento, en orden. Desde la v1.1 del Reglamento Nacional
// (2026) el G0 se llama Iniciantes: se acepta cualquiera de los dos nombres y
// se muestra el nuevo. G2/G3 es el bloque unificado (Art. 34), que también
// puede venir así en el CSV.
const GRADOS = [
  { id: 'iniciantes', nombre: 'Iniciantes',
    alias: ['iniciantes', 'iniciante', 'ini', 'g0', 'grado-0', 'gr0', '0'] },
  { id: 'g1', nombre: 'G1', alias: ['g1', 'grado-1', 'gr1', '1'] },
  { id: 'g2', nombre: 'G2', alias: ['g2', 'grado-2', 'gr2', '2'] },
  { id: 'g2-g3', nombre: 'G2/G3', alias: ['g2-g3', 'g2-3', 'grado-2-3'] },
  { id: 'g3', nombre: 'G3', alias: ['g3', 'grado-3', 'gr3', '3'] }
];
const G2G3 = GRADOS.findIndex(g => g.id === 'g2-g3');

// El grado de una inscripción: { id, nombre, rango }. Uno que no está en la
// lista (un "Open") queda con su nombre, después de los conocidos.
export function gradoDe(categoria) {
  const c = clave(categoria);
  const i = GRADOS.findIndex(g => g.alias.includes(c));
  if (i >= 0) return { id: GRADOS[i].id, nombre: GRADOS[i].nombre, rango: i };
  return c ? { id: c, nombre: String(categoria).trim(), rango: GRADOS.length }
    : { id: 'sin-grado', nombre: '', rango: GRADOS.length + 1 };
}

// El grado con el que se arma el podio: el del perro, salvo G2 y G3, que
// comparten "G2/G3" mientras la mesa no los separe. Sin `separarG3` van
// juntos, que es lo que el reglamento manda mientras no haya suficientes G3.
export function gradoDePodio(categoria, { separarG3 = false } = {}) {
  const gr = gradoDe(categoria);
  if (separarG3 || (gr.id !== 'g2' && gr.id !== 'g3')) return gr;
  return { id: 'g2-g3', nombre: 'G2/G3', rango: G2G3 };
}

// El podio de una inscripción: grupo de altura × grado. `opciones` son las
// del evento ({ separarG3 }).
export function podioDe(i, opciones) {
  const g = grupoDeAltura(i.altura);
  const gr = gradoDePodio(i.categoria, opciones);
  return {
    id: `${g.id}--${gr.id}`,
    grupo: g.id,
    categoria: gr.nombre,
    rangoGrado: gr.rango,
    nombre: [g.nombre, gr.nombre].filter(Boolean).join(' ')
  };
}

// El TRS de una pista se guarda de dos maneras: uno para todos
// ({ trs, largo?, velocidad? }, como era antes) o uno por grupo de altura,
// con el largo compartido porque el recorrido es el mismo
// ({ largo?, grupos: { 'small-midi': { trs, velocidad? }, … } }).
// Esto devuelve la regla que le toca a un grupo: { trs?, largo?, velocidad? } o null.
export function reglaDeGrupo(trsPista, grupoId) {
  if (!trsPista) return null;
  if (!trsPista.grupos) return trsPista.trs || trsPista.largo ? trsPista : null;
  const g = trsPista.grupos[grupoId];
  return g || trsPista.largo ? { largo: trsPista.largo, ...g } : null;
}

export const reglaDe = (trsPista, altura) => reglaDeGrupo(trsPista, grupoDeAltura(altura).id);

const ordenPodios = (a, b) => rangoGrupo(a.grupo) - rangoGrupo(b.grupo) ||
  a.grupo.localeCompare(b.grupo) || a.rangoGrado - b.rangoGrado ||
  a.categoria.localeCompare(b.categoria, 'es', { numeric: true });

// TRS = largo ÷ velocidad, como en la planilla (191 m ÷ 4,5 m/s = 42,44 s).
export function trsDe(largo, velocidad) {
  return largo > 0 && velocidad > 0 ? limpio(largo / velocidad) : null;
}

// Clasificación de una pista. `lista` son las inscripciones (con `resultado`
// crudo), `trsPista` el TRS de la pista tal como se guarda (ver reglaDeGrupo),
// `opciones` las del evento ({ separarG3 }, ver gradoDePodio).
// Cada podio lleva su `regla`: los podios ya van por grupo de altura.
// Devuelve un bloque por podio, en orden de alturas y de grados,
// con los clasificados primero y los eliminados al final. Los que todavía
// no tienen resultado no entran, pero se cuentan: una clasificación con
// perros por correr es provisoria y hay que decirlo.
export function clasificar(lista, trsPista, opciones) {
  const podios = new Map();
  for (const i of lista) {
    const pd = podioDe(i, opciones);
    if (!podios.has(pd.id)) {
      podios.set(pd.id, { ...pd, regla: reglaDeGrupo(trsPista, pd.grupo), filas: [], eliminados: [], faltan: 0 });
    }
    const p = podios.get(pd.id);
    if (i.estado === 'ausente') continue;
    const calc = (i.estado === 'corrido' || i.estado === 'en_pista') && i.resultado
      ? calcular(i.resultado, p.regla) : null;
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
