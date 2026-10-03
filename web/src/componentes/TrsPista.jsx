import { useState } from 'react';
import * as R from '../../../shared/resultados.mjs';
import { fmtLibre } from '../lib/formato.js';
import { BotonCarga } from './comunes.jsx';

const desdeSnap = r => ({
  largo: r?.largo ? fmtLibre(r.largo) : '',
  velocidad: r?.velocidad ? fmtLibre(r.velocidad) : '',
  trs: r?.trs ? R.fmt(r.trs) : ''
});

// TRS de la pista: uno solo para todos los que la corren. Como en la planilla,
// largo ÷ velocidad; si ya viene calculado, se tipea directo.
export default function TrsPista({ snap, accion, mostrar }) {
  // Lo tipeado, por pista, hasta que se guarda.
  const [borradores, setBorradores] = useState({});
  if (!snap.pista || !snap.lista.length) return null;

  const pid = snap.pista.id;
  const v = borradores[pid] || desdeSnap(snap.trs);
  const calc = R.trsDe(R.leerNumero(v.largo), R.leerNumero(v.velocidad));
  const cambiar = (campo, valor) => setBorradores(b => ({ ...b, [pid]: { ...v, [campo]: valor } }));

  async function guardar() {
    const body = { pistaId: pid, largo: v.largo, velocidad: v.velocidad };
    // Con largo y velocidad manda la cuenta; el TRS tipeado sólo cuenta sin ellos.
    if (!v.largo && !v.velocidad) body.trs = v.trs;
    if (!(await accion('trs', body))) return;
    setBorradores(b => { const n = { ...b }; delete n[pid]; return n; });
    mostrar(v.trs || v.largo ? 'TRS guardado. Los resultados se recalcularon.' : 'TRS borrado.');
  }

  const campo = (c, nombre, unidad, valor, extra = {}) => (
    <label>{nombre} <input type="text" inputMode="decimal" autoComplete="off" placeholder="—" aria-label={nombre}
                           value={valor} onChange={e => cambiar(c, e.target.value)} {...extra} /> {unidad}</label>
  );

  return (
    <section className="mesa-seccion">
      <p className="eyebrow">TRS · {snap.pista.nombre}</p>
      <p className="mesa-actual-sub" style={{ margin: '8px 0 6px' }}>
        Uno para toda la pista: largo del recorrido ÷ velocidad, como en la planilla.
        Si ya tenés el TRS calculado, dejá largo y velocidad vacíos y cargalo directo.
        Cada segundo por encima del TRS suma un punto.
      </p>
      <div className="trs-fila">
        {campo('largo', 'Largo', 'm', v.largo)}
        {campo('velocidad', 'Velocidad', 'm/s', v.velocidad)}
        {campo('trs', 'TRS', 's', calc ? R.fmt(calc) : v.trs, { disabled: !!calc })}
        <BotonCarga className="btn chico" style={{ background: 'var(--chalk)', color: 'var(--turf)' }} onClick={guardar}>
          Guardar
        </BotonCarga>
      </div>
    </section>
  );
}
