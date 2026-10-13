import { describe, expect, it } from 'vitest';
import { armarSnapshot, perro } from '../prueba/ayuda.js';
import { armarPdf, fechaPlanilla, hojasCombinado, hojasPista, nombreArchivo, senas } from './planilla.js';

// Una pista de G2 Small/Medium en fecha de ranking, con los mismos números que
// una hoja del Nacional 2026 (220 m a 3,60 m/s; el más rápido limpio en
// 48,74 s da TRS 57,51), y un G1 Large aparte.
const lista = [
  perro(1, '201', 'ALFA', 'Guía Uno', 'Small', 'G2', 'corrido', { tiempo: 48.74, faltas: 0, rehuses: 0 }),
  perro(2, '202', 'BETA', 'Guía Dos', 'Medium', 'G2', 'corrido', { tiempo: 53, faltas: 1, rehuses: 1 }),
  perro(3, '203', 'GAMA', 'Guía Tres', 'Small', 'G2', 'corrido', { tiempo: 75, faltas: 0, rehuses: 0 }),
  perro(4, '204', 'DELTA', 'Guía Cuatro', 'Small', 'G2', 'corrido', { tiempo: null, faltas: 0, rehuses: 0, eliminado: true }),
  perro(5, '205', 'EPSILON', 'Guía Cinco', 'Medium', 'G2', 'ausente'),
  perro(6, '301', 'ZETA', 'Guía Seis', 'Large', 'G1', 'corrido', { tiempo: 40, faltas: 0, rehuses: 0 }),
  perro(7, '302', 'ETA', 'Guía Siete', 'Large', 'G1', 'pendiente')
];
const snapPista = () => armarSnapshot(lista, {
  pistas: [{ id: 'p1', nombre: 'Agility 1', estado: 'en_curso', juez: 'Juez Ejemplo',
    trs: { largo: 220, grupos: { 'small-midi': { velocidad: 3.6, trs: 61.11 } } } }],
  evento: { nombre: 'Nacional Ejemplo', fecha: '2026-10-10', organizador: 'Club Ejemplo', ranking: true }
});

describe('planilla de una pista', () => {
  it('una hoja por podio, con el título y el encabezado de la planilla', () => {
    const hojas = hojasPista(snapPista());
    expect(hojas.map(h => h.titulo)).toEqual(['G2/G3 - AGILITY 1 - SMALL/MEDIUM', 'G1 - AGILITY 1 - INTERMEDIATE/LARGE']);
    const [g2] = hojas;
    expect(g2.subtitulo).toBe('Nacional Ejemplo');
    expect(g2.datos).toEqual([['Juez', 'Juez Ejemplo'], ['Fecha', '10/10/2026'], ['ORG', 'Club Ejemplo']]);
    expect(g2.medidas).toEqual([['Largo', '220 m'], ['Velocidad', '3,6 m/s'], ['TRS', '57,51 s']]);
    expect(g2.nota).toMatch(/más rápido 48,74 s \+ 18%/);
  });

  it('la grilla: señas, faltas por 5, m/s, faltas de tiempo, calificación y puntos', () => {
    const [g2] = hojasPista(snapPista());
    expect(g2.columnas.at(-1)).toBe('PTOS');
    expect(g2.filas).toEqual([
      [1, '201 ALFA Guía Uno', 'CERO', 0, 0, '48,74', '4,51', '0,00', '0,00', 'Cero Exc', 25],
      [2, '202 BETA Guía Dos', 'FN', 2, 10, '53,00', '4,15', '0,00', '10,00', 'MB', 16],
      // Limpio pero pasado del TRS: sigue siendo "CERO" en señas.
      [3, '203 GAMA Guía Tres', 'CERO', 0, 0, '75,00', '2,93', '17,49', '17,49', 'B', 14],
      ['-', '204 DELTA Guía Cuatro', 'DESC', '-', '-', '-', '-', '-', '-', 'No clasifica', 0],
      ['-', '205 EPSILON Guía Cinco', 'AUS', '-', '-', '-', '-', '-', '-', 'Ausente', 0]
    ]);
    expect(g2.provisoria).toBe(0);
  });

  it('G1 no lleva puntos; sin TRS lo dice (el largo es el de la pista), y con perros por correr sale provisoria', () => {
    const [, g1] = hojasPista(snapPista());
    expect(g1.columnas).not.toContain('PTOS');
    expect(g1.filas).toEqual([[1, '301 ZETA Guía Seis', 'CERO', 0, 0, '40,00', '5,50', '0,00', '0,00', 'Cero Exc']]);
    expect(g1.nota).toMatch(/Sin TRS/);
    expect(g1.provisoria).toBe(1);
  });

  it('sin resultados no hay hojas', () => {
    expect(hojasPista(armarSnapshot([perro(1, '1', 'X', 'Y', 'Small', 'G1', 'pendiente')]))).toEqual([]);
  });

  it('el PDF lleva una página por hoja, con su título', async () => {
    const doc = await armarPdf(hojasPista(snapPista()));
    expect(doc.getNumberOfPages()).toBe(2);
    const texto = doc.output();
    expect(texto).toContain('G2/G3 - AGILITY 1 - SMALL/MEDIUM');
    expect(texto).toContain('ALFA');
  });
});

describe('planilla del combinado', () => {
  it('tiempos y faltas de cada pista, y la suma; un DESC en alguna va al final sin puesto', () => {
    const snap = armarSnapshot([
      perro(1, '201', 'ALFA', 'Guía Uno', 'Small', 'G1', 'corrido', { tiempo: 40, faltas: 1, rehuses: 0 }),
      perro(2, '202', 'BETA', 'Guía Dos', 'Small', 'G1', 'corrido', { tiempo: 45, faltas: 0, rehuses: 0 }),
      perro(3, '201', 'ALFA', 'Guía Uno', 'Small', 'G1', 'corrido', { tiempo: 42, faltas: 0, rehuses: 0 }, 'p2'),
      perro(4, '202', 'BETA', 'Guía Dos', 'Small', 'G1', 'corrido', { tiempo: null, faltas: 0, rehuses: 0, eliminado: true }, 'p2')
    ], {
      pistas: [
        { id: 'p1', nombre: 'Agility 1', estado: 'cerrada', trs: { trs: 50 }, combinaCon: 'p2', juez: 'Juez A' },
        { id: 'p2', nombre: 'Jumping 1', estado: 'en_curso', trs: { trs: 50 }, combinaCon: 'p1', juez: 'Juez B' }
      ]
    });
    const [h] = hojasCombinado(snap);
    expect(h.titulo).toBe('COMBINADO - G1 - SMALL/MEDIUM');
    expect(h.datos[0]).toEqual(['Juez', 'Juez A / Juez B']);
    expect(h.medidas).toEqual([['P1', 'Agility 1'], ['P2', 'Jumping 1']]);
    expect(h.filas).toEqual([
      [1, '201 ALFA Guía Uno', '40,00', '5,00', '42,00', '0,00', '82,00', '5,00', 'Exc'],
      ['-', '202 BETA Guía Dos', '45,00', '0,00', '-', 'DESC', '45,00', 'DESC', 'No clasifica']
    ]);
  });

  it('una pista que no combina no tiene planilla de combinado', () => {
    expect(hojasCombinado(snapPista())).toEqual([]);
  });
});

describe('detalles', () => {
  it('señas, fecha y nombre de archivo', () => {
    expect(senas({ faltas: 2, rehuses: 1 })).toBe('FFN');
    expect(senas({ eliminado: true })).toBe('DESC');
    expect(fechaPlanilla('2026-10-10')).toBe('10/10/2026');
    expect(nombreArchivo('Planilla Agility 1/2')).toBe('Planilla Agility 1-2.pdf');
  });
});
