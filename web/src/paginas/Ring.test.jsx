import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { armarSnapshot, canalFalso, fetchFalso, perro } from '../prueba/ayuda.js';

let conectado = true;
const canal = canalFalso();
vi.mock('../lib/realtime.js', () => ({
  useCanal: (...a) => { canal.useCanal(...a); return conectado; }
}));
const { default: Ring } = await import('./Ring.jsx');

const PISTA = { id: 'm1', nombre: 'Agility 1', estado: 'en_curso' };
const lista = (res41 = null) => [
  perro(1, '41', 'Kira', "Sofía Bustos O'Brien", 'Large', 'G1', 'corrido', res41, 'm1'),
  perro(2, '42', 'Tango', 'Diego Sosa', 'Small', 'G2', 'en_pista', null, 'm1'),
  perro(3, '47', 'Luna', 'Ana Paz', 'Intermediate', 'G3', 'pendiente', null, 'm1'),
  perro(4, '48', 'Toto', 'Juan Gil', 'Medium', '', 'pendiente', null, 'm1')
];

function montar(snap, { clave = '47', red = true, cache = null } = {}) {
  if (clave) localStorage.setItem('miClave', clave);
  if (cache) localStorage.setItem('snap:ring-1:activa', JSON.stringify(cache));
  vi.stubGlobal('fetch', fetchFalso(async () => (red ? { status: 200, json: snap } : null)));
  return render(
    <MemoryRouter initialEntries={['/ring/ring-1']}>
      <Routes><Route path="/ring/:ringId" element={<Ring />} /></Routes>
    </MemoryRouter>
  );
}

const fila = dorsal => screen.getByText(dorsal, { selector: '.cola-lista .dorsal' }).closest('li');

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); conectado = true; });

describe('vista del corredor', () => {
  it('abre desde la caché sin red, y dice que el dato es viejo', async () => {
    conectado = false;
    const snap = armarSnapshot(lista(), { pistas: [PISTA] });
    montar(null, { red: false, cache: { snap, recibidoEn: Date.now() - 180000 } });
    expect((await screen.findAllByText('Diego Sosa', { exact: false })).length).toBeGreaterThan(0);
    expect(screen.getByText(/sin señal · 3 min atrás/)).toBeTruthy();
    expect(document.querySelector('.tope .pulso').className).toBe('pulso muerto');
  });

  it('la lista entera, con el estado de cada uno', async () => {
    montar(armarSnapshot(lista(), { pistas: [PISTA] }));
    await screen.findByTestId('orden');
    const filas = [...screen.getByTestId('orden').querySelectorAll('li')];
    expect(filas.map(li => li.querySelector('.dorsal').textContent)).toEqual(['41', '42', '47', '48']);
    expect(fila('41').className).toMatch(/corrido/);
    expect(within(fila('41')).getByText('corrió')).toBeTruthy();
    expect(fila('42').className).toMatch(/corriendo/);
    expect(fila('42').className).not.toMatch(/corrido/);
    expect(within(fila('42')).getByText('en pista')).toBeTruthy();
    expect(fila('47').className).toBe('cola-item vos');
    expect(fila('48').className).toBe('cola-item');
    expect(fila('47').querySelector('.cola-eta').textContent).toMatch(/^\d{1,2}:\d{2}/);
  });

  it('altura y grado por perro, sin recuadro vacío si falta el grado', async () => {
    montar(armarSnapshot(lista(), { pistas: [PISTA] }));
    await screen.findByTestId('orden');
    const etiq = d => [...fila(d).querySelectorAll('.etiq')].map(e => e.textContent);
    expect(etiq('41')).toEqual(['Large', 'G1']);
    expect(etiq('48')).toEqual(['Medium']);
    expect(within(document.querySelector('.pista')).getByText('Small')).toBeTruthy();
  });

  it('el perro va en la línea primaria y el guía en la secundaria', async () => {
    montar(armarSnapshot(lista(), { pistas: [PISTA] }));
    await screen.findByTestId('orden');
    expect(fila('41').querySelector('.cola-nombre').textContent).toBe('Kira');
    expect(fila('41').querySelector('.cola-sub').textContent).toMatch(/^Sofía Bustos O'Brien/);
    expect(document.querySelector('.pista-nombre').textContent).toBe('Tango');
  });

  it('cuenta cuántos perros faltan para tu turno', async () => {
    montar(armarSnapshot(lista(), { pistas: [PISTA] }));
    const turno = await screen.findByTestId('turno');
    expect(turno.textContent).toMatch(/Sos el próximo/);
  });

  it('del broadcast sólo aplica el snapshot de la pista que se mira', async () => {
    const snap = armarSnapshot(lista(), { pistas: [PISTA] });
    montar(snap);
    await screen.findByTestId('orden');
    act(() => canal.emitir('ring:ring-1', 'snapshot', {
      ...snap, pista: { id: 'm2', nombre: 'Otra Pista', estado: 'pendiente', arrancada: false }, esActiva: false, lista: []
    }));
    expect(document.querySelector('.tope-pista').textContent).toBe('Agility 1');
    act(() => canal.emitir('ring:ring-1', 'snapshot', { ...snap, pista: { ...snap.pista, nombre: 'Agility 1 bis' } }));
    expect(document.querySelector('.tope-pista').textContent).toBe('Agility 1 bis');
  });

  it('resultados en la lista, y la pestaña de clasificación', async () => {
    montar(armarSnapshot(lista({ tiempo: 38.2, faltas: 0, rehuses: 0, eliminado: false }), { pistas: [PISTA] }));
    await screen.findByTestId('orden');
    const res41 = [...fila('41').querySelectorAll('.cola-res > span')].map(s => s.textContent);
    expect(res41).toEqual(['F: 0,00', '38,20 s']);
    fireEvent.click(screen.getByText('Clasificación'));
    const c = screen.getByTestId('clasificacion');
    expect(c.textContent).toMatch(/Intermediate\/Large G1/);   // Large va con Intermediate
    expect(c.textContent).toMatch(/sin TRS/);
    expect(c.querySelector('.etiq.calif.cero').textContent).toBe('Cero Exc');
    expect(c.textContent).not.toMatch(/Small\/Midi G2/);       // podio sin resultados: no aparece
    expect(localStorage.getItem('vista')).toBe('clasif');
  });

  it('con largo cargado muestra la velocidad; el descalificado dice DESC', async () => {
    const conDesc = lista({ tiempo: 38.2, faltas: 0, rehuses: 0, eliminado: false }).map(i =>
      i.dorsal === '42' ? { ...i, estado: 'corrido', resultado: { tiempo: 50, faltas: 0, rehuses: 0, eliminado: true } } : i);
    montar(armarSnapshot(conDesc, { pistas: [{ ...PISTA, trs: { largo: 191, velocidad: 4.5, trs: 191 / 4.5 } }] }));
    await screen.findByTestId('orden');
    const res41 = [...fila('41').querySelectorAll('.cola-res > span')].map(s => s.textContent);
    expect(res41).toEqual(['F: 0,00', '38,20 s | 5,00 m/s']);
    fireEvent.click(screen.getByText('Clasificación'));
    const c = screen.getByTestId('clasificacion');
    const desc = within(c).getByText('Tango').closest('li');
    expect(desc.querySelector('.puesto').textContent).toBe('DESC');
    expect(desc.querySelector('.cola-res > span').textContent).toBe('DESC');
    expect(c.textContent).toContain('TRS 42,44 s · 191 m a 4,5 m/s');
  });

  it('sin resultados no hay pestaña de clasificación', async () => {
    montar(armarSnapshot(lista(), { pistas: [PISTA] }));
    await screen.findByTestId('orden');
    expect(screen.queryByText('Clasificación')).toBeNull();
  });

  it('pista terminada: nadie desaparece y no promete una siguiente', async () => {
    const terminada = lista().map(i => ({ ...i, estado: i.dorsal === '48' ? 'ausente' : 'corrido' }));
    montar(armarSnapshot(terminada, { pistas: [{ ...PISTA, estado: 'cerrada' }] }));
    await screen.findByTestId('orden');
    expect(screen.getByTestId('orden').querySelectorAll('li')).toHaveLength(4);
    expect(fila('48').className).toMatch(/ausente/);
    expect(document.querySelector('.cola-item.corriendo')).toBeNull();
    expect(fila('47').className).toMatch(/vos/);
    expect(document.querySelector('.tope-pista').textContent).toBe('Agility 1');
    expect(screen.getByText('Pista terminada')).toBeTruthy();
    expect(screen.getByText('No queda nada más por correr')).toBeTruthy();
    expect(screen.getByTestId('turno').textContent).toMatch(/Ya corriste esta pista/);
  });

  describe('pistas sin dorsal (G0)', () => {
    const g0 = [
      perro(1, '', 'OREO', 'Ana', 'Small', 'G0', 'corrido', null, 'm1'),
      perro(2, '', 'Ñandú', 'Bea', 'Small', 'G0', 'en_pista', null, 'm1'),
      perro(3, '', 'Rocky', 'Caro', 'Medium', 'G0', 'pendiente', null, 'm1'),
      perro(4, '', 'LOLA', 'Dani', 'Medium', 'G0', 'pendiente', null, 'm1')
    ];

    it('no dibuja recuadros de dorsal y pide el nombre del perro', async () => {
      montar(armarSnapshot(g0, { pistas: [PISTA] }), { clave: null });
      await screen.findByTestId('orden');
      expect(document.querySelector('.cola-lista .dorsal, .pista .dorsal')).toBeNull();
      expect(screen.getByPlaceholderText('OREO')).toBeTruthy();
      expect(screen.getByTestId('turno').textContent).toMatch(/Poné el nombre de tu perro/);
    });

    it('se reconoce por nombre, sin mayúsculas ni acentos', async () => {
      montar(armarSnapshot(g0, { pistas: [PISTA] }), { clave: 'lola' });
      await screen.findByTestId('orden');
      expect(screen.getByText('LOLA').closest('li').className).toMatch(/vos/);
      expect(screen.getByTestId('turno').textContent).toMatch(/perro antes que vos|Sos el próximo/);
    });

    it('el que está en pista se reconoce igual, aunque tenga eñe', async () => {
      montar(armarSnapshot(g0, { pistas: [PISTA] }), { clave: 'nandu' });
      expect((await screen.findByTestId('turno')).textContent).toMatch(/Estás en pista/);
    });

    it('un perro con dorsal nunca se matchea por nombre', async () => {
      const mixta = [...g0, perro(5, '976', 'Rocky', 'Eva', 'Large', 'G1', 'pendiente', null, 'm1')];
      montar(armarSnapshot(mixta, { pistas: [PISTA] }), { clave: 'rocky' });
      await screen.findByTestId('orden');
      const marcados = [...document.querySelectorAll('.cola-item.vos')];
      expect(marcados).toHaveLength(1);
      expect(marcados[0].querySelector('.dorsal')).toBeNull();
    });

    it('en una pista mixta el texto aclara las dos opciones', async () => {
      const mixta = [...g0, perro(5, '976', 'Rocky', 'Eva', 'Large', 'G1', 'pendiente', null, 'm1')];
      montar(armarSnapshot(mixta, { pistas: [PISTA] }), { clave: null });
      expect((await screen.findByTestId('turno')).textContent).toMatch(/o el nombre de tu perro si no tenés número/);
    });

    it('un nombre que no está lo dice', async () => {
      montar(armarSnapshot(g0, { pistas: [PISTA] }), { clave: 'firulais' });
      expect((await screen.findByTestId('turno')).textContent).toMatch(/no está en esta pista/);
    });

    it('el dorsal viejo del localStorage (miDorsal) sigue valiendo', async () => {
      localStorage.setItem('miDorsal', '42');
      montar(armarSnapshot(lista(), { pistas: [PISTA] }), { clave: null });
      expect((await screen.findByTestId('turno')).textContent).toMatch(/Estás en pista/);
    });
  });
});
