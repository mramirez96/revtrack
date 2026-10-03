import { useRef, useState } from 'react';
import { enviar } from '../lib/api.js';
import { BotonCarga } from './comunes.jsx';

// Mismo tope que el servidor: mejor avisar acá que mandar 5 MB al vacío.
const TOPE = 500000;

// Carga el orden de salida de una pista desde un CSV (el que sale del
// cronometraje de la pista anterior). Sólo para pistas que no arrancaron.
export function CargarOrden({ snap, accion, mostrar }) {
  const sinArrancar = snap.pistas.filter(p => !p.arrancada);
  const [pistaId, setPistaId] = useState('');
  const [invertir, setInvertir] = useState(false);
  const archivo = useRef(null);
  const elegida = sinArrancar.some(p => p.id === pistaId) ? pistaId : sinArrancar[0]?.id;

  async function aplicar() {
    const f = archivo.current?.files?.[0];
    if (!f) return mostrar('Elegí primero el archivo con el orden.', true);
    if (f.size > TOPE) return mostrar('Ese archivo es demasiado grande (máx. 500 KB).', true);
    let csv;
    try { csv = await f.text(); } catch { return mostrar('No pude leer el archivo.', true); }
    await accion('cargar_orden', { pistaId: elegida, csv, invertir });
  }

  return (
    <section className="mesa-seccion">
      <p className="eyebrow">Cargar orden desde archivo</p>
      {sinArrancar.length ? <>
        <p className="mesa-actual-sub" style={{ margin: '8px 0 10px' }}>
          Un CSV con una columna <b>dorsal</b>. El orden de las filas es el orden de salida
          y las alturas se acomodan de menor a mayor. Los tiempos, si vienen, se ignoran.
        </p>
        <div className="orden-carga">
          <select aria-label="Pista a reordenar" value={elegida} onChange={e => setPistaId(e.target.value)}>
            {sinArrancar.map(p => <option key={p.id} value={p.id}>{p.nombre} · {p.total} perros</option>)}
          </select>
          <input ref={archivo} type="file" accept=".csv,text/csv,text/plain" aria-label="Archivo con el orden" />
          <label className="orden-check">
            <input type="checkbox" checked={invertir} onChange={e => setInvertir(e.target.checked)} /> invertir el archivo
          </label>
          <BotonCarga className="btn" style={{ background: 'var(--chalk)', color: 'var(--turf)' }} onClick={aplicar}>
            Aplicar orden
          </BotonCarga>
        </div>
      </> : (
        <p className="mesa-actual-sub" style={{ marginTop: 8 }}>
          Todas las pistas ya arrancaron: el orden sólo se importa antes del primer perro.
        </p>
      )}
    </section>
  );
}

// Borra todo y siembra de cero desde un CSV. La palabra tipeada es la guarda:
// un confirm() está a un toque de distancia y esto borra el día entero.
export function NuevaCompetencia({ snap, token, mostrar, corridos }) {
  const [confirmar, setConfirmar] = useState('');
  const archivo = useRef(null);

  async function cargar() {
    const f = archivo.current?.files?.[0];
    if (!f) return mostrar('Elegí el CSV de la competencia nueva.', true);
    if (f.size > TOPE) return mostrar('Ese archivo es demasiado grande (máx. 500 KB).', true);
    if (confirmar.trim().toUpperCase() !== 'BORRAR') return mostrar('Escribí BORRAR en el casillero para confirmar.', true);
    let csv;
    try { csv = await f.text(); } catch { return mostrar('No pude leer el archivo.', true); }
    try {
      const r = await enviar('/api/nueva_competencia', { csv, confirmar: 'BORRAR' }, token);
      if (!r.ok) return mostrar(r.datos.error || 'No se pudo cargar la competencia.', true);
      // La mesa se va derecho a la competencia nueva: su URL vieja apunta a un
      // ring que probablemente ya no exista. El reporte cruza la navegación
      // por sessionStorage.
      try { if (r.datos.aviso) sessionStorage.setItem('avisoPendiente', r.datos.aviso); } catch { /* sin storage */ }
      location.href = r.datos.ringId ? `/mesa/${encodeURIComponent(r.datos.ringId)}` : '/';
    } catch {
      mostrar('No pude conectarme al servidor.', true);
    }
  }

  return (
    <section className="mesa-seccion">
      <p className="eyebrow" style={{ color: '#FFB3AA' }}>Cargar otra competencia</p>
      <div className="mesa-peligro">
        <p>Borra <b>todo</b> lo de esta competencia y siembra de cero desde el archivo.
          Mismo formato que <code>data/seed.csv</code>.</p>
        <p className="mesa-actual-sub">Se va a perder: {corridos} corrido(s) y el orden de {snap.pistas.length} pista(s).
          El estado actual queda respaldado en la base, pero desde la app no se puede volver atrás.</p>
        <div className="orden-carga" style={{ marginTop: 12 }}>
          <input ref={archivo} type="file" accept=".csv,text/csv,text/plain" aria-label="CSV de la competencia nueva" />
          <input type="text" placeholder="escribí BORRAR" aria-label="Escribí BORRAR para confirmar"
                 style={{ width: 150, fontFamily: 'inherit' }} value={confirmar} onChange={e => setConfirmar(e.target.value)} />
          <BotonCarga className="mesa-btn secundario peligro" style={{ fontSize: 16, padding: '12px 18px' }} onClick={cargar}>
            Borrar y cargar
          </BotonCarga>
        </div>
      </div>
    </section>
  );
}
