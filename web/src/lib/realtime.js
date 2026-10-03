import { useEffect, useRef, useState } from 'react';

// Supabase Realtime Broadcast como hook. El servidor publica después de cada
// acción (lib/realtime.js); acá sólo se escucha. La URL y la anon key se piden
// a /api/config en vez de quedar fijas en el bundle, para no atar el front a
// un proyecto de Supabase.
//
// "En vivo" es el estado de la suscripción: no hay heartbeat de servidor.

let clientePromesa = null;

function conectar() {
  if (!clientePromesa) {
    // supabase-js es la mayor parte del bundle: se baja aparte, en paralelo
    // con la config, para que la pantalla se pinte sin esperarlo.
    clientePromesa = Promise.all([
      fetch('/api/config').then(r => r.json()),
      import('@supabase/supabase-js')
    ]).then(([{ supabaseUrl, supabaseAnonKey }, { createClient }]) => {
      if (!supabaseUrl || !supabaseAnonKey) {
        throw new Error('Supabase no está configurado (faltan SUPABASE_URL / SUPABASE_ANON_KEY).');
      }
      return createClient(supabaseUrl, supabaseAnonKey);
    });
    // Si falla, que el próximo intento vuelva a probar en vez de quedar roto.
    clientePromesa.catch(() => { clientePromesa = null; });
  }
  return clientePromesa;
}

// topic: 'ring:<id>' | 'lobby' | 'global'
// eventos: { nombreDeEvento: payload => void }. Se leen siempre en su versión
// más reciente (ref), así los handlers pueden cerrar sobre el estado actual sin
// re-suscribirse en cada render. Los nombres de evento se fijan al suscribir.
// Devuelve si el canal está conectado.
export function useCanal(topic, eventos) {
  const [conectado, setConectado] = useState(false);
  const handlers = useRef(eventos);
  useEffect(() => { handlers.current = eventos; });

  useEffect(() => {
    if (!topic) return undefined;
    let vivo = true;
    let sb = null;
    let canal = null;
    conectar()
      .then(cliente => {
        if (!vivo) return;
        sb = cliente;
        canal = sb.channel(topic);
        for (const nombre of Object.keys(handlers.current)) {
          canal.on('broadcast', { event: nombre }, ({ payload }) => handlers.current[nombre]?.(payload));
        }
        canal.subscribe(status => { if (vivo) setConectado(status === 'SUBSCRIBED'); });
      })
      .catch(() => { if (vivo) setConectado(false); });
    return () => {
      vivo = false;
      if (sb && canal) sb.removeChannel(canal);
    };
  }, [topic]);

  return conectado;
}
