// Pedidos al servidor (api/index.js). Contrato: un error es { error } con un
// status no-2xx; el éxito de una acción es {} o { aviso }.

export class RingInexistente extends Error {}

export async function pedirSnapshot(ringId, pistaId) {
  const q = pistaId ? `?pista=${encodeURIComponent(pistaId)}` : '';
  const r = await fetch(`/api/ring/${encodeURIComponent(ringId)}${q}`);
  if (r.status === 404) throw new RingInexistente(ringId);
  // Un 500 trae { error }, no un snapshot: no se puede pisar el estado con eso.
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function pedirResumen() {
  const r = await fetch('/api/resumen');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Devuelve { ok, status, datos } y no tira por un error del servidor: el que
// llama decide qué aviso mostrar. Sí tira si no hay red.
export async function enviar(ruta, body, token) {
  const r = await fetch(ruta, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body || {})
  });
  const datos = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, datos };
}
