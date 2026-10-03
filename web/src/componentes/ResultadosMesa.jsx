import { useEffect, useRef, useState } from 'react';
import * as R from '../../../shared/resultados.mjs';
import { BotonCarga, Dorsal, Etiquetas } from './comunes.jsx';

// Todo lo de cargar resultados en la mesa. El flujo normal vive arriba, en la
// tarjeta del perro en pista: tiempo, faltas, negativas y "Guardar y largar el
// siguiente", que guarda y avanza el orden en un solo paso. Abajo quedan las
// correcciones: los que corrieron sin resultado y los ya cargados.

function borradorDe(i) {
  const r = i.resultado;
  return {
    tiempo: r && r.tiempo !== null ? R.fmt(r.tiempo) : '',
    faltas: r ? r.faltas : 0,
    rehuses: r ? r.rehuses : 0,
    eliminado: r ? r.eliminado : false
  };
}

const nombrePodio = i => i.podio || R.podioDe(i).nombre;

// La penalización de lo que está tipeado, antes de guardar: el mismo cálculo
// que el servidor (shared/resultados.mjs), así lo que se ve es lo que va a quedar.
function vistaPrevia(b, regla) {
  const t = R.leerNumero(b.tiempo);
  if (!b.eliminado && t === null) return b.tiempo.trim() ? 'El tiempo no es un número.' : 'Falta el tiempo.';
  const calc = R.calcular({ tiempo: t, faltas: b.faltas, rehuses: b.rehuses, eliminado: b.eliminado }, regla);
  if (calc.eliminado) return `→ ${R.desglose(calc)} · No clasifica`;
  return `→ F: ${R.fmt(calc.total)} · ${calc.calif} · ${R.desglose(calc)} · ${
    regla?.trs ? `TRS ${R.fmt(regla.trs)} s` : 'sin TRS cargado'}`;
}

/* ── estado compartido ───────────────────────────────────────────────── */

// Guardar salta en el acto: el perro se da por guardado mientras el pedido
// viaja (y, si avanza, ya se muestra el siguiente en pista). Si el servidor lo
// rechaza, vuelve a ese perro con lo que se había tipeado.
export function useResultados(accion, mostrar) {
  // Mandados y todavía sin respuesta.
  const [guardando, setGuardando] = useState(() => new Set());
  // Lo tipeado de un guardado que falló, para no hacerlo tipear de nuevo.
  const [restaurar, setRestaurar] = useState({});
  // Después de guardar, el cursor queda en el tiempo del próximo.
  const [enfocar, setEnfocar] = useState(false);

  async function guardar(i, b, { avanzar }) {
    setGuardando(s => new Set(s).add(i.id));
    setEnfocar(avanzar);
    const ok = await accion('resultado', {
      id: i.id, tiempo: b.tiempo, faltas: b.faltas, rehuses: b.rehuses, eliminado: b.eliminado, avanzar
    });
    setGuardando(s => { const n = new Set(s); n.delete(i.id); return n; });
    setRestaurar(r => { const n = { ...r }; if (ok) delete n[i.id]; else n[i.id] = b; return n; });
    if (ok) mostrar(avanzar ? `Guardado: ${i.perro}. Entra el siguiente.` : `Guardado: ${i.perro}.`, false, 2500);
    return ok;
  }

  async function borrar(i) {
    if (!confirm(`¿Borrar el resultado de ${i.perro}?`)) return false;
    const ok = await accion('resultado', { id: i.id, borrar: true });
    if (ok) mostrar(`Resultado de ${i.perro} borrado.`);
    return ok;
  }

  return { guardando, restaurar, enfocar, enfocado: () => setEnfocar(false), guardar, borrar, mostrar };
}

/* ── formulario ──────────────────────────────────────────────────────── */

function Contador({ nombre, valor, onChange }) {
  return (
    <div className="res-campo"><span>{nombre}</span>
      <div className="res-cont">
        <button type="button" className="iconbtn" aria-label={`Restar ${nombre.toLowerCase()}`} disabled={!valor}
                onClick={() => onChange(Math.max(0, valor - 1))}>−</button>
        <b className="mono">{valor}</b>
        <button type="button" className="iconbtn" aria-label={`Sumar ${nombre.toLowerCase()}`}
                onClick={() => onChange(valor + 1)}>+</button>
      </div>
    </div>
  );
}

// Lo tipeado vive acá adentro; quien lo usa le pone `key={perro.id}`, así cada
// perro arranca con su propio borrador (o con lo que había quedado de un
// guardado que falló).
function FormResultado({ perro, res, regla, grande, textoBoton, onGuardar, extra, enfocar }) {
  const [b, setB] = useState(() => res.restaurar[perro.id] || borradorDe(perro));
  const tiempo = useRef(null);
  const cambiar = c => setB(x => ({ ...x, ...c }));

  useEffect(() => {
    if (enfocar && res.enfocar && tiempo.current) { tiempo.current.focus(); res.enfocado(); }
  }, [enfocar, res]);

  function guardar() {
    // Lo que el servidor va a rechazar seguro se frena acá, antes de saltar.
    if (!b.eliminado && R.leerNumero(b.tiempo) === null) {
      res.mostrar(b.tiempo.trim() ? 'El tiempo no es un número.' : 'Falta el tiempo.', true);
      return;
    }
    onGuardar(b);
  }

  return (
    <div className={grande ? 'res-form grande' : 'res-form'}>
      <div className="res-campos">
        <label className="res-campo"><span>Tiempo (s)</span>
          <input ref={tiempo} type="text" inputMode="decimal" autoComplete="off" placeholder="38,52"
                 aria-label="Tiempo" value={b.tiempo}
                 onChange={e => cambiar({ tiempo: e.target.value })}
                 onKeyDown={e => { if (e.key === 'Enter') guardar(); }} />
        </label>
        <Contador nombre="Faltas" valor={b.faltas} onChange={faltas => cambiar({ faltas })} />
        <Contador nombre="Negativas" valor={b.rehuses} onChange={rehuses => cambiar({ rehuses })} />
      </div>
      <label className="orden-check res-elim">
        <input type="checkbox" checked={b.eliminado} onChange={e => cambiar({ eliminado: e.target.checked })} /> Descalificado
      </label>
      <p className="res-previa mono">{vistaPrevia(b, regla)}</p>
      <div className="res-btns">
        <button className={grande ? 'mesa-btn' : 'btn'} onClick={guardar}
                style={grande ? undefined : { background: 'var(--chalk)', color: 'var(--turf)' }}>
          {textoBoton}
        </button>
        {extra}
      </div>
    </div>
  );
}

/* ── arriba: el perro en pista ───────────────────────────────────────── */

// El que decide no correr no se marca "ausente": en la planilla del club va
// igual que un eliminado ("No clasifica"), así que se tilda Descalificado.
export function EnPistaMesa({ snap, res, accion }) {
  const otra = !snap.esActiva;
  const lista = snap.lista;
  const enPista = lista.find(i => i.estado === 'en_pista');
  const pendientes = lista.filter(i => i.estado === 'pendiente');
  // Mientras viaja "guardar y largar el siguiente", ya se muestra al siguiente.
  const actual = enPista && !otra && res.guardando.has(enPista.id) ? pendientes[0] : enPista;

  let cuerpo;
  if (actual) {
    cuerpo = <>
      <div className="mesa-actual-fila">
        <Dorsal i={actual} />
        <span><span className="mesa-actual-nombre">{actual.perro}</span><br />
          <span className="mesa-actual-sub">{actual.guia}<Etiquetas i={actual} /> · {nombrePodio(actual)}</span></span>
      </div>
      <FormResultado key={actual.id} perro={actual} res={res} regla={snap.trs} grande enfocar
                     textoBoton={otra ? 'Guardar resultado' : 'Guardar y largar el siguiente'}
                     onGuardar={b => res.guardar(actual, b, { avanzar: !otra })} />
    </>;
  } else {
    cuerpo = (
      <p className="mesa-actual-nombre" style={{ marginTop: 6 }}>
        {!snap.pista?.arrancada ? 'Todavía no arrancó' : pendientes.length ? 'Nadie en pista' : 'Pista terminada'}
      </p>
    );
  }

  return <>
    <section className="mesa-actual" data-testid="en-pista">
      <p className="eyebrow">{otra ? snap.pista?.nombre : 'En pista'}</p>
      {cuerpo}
    </section>

    {/* Los botones de avanzar no existen mirando otra pista: "Siguiente" siempre
        actúa sobre la que corre, y tenerlo a mano acá es la forma segura de
        largar la equivocada sin darse cuenta. */}
    {!otra && (actual ? (
      <div className="mesa-secundarios">
        <BotonCarga className="mesa-btn secundario chico" onClick={() => accion('siguiente')}>
          Siguiente sin resultado
        </BotonCarga>
      </div>
    ) : pendientes.length > 0 && (
      <div className="mesa-botones">
        <BotonCarga className="mesa-btn" onClick={() => accion('siguiente')}>Largar el primero</BotonCarga>
      </div>
    ))}
  </>;
}

/* ── abajo: completar y corregir ─────────────────────────────────────── */

export function CorregirResultados({ snap, res }) {
  const [editando, setEditando] = useState(null);
  const [todos, setTodos] = useState(false);
  const corridos = snap.lista.filter(i => i.estado === 'corrido');
  if (!corridos.length) return null;

  const sinResultado = corridos.filter(i => !i.resultado && !res.guardando.has(i.id));
  // Los más recientes primero: lo que se corrige suele ser lo último cargado.
  const cargados = corridos.filter(i => i.resultado).reverse();
  const visibles = todos ? cargados : cargados.slice(0, 5);
  const ed = editando && corridos.find(i => i.id === editando);

  async function guardar(b) {
    const perro = ed;
    setEditando(null);
    if (!(await res.guardar(perro, b, { avanzar: false }))) setEditando(perro.id);
  }

  return (
    <section className="mesa-seccion">
      <p className="eyebrow">Resultados{sinResultado.length ? ` · faltan cargar ${sinResultado.length}` : ''}</p>

      {ed && (
        <div className="res-editor" data-testid="editor-correccion">
          <div className="mesa-actual-fila">
            <Dorsal i={ed} />
            <span><span className="mesa-item-quien">{ed.perro}</span><br />
              <span className="mesa-item-sub">{ed.guia}<Etiquetas i={ed} /> · {nombrePodio(ed)}</span></span>
          </div>
          <FormResultado key={ed.id} perro={ed} res={res} regla={snap.trs} textoBoton="Guardar resultado"
                         onGuardar={guardar}
                         extra={<>
                           {ed.resultado && (
                             <BotonCarga className="mesa-link" onClick={async () => { if (await res.borrar(ed)) setEditando(null); }}>
                               Borrar resultado
                             </BotonCarga>
                           )}
                           <button className="mesa-link" onClick={() => setEditando(null)}>Cancelar</button>
                         </>} />
        </div>
      )}

      {sinResultado.length > 0 && <>
        <p className="mesa-actual-sub" style={{ margin: '10px 0 0' }}>Corrieron sin resultado · tocá uno para cargarlo:</p>
        <div className="mesa-pistas">
          {sinResultado.map(i => (
            <button key={i.id} className={`chip ${i.id === editando ? 'activa' : ''}`} onClick={() => setEditando(i.id)}>
              {i.dorsal || i.perro}
            </button>
          ))}
        </div>
      </>}

      {cargados.length > 0 && <>
        <p className="mesa-actual-sub" style={{ margin: '14px 0 0' }}>Cargados · tocá uno para corregirlo</p>
        <ul className="mesa-lista">
          {visibles.map(i => (
            <li key={i.id} className={`mesa-item ${i.id === editando ? 'viendo' : ''}`}>
              <Dorsal i={i} />
              <button className="mesa-pista-sel" onClick={() => setEditando(i.id)}>
                {i.perro}
                <span className="mesa-item-sub">
                  {R.resumenCorto(i.res)}{i.puesto ? ` · ${i.puesto}º en ${i.podio}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {cargados.length > 5 && (
          <button className="mesa-link" onClick={() => setTodos(!todos)}>
            {todos ? 'Ver sólo los últimos' : `Ver los ${cargados.length}`}
          </button>
        )}
      </>}
    </section>
  );
}
