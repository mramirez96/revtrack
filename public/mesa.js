'use strict';

const ringId = location.pathname.split('/').filter(Boolean)[1];
const el = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Altura y grado del perro. Con todo mezclado en una sola pista, la mesa las
// necesita a la vista para acomodar los saltos entre perro y perro.
// En las pistas sin dorsal (los G0) el recuadro del número no se dibuja, para no
// dejar un hueco donde no hay nada que poner.
const dorsalDe = i => i.dorsal ? `<span class="dorsal">${esc(i.dorsal)}</span>` : '';

const etiquetas = i => [i.altura, i.categoria]
  .filter(Boolean)
  .map(t => ` <span class="etiq">${esc(t)}</span>`)
  .join('');

let snap = null;
// Qué pista está mirando la mesa. `null` = la que está corriendo.
let viendo = null;
let token = localStorage.getItem('mesaToken') || '';
try { localStorage.removeItem('mesaPin'); } catch { /* nada que hacer: era la versión vieja, guardaba el PIN */ }
let autorizado = false;
let recibidoEn = 0;
// Estado de la suscripción de Realtime — ver la nota en live.js sobre por qué
// "en vivo" ahora se lee directo de acá y no de un heartbeat de servidor.
let conectado = false;

/* ── avisos ──────────────────────────────────────────────────────────── */
let avisoTimer = null;
function aviso(msg, esError, ms = 3500) {
  const a = el('aviso');
  a.textContent = msg;
  a.className = 'aviso' + (esError ? ' error' : '');
  a.hidden = false;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => { a.hidden = true; }, ms);
}

function frescura() {
  const pulso = el('pulso');
  const txt = el('frescura');
  if (!conectado) { pulso.className = 'pulso muerto'; txt.textContent = 'sin señal'; return; }
  pulso.className = 'pulso';
  txt.textContent = autorizado ? 'mesa · en vivo' : 'sólo lectura';
}
setInterval(frescura, 15000);

/* ── render ──────────────────────────────────────────────────────────── */

function render() {
  if (!snap) return;
  el('ringNombre').textContent = `Mesa · ${snap.ring.nombre}`;
  el('pistaNombre').textContent = snap.pista ? snap.pista.nombre : 'sin pista abierta';

  if (!autorizado) return renderPin();

  const lista = snap.lista;
  const enPista = lista.find(i => i.estado === 'en_pista');
  const pendientes = lista.filter(i => i.estado === 'pendiente');
  const corridos = lista.filter(i => i.estado === 'corrido').length;
  const sinArrancar = snap.pistas.filter(p => !p.arrancada);

  // Mirando una pista que no es la que corre: se muestran las herramientas de
  // orden, pero NO los botones de avanzar. "Siguiente" siempre actúa sobre la
  // pista en curso, y tenerlo a mano acá es la forma segura de largar la pista
  // equivocada sin darse cuenta.
  const otra = !snap.esActiva;

  el('app').innerHTML = `
    ${otra ? `
      <div class="mesa-ojo">
        <p><b>Estás mirando ${esc(snap.pista?.nombre || '')}</b>, que no es la que está corriendo.</p>
        <p class="mesa-actual-sub">Podés reordenarla y cargarle el orden. Para avanzar el orden hay que abrirla.</p>
        <div class="mesa-ojo-btns">
          ${snap.activa ? `<button class="btn chico" id="btnVolverActiva">Ir a ${esc(snap.activa.nombre)}</button>` : ''}
          <button class="btn fantasma chico" id="btnAbrirEsta" style="color:var(--chalk);box-shadow:inset 0 0 0 1.5px rgba(244,246,241,.4)">Abrir esta pista</button>
        </div>
      </div>` : ''}

    <section class="mesa-actual">
      <p class="eyebrow">${otra ? esc(snap.pista?.nombre || '') : 'En pista'}</p>
      ${enPista
        ? `<div class="mesa-actual-fila">
             ${dorsalDe(enPista)}
             <span><span class="mesa-actual-nombre">${esc(enPista.perro)}</span><br>
             <span class="mesa-actual-sub">${esc(enPista.guia)}${etiquetas(enPista)}</span></span>
           </div>`
        : `<p class="mesa-actual-nombre" style="margin-top:6px">${
             otra && !snap.pista?.arrancada ? 'Todavía no arrancó'
             : pendientes.length ? 'Nadie en pista' : 'Pista terminada'}</p>`}
    </section>

    ${otra ? '' : `
      <div class="mesa-botones">
        <button class="mesa-btn" id="btnSiguiente" ${!pendientes.length && !enPista ? 'disabled' : ''}>
          ${enPista ? 'Siguiente' : 'Largar el primero'}
        </button>
        <button class="mesa-btn secundario peligro" id="btnAusente" ${!enPista && !pendientes.length ? 'disabled' : ''}>
          Marcar ausente
        </button>
      </div>`}

    <div class="mesa-fila-chica">
      <button class="mesa-link" id="btnDeshacer">Deshacer lo último</button>
      <span style="margin-left:auto" class="mesa-actual-sub mono">
        ${corridos} corridos · ${pendientes.length} en lista${otra ? '' : ` · ~${snap.segPerro} s/perro`}
      </span>
    </div>

    <section class="mesa-seccion">
      <p class="eyebrow">${otra ? 'Orden de salida' : 'Próximos'}</p>
      <ul class="mesa-lista">${
        pendientes.slice(0, 8).map((i, n) => `
          <li class="mesa-item">
            ${dorsalDe(i)}
            <span class="mesa-item-quien">${esc(i.perro)}<br><span class="mesa-item-sub">${esc(i.guia)}${etiquetas(i)}</span></span>
            <button class="iconbtn" data-mover="${i.id}" data-delta="-1" aria-label="Subir a ${esc(i.perro)}" ${n === 0 ? 'disabled' : ''}>↑</button>
            <button class="iconbtn" data-mover="${i.id}" data-delta="1" aria-label="Bajar a ${esc(i.perro)}" ${n === pendientes.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="iconbtn" data-ausente="${i.id}" aria-label="Marcar ausente a ${esc(i.perro)}">✕</button>
          </li>`).join('') || '<li class="mesa-item"><span class="mesa-item-quien">No queda nadie pendiente.</span></li>'
      }</ul>
    </section>

    <section class="mesa-seccion">
      <p class="eyebrow">Programa · pistas de la competencia</p>
      <p class="mesa-actual-sub" style="margin:8px 0 0">
        Tocá una para verla y reordenar sus perros. Las flechas cambian el orden en que
        se corren las pistas; abrirla es el botón aparte.
      </p>
      <ul class="mesa-lista">${
        // Sólo se pueden mover las que no arrancaron, y entre ellas: para saber si
        // una flecha va deshabilitada hay que mirar la posición en ese subconjunto.
        (() => {
          const movibles = snap.pistas.filter(p => !p.arrancada).map(p => p.id);
          return snap.pistas.map(m => {
            const iMov = movibles.indexOf(m.id);
            const puedeSubir = iMov > 0;
            const puedeBajar = iMov >= 0 && iMov < movibles.length - 1;
            return `
            <li class="mesa-item ${m.id === snap.pista?.id ? 'viendo' : ''} ${m.estado === 'cerrada' ? 'ausente' : ''}">
              <button class="mesa-pista-sel" data-ver="${m.id}">
                ${esc(m.nombre)}
                <span class="mesa-item-sub">${m.total} perros${
                  m.id === snap.activa?.id ? ' · corriendo' : m.estado === 'cerrada' ? ' · terminada' : m.arrancada ? ' · empezada' : ''}</span>
              </button>
              <button class="iconbtn" data-mpista="${m.id}" data-delta="-1"
                      aria-label="Subir ${esc(m.nombre)} en el programa" ${puedeSubir ? '' : 'disabled'}>↑</button>
              <button class="iconbtn" data-mpista="${m.id}" data-delta="1"
                      aria-label="Bajar ${esc(m.nombre)} en el programa" ${puedeBajar ? '' : 'disabled'}>↓</button>
            </li>`;
          }).join('');
        })()
      }</ul>
    </section>

    <section class="mesa-seccion">
      <p class="eyebrow">Cargar orden desde archivo</p>
      ${sinArrancar.length ? `
        <p class="mesa-actual-sub" style="margin:8px 0 10px">
          Un CSV con una columna <b>dorsal</b>. El orden de las filas es el orden de salida
          y las alturas se acomodan de menor a mayor. Los tiempos, si vienen, se ignoran.
        </p>
        <div class="orden-carga">
          <select id="ordenPista" aria-label="Pista a reordenar">${
            sinArrancar.map(p => `<option value="${p.id}">${esc(p.nombre)} · ${p.total} perros</option>`).join('')
          }</select>
          <input type="file" id="ordenArchivo" accept=".csv,text/csv,text/plain" aria-label="Archivo con el orden">
          <label class="orden-check"><input type="checkbox" id="ordenInvertir"> invertir el archivo</label>
          <button class="btn" id="btnOrden" style="background:var(--chalk);color:var(--turf)">Aplicar orden</button>
        </div>`
      : `<p class="mesa-actual-sub" style="margin-top:8px">
           Todas las pistas ya arrancaron: el orden sólo se importa antes del primer perro.
         </p>`}
    </section>

    <section class="mesa-seccion">
      <p class="eyebrow" style="color:#FFB3AA">Cargar otra competencia</p>
      <div class="mesa-peligro">
        <p>Borra <b>todo</b> lo de esta competencia y siembra de cero desde el archivo.
        Mismo formato que <code>data/seed.csv</code>.</p>
        <p class="mesa-actual-sub">Se va a perder: ${corridos} corrido(s) y el orden de
        ${snap.pistas.length} pista(s). El estado actual queda respaldado en <code>data/</code>,
        pero desde la app no se puede volver atrás.</p>
        <div class="orden-carga" style="margin-top:12px">
          <input type="file" id="nuevaArchivo" accept=".csv,text/csv,text/plain" aria-label="CSV de la competencia nueva">
          <input type="text" id="nuevaConfirmar" placeholder="escribí BORRAR" aria-label="Escribí BORRAR para confirmar"
                 style="width:150px;font-family:inherit">
          <button class="mesa-btn secundario peligro" id="btnNueva" style="font-size:16px;padding:12px 18px">
            Borrar y cargar
          </button>
        </div>
      </div>
    </section>

    <p class="pie" style="color:#8FB3A0">
      Vista pública: <a href="/ring/${encodeURIComponent(ringId)}" style="color:#A9C0B2">/ring/${esc(ringId)}</a>
    </p>`;

  // Los botones de avanzar no existen cuando se está mirando otra pista.
  const btnSig = el('btnSiguiente');
  if (btnSig) btnSig.onclick = () => accion('siguiente');
  const btnAus = el('btnAusente');
  if (btnAus) btnAus.onclick = () => {
    const objetivo = enPista || pendientes[0];
    if (!objetivo) return;
    const quien = `${objetivo.perro} (${objetivo.guia}${objetivo.dorsal ? `, dorsal ${objetivo.dorsal}` : ''})`;
    if (confirm(`¿Marcar ausente a ${quien}?`)) {
      accion('ausente', { id: objetivo.id });
    }
  };
  el('btnDeshacer').onclick = () => accion('deshacer');

  const btnVolver = el('btnVolverActiva');
  if (btnVolver) btnVolver.onclick = () => verPista(null);
  const btnAbrir = el('btnAbrirEsta');
  if (btnAbrir) btnAbrir.onclick = () => {
    if (confirm(`¿Abrir ${snap.pista.nombre}? La que está en curso queda en pausa.`)) {
      accion('abrir_pista', { id: snap.pista.id });
      verPista(null);
    }
  };

  el('app').querySelectorAll('[data-mover]').forEach(b => {
    b.onclick = () => accion('mover', { id: b.dataset.mover, delta: Number(b.dataset.delta) });
  });
  el('app').querySelectorAll('[data-ausente]').forEach(b => {
    b.onclick = () => accion('ausente', { id: b.dataset.ausente });
  });
  const btnOrden = el('btnOrden');
  if (btnOrden) btnOrden.onclick = () => {
    const archivo = el('ordenArchivo').files?.[0];
    if (!archivo) return aviso('Elegí primero el archivo con el orden.', true);
    // Mismo tope que el servidor: mejor avisar acá que mandar 5 MB al vacío.
    if (archivo.size > 500000) return aviso('Ese archivo es demasiado grande (máx. 500 KB).', true);
    const pistaId = el('ordenPista').value;
    const invertir = el('ordenInvertir').checked;
    const lector = new FileReader();
    lector.onerror = () => aviso('No pude leer el archivo.', true);
    lector.onload = () => accion('cargar_orden', { pistaId, csv: String(lector.result), invertir });
    lector.readAsText(archivo, 'utf-8');
  };

  const btnNueva = el('btnNueva');
  if (btnNueva) btnNueva.onclick = () => {
    const archivo = el('nuevaArchivo').files?.[0];
    if (!archivo) return aviso('Elegí el CSV de la competencia nueva.', true);
    if (archivo.size > 500000) return aviso('Ese archivo es demasiado grande (máx. 500 KB).', true);
    // La palabra tipeada es la guarda: un confirm() está a un toque de distancia
    // y esto borra el día entero.
    if (el('nuevaConfirmar').value.trim().toUpperCase() !== 'BORRAR') {
      return aviso('Escribí BORRAR en el casillero para confirmar.', true);
    }
    const lector = new FileReader();
    lector.onerror = () => aviso('No pude leer el archivo.', true);
    lector.onload = () => nuevaCompetenciaSubmit(String(lector.result));
    lector.readAsText(archivo, 'utf-8');
  };

  // Tocar un chip sólo cambia lo que la mesa está viendo. Abrir una pista —que
  // pausa la que está corriendo— es el botón aparte, con confirmación.
  el('app').querySelectorAll('[data-ver]').forEach(b => {
    b.onclick = () => verPista(b.dataset.ver);
  });
  el('app').querySelectorAll('[data-mpista]').forEach(b => {
    b.onclick = () => accion('mover_pista', { id: b.dataset.mpista, delta: Number(b.dataset.delta) });
  });

  frescura();
}

function renderPin() {
  if (el('inPin')) return;   // ya está el formulario: no pisar lo que están tipeando
  el('app').innerHTML = `
    <section class="mesa-seccion">
      <p class="eyebrow">Control de mesa</p>
      <p class="mesa-actual-nombre" style="margin:8px 0 4px">${esc(snap.ring.nombre)}</p>
      <p class="mesa-actual-sub">Ingresá el PIN de mesa para poder avanzar el orden.</p>
      <div class="dorsal-set">
        <input id="inPin" type="password" inputmode="numeric" placeholder="PIN" aria-label="PIN de mesa">
        <button class="btn" id="btnPin" style="background:var(--chalk);color:var(--turf)">Entrar</button>
      </div>
    </section>`;
  const enviar = () => entrarConPin(el('inPin').value.trim());
  el('btnPin').onclick = enviar;
  el('inPin').onkeydown = e => { if (e.key === 'Enter') enviar(); };
}

/* ── token de mesa ───────────────────────────────────────────────────── */

function payloadDe(tok) {
  if (!tok || !tok.includes('.')) return null;
  try {
    let b64 = tok.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return JSON.parse(atob(b64));
  } catch { return null; }
}

// El token no se verifica del lado del cliente (no hay cómo, sin el secreto) —
// esto es sólo para decidir qué pantalla mostrar. La autorización real la
// hace el servidor en cada pedido.
function tokenVigente(tok) {
  const p = payloadDe(tok);
  return !!p && p.r === ringId && p.e > Date.now();
}

async function entrarConPin(pin) {
  if (!pin) return;
  try {
    const r = await fetch('/api/mesa/entrar', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ringId, pin })
    });
    const d = await r.json();
    if (!r.ok) return aviso(r.status === 429 ? d.error : 'PIN incorrecto', true);
    token = d.token;
    localStorage.setItem('mesaToken', token);
    autorizado = true;
    render();
  } catch {
    aviso('No pude conectarme al servidor.', true);
  }
}

/* ── acciones + tiempo real ──────────────────────────────────────────── */

async function accion(ruta, body) {
  try {
    const r = await fetch(`/api/ring/${encodeURIComponent(ringId)}/${ruta}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body || {})
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) {
      // El token venció o dejó de servir: misma pantalla que si nunca hubiera
      // entrado, sin perder de vista el error.
      token = '';
      localStorage.removeItem('mesaToken');
      autorizado = false;
      render();
      return aviso('Sesión de mesa vencida. Ingresá el PIN de nuevo.', true);
    }
    if (!r.ok) return aviso(d.error || 'No se pudo completar la acción.', true);
    // El reporte de "cargar orden" tiene varias partes y hay que poder leerlo;
    // el snapshot actualizado llega solo, por el canal de Realtime.
    if (d.aviso) aviso(d.aviso, false, 14000);
  } catch {
    aviso('No pude conectarme al servidor.', true);
  }
}

async function nuevaCompetenciaSubmit(csv) {
  try {
    const r = await fetch('/api/nueva_competencia', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ csv, confirmar: 'BORRAR' })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return aviso(d.error || 'No se pudo cargar la competencia.', true);
    // La mesa se va derecho a la competencia nueva, sin esperar. Su URL vieja
    // apunta a un ring que probablemente ya no exista. El reporte cruza la
    // navegación por sessionStorage, así que se lee del otro lado en vez de
    // retrasar el salto.
    try { if (d.aviso) sessionStorage.setItem('avisoPendiente', d.aviso); } catch { /* sin storage */ }
    location.href = d.ringId ? `/mesa/${encodeURIComponent(d.ringId)}` : '/';
  } catch {
    aviso('No pude conectarme al servidor.', true);
  }
}

function verPista(id) {
  viendo = id;
  cargarSnapshot();
}

// Si el ring de la URL no existe, la pantalla quedaba en "Cargando…" sin
// salida ni explicación.
function ringInexistente() {
  el('app').innerHTML = `
    <section class="mesa-seccion">
      <p class="eyebrow">Esta competencia no existe</p>
      <p class="mesa-actual-nombre" style="margin:8px 0 6px">${esc(ringId)}</p>
      <p class="mesa-actual-sub">
        Puede ser que se haya cargado otra competencia desde entonces, o que la
        dirección esté mal escrita.
      </p>
      <p style="margin-top:14px"><a class="btn" href="/" style="text-decoration:none">Ir al inicio</a></p>
    </section>`;
}

async function cargarSnapshot() {
  try {
    const q = viendo ? `?pista=${encodeURIComponent(viendo)}` : '';
    const r = await fetch(`/api/ring/${encodeURIComponent(ringId)}${q}`);
    if (r.status === 404) return ringInexistente();
    snap = await r.json();
    recibidoEn = Date.now();
    render();
  } catch {
    aviso('No pude conectarme al servidor.', true);
  }
}

// El broadcast manda un snapshot por cada pista del ring; sólo importa el de
// la que se está mirando (o, si no se eligió ninguna, la que sea la activa en
// este momento — así se sigue el puntero cuando se cierra una pista y se abre
// la próxima).
function alRecibirSnapshot(s) {
  if (viendo ? s.pista?.id === viendo : s.esActiva) {
    snap = s;
    recibidoEn = Date.now();
    render();
  }
}

autorizado = tokenVigente(token);
cargarSnapshot();
RT.suscribir(`ring:${ringId}`, { snapshot: alRecibirSnapshot }, c => { conectado = c; frescura(); });
RT.suscribir('global', { recargar: () => location.reload() });

// Reporte que quedó de la navegación anterior (ver nuevaCompetenciaSubmit).
try {
  const pendiente = sessionStorage.getItem('avisoPendiente');
  if (pendiente) { sessionStorage.removeItem('avisoPendiente'); aviso(pendiente, false, 14000); }
} catch { /* sin storage */ }

// Atajos para quien usa la mesa con teclado o pedal.
document.addEventListener('keydown', e => {
  if (!autorizado || e.target.tagName === 'INPUT') return;
  if (e.code === 'Space' || e.key === 'ArrowRight') { e.preventDefault(); accion('siguiente'); }
  if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); accion('deshacer'); }
});
