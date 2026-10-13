import * as R from '../../../shared/resultados.mjs';
import { trsTexto } from '../componentes/Clasificacion.jsx';
import { fmtLibre } from './formato.js';

// Las planillas de resultados, como las del Nacional 2026: una hoja por podio
// (grado × grupo de altura), con la grilla de siempre — señas, faltas por 5,
// tiempo, m/s, faltas de tiempo, total, calificación y puntos. Se arman desde
// el snapshot, que ya trae todo calculado por el servidor; acá sólo se le da
// la forma de la planilla. El PDF se dibuja en el navegador (descargarPdf).

// En la planilla los grupos de altura van con el nombre del reglamento.
const GRUPO_PLANILLA = { 'small-midi': 'SMALL/MEDIUM', 'intermediate-large': 'INTERMEDIATE/LARGE' };
const nombreGrupo = (id, nombre) => GRUPO_PLANILLA[id] || String(nombre || '').toUpperCase();

// "2026-10-10" → "10/10/2026".
export const fechaPlanilla = f => (/^\d{4}-\d{2}-\d{2}$/.test(f || '') ? f.split('-').reverse().join('/') : f || '');

const sinDato = '-';
const quien = f => [f.dorsal, f.perro, f.guia].filter(Boolean).join(' ');

// La columna SEÑAS: lo que anotó el juez. La app guarda cuántas faltas y
// negativas hubo, no en qué orden, así que van agrupadas: "FFN". Sin ninguna,
// "CERO" (aunque se haya pasado del TRS: eso va en faltas de tiempo).
export function senas(res) {
  if (res.eliminado) return 'DESC';
  if (!res.faltas && !res.rehuses) return 'CERO';
  return 'F'.repeat(res.faltas) + 'N'.repeat(res.rehuses);
}

// El título de cada hoja: "G2 - AGILITY 1 - SMALL/MEDIUM".
const tituloHoja = (p, nombrePista) =>
  [p.categoria, nombrePista, nombreGrupo(p.grupo, p.nombre)].filter(Boolean).join(' - ').toUpperCase();

// Las hojas de una pista. Cada una: { titulo, subtitulo, datos: [[rótulo,
// valor]…], medidas, nota, columnas, filas, provisoria }. Los ausentes van al
// final de su podio, para que la planilla cuente a todos los inscriptos.
export function hojasPista(snap) {
  const ev = snap.evento || {};
  const opciones = { separarG3: !!ev.separarG3 };
  const ausentes = new Map();
  for (const i of snap.lista || []) {
    if (i.estado !== 'ausente') continue;
    const id = R.podioDe(i, opciones).id;
    ausentes.set(id, [...(ausentes.get(id) || []), i]);
  }

  return (snap.clasificacion || []).filter(p => p.filas.length || ausentes.has(p.id)).map(p => {
    const r = p.regla || {};
    const conPuntos = p.filas.some(f => f.puntos !== undefined);
    const filas = p.filas.map(f => {
      const c = f.res;
      const fila = c.eliminado
        ? [sinDato, quien(f), 'DESC', sinDato, sinDato, sinDato, sinDato, sinDato, sinDato, 'No clasifica']
        : [f.puesto, quien(f), senas(c), c.faltas + c.rehuses, c.recorrido,
          c.tiempo !== null ? R.fmt(c.tiempo) : sinDato,
          c.tiempo !== null && R.velocidad(r.largo, c.tiempo) ? R.fmt(R.velocidad(r.largo, c.tiempo)) : sinDato,
          R.fmt(c.exceso), R.fmt(c.total), c.calif];
      return conPuntos ? [...fila, f.puntos ?? 0] : fila;
    });
    for (const i of ausentes.get(p.id) || []) {
      const fila = [sinDato, quien(i), 'AUS', sinDato, sinDato, sinDato, sinDato, sinDato, sinDato, 'Ausente'];
      filas.push(conPuntos ? [...fila, 0] : fila);
    }
    return {
      titulo: tituloHoja(p, snap.pista?.nombre),
      subtitulo: ev.nombre || '',
      datos: [['Juez', snap.pista?.juez || ''], ['Fecha', fechaPlanilla(ev.fecha)], ['ORG', ev.organizador || '']],
      medidas: [
        ['Largo', r.largo ? `${fmtLibre(r.largo)} m` : sinDato],
        ['Velocidad', r.velocidad ? `${fmtLibre(r.velocidad)} m/s` : sinDato],
        ['TRS', r.trs ? `${R.fmt(r.trs)} s` : sinDato]
      ],
      nota: r.trs ? trsTexto(r) : 'Sin TRS: no se sumaron faltas de tiempo.',
      columnas: ['POSICIÓN', 'N° - PERRO - GUÍA', 'SEÑAS', 'TOTAL', 'X 5', 'TIEMPO', 'm/s',
        'FALTAS TIEMPO', 'TOTAL FALTAS', 'CALIFICACIÓN', ...(conPuntos ? ['PTOS'] : [])],
      filas,
      provisoria: p.faltan
    };
  });
}

// Una parte del combinado: tiempo y faltas, o "DESC" si quedó descalificado
// (o ausente) en esa pista.
const parte = q => (q.desc ? [sinDato, 'DESC'] : [R.fmt(q.tiempo), R.fmt(q.faltas)]);

// Las hojas del combinado de la pista, si es parte de uno: tiempos y faltas
// de las dos pistas y la suma, como "COMBINADO NACIONAL - GRADO 2".
export function hojasCombinado(snap) {
  const cb = snap.combinado;
  if (!cb) return [];
  const ev = snap.evento || {};
  const [p1, p2] = cb.pistas;
  const jueces = [...new Set(cb.pistas.map(p => p.juez).filter(Boolean))].join(' / ');
  return (cb.clasificacion || []).filter(p => p.filas.length).map(p => {
    const conPuntos = p.filas.some(f => f.puntos !== undefined);
    return {
      titulo: ['COMBINADO', p.categoria, nombreGrupo(p.grupo, p.nombre)].filter(Boolean).join(' - ').toUpperCase(),
      subtitulo: ev.nombre || '',
      datos: [['Juez', jueces], ['Fecha', fechaPlanilla(ev.fecha)], ['ORG', ev.organizador || '']],
      medidas: [['P1', p1.nombre], ['P2', p2.nombre]],
      nota: 'Perros descalificados o no clasificados en alguna pista no se premian en el Combinado.',
      columnas: ['POSICIÓN', 'N° - PERRO - GUÍA', 'TIEMPO P1', 'FALTAS P1', 'TIEMPO P2', 'FALTAS P2',
        'TOTAL TIEMPO', 'TOTAL FALTAS', 'CALIFICACIÓN', ...(conPuntos ? ['PTOS'] : [])],
      filas: p.filas.map(f => {
        const fila = [f.puesto ?? sinDato, quien(f), ...parte(f.partes[0]), ...parte(f.partes[1]),
          R.fmt(f.tiempo), f.desc ? 'DESC' : R.fmt(f.faltas), f.calif];
        return conPuntos ? [...fila, f.puntos ?? 0] : fila;
      }),
      provisoria: p.faltan
    };
  });
}

// Un nombre de archivo que ningún sistema rechace: "Planilla Agility 1.pdf".
export const nombreArchivo = s => `${String(s).replace(/[\\/:*?"<>|]+/g, '-').trim()}.pdf`;

// Dibuja las hojas en un PDF apaisado: una por página; si un podio no entra,
// sigue en la siguiente con el encabezado de la grilla repetido. jsPDF se
// carga recién acá: pesa, y sólo lo usa la mesa al final.
export async function armarPdf(hojas) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const ancho = doc.internal.pageSize.getWidth();
  const alto = doc.internal.pageSize.getHeight();
  const m = 12;

  hojas.forEach((h, n) => {
    if (n) doc.addPage();
    doc.setFont('helvetica', 'bold').setFontSize(15).text(h.titulo, m, m + 5);
    doc.setFontSize(10);
    // Largo, velocidad y TRS (o las pistas del combinado), a la derecha.
    doc.text(h.medidas.map(([k, v]) => `${k}: ${v}`).join('     '), ancho - m, m + 5, { align: 'right' });

    let y = m + 13;
    for (const [k, v] of h.datos) {
      doc.setFont('helvetica', 'bold').text(`${k}:`, m, y);
      doc.setFont('helvetica', 'normal').text(v || '', m + 16, y);
      y += 5.5;
    }
    if (h.subtitulo) doc.setFont('helvetica', 'bold').setFontSize(12).text(h.subtitulo.toUpperCase(), ancho / 2, m + 18.5, { align: 'center' });
    doc.setFont('helvetica', 'italic').setFontSize(8.5).text(h.nota, m, y + 1);
    if (h.provisoria) {
      doc.setFont('helvetica', 'bold').text(
        `PROVISORIA: ${h.provisoria} ${h.provisoria === 1 ? 'perro' : 'perros'} sin resultado`, ancho - m, y + 1, { align: 'right' });
    }

    autoTable(doc, {
      startY: y + 4,
      head: [h.columnas],
      body: h.filas,
      theme: 'grid',
      margin: { left: m, right: m, bottom: 14 },
      styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 1.4, halign: 'center', lineColor: 60, lineWidth: 0.2, textColor: 20 },
      headStyles: { fillColor: 225, textColor: 20, fontStyle: 'bold', fontSize: 8 },
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 18 }, 1: { halign: 'left', fontStyle: 'bold', cellWidth: 68 } }
    });
  });

  // Pie en todas las páginas: de dónde salió y cuántas son.
  const total = doc.getNumberOfPages();
  const hecho = new Date().toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(110);
    doc.text(`RevTrack · generada el ${hecho}`, m, alto - 7);
    doc.text(`${i} / ${total}`, ancho - m, alto - 7, { align: 'right' });
    doc.setTextColor(0);
  }
  return doc;
}

export async function descargarPdf(hojas, archivo) {
  (await armarPdf(hojas)).save(archivo);
}
