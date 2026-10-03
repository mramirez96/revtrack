import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

// El recuadro del dorsal se omite cuando no hay número (los G0), para no dejar
// un hueco donde no hay nada que poner.
export function Dorsal({ i, className = 'dorsal' }) {
  return i.dorsal ? <span className={className}>{i.dorsal}</span> : null;
}

// Altura y grado del perro. En la misma pista corren todos mezclados, así que
// son el dato que dice quién es cada uno (y la mesa los necesita para acomodar
// los saltos). Se omite la que el CSV no traiga, para no dejar un recuadro vacío.
export function Etiquetas({ i }) {
  return [i.altura, i.categoria].filter(Boolean).map(t => (
    <span key={t}> <span className="etiq">{t}</span></span>
  ));
}

// Cabecera fija: ring, pista y si lo que se ve está en vivo.
export function Tope({ ring, pista, conectado, texto }) {
  return (
    <header className="tope">
      <div className="wrap">
        <span className="tope-ring">{ring}</span>
        <span className="tope-pista">{pista}</span>
        <span className="tope-estado">
          <span className={conectado ? 'pulso' : 'pulso muerto'} />
          <span>{texto}</span>
        </span>
      </div>
    </header>
  );
}

// Aviso flotante. `mostrar(msg, esError, ms)`.
export function useAviso() {
  const [aviso, setAviso] = useState(null);
  const timer = useRef(null);
  const mostrar = useCallback((msg, esError = false, ms = 3500) => {
    setAviso({ msg, esError });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAviso(null), ms);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [aviso, mostrar];
}

export function Aviso({ aviso }) {
  if (!aviso) return null;
  return (
    <div className={aviso.esError ? 'aviso error' : 'aviso'} role="status" aria-live="polite">
      {aviso.msg}
    </div>
  );
}

// Botón que muestra un spinner mientras espera al servidor: en la nube cada
// acción es un viaje a Postgres, y sin esto el toque se siente como que no pasó
// nada. `onClick` devuelve una promesa.
export function BotonCarga({ onClick, children, disabled, ...resto }) {
  const [cargando, setCargando] = useState(false);
  const vivo = useRef(true);
  useEffect(() => () => { vivo.current = false; }, []);
  const tocar = async e => {
    if (cargando) return;
    setCargando(true);
    try { await onClick(e); } finally { if (vivo.current) setCargando(false); }
  };
  return (
    <button {...resto} disabled={disabled || cargando} onClick={tocar}>
      {cargando ? <span className="spinner" aria-hidden="true" /> : children}
    </button>
  );
}

// Si el ring de la URL no existe, la pantalla no puede quedar en "Cargando…"
// sin salida ni explicación.
export function RingInexistente({ ringId }) {
  return (
    <div className="wrap" style={{ padding: '24px var(--pad)' }}>
      <p className="eyebrow">Esta competencia no existe</p>
      <h1>{ringId}</h1>
      <p className="pie">
        Puede ser que se haya cargado otra competencia desde entonces, o que la
        dirección esté mal escrita.
      </p>
      <p style={{ marginTop: 14 }}><Link className="btn" to="/" style={{ textDecoration: 'none' }}>Ir al inicio</Link></p>
    </div>
  );
}
