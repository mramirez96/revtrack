import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { armarSnapshot, canalFalso, fetchFalso, perro, tokenDe } from '../prueba/ayuda.js';

const canal = canalFalso();
vi.mock('../lib/realtime.js', () => ({ useCanal: (...a) => canal.useCanal(...a) }));
const { default: Mesa } = await import('./Mesa.jsx');

const PISTAS = [
  { id: 'p1', nombre: 'Jumping 1', estado: 'en_curso', trs: { trs: 40 } },
  { id: 'p2', nombre: 'Jumping 2', estado: 'pendiente' },
  { id: 'p3', nombre: 'Agility 1', estado: 'pendiente' }
];
const base = (resultadoRocky = null) => [
  perro(1, '976', 'ROCKY', 'Gastón Cossano', 'XS', 'G1', 'corrido', resultadoRocky),
  perro(2, '941', 'FURIA', 'Cristian Pace', 'Small', 'G1', 'en_pista'),
  perro(3, '1013', 'TRISHA', 'Micaela Ramirez', 'Intermediate', 'G2', 'pendiente'),
  perro(4, '50', 'OTRO', 'Guía 4', 'Large', 'G1', 'pendiente', null, 'p2')
];

let snap;
let respuestaAccion;
function montar(token = tokenDe('ring-1')) {
  localStorage.setItem('mesaToken', token);
  vi.stubGlobal('fetch', fetchFalso(async url => {
    if (url.startsWith('/api/ring/ring-1/')) return respuestaAccion();
    if (url.startsWith('/api/ring/ring-1')) return { status: 200, json: snap };
    return { status: 404 };
  }));
  return render(
    <MemoryRouter initialEntries={['/mesa/ring-1']}>
      <Routes><Route path="/mesa/:ringId" element={<Mesa />} /></Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  snap = armarSnapshot(base(), { pistas: PISTAS });
  respuestaAccion = () => ({ status: 200, json: {} });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe('mesa', () => {
  it('con un token vigente entra directo, sin pedir el PIN', async () => {
    montar();
    expect(await screen.findByText('FURIA', { selector: '.mesa-actual-nombre' })).toBeTruthy();
    expect(screen.queryByText('Control de mesa')).toBeNull();
  });

  it('el perro en pista, con el guía y la altura/grado de secundario', async () => {
    const { container } = montar();
    await screen.findByText('FURIA', { selector: '.mesa-actual-nombre' });
    const sub = container.querySelector('.mesa-actual .mesa-actual-sub');
    expect(sub.textContent).toMatch(/Cristian Pace/);
    expect(within(sub).getByText('Small')).toBeTruthy();
  });

  it('los próximos traen altura y grado; el programa lista las 3 pistas', async () => {
    const { container } = montar();
    await screen.findByText('TRISHA');
    const item = screen.getByText('TRISHA').closest('li');
    expect(within(item).getByText('Intermediate')).toBeTruthy();
    expect(container.querySelectorAll('.mesa-pista-sel')).toHaveLength(3);
  });

  it('cargar orden sólo ofrece las pistas que no arrancaron', async () => {
    montar();
    const select = await screen.findByLabelText('Pista a reordenar');
    const valores = [...select.querySelectorAll('option')].map(o => o.value);
    expect(valores).toEqual(['p2', 'p3']);
  });

  it('si todas arrancaron, no ofrece importar y explica por qué', async () => {
    snap = { ...snap, pistas: snap.pistas.map(p => ({ ...p, arrancada: true })) };
    montar();
    expect(await screen.findByText(/sólo se importa antes del primer perro/)).toBeTruthy();
    expect(screen.queryByText('Aplicar orden')).toBeNull();
  });

  it('el editor propone al último que corrió sin resultado, con su podio', async () => {
    montar();
    const editor = await screen.findByTestId('editor-resultado');
    expect(within(editor).getByText('ROCKY')).toBeTruthy();
    expect(within(editor).queryByText('FURIA')).toBeNull();
    expect(editor.textContent).toMatch(/Small\/Midi G1/);     // XS va con Small/Midi
    expect(within(editor).getByLabelText('Sumar negativas')).toBeTruthy();
    expect(editor.textContent).toMatch(/Falta el tiempo/);
    expect(screen.getByText(/faltan cargar 2/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '941' })).toBeTruthy();   // "también falta"
  });

  it('la vista previa calcula como el servidor (falta + exceso de TRS + calificación)', async () => {
    montar();
    const editor = await screen.findByTestId('editor-resultado');
    fireEvent.change(within(editor).getByLabelText('Tiempo'), { target: { value: '41,5' } });
    fireEvent.click(within(editor).getByLabelText('Sumar faltas'));
    expect(editor.textContent).toMatch(/6,50 pen\. · MB · 1 falta · 1,50 de tiempo · TRS 40,00 s/);
  });

  it('un solo TRS para toda la pista, con largo y velocidad', async () => {
    montar();
    expect((await screen.findByLabelText('TRS')).value).toBe('40,00');
    expect(screen.getAllByLabelText('TRS')).toHaveLength(1);
    expect(screen.getByLabelText('Largo')).toBeTruthy();
    expect(screen.getByLabelText('Velocidad')).toBeTruthy();
  });

  it('con largo y velocidad, el TRS se calcula solo y no se tipea', async () => {
    montar();
    fireEvent.change(await screen.findByLabelText('Largo'), { target: { value: '191' } });
    fireEvent.change(screen.getByLabelText('Velocidad'), { target: { value: '4,5' } });
    const trs = screen.getByLabelText('TRS');
    expect(trs.value).toBe('42,44');
    expect(trs.disabled).toBe(true);
  });

  it('con el anterior cargado pasa al que está en pista, y lista lo cargado', async () => {
    snap = armarSnapshot(base({ tiempo: 41.5, faltas: 1, rehuses: 0, eliminado: false }), { pistas: PISTAS });
    montar();
    const editor = await screen.findByTestId('editor-resultado');
    expect(within(editor).getByText('FURIA')).toBeTruthy();
    expect(screen.getByText(/6,50 pen\. · MB · 41,50 s · 1º en Small\/Midi G1/)).toBeTruthy();
  });

  it('al guardar salta en el acto al próximo; si el servidor falla, vuelve con lo tipeado', async () => {
    let soltar;
    respuestaAccion = () => new Promise(res => { soltar = () => res({ status: 500, json: { error: 'Algo falló.' } }); });
    montar();
    const editor = await screen.findByTestId('editor-resultado');
    fireEvent.change(within(editor).getByLabelText('Tiempo'), { target: { value: '41,5' } });
    fireEvent.click(within(editor).getByText('Guardar resultado'));

    // Todavía sin respuesta del servidor: ya está en el siguiente.
    const ahora = screen.getByTestId('editor-resultado');
    expect(within(ahora).getByText('FURIA')).toBeTruthy();
    expect(within(ahora).getByLabelText('Tiempo')).toBe(document.activeElement);

    await act(async () => { soltar(); });
    await waitFor(() => expect(within(screen.getByTestId('editor-resultado')).getByText('ROCKY')).toBeTruthy());
    expect(within(screen.getByTestId('editor-resultado')).getByLabelText('Tiempo').value).toBe('41,5');
    expect(screen.getByText('Algo falló.')).toBeTruthy();
  });

  it('sin tiempo no salta: avisa y se queda en el perro', async () => {
    montar();
    const editor = await screen.findByTestId('editor-resultado');
    fireEvent.click(within(editor).getByText('Guardar resultado'));
    expect(within(screen.getByTestId('editor-resultado')).getByText('ROCKY')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Falta el tiempo.');
  });

  it('lo que se está tipeando sobrevive a un snapshot que llega en el medio', async () => {
    montar();
    const editor = await screen.findByTestId('editor-resultado');
    const tiempo = within(editor).getByLabelText('Tiempo');
    tiempo.focus();
    fireEvent.change(tiempo, { target: { value: '39,1' } });
    act(() => canal.emitir('ring:ring-1', 'snapshot', armarSnapshot(base(), { pistas: PISTAS })));
    const despues = within(screen.getByTestId('editor-resultado')).getByLabelText('Tiempo');
    expect(despues.value).toBe('39,1');
    expect(despues).toBe(document.activeElement);
  });

  it('con un token de otro ring pide el PIN', async () => {
    montar(tokenDe('otro-ring'));
    expect(await screen.findByText('Control de mesa')).toBeTruthy();
    expect(screen.queryByText('FURIA')).toBeNull();
  });
});
