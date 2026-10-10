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
  perro(1, '101', 'BRUNO', 'Guía Uno', 'XS', 'G1', 'corrido', resultadoRocky),
  perro(2, '102', 'CHISPA', 'Guía Dos', 'Small', 'G1', 'en_pista'),
  perro(3, '103', 'NIEBLA', 'Guía Tres', 'Intermediate', 'G2', 'pendiente'),
  perro(4, '50', 'OTRO', 'Guía 4', 'Large', 'G1', 'pendiente', null, 'p2')
];

let snap;
let respuestaAccion;
let pedidos;
function montar(token = tokenDe('ring-1')) {
  localStorage.setItem('mesaToken', token);
  vi.stubGlobal('fetch', fetchFalso(async (url, op) => {
    if (url.startsWith('/api/ring/ring-1/')) {
      pedidos.push({ url, body: JSON.parse(op.body) });
      return respuestaAccion(url, op);
    }
    if (url.startsWith('/api/ring/ring-1')) return { status: 200, json: snap };
    return { status: 404 };
  }));
  return render(
    <MemoryRouter initialEntries={['/mesa/ring-1']}>
      <Routes><Route path="/mesa/:ringId" element={<Mesa />} /></Routes>
    </MemoryRouter>
  );
}

const tarjeta = () => screen.getByTestId('en-pista');

beforeEach(() => {
  snap = armarSnapshot(base(), { pistas: PISTAS });
  respuestaAccion = () => ({ status: 200, json: {} });
  pedidos = [];
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe('mesa', () => {
  it('con un token vigente entra directo, sin pedir el PIN', async () => {
    montar();
    expect(await screen.findByText('CHISPA', { selector: '.mesa-actual-nombre' })).toBeTruthy();
    expect(screen.queryByText('Control de mesa')).toBeNull();
  });

  it('arriba: el perro en pista, grande, con su formulario y el botón de largar el siguiente', async () => {
    montar();
    await screen.findByText('CHISPA', { selector: '.mesa-actual-nombre' });
    const t = tarjeta();
    expect(t.querySelector('.dorsal').textContent).toBe('102');
    expect(t.querySelector('.mesa-actual-sub').textContent).toMatch(/Guía Dos/);
    expect(within(t).getByText('Small')).toBeTruthy();
    expect(t.textContent).toMatch(/Small\/Midi G1/);
    expect(within(t).getByLabelText('Tiempo')).toBeTruthy();
    expect(within(t).getByLabelText('Sumar negativas')).toBeTruthy();
    expect(within(t).getByText('Guardar y largar el siguiente')).toBeTruthy();
  });

  it('"Siguiente sin resultado" queda abajo, en chico; ausente no existe más en la mesa', async () => {
    montar();
    await screen.findByTestId('en-pista');
    expect(screen.getByText('Siguiente sin resultado').className).toMatch(/chico/);
    expect(screen.queryByText('Siguiente', { exact: true })).toBeNull();
    // El que no corre se carga como descalificado (así va en la planilla del club).
    expect(screen.queryByText(/Marcar ausente/)).toBeNull();
    expect(screen.queryByLabelText(/Marcar ausente/)).toBeNull();
    expect(within(tarjeta()).getByLabelText('Descalificado')).toBeTruthy();
  });

  it('"Descalificado" (también el que no corre): sin tiempo, y larga al siguiente', async () => {
    montar();
    await screen.findByTestId('en-pista');
    fireEvent.click(within(tarjeta()).getByLabelText('Descalificado'));
    expect(tarjeta().textContent).toMatch(/No clasifica/);
    fireEvent.click(within(tarjeta()).getByText('Guardar y largar el siguiente'));
    await waitFor(() => expect(pedidos).toHaveLength(1));
    expect(pedidos[0].body).toMatchObject({ id: 'i2', tiempo: '', eliminado: true, avanzar: true });
  });

  it('con la pista sin arrancar, la acción grande es largar el primero', async () => {
    snap = armarSnapshot(base().map(i => ({ ...i, estado: 'pendiente', resultado: null })), { pistas: PISTAS });
    montar();
    expect(await screen.findByText('Largar el primero')).toBeTruthy();
    expect(screen.queryByLabelText('Tiempo')).toBeNull();
  });

  it('los próximos traen altura y grado; el programa lista las 3 pistas', async () => {
    const { container } = montar();
    await screen.findByText('NIEBLA');
    const item = screen.getByText('NIEBLA').closest('li');
    expect(within(item).getByText('Intermediate')).toBeTruthy();
    expect(container.querySelectorAll('.mesa-pista-sel')).toHaveLength(3);
  });

  it('cargar orden sólo ofrece las pistas que no arrancaron', async () => {
    montar();
    const select = await screen.findByLabelText('Pista a reordenar');
    expect([...select.querySelectorAll('option')].map(o => o.value)).toEqual(['p2', 'p3']);
  });

  it('si todas arrancaron, no ofrece importar y explica por qué', async () => {
    snap = { ...snap, pistas: snap.pistas.map(p => ({ ...p, arrancada: true })) };
    montar();
    expect(await screen.findByText(/sólo se importa antes del primer perro/)).toBeTruthy();
    expect(screen.queryByText('Aplicar orden')).toBeNull();
  });

  it('la vista previa calcula como el servidor (falta + exceso de TRS + calificación)', async () => {
    montar();
    await screen.findByTestId('en-pista');
    fireEvent.change(within(tarjeta()).getByLabelText('Tiempo'), { target: { value: '41,5' } });
    fireEvent.click(within(tarjeta()).getByLabelText('Sumar faltas'));
    expect(tarjeta().textContent).toMatch(/→ F: 6,50 · MB · 1 falta · 1,50 de tiempo · TRS 40,00 s/);
  });

  it('guardar el del que está en pista manda avanzar, y salta en el acto al siguiente', async () => {
    let soltar;
    respuestaAccion = () => new Promise(res => { soltar = () => res({ status: 200, json: {} }); });
    montar();
    await screen.findByTestId('en-pista');
    fireEvent.change(within(tarjeta()).getByLabelText('Tiempo'), { target: { value: '37' } });
    fireEvent.click(within(tarjeta()).getByText('Guardar y largar el siguiente'));

    // Todavía sin respuesta del servidor: arriba ya está el siguiente, listo para tipear.
    expect(within(tarjeta()).getByText('NIEBLA')).toBeTruthy();
    expect(within(tarjeta()).getByLabelText('Tiempo')).toBe(document.activeElement);
    expect(within(tarjeta()).getByLabelText('Tiempo').value).toBe('');
    expect(pedidos[0]).toMatchObject({ url: '/api/ring/ring-1/resultado', body: { id: 'i2', tiempo: '37', avanzar: true } });
    await act(async () => { soltar(); });
  });

  it('si el servidor rechaza el guardado, vuelve al perro con lo tipeado', async () => {
    respuestaAccion = () => ({ status: 500, json: { error: 'Algo falló.' } });
    montar();
    await screen.findByTestId('en-pista');
    fireEvent.change(within(tarjeta()).getByLabelText('Tiempo'), { target: { value: '41,5' } });
    fireEvent.click(within(tarjeta()).getByText('Guardar y largar el siguiente'));
    await waitFor(() => expect(screen.getByText('Algo falló.')).toBeTruthy());
    expect(within(tarjeta()).getByText('CHISPA')).toBeTruthy();
    expect(within(tarjeta()).getByLabelText('Tiempo').value).toBe('41,5');
  });

  it('sin tiempo no guarda ni salta: avisa y se queda en el perro', async () => {
    montar();
    await screen.findByTestId('en-pista');
    fireEvent.click(within(tarjeta()).getByText('Guardar y largar el siguiente'));
    expect(within(tarjeta()).getByText('CHISPA')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Falta el tiempo.');
    expect(pedidos).toHaveLength(0);
  });

  it('lo que se está tipeando sobrevive a un snapshot que llega en el medio', async () => {
    montar();
    await screen.findByTestId('en-pista');
    const tiempo = within(tarjeta()).getByLabelText('Tiempo');
    tiempo.focus();
    fireEvent.change(tiempo, { target: { value: '39,1' } });
    act(() => canal.emitir('ring:ring-1', 'snapshot', armarSnapshot(base(), { pistas: PISTAS })));
    const despues = within(tarjeta()).getByLabelText('Tiempo');
    expect(despues.value).toBe('39,1');
    expect(despues).toBe(document.activeElement);
  });

  it('abajo: los que corrieron sin resultado, para cargarlos sin largar a nadie', async () => {
    montar();
    expect(await screen.findByText(/faltan cargar 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '101' }));
    const editor = screen.getByTestId('editor-correccion');
    expect(within(editor).getByText('BRUNO')).toBeTruthy();
    fireEvent.change(within(editor).getByLabelText('Tiempo'), { target: { value: '40' } });
    fireEvent.click(within(editor).getByText('Guardar resultado'));
    await waitFor(() => expect(pedidos).toHaveLength(1));
    expect(pedidos[0].body).toMatchObject({ id: 'i1', tiempo: '40', avanzar: false });
    expect(within(tarjeta()).getByText('CHISPA')).toBeTruthy();   // arriba no cambió nada
  });

  it('lo cargado se lista con penalización, calificación y puesto', async () => {
    snap = armarSnapshot(base({ tiempo: 41.5, faltas: 1, rehuses: 0, eliminado: false }), { pistas: PISTAS });
    montar();
    expect(await screen.findByText(/F: 6,50 · 41,50 s · MB · 1º en Small\/Midi G1/)).toBeTruthy();
  });

  it('la clasificación, la misma que la de los corredores, se puede abrir desde la mesa', async () => {
    snap = armarSnapshot(base({ tiempo: 41.5, faltas: 1, rehuses: 0, eliminado: false }), { pistas: PISTAS });
    montar();
    fireEvent.click(await screen.findByText('Ver (1 con resultado)'));
    const c = screen.getByTestId('clasificacion');
    expect(within(c).getByText('Small/Midi G1')).toBeTruthy();
    expect(within(c).getByText('BRUNO')).toBeTruthy();
    expect(c.querySelector('.cola-res').textContent).toBe('F: 6,5041,50 s');
    fireEvent.click(screen.getByText('Ocultar'));
    expect(screen.queryByTestId('clasificacion')).toBeNull();
  });

  it('un TRS por altura, con el largo compartido', async () => {
    montar();
    // El TRS de antes (uno para todos) aparece en los dos grupos.
    expect((await screen.findByLabelText('TRS Small/Midi')).value).toBe('40,00');
    expect(screen.getByLabelText('TRS Intermediate/Large').value).toBe('40,00');
    expect(screen.getAllByLabelText('Largo')).toHaveLength(1);
    expect(screen.getByLabelText('Velocidad Small/Midi')).toBeTruthy();
    expect(screen.getByLabelText('Velocidad Intermediate/Large')).toBeTruthy();
  });

  it('largo y velocidad proponen el TRS al tocarlos; después se escribe encima sin que se recalcule', async () => {
    montar();
    fireEvent.change(await screen.findByLabelText('Largo'), { target: { value: '191' } });
    fireEvent.change(screen.getByLabelText('Velocidad Small/Midi'), { target: { value: '4,5' } });
    expect(screen.getByLabelText('TRS Small/Midi').value).toBe('42,44');
    // El otro grupo no tiene velocidad: queda como estaba.
    expect(screen.getByLabelText('TRS Intermediate/Large').value).toBe('40,00');

    fireEvent.change(screen.getByLabelText('TRS Small/Midi'), { target: { value: '45' } });
    expect(screen.getByLabelText('TRS Small/Midi').value).toBe('45');
    expect(screen.queryByText(/Ajustado a mano/)).toBeNull();

    fireEvent.click(screen.getByText('Guardar TRS'));
    await waitFor(() => expect(pedidos).toHaveLength(1));
    expect(pedidos[0].url).toBe('/api/ring/ring-1/trs');
    expect(pedidos[0].body).toEqual({
      pistaId: 'p1', largo: '191',
      grupos: { 'small-midi': { velocidad: '4,5', trs: '45' }, 'intermediate-large': { velocidad: '', trs: '40,00' } }
    });
  });

  it('el formulario de resultado: faltas y negativas arriba, el tiempo abajo', async () => {
    montar();
    await screen.findByText('CHISPA', { selector: '.mesa-actual-nombre' });
    const filas = [...tarjeta().querySelectorAll('.res-campos')];
    expect(filas).toHaveLength(2);
    expect(filas[0].textContent).toMatch(/Faltas.*Negativas/);
    expect(within(filas[1]).getByLabelText('Tiempo')).toBeTruthy();
  });

  it('el nombre y la fecha del evento se corrigen desde la mesa', async () => {
    montar();
    const nombre = await screen.findByLabelText('Nombre del evento');
    expect(nombre.value).toBe('Winter Open');
    const guardar = screen.getByText('Guardar nombre y fecha');
    expect(guardar.disabled).toBe(true);
    fireEvent.change(nombre, { target: { value: 'Nacional Ejemplo' } });
    fireEvent.change(screen.getByLabelText('Fecha del evento'), { target: { value: '2026-10-10' } });
    fireEvent.click(guardar);
    await waitFor(() => expect(pedidos).toHaveLength(1));
    expect(pedidos[0].url).toBe('/api/ring/ring-1/evento');
    expect(pedidos[0].body).toEqual({ nombre: 'Nacional Ejemplo', fecha: '2026-10-10' });
  });

  it('con un token de otro ring pide el PIN', async () => {
    montar(tokenDe('otro-ring'));
    expect(await screen.findByText('Control de mesa')).toBeTruthy();
    expect(screen.queryByText('CHISPA')).toBeNull();
  });
});
