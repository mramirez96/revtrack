import * as R from '../../../shared/resultados.mjs';
import { esMio, fmtLibre } from '../lib/formato.js';
import { Etiquetas } from './comunes.jsx';

// La clasificación de una pista, por podio. La misma en la vista del corredor
// y en la mesa (para chequear desde ahí lo que ven todos).

// El resultado de un perro en dos líneas con el mismo peso: la penalización
// ("F: 5,00", o "DESC") y el recorrido ("38,52 s | 4,96 m/s"). Ninguna de las
// dos se destaca sobre la otra: es un dato, no un titular.
export function ResultadoCorto({ res, regla }) {
  const l = R.lineasResultado(res, regla);
  return (
    <span className="cola-eta cola-res mono">
      <span>{l.faltas}</span>
      <span>{l.recorrido}</span>
    </span>
  );
}

// "TRS 42,44 s · 191 m a 4,5 m/s": de dónde salió, para quien quiera hacer la
// cuenta. Va en cada podio: Small/Midi e Intermediate/Large pueden tener TRS distintos.
function trsTexto(r) {
  if (!r?.trs) return 'sin TRS';
  return `TRS ${R.fmt(r.trs)} s${r.largo && r.velocidad ? ` · ${fmtLibre(r.largo)} m a ${fmtLibre(r.velocidad)} m/s` : ''}`;
}

// `clave`: el dorsal o nombre del que mira, para resaltarlo (sólo en la vista
// del corredor; en la mesa no hay "vos").
export default function Clasificacion({ snap, clave = '' }) {
  const podios = (snap.clasificacion || []).filter(p => p.filas.length);
  return (
    <div className="clasif" data-testid="clasificacion">
      {!podios.length && <p className="vacio">Todavía no hay resultados cargados.</p>}
      {podios.map(p => (
        <div key={p.id} className="podio">
          <p className="podio-tit">{p.nombre}</p>
          <p className="clasif-trs mono">{trsTexto(p.regla)}</p>
          <ol className="cola-lista">
            {p.filas.map(f => (
              <li key={f.id} className={`cola-item ${esMio(f, clave) ? 'vos' : ''} ${f.res.eliminado ? 'eliminado' : ''}`}>
                <span className={`dorsal puesto ${f.puesto ? '' : 'desc'}`}>{f.puesto ?? 'DESC'}</span>
                <span className="cola-quien">
                  <span className="cola-nombre">{f.perro}</span><br />
                  <span className="cola-sub">{f.dorsal ? `${f.dorsal} · ` : ''}{f.guia}<Etiquetas i={f} />{' '}
                    <span className={`etiq calif ${f.res.calif === 'Cero Exc' ? 'cero' : ''}`}>{f.res.calif}</span></span>
                </span>
                <ResultadoCorto res={f.res} regla={p.regla} />
              </li>
            ))}
          </ol>
          {p.faltan > 0 && <p className="podio-nota">Provisoria · {p.faltan} por correr</p>}
        </div>
      ))}
    </div>
  );
}
