import { useState } from 'react';
import * as R from '../../../shared/resultados.mjs';
import { fmtLibre } from '../lib/formato.js';
import { BotonCarga } from './comunes.jsx';

// Los grupos de altura que corren esta pista, en el orden de la lista.
function gruposDe(lista) {
  const vistos = new Map();
  for (const i of lista) {
    const g = R.grupoDeAltura(i.altura);
    if (!vistos.has(g.id)) vistos.set(g.id, g);
  }
  return [...vistos.values()];
}

function desdeSnap(trsPista, grupos) {
  return {
    largo: trsPista?.largo ? fmtLibre(trsPista.largo) : '',
    grupos: Object.fromEntries(grupos.map(g => {
      const r = R.reglaDeGrupo(trsPista, g.id);
      return [g.id, {
        velocidad: r?.velocidad ? fmtLibre(r.velocidad) : '',
        trs: r?.trs ? R.fmt(r.trs) : ''
      }];
    }))
  };
}

// TRS de la pista, uno por grupo de altura (Small/Midi e Intermediate/Large
// suelen ir a velocidades distintas), con el largo compartido. Como en la
// planilla, largo ÷ velocidad propone el TRS en el momento en que se tocan;
// después el TRS es un campo más, y lo que diga es lo que se guarda.
export default function TrsPista({ snap, accion, mostrar }) {
  // Lo tipeado, por pista, hasta que se guarda.
  const [borradores, setBorradores] = useState({});
  if (!snap.pista || !snap.lista.length) return null;

  const pid = snap.pista.id;
  const grupos = gruposDe(snap.lista);
  const v = borradores[pid] || desdeSnap(snap.trs, grupos);
  const poner = n => setBorradores(b => ({ ...b, [pid]: n }));

  // Cuenta de un grupo con el largo y la velocidad dados; si no da, deja el TRS como está.
  const cuenta = (largo, g) => {
    const t = R.trsDe(R.leerNumero(largo), R.leerNumero(g.velocidad));
    return t ? { ...g, trs: R.fmt(t) } : g;
  };
  const cambiarLargo = largo => poner({
    largo,
    grupos: Object.fromEntries(Object.entries(v.grupos).map(([id, g]) => [id, cuenta(largo, g)]))
  });
  const cambiarGrupo = (id, cambios, recalcular) => {
    const g = { ...v.grupos[id], ...cambios };
    poner({ ...v, grupos: { ...v.grupos, [id]: recalcular ? cuenta(v.largo, g) : g } });
  };

  async function guardar() {
    if (!(await accion('trs', { pistaId: pid, largo: v.largo, grupos: v.grupos }))) return;
    setBorradores(b => { const n = { ...b }; delete n[pid]; return n; });
    const alguno = v.largo || Object.values(v.grupos).some(g => g.trs || g.velocidad);
    mostrar(alguno ? 'TRS guardado. Los resultados se recalcularon.' : 'TRS borrado.');
  }

  const campo = (nombre, aria, unidad, valor, onChange) => (
    <label>{nombre} <input type="text" inputMode="decimal" autoComplete="off" placeholder="—" aria-label={aria}
                           value={valor} onChange={e => onChange(e.target.value)} /> {unidad}</label>
  );

  return (
    <section className="mesa-seccion">
      <p className="eyebrow">TRS · {snap.pista.nombre}</p>
      <p className="mesa-actual-sub" style={{ margin: '8px 0 6px' }}>
        Uno por altura. Con largo y velocidad se calcula, como en la planilla; si el juez
        da otro, tipealo encima. Cada segundo por encima del TRS suma un punto.
      </p>
      <div className="trs-fila">
        {campo('Largo', 'Largo', 'm', v.largo, cambiarLargo)}
      </div>
      {grupos.map(g => (
        <div key={g.id} className="trs-fila">
          <span className="trs-grupo">{g.nombre}</span>
          {campo('Velocidad', `Velocidad ${g.nombre}`, 'm/s', v.grupos[g.id]?.velocidad ?? '',
            velocidad => cambiarGrupo(g.id, { velocidad }, true))}
          {campo('TRS', `TRS ${g.nombre}`, 's', v.grupos[g.id]?.trs ?? '',
            trs => cambiarGrupo(g.id, { trs }, false))}
        </div>
      ))}
      <div className="trs-fila">
        <BotonCarga className="btn chico" style={{ background: 'var(--chalk)', color: 'var(--turf)' }} onClick={guardar}>
          Guardar TRS
        </BotonCarga>
      </div>
    </section>
  );
}
