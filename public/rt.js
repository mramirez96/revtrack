'use strict';

// Envoltorio chico sobre Supabase Realtime Broadcast. Reemplaza a
// socket.io-client: en vez de una conexión al mismo servidor que atiende las
// acciones, esto escucha directamente los mensajes que el servidor publica
// por lib/realtime.js después de cada acción.
//
// El estado de la suscripción (conectado / no) es ahora la única señal de
// "en vivo": no hay heartbeat de servidor — ver la nota en el plan de
// migración sobre por qué se sacó.
window.RT = (() => {
  let clientePromesa = null;

  function conectar() {
    if (!clientePromesa) {
      clientePromesa = fetch('/api/config')
        .then(r => r.json())
        .then(({ supabaseUrl, supabaseAnonKey }) => {
          if (!supabaseUrl || !supabaseAnonKey) {
            throw new Error('Supabase no está configurado (faltan SUPABASE_URL / SUPABASE_ANON_KEY).');
          }
          return window.supabase.createClient(supabaseUrl, supabaseAnonKey);
        });
    }
    return clientePromesa;
  }

  // topic: 'ring:<id>' | 'lobby' | 'global'
  // eventos: { nombreDeEvento: payload => void }
  // onEstado: conectado:boolean => void — se llama en cada cambio de estado.
  async function suscribir(topic, eventos, onEstado) {
    const sb = await conectar();
    const canal = sb.channel(topic);
    for (const [nombre, fn] of Object.entries(eventos)) {
      canal.on('broadcast', { event: nombre }, ({ payload }) => fn(payload));
    }
    canal.subscribe(status => onEstado?.(status === 'SUBSCRIBED'));
    return canal;
  }

  return { suscribir };
})();
