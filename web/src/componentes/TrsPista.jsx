import { useState } from 'react';
import * as R from '../../../shared/resultados.mjs';
import { fmtLibre } from '../lib/formato.js';
import { BotonCarga } from './comunes.jsx';

// `manual`: el TRS se tipeó (o se ajustó) a mano y no sigue a largo ÷ velocidad.
const desdeSnap = r => ({
  largo: r?.largo ? fmtLibre(r.largo) : '',
  velocidad: r?.velocidad ? fmtLibre(r.velocidad) : '',
  trs: r?.trs ? R.fmt(r.trs) : '',
  manual: !!r?.ajustado || (!!r?.trs && !r?.largo)
});

// TRS de la pista: uno solo para todos los que la corren. Como en la planilla,
// largo ÷ velocidad propone el TRS; el juez lo puede ajustar a mano después
// (también con la pista empezada), y al guardar se recalcula a todos.
export default function TrsPista({ snap, accion, mostrar }) {
  // Lo tipeado, por pista, hasta que se guarda.
  const [borradores, setBorradores] = useState({});
  if (!snap.pista || !snap.lista.length) return null;

  const pid = snap.pista.id;
  const v = borradores[pid] || desdeSnap(snap.trs);
  const calc = R.trsDe(R.leerNumero(v.largo), R.leerNumero(v.velocidad));
  // Mientras no se lo toque, el TRS sigue a la cuenta.
  const trsVisible = v.manual || !calc ? v.trs : R.fmt(calc);
  const ajustado = v.manual && calc;
  const cambiar = cambios => setBorradores(b => ({ ...b, [pid]: { ...v, ...cambios } }));

  async function guardar() {
    const body = { pistaId: pid, largo: v.largo, velocidad: v.velocidad };
    if (v.manual || !calc) body.trs = trsVisible;
    if (!(await accion('trs', body))) return;
    setBorradores(b => { const n = { ...b }; delete n[pid]; return n; });
    mostrar(trsVisible || v.largo ? 'TRS guardado. Los resultados se recalcularon.' : 'TRS borrado.');
  }

  const campo = (nombre, unidad, valor, onChange) => (
    <label>{nombre} <input type="text" inputMode="decimal" autoComplete="off" placeholder="—" aria-label={nombre}
                           value={valor} onChange={e => onChange(e.target.value)} /> {unidad}</label>
  );

  return (
    <section className="mesa-seccion">
      <p className="eyebrow">TRS · {snap.pista.nombre}</p>
      <p className="mesa-actual-sub" style={{ margin: '8px 0 6px' }}>
        Uno para toda la pista. Largo ÷ velocidad lo calcula, como en la planilla; si el
        juez lo ajusta, tipeá el TRS encima. Cada segundo por encima del TRS suma un punto.
      </p>
      <div className="trs-fila">
        {campo('Largo', 'm', v.largo, largo => cambiar({ largo }))}
        {campo('Velocidad', 'm/s', v.velocidad, velocidad => cambiar({ velocidad }))}
        {/* Tipear el TRS lo deja fijo; borrarlo lo devuelve a la cuenta. */}
        {campo('TRS', 's', trsVisible, trs => cambiar({ trs, manual: trs.trim() !== '' }))}
        <BotonCarga className="btn chico" style={{ background: 'var(--chalk)', color: 'var(--turf)' }} onClick={guardar}>
          Guardar
        </BotonCarga>
      </div>
      {ajustado && (
        <p className="mesa-actual-sub" style={{ marginTop: 6 }}>
          Ajustado a mano: con largo y velocidad daría {R.fmt(calc)} s.{' '}
          <button className="mesa-link" onClick={() => cambiar({ trs: '', manual: false })}>Volver a la cuenta</button>
        </p>
      )}
    </section>
  );
}
