import { useEffect, useRef, useState } from 'react';
import * as R from '../../../shared/resultados.mjs';
import { BotonCarga, Dorsal, Etiquetas } from './comunes.jsx';

const corrio = i => i.estado === 'corrido' || i.estado === 'en_pista';

function borradorDe(i) {
  const r = i.resultado;
  return {
    id: i.id,
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
  return `→ ${R.fmt(calc.total)} pen. · ${calc.calif} · ${R.desglose(calc)} · ${
    regla?.trs ? `TRS ${R.fmt(regla.trs)} s` : 'sin TRS cargado'}`;
}

function Contador({ nombre, valor, onChange }) {
  return (
    <div className="res-campo"><span>{nombre}</span>
      <div className="res-cont">
        <button className="iconbtn" aria-label={`Restar ${nombre.toLowerCase()}`} disabled={!valor}
                onClick={() => onChange(Math.max(0, valor - 1))}>−</button>
        <b className="mono">{valor}</b>
        <button className="iconbtn" aria-label={`Sumar ${nombre.toLowerCase()}`}
                onClick={() => onChange(valor + 1)}>+</button>
      </div>
    </div>
  );
}

// Carga de resultados. Nunca traba "Siguiente": propone al último que corrió
// sin resultado (el que acaba de salir de la pista) y, al guardar, salta en el
// acto al próximo —el guardado sigue en segundo plano y, si el servidor lo
// rechaza, vuelve a ese perro con lo que se había tipeado.
export default function EditorResultado({ snap, accion, mostrar }) {
  const [editando, setEditando] = useState(null);
  const [borrador, setBorrador] = useState(null);
  // Mandados y todavía sin respuesta: se los trata como cargados, así un
  // snapshot que llegue en el medio no hace volver a la mesa a ese perro.
  const [guardando, setGuardando] = useState(() => new Set());
  const [todos, setTodos] = useState(false);
  const [enfocar, setEnfocar] = useState(false);
  const tiempoRef = useRef(null);

  const corrieron = snap.lista.filter(corrio);
  const sinResultado = corrieron.filter(i => !i.resultado && !guardando.has(i.id));
  const objetivo = (editando && corrieron.find(i => i.id === editando))
    || sinResultado.filter(i => i.estado === 'corrido').at(-1)
    || sinResultado.find(i => i.estado === 'en_pista')
    || null;
  const b = objetivo ? (borrador && borrador.id === objetivo.id ? borrador : borradorDe(objetivo)) : null;
  const cambiar = cambios => setBorrador({ ...b, ...cambios });

  // Después de guardar, el cursor queda listo para el tiempo del siguiente.
  useEffect(() => {
    if (enfocar) { tiempoRef.current?.focus(); setEnfocar(false); }
  }, [enfocar, objetivo?.id]);

  const sacar = id => setGuardando(s => { const n = new Set(s); n.delete(id); return n; });

  async function guardar() {
    // Lo que el servidor va a rechazar seguro se frena acá, antes de saltar.
    if (!b.eliminado && R.leerNumero(b.tiempo) === null) {
      mostrar(b.tiempo.trim() ? 'El tiempo no es un número.' : 'Falta el tiempo.', true);
      return;
    }
    const i = objetivo;
    const tipeado = b;
    setGuardando(s => new Set(s).add(i.id));
    setEditando(null);
    setBorrador(null);
    setEnfocar(true);
    const ok = await accion('resultado', {
      id: i.id, tiempo: tipeado.tiempo, faltas: tipeado.faltas, rehuses: tipeado.rehuses, eliminado: tipeado.eliminado
    });
    sacar(i.id);
    if (!ok) {
      setEditando(i.id);
      setBorrador(tipeado);
      return;
    }
    mostrar(`Guardado: ${i.perro}.`, false, 1800);
  }

  async function borrar() {
    if (!confirm(`¿Borrar el resultado de ${objetivo.perro}?`)) return;
    if (await accion('resultado', { id: objetivo.id, borrar: true })) {
      setEditando(null);
      setBorrador(null);
      mostrar(`Resultado de ${objetivo.perro} borrado.`);
    }
  }

  const editar = id => { setEditando(id); setBorrador(null); };

  if (!snap.pista?.arrancada) return null;
  const otrosSin = sinResultado.filter(i => i.id !== objetivo?.id);
  // Los más recientes primero: lo que se corrige suele ser lo último cargado.
  const cargados = corrieron.filter(i => i.resultado).reverse();
  const visibles = todos ? cargados : cargados.slice(0, 5);

  return (
    <section className="mesa-seccion">
      <p className="eyebrow">Resultado{sinResultado.length ? ` · faltan cargar ${sinResultado.length}` : ''}</p>
      {objetivo ? (
        <div className="res-editor" data-testid="editor-resultado">
          <div className="mesa-actual-fila">
            <Dorsal i={objetivo} />
            <span><span className="mesa-item-quien">{objetivo.perro}</span><br />
              <span className="mesa-item-sub">
                {objetivo.guia}<Etiquetas i={objetivo} /> · {nombrePodio(objetivo)}
                {objetivo.estado === 'en_pista' ? ' · en pista' : ''}
              </span>
            </span>
          </div>
          <div className="res-campos">
            <label className="res-campo"><span>Tiempo (s)</span>
              <input ref={tiempoRef} type="text" inputMode="decimal" autoComplete="off" placeholder="38,52"
                     aria-label="Tiempo" value={b.tiempo}
                     onChange={e => cambiar({ tiempo: e.target.value })}
                     onKeyDown={e => { if (e.key === 'Enter') guardar(); }} />
            </label>
            <Contador nombre="Faltas" valor={b.faltas} onChange={faltas => cambiar({ faltas })} />
            <Contador nombre="Negativas" valor={b.rehuses} onChange={rehuses => cambiar({ rehuses })} />
          </div>
          <label className="orden-check">
            <input type="checkbox" checked={b.eliminado} onChange={e => cambiar({ eliminado: e.target.checked })} /> Eliminado
          </label>
          <p className="res-previa mono">{vistaPrevia(b, snap.trs)}</p>
          <div className="res-btns">
            <button className="btn" style={{ background: 'var(--chalk)', color: 'var(--turf)' }} onClick={guardar}>
              Guardar resultado
            </button>
            {objetivo.resultado && <BotonCarga className="mesa-link" onClick={borrar}>Borrar resultado</BotonCarga>}
            {editando && <button className="mesa-link" onClick={() => editar(null)}>Cancelar</button>}
          </div>
        </div>
      ) : (
        <p className="mesa-actual-sub" style={{ marginTop: 8 }}>Todos los que corrieron tienen su resultado.</p>
      )}

      {otrosSin.length > 0 && <>
        <p className="mesa-actual-sub" style={{ margin: '14px 0 0' }}>También {otrosSin.length === 1 ? 'falta' : 'faltan'}:</p>
        <div className="mesa-pistas">
          {otrosSin.map(i => <button key={i.id} className="chip" onClick={() => editar(i.id)}>{i.dorsal || i.perro}</button>)}
        </div>
      </>}

      {cargados.length > 0 && <>
        <p className="mesa-actual-sub" style={{ margin: '14px 0 0' }}>Cargados · tocá uno para corregirlo</p>
        <ul className="mesa-lista">
          {visibles.map(i => (
            <li key={i.id} className={`mesa-item ${i.id === objetivo?.id ? 'viendo' : ''}`}>
              <Dorsal i={i} />
              <button className="mesa-pista-sel" onClick={() => editar(i.id)}>
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
