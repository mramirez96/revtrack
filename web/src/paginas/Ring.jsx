import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import * as R from '../../../shared/resultados.mjs';
import { pedirSnapshot, RingInexistente as NoExiste } from '../lib/api.js';
import { useCanal } from '../lib/realtime.js';
import { esMio, guardado, minutos, plural, reloj } from '../lib/formato.js';
import { Aviso, Dorsal, Etiquetas, RingInexistente, Tope, useAviso } from '../componentes/comunes.jsx';
import Clasificacion, { ResultadoCorto } from '../componentes/Clasificacion.jsx';

const cacheKey = (ringId, pistaId) => `snap:${ringId}:${pistaId || 'activa'}`;

function leerCache(ringId, pistaId) {
  try {
    const c = JSON.parse(guardado.leer(cacheKey(ringId, pistaId)));
    return c && c.snap ? c : null;
  } catch { return null; }
}

// La vista del corredor: quién está en pista, cuántos faltan para su turno y
// el orden entero (o la clasificación). Abre aunque el campo no tenga señal:
// lo último que se vio queda en localStorage.
export default function Ring() {
  const { ringId } = useParams();
  const [params, setParams] = useSearchParams();
  // Qué pista se mira. Sin `?pista=` es la que está corriendo.
  const pistaId = params.get('pista') || null;
  const [estado, setEstado] = useState(() => leerCache(ringId, pistaId) || { snap: null, recibidoEn: 0 });
  const [inexistente, setInexistente] = useState(false);
  const [aviso, mostrar] = useAviso();
  const [, setTick] = useState(0);
  // Lo que el corredor puso para reconocerse: su dorsal, o el nombre del perro
  // donde no se reparten números. Lo usan "Tu turno" y la lista (para "vos").
  const [clave, setClaveEstado] = useState(() => guardado.leer('miClave') || guardado.leer('miDorsal') || '');
  const setClave = v => {
    setClaveEstado(v);
    if (v) guardado.escribir('miClave', v);
    else { guardado.borrar('miClave'); guardado.borrar('miDorsal'); }
  };
  const { snap, recibidoEn } = estado;

  const recibir = useCallback(s => {
    const nuevo = { snap: s, recibidoEn: Date.now() };
    setEstado(nuevo);
    guardado.escribir(cacheKey(ringId, pistaId), JSON.stringify(nuevo));
  }, [ringId, pistaId]);

  const cargar = useCallback(async () => {
    try {
      recibir(await pedirSnapshot(ringId, pistaId));
    } catch (e) {
      if (e instanceof NoExiste) setInexistente(true);
      else mostrar('No pude conectarme al servidor.', true);
    }
  }, [ringId, pistaId, recibir, mostrar]);
  useEffect(() => { cargar(); }, [cargar]);

  // El broadcast manda un snapshot por cada pista del ring: sólo importa el de
  // la que se mira (o, sin elegir, el de la activa en este momento).
  const conectado = useCanal(`ring:${ringId}`, {
    snapshot: s => { if (pistaId ? s.pista?.id === pistaId : s.esActiva) recibir(s); }
  });
  // La mesa cargó otra competencia: lo que está en pantalla ya no existe.
  useCanal('global', {
    recargar: () => { guardado.borrar(cacheKey(ringId, pistaId)); location.reload(); }
  });

  // Los navegadores de celular pausan el websocket con la pestaña en segundo
  // plano; al volver, un pedido nuevo es más seguro que confiar en que no se
  // perdió nada.
  useEffect(() => {
    const volver = () => { if (!document.hidden) cargar(); };
    document.addEventListener('visibilitychange', volver);
    return () => document.removeEventListener('visibilitychange', volver);
  }, [cargar]);

  // Refresca "hace cuánto" y las horas estimadas aunque no llegue nada nuevo.
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 15000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (snap) document.title = snap.pista ? `${snap.pista.nombre} · ${snap.ring.nombre}` : `${snap.ring.nombre} · RevTrack`;
  }, [snap]);

  if (inexistente) return <main><RingInexistente ringId={ringId} /></main>;

  const seg = Math.round((Date.now() - recibidoEn) / 1000);
  const texto = !snap ? 'conectando'
    : conectado ? 'en vivo'
      : seg < 90 ? 'sin señal' : `sin señal · ${minutos(seg)} atrás`;

  const verPista = id => setParams(p => { const n = new URLSearchParams(p); n.set('pista', id); return n; }, { replace: true });

  return <>
    <Tope ring={snap?.ring.nombre ?? '—'} pista={snap ? (snap.pista?.nombre ?? 'sin pista abierta') : ''}
          conectado={!!snap && conectado} texto={texto} />
    {snap && <>
      <PistasNav snap={snap} verPista={verPista} />
      <EnPista snap={snap} />
      <Turno snap={snap} clave={clave} setClave={setClave} />
      <Cola snap={snap} clave={clave} />
    </>}
    <Aviso aviso={aviso} />
  </>;
}

// Selector de pistas del ring: deja mirar el orden de cualquiera, no sólo la
// que está corriendo.
function PistasNav({ snap, verPista }) {
  if (!snap.pistas || snap.pistas.length < 2) return null;
  return (
    <nav className="pistas-nav">
      <div className="wrap">
        {snap.pistas.map(p => (
          <button key={p.id} onClick={() => verPista(p.id)}
                  className={`chip ${p.id === snap.pista?.id ? 'activa' : ''} ${p.estado === 'cerrada' ? 'cerrada' : ''}`}>
            {p.nombre}{p.id === snap.activa?.id ? ' ·' : ''}
          </button>
        ))}
      </div>
    </nav>
  );
}

function EnPista({ snap }) {
  const lista = snap.lista;
  const enPista = lista.find(i => i.estado === 'en_pista');
  const pendientes = lista.filter(i => i.estado === 'pendiente');
  let cuerpo;
  if (enPista) {
    cuerpo = (
      <div className="pista-fila">
        <Dorsal i={enPista} className="dorsal pista-dorsal" />
        <span className="pista-quien">
          <span className="pista-nombre">{enPista.perro}</span>
          <span className="pista-sub">{enPista.guia}{enPista.raza ? ` · ${enPista.raza}` : ''}<Etiquetas i={enPista} /></span>
        </span>
      </div>
    );
  } else if (!snap.pista?.arrancada && pendientes.length) {
    // Una pista que todavía no largó: no hay "nadie en pista", no arrancó.
    cuerpo = <>
      <p className="pista-vacia">Todavía no arrancó</p>
      <p className="pista-nota">{lista.length} {plural(lista.length, 'anotado', 'anotados')}
        {snap.activa && !snap.esActiva ? ` · ahora corre ${snap.activa.nombre}` : ''}</p>
    </>;
  } else if (pendientes.length) {
    cuerpo = <>
      <p className="pista-vacia">Nadie en pista</p>
      <p className="pista-nota">Faltan {pendientes.length} {plural(pendientes.length, 'perro', 'perros')} en esta pista</p>
    </>;
  } else {
    cuerpo = <>
      <p className="pista-vacia">Pista terminada</p>
      <p className="pista-nota">{snap.pistas.some(p => p.estado === 'pendiente')
        ? 'Esperando que la mesa abra la siguiente' : 'No queda nada más por correr'}</p>
    </>;
  }
  return (
    <section className="pista">
      <div className="wrap"><p className="eyebrow">En pista</p><div>{cuerpo}</div></div>
    </section>
  );
}

// Marcas de conteo agrupadas de a cinco: una raya por perro que falta.
function Tally({ n }) {
  if (n === 0) return null;
  const tope = Math.min(n, 30);
  const grupos = [];
  for (let g = 0; g < Math.ceil(tope / 5); g++) {
    const rayas = [];
    for (let i = g * 5; i < Math.min((g + 1) * 5, tope); i++) rayas.push(<i key={i} className={(i + 1) % 5 === 0 ? 'alta' : ''} />);
    grupos.push(<span key={g} className="tally-grupo">{rayas}</span>);
  }
  return <div className="tally" aria-hidden="true">{grupos}{n > tope && <span className="tally-mas">+{n - tope}</span>}</div>;
}

function Turno({ snap, clave, setClave }) {
  const [tipeado, setTipeado] = useState('');
  const lista = snap.lista;
  const pendientes = lista.filter(i => i.estado === 'pendiente');

  const guardar = () => { if (tipeado.trim()) setClave(tipeado.trim()); };
  const cambiar = () => { setClave(''); setTipeado(''); };

  // En una pista sin dorsales (los G0) se pide el nombre del perro; en una con
  // números, el dorsal. Si hay de los dos, se aclara.
  const conDorsal = lista.some(i => i.dorsal);
  const sinDorsal = lista.some(i => !i.dorsal);
  const pide = conDorsal && sinDorsal
    ? { texto: 'Poné tu dorsal, o el nombre de tu perro si no tenés número', ph: '47', modo: 'text', etiq: 'Tu dorsal o el nombre de tu perro' }
    : conDorsal
      ? { texto: 'Poné tu dorsal', ph: '47', modo: 'numeric', etiq: 'Tu dorsal' }
      : { texto: 'Poné el nombre de tu perro', ph: 'OREO', modo: 'text', etiq: 'El nombre de tu perro' };

  const boton = <div className="dorsal-set"><button className="btn fantasma chico" onClick={cambiar}>Cambiar ({clave})</button></div>;
  let clase = 'turno';
  let cuerpo;

  if (!clave) {
    cuerpo = <>
      <p className="cuenta-txt" style={{ marginTop: 6 }}>{pide.texto} y te digo cuántos perros faltan para que te toque.</p>
      <form className="dorsal-set" onSubmit={e => { e.preventDefault(); guardar(); }}>
        <input type="text" inputMode={pide.modo} placeholder={pide.ph} aria-label={pide.etiq}
               value={tipeado} onChange={e => setTipeado(e.target.value)} />
        <button className="btn" type="submit">Guardar</button>
      </form>
    </>;
  } else {
    const mio = lista.find(i => esMio(i, clave));
    if (!mio) {
      cuerpo = <>
        <p className="cuenta-txt" style={{ marginTop: 6 }}>{clave} no está en esta pista.</p>
        <p className="cuenta-sub">Puede ser que corras en otra pista.</p>{boton}
      </>;
    } else if (mio.estado === 'en_pista') {
      clase = 'turno es-vos';
      cuerpo = <>
        <div className="cuenta"><span className="dorsal cuenta-n">Ya</span>
          <span className="cuenta-txt">Estás en pista.<br /><span className="cuenta-sub">Suerte.</span></span></div>{boton}
      </>;
    } else if (mio.estado !== 'pendiente') {
      clase = 'turno ya';
      cuerpo = <>
        {mio.estado === 'ausente'
          ? <p className="cuenta-txt" style={{ marginTop: 6 }}>Figurás como ausente en esta pista.</p>
          : <MiResultado mio={mio} snap={snap} />}
        {boton}
      </>;
    } else if (!snap.pista?.arrancada) {
      // La pista no largó: la hora estimada sería inventada. La posición sí es firme.
      cuerpo = <>
        <div className="cuenta">
          <span className="dorsal cuenta-n">{pendientes.indexOf(mio) + 1}º</span>
          <span className="cuenta-txt">de {pendientes.length} en esta pista
            <br /><span className="cuenta-sub">Todavía no arrancó{
              snap.activa && !snap.esActiva ? `; ahora corre ${snap.activa.nombre}` : ''}.</span>
          </span>
        </div>
        <p className="cuenta-sub">Cuando la mesa la abra vas a ver cuántos perros faltan y a qué hora aproximada te toca.</p>
        {boton}
      </>;
    } else {
      const faltan = pendientes.indexOf(mio);
      const seg = faltan * snap.segPerro;
      clase = 'turno es-vos';
      cuerpo = <>
        <div className="cuenta">
          <span className="dorsal cuenta-n">{faltan}</span>
          <span className="cuenta-txt">{faltan === 0 ? 'Sos el próximo.' : `${plural(faltan, 'perro', 'perros')} antes que vos`}
            <br /><span className="cuenta-sub">{faltan === 0 ? 'Andá al ingreso.' : `aprox. ${minutos(seg)} · cerca de las ${reloj(seg)}`}</span>
          </span>
        </div>
        <Tally n={faltan} />
        <p className="cuenta-sub">{snap.estimadoRealista
          ? `Calculado con el ritmo real de la pista: ${snap.segPerro} s por perro.`
          : `Estimado con ${snap.segPerro} s por perro. Se ajusta cuando la pista arranca.`}</p>
        {boton}
      </>;
    }
  }

  return (
    <section className={clase} data-testid="turno">
      <div className="wrap"><p className="eyebrow">Tu turno</p>{cuerpo}</div>
    </section>
  );
}

function MiResultado({ mio, snap }) {
  if (!mio.res) {
    return <>
      <p className="cuenta-txt" style={{ marginTop: 6 }}>Ya corriste esta pista.</p>
      <p className="cuenta-sub">Tu resultado todavía no está cargado.</p>
    </>;
  }
  const podio = (snap.clasificacion || []).find(p => p.filas.some(f => f.id === mio.id));
  return <>
    <div className="cuenta">
      <span className="dorsal cuenta-n">{mio.puesto ? `${mio.puesto}º` : 'DESC'}</span>
      <span className="cuenta-txt">{mio.puesto ? `de ${podio.clasificados} en ${mio.podio}` : `Descalificado en ${mio.podio}`}
        <br /><span className="cuenta-sub">{R.resumenCorto(mio.res)} · {R.desglose(mio.res)}</span>
      </span>
    </div>
    {podio?.faltan > 0 && (
      <p className="cuenta-sub">Provisorio: {podio.faltan === 1 ? 'falta 1' : `faltan ${podio.faltan}`} por correr en tu podio.</p>
    )}
  </>;
}

const MARCA = {
  corrido: { clase: 'corrido', nota: 'corrió' },
  en_pista: { clase: 'corriendo', nota: 'en pista' },
  ausente: { clase: 'ausente', nota: 'ausente' }
};

// Orden de salida o clasificación. La pestaña sólo aparece cuando hay algún
// resultado: antes, "Clasificación" sería una pantalla vacía.
function Cola({ snap, clave }) {
  const [vista, setVista] = useState(() => (guardado.leer('vista') === 'clasif' ? 'clasif' : 'orden'));
  const hay = (snap.clasificacion || []).some(p => p.filas.length);
  const enClasif = hay && vista === 'clasif';
  const elegir = v => { setVista(v); guardado.escribir('vista', v); };

  return (
    <section className="cola">
      <div className="wrap">
        {hay ? (
          <div className="vista-tabs">
            <button className={`tab ${enClasif ? '' : 'activa'}`} onClick={() => elegir('orden')}>Orden de salida</button>
            <button className={`tab ${enClasif ? 'activa' : ''}`} onClick={() => elegir('clasif')}>Clasificación</button>
          </div>
        ) : <p className="eyebrow">Orden de salida</p>}
        {enClasif ? <Clasificacion snap={snap} clave={clave} /> : <Orden snap={snap} clave={clave} />}
        <p className="pie"><Link to="/">Ver todas las pistas</Link></p>
        <p className="firma">RevTrack · Powered by Revamp</p>
      </div>
    </section>
  );
}

// La pista entera en orden de salida: los que ya corrieron grisados (con su
// resultado, si está), el que está en pista marcado, y los que faltan con su
// hora estimada.
function Orden({ snap, clave }) {
  const lista = snap.lista;
  if (!lista.length) return <ul className="cola-lista"><li className="vacio">Esta pista no tiene a nadie anotado.</li></ul>;
  const pendientes = lista.filter(i => i.estado === 'pendiente');
  return (
    <ul className="cola-lista" data-testid="orden">
      {lista.map(i => {
        const marca = MARCA[i.estado];
        const idx = pendientes.indexOf(i);
        const clases = ['cola-item'];
        if (esMio(i, clave)) clases.push('vos');
        if (marca) clases.push(marca.clase);
        return (
          <li key={i.id} className={clases.join(' ')}>
            <Dorsal i={i} />
            <span className="cola-quien">
              <span className="cola-nombre">{i.perro}</span><br />
              <span className="cola-sub">{i.guia}<Etiquetas i={i} /></span>
            </span>
            {i.res ? <ResultadoCorto res={i.res} regla={snap.trs} /> : (
              <span className="cola-eta mono">{marca
                ? marca.nota
                : snap.pista?.arrancada ? reloj(idx * snap.segPerro) : `${idx + 1}º`}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
