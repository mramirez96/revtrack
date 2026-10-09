import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { enviar, pedirSnapshot, RingInexistente as NoExiste } from '../lib/api.js';
import { useCanal } from '../lib/realtime.js';
import { guardado } from '../lib/formato.js';
import {
  Aviso, BotonCarga, Dorsal, Etiquetas, RingInexistente, Tope, useAviso
} from '../componentes/comunes.jsx';
import { CorregirResultados, EnPistaMesa, useResultados } from '../componentes/ResultadosMesa.jsx';
import TrsPista from '../componentes/TrsPista.jsx';
import { CargarOrden, DatosEvento, NuevaCompetencia } from '../componentes/ArchivosMesa.jsx';
import Clasificacion from '../componentes/Clasificacion.jsx';

/* ── token de mesa ───────────────────────────────────────────────────── */

function payloadDe(tok) {
  if (!tok || !tok.includes('.')) return null;
  try {
    let b64 = tok.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return JSON.parse(atob(b64));
  } catch { return null; }
}

// El token no se verifica del lado del cliente (no hay cómo, sin el secreto):
// esto sólo decide qué pantalla mostrar. La autorización real la hace el
// servidor en cada pedido.
export function tokenVigente(tok, ringId) {
  const p = payloadDe(tok);
  return !!p && p.r === ringId && p.e > Date.now();
}

/* ── página ──────────────────────────────────────────────────────────── */

export default function Mesa() {
  const { ringId } = useParams();
  const [snap, setSnap] = useState(null);
  const [inexistente, setInexistente] = useState(false);
  // Qué pista está mirando la mesa. `null` = la que está corriendo.
  const [viendo, setViendo] = useState(null);
  const [token, setToken] = useState(() => guardado.leer('mesaToken') || '');
  const autorizado = tokenVigente(token, ringId);
  const [aviso, mostrar] = useAviso();

  useEffect(() => {
    document.body.classList.add('mesa');
    guardado.borrar('mesaPin');   // la versión vieja guardaba el PIN: se limpia
    return () => document.body.classList.remove('mesa');
  }, []);

  const cargar = useCallback(async () => {
    try {
      setSnap(await pedirSnapshot(ringId, viendo));
    } catch (e) {
      if (e instanceof NoExiste) setInexistente(true);
      else mostrar('No pude conectarme al servidor.', true);
    }
  }, [ringId, viendo, mostrar]);
  useEffect(() => { cargar(); }, [cargar]);

  // El broadcast manda un snapshot por cada pista del ring; sólo importa el de
  // la que se está mirando (o, sin elegir ninguna, el de la activa: así se
  // sigue el puntero cuando se cierra una pista y se abre la próxima).
  const conectado = useCanal(`ring:${ringId}`, {
    snapshot: s => { if (viendo ? s.pista?.id === viendo : s.esActiva) setSnap(s); }
  });
  useCanal('global', { recargar: () => location.reload() });

  // Reporte que quedó de "cargar otra competencia" (ver ArchivosMesa).
  useEffect(() => {
    try {
      const p = sessionStorage.getItem('avisoPendiente');
      if (p) { sessionStorage.removeItem('avisoPendiente'); mostrar(p, false, 14000); }
    } catch { /* sin storage */ }
  }, [mostrar]);

  const salir = useCallback(() => { setToken(''); guardado.borrar('mesaToken'); }, []);

  // Una acción de mesa. Devuelve true si salió bien, y para entonces la
  // pantalla ya está actualizada: además del broadcast se vuelve a pedir el
  // snapshot, así la mesa no depende de que Realtime esté andando.
  const accion = useCallback(async (ruta, body) => {
    try {
      const r = await enviar(`/api/ring/${encodeURIComponent(ringId)}/${ruta}`, body, token);
      if (r.status === 401) {
        salir();
        mostrar('Sesión de mesa vencida. Ingresá el PIN de nuevo.', true);
        return false;
      }
      if (!r.ok) { mostrar(r.datos.error || 'No se pudo completar la acción.', true); return false; }
      if (r.datos.aviso) mostrar(r.datos.aviso, false, 14000);
      await cargar();
      return true;
    } catch {
      mostrar('No pude conectarme al servidor.', true);
      return false;
    }
  }, [ringId, token, salir, mostrar, cargar]);

  // Atajos para quien usa la mesa con teclado o pedal.
  const esActiva = !!snap?.esActiva;
  useEffect(() => {
    if (!autorizado) return undefined;
    const tecla = e => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if (esActiva && (e.code === 'Space' || e.key === 'ArrowRight')) { e.preventDefault(); accion('siguiente'); }
      if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); accion('deshacer'); }
    };
    document.addEventListener('keydown', tecla);
    return () => document.removeEventListener('keydown', tecla);
  }, [autorizado, esActiva, accion]);

  if (inexistente) return <main className="mesa-main"><RingInexistente ringId={ringId} /></main>;

  return <>
    <Tope ring={`Mesa · ${snap?.ring.nombre ?? ''}`}
          pista={snap ? (snap.pista?.nombre ?? 'sin pista abierta') : ''}
          conectado={conectado}
          texto={!snap ? 'conectando' : !conectado ? 'sin señal' : autorizado ? 'mesa · en vivo' : 'sólo lectura'} />
    <main className="mesa-main">
      <div className="wrap">
        {!snap
          ? <p className="cuenta-sub" style={{ padding: '24px 0' }}>Cargando…</p>
          : !autorizado
            ? <Pin ring={snap.ring} ringId={ringId} mostrar={mostrar}
                   alEntrar={t => { setToken(t); guardado.escribir('mesaToken', t); }} />
            : <Panel snap={snap} ringId={ringId} token={token} accion={accion} mostrar={mostrar}
                     setViendo={setViendo} />}
      </div>
    </main>
    <Aviso aviso={aviso} />
  </>;
}

function Pin({ ring, ringId, mostrar, alEntrar }) {
  const [pin, setPin] = useState('');
  async function entrar(e) {
    e?.preventDefault();
    if (!pin.trim()) return;
    try {
      const r = await enviar('/api/mesa/entrar', { ringId, pin: pin.trim() });
      if (!r.ok) return mostrar(r.status === 429 ? r.datos.error : 'PIN incorrecto', true);
      alEntrar(r.datos.token);
    } catch {
      mostrar('No pude conectarme al servidor.', true);
    }
  }
  return (
    <section className="mesa-seccion">
      <p className="eyebrow">Control de mesa</p>
      <p className="mesa-actual-nombre" style={{ margin: '8px 0 4px' }}>{ring.nombre}</p>
      <p className="mesa-actual-sub">Ingresá el PIN de mesa para poder avanzar el orden.</p>
      <form className="dorsal-set" onSubmit={e => e.preventDefault()}>
        <input type="password" inputMode="numeric" placeholder="PIN" aria-label="PIN de mesa"
               value={pin} onChange={e => setPin(e.target.value)} />
        <BotonCarga type="submit" className="btn" style={{ background: 'var(--chalk)', color: 'var(--turf)' }} onClick={entrar}>
          Entrar
        </BotonCarga>
      </form>
    </section>
  );
}

function Panel({ snap, ringId, token, accion, mostrar, setViendo }) {
  const lista = snap.lista;
  const pendientes = lista.filter(i => i.estado === 'pendiente');
  const corridos = lista.filter(i => i.estado === 'corrido').length;
  // Mirando una pista que no es la que corre: se muestran las herramientas de
  // orden, pero NO los botones de avanzar. "Siguiente" siempre actúa sobre la
  // pista en curso, y tenerlo a mano acá es la forma segura de largar la pista
  // equivocada sin darse cuenta.
  const otra = !snap.esActiva;

  const res = useResultados(accion, mostrar);

  const abrirEsta = async () => {
    if (!confirm(`¿Abrir ${snap.pista.nombre}? La que está en curso queda en pausa.`)) return;
    if (await accion('abrir_pista', { id: snap.pista.id })) setViendo(null);
  };

  return <>
    {otra && (
      <div className="mesa-ojo">
        <p><b>Estás mirando {snap.pista?.nombre}</b>, que no es la que está corriendo.</p>
        <p className="mesa-actual-sub">Podés reordenarla y cargarle el orden. Para avanzar el orden hay que abrirla.</p>
        <div className="mesa-ojo-btns">
          {snap.activa && <button className="btn chico" onClick={() => setViendo(null)}>Ir a {snap.activa.nombre}</button>}
          <BotonCarga className="btn fantasma chico" style={{ color: 'var(--chalk)', boxShadow: 'inset 0 0 0 1.5px rgba(244,246,241,.4)' }}
                      onClick={abrirEsta}>Abrir esta pista</BotonCarga>
        </div>
      </div>
    )}

    {/* Lo que la mesa hace el 90% del tiempo, todo junto arriba: el perro en
        pista, su tiempo, y largar el siguiente. */}
    <EnPistaMesa key={`en-pista:${snap.pista?.id}`} snap={snap} res={res} accion={accion} />

    <div className="mesa-fila-chica">
      <BotonCarga className="mesa-link" onClick={() => accion('deshacer')}>Deshacer lo último</BotonCarga>
      <span style={{ marginLeft: 'auto' }} className="mesa-actual-sub mono">
        {corridos} corridos · {pendientes.length} en lista{otra ? '' : ` · ~${snap.segPerro} s/perro`}
      </span>
    </div>

    <CorregirResultados key={`resultados:${snap.pista?.id}`} snap={snap} res={res} />

    <ClasificacionMesa snap={snap} />

    <section className="mesa-seccion">
      <p className="eyebrow">{otra ? 'Orden de salida' : 'Próximos'}</p>
      <ul className="mesa-lista">
        {pendientes.slice(0, 8).map((i, n) => (
          <li key={i.id} className="mesa-item">
            <Dorsal i={i} />
            <span className="mesa-item-quien">{i.perro}<br /><span className="mesa-item-sub">{i.guia}<Etiquetas i={i} /></span></span>
            <BotonCarga className="iconbtn" aria-label={`Subir a ${i.perro}`} disabled={n === 0}
                        onClick={() => accion('mover', { id: i.id, delta: -1 })}>↑</BotonCarga>
            <BotonCarga className="iconbtn" aria-label={`Bajar a ${i.perro}`} disabled={n === pendientes.length - 1}
                        onClick={() => accion('mover', { id: i.id, delta: 1 })}>↓</BotonCarga>
          </li>
        ))}
        {!pendientes.length && <li className="mesa-item"><span className="mesa-item-quien">No queda nadie pendiente.</span></li>}
      </ul>
    </section>

    <TrsPista snap={snap} accion={accion} mostrar={mostrar} />

    <Programa snap={snap} accion={accion} setViendo={setViendo} />

    <CargarOrden snap={snap} accion={accion} mostrar={mostrar} />

    {/* Con key: si el evento cambia por otro lado, el formulario arranca de nuevo. */}
    <DatosEvento key={`${snap.evento.nombre}|${snap.evento.fecha}`} snap={snap} accion={accion} />

    <NuevaCompetencia snap={snap} token={token} mostrar={mostrar} corridos={corridos} />

    <p className="pie" style={{ color: '#8FB3A0' }}>
      Vista pública: <Link to={`/ring/${encodeURIComponent(ringId)}`} style={{ color: '#A9C0B2' }}>/ring/{ringId}</Link>
    </p>
  </>;
}

// El programa del día. Tocar una pista sólo cambia lo que la mesa mira; las
// flechas cambian el orden en que se corren. Abrirla (lo que pausa la que está
// corriendo) es el botón aparte, con confirmación.
function Programa({ snap, accion, setViendo }) {
  // Sólo se mueven las que no arrancaron, y entre ellas.
  const movibles = snap.pistas.filter(p => !p.arrancada).map(p => p.id);
  return (
    <section className="mesa-seccion">
      <p className="eyebrow">Programa · pistas de la competencia</p>
      <p className="mesa-actual-sub" style={{ margin: '8px 0 0' }}>
        Tocá una para verla y reordenar sus perros. Las flechas cambian el orden en que
        se corren las pistas; abrirla es el botón aparte.
      </p>
      <ul className="mesa-lista">
        {snap.pistas.map(m => {
          const iMov = movibles.indexOf(m.id);
          return (
            <li key={m.id} className={`mesa-item ${m.id === snap.pista?.id ? 'viendo' : ''} ${m.estado === 'cerrada' ? 'ausente' : ''}`}>
              <button className="mesa-pista-sel" onClick={() => setViendo(m.id)}>
                {m.nombre}
                <span className="mesa-item-sub">{m.total} perros{
                  m.id === snap.activa?.id ? ' · corriendo' : m.estado === 'cerrada' ? ' · terminada' : m.arrancada ? ' · empezada' : ''}</span>
              </button>
              <BotonCarga className="iconbtn" aria-label={`Subir ${m.nombre} en el programa`} disabled={!(iMov > 0)}
                          onClick={() => accion('mover_pista', { id: m.id, delta: -1 })}>↑</BotonCarga>
              <BotonCarga className="iconbtn" aria-label={`Bajar ${m.nombre} en el programa`}
                          disabled={!(iMov >= 0 && iMov < movibles.length - 1)}
                          onClick={() => accion('mover_pista', { id: m.id, delta: 1 })}>↓</BotonCarga>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// La misma clasificación que ven los corredores, para chequearla desde la
// mesa. Plegada por defecto: no es lo que se mira a cada rato.
function ClasificacionMesa({ snap }) {
  const [ver, setVer] = useState(false);
  if (!snap.pista?.arrancada) return null;
  const n = (snap.clasificacion || []).reduce((a, p) => a + p.filas.length, 0);
  return (
    <section className="mesa-seccion">
      <div className="mesa-seccion-tope">
        <p className="eyebrow">Clasificación · {snap.pista.nombre}</p>
        <button className="mesa-link" onClick={() => setVer(!ver)}>
          {ver ? 'Ocultar' : `Ver (${n} con resultado)`}
        </button>
      </div>
      {ver && <div className="clasif-en-mesa"><Clasificacion snap={snap} /></div>}
    </section>
  );
}
