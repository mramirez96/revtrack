import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { pedirResumen } from '../lib/api.js';
import { useCanal } from '../lib/realtime.js';

const estadoTxt = p => {
  if (p.estado === 'cerrada') return 'terminada';
  if (!p.corridos && !p.enPista) return `${p.total} anotados`;
  return `${p.faltan} en lista`;
};

// El programa del día: cada ring con TODAS sus pistas. La que está corriendo
// se muestra abierta, con quién está en pista; las demás en una línea.
export default function Portada() {
  const [datos, setDatos] = useState(null);
  useEffect(() => {
    document.title = 'RevTrack';
    pedirResumen().then(setDatos).catch(() => {});
  }, []);
  useCanal('lobby', { resumen: setDatos });
  useCanal('global', { recargar: () => location.reload() });

  if (!datos) return <main className="portada"><div className="wrap"><h1>—</h1></div></main>;

  // Una competencia corre de a una pista por vez. Con un solo ring —el caso
  // normal— el ring ES la competencia: va el nombre del evento y abajo las
  // pistas. El encabezado del ring sólo aparece si hay más de una cancha.
  const variosRings = datos.rings.length > 1;
  const fecha = new Date(`${datos.evento.fecha}T12:00`)
    .toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <main className="portada">
      <div className="wrap">
        <p className="eyebrow" style={{ color: 'var(--mist)' }}>{fecha}</p>
        <h1>{datos.evento.nombre}</h1>
        {datos.rings.map(r => (
          <section key={r.id} className="ring-bloque">
            {variosRings && <h2 className="ring-bloque-nombre">{r.nombre}</h2>}
            {r.pistas.map(p => (
              <Link key={p.id} to={`/ring/${encodeURIComponent(r.id)}?pista=${encodeURIComponent(p.id)}`}
                    className={`ring-card ${p.esActiva ? 'activa' : ''} ${p.estado === 'cerrada' ? 'cerrada' : ''}`}>
                <span className="ring-card-tope">
                  <span className="ring-card-nombre">{p.nombre}</span>
                  <span className="ring-card-pista">{p.esActiva ? 'en curso' : estadoTxt(p)}</span>
                </span>
                {p.esActiva && (
                  <span className="ring-card-fila">
                    {p.enPista ? <>
                      {p.enPista.dorsal && <span className="dorsal">{p.enPista.dorsal}</span>}
                      <span><span className="ring-card-nombre">{p.enPista.perro}</span><br />
                        <span className="ring-card-sub">{p.enPista.guia}</span></span>
                    </> : <span className="ring-card-sub">{p.faltan ? 'nadie en pista' : 'pista terminada'}</span>}
                    <span className="ring-card-faltan">{p.faltan}<br />en lista</span>
                  </span>
                )}
              </Link>
            ))}
          </section>
        ))}
        <p className="pie">
          Tocá una pista para ver su orden de salida. Si estás en la mesa, entrá por{' '}
          {datos.rings.map((r, n) => (
            <span key={r.id}>{n > 0 && ' o '}<Link to={`/mesa/${encodeURIComponent(r.id)}`}>/mesa/{r.id}</Link></span>
          ))}
          . Se corre de a una pista por vez: la que está en curso queda arriba resaltada.
        </p>
        <p className="firma">RevTrack · Powered by Revamp</p>
      </div>
    </main>
  );
}
