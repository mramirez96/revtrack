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
let pin = localStorage.getItem('mesaPin') || '';
let autorizado = false;
let intentoPin = false;   // true sólo cuando alguien tipeó un PIN y lo mandó
let recibidoEn = 0;

const socket = io({ transports: ['websocket', 'polling'] });

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
  if (!socket.connected) { pulso.className = 'pulso muerto'; txt.textContent = 'sin señal'; return; }
  const seg = Math.round((Date.now() - recibidoEn) / 1000);
  pulso.className = seg < 75 ? 'pulso' : 'pulso frio';
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
  if (btnSig) btnSig.onclick = () => socket.emit('siguiente');
  const btnAus = el('btnAusente');
  if (btnAus) btnAus.onclick = () => {
    const objetivo = enPista || pendientes[0];
    if (!objetivo) return;
    const quien = `${objetivo.perro} (${objetivo.guia}${objetivo.dorsal ? `, dorsal ${objetivo.dorsal}` : ''})`;
    if (confirm(`¿Marcar ausente a ${quien}?`)) {
      socket.emit('ausente', objetivo.id);
    }
  };
  el('btnDeshacer').onclick = () => socket.emit('deshacer');

  const btnVolver = el('btnVolverActiva');
  if (btnVolver) btnVolver.onclick = () => verPista(null);
  const btnAbrir = el('btnAbrirEsta');
  if (btnAbrir) btnAbrir.onclick = () => {
    if (confirm(`¿Abrir ${snap.pista.nombre}? La que está en curso queda en pausa.`)) {
      socket.emit('abrir_pista', snap.pista.id);
      verPista(null);
    }
  };

  el('app').querySelectorAll('[data-mover]').forEach(b => {
    b.onclick = () => socket.emit('mover', { id: b.dataset.mover, delta: Number(b.dataset.delta) });
  });
  el('app').querySelectorAll('[data-ausente]').forEach(b => {
    b.onclick = () => socket.emit('ausente', b.dataset.ausente);
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
    lector.onload = () => socket.emit('cargar_orden', { pistaId, csv: String(lector.result), invertir });
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
    lector.onload = () => socket.emit('nueva_competencia', {
      csv: String(lector.result), confirmar: 'BORRAR'
    });
    lector.readAsText(archivo, 'utf-8');
  };

  // Tocar un chip sólo cambia lo que la mesa está viendo. Abrir una pista —que
  // pausa la que está corriendo— es el botón aparte, con confirmación.
  el('app').querySelectorAll('[data-ver]').forEach(b => {
    b.onclick = () => verPista(b.dataset.ver);
  });
  el('app').querySelectorAll('[data-mpista]').forEach(b => {
    b.onclick = () => socket.emit('mover_pista', { id: b.dataset.mpista, delta: Number(b.dataset.delta) });
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
  const enviar = () => {
    pin = el('inPin').value.trim();
    if (!pin) return;
    intentoPin = true;
    localStorage.setItem('mesaPin', pin);
    socket.emit('join', { ringId, pin });
  };
  el('btnPin').onclick = enviar;
  el('inPin').onkeydown = e => { if (e.key === 'Enter') enviar(); };
}

/* ── socket ──────────────────────────────────────────────────────────── */

function verPista(id) {
  viendo = id;
  socket.emit('ver_pista', id);
}

socket.on('connect', () => socket.emit('join', { ringId, pin, pistaId: viendo }));

socket.on('snapshot', s => { snap = s; recibidoEn = Date.now(); render(); });

socket.on('latido', () => { recibidoEn = Date.now(); frescura(); });

socket.on('mesa_ok', ok => {
  autorizado = ok;
  if (!ok) {
    localStorage.removeItem('mesaPin');
    pin = '';
    if (intentoPin) aviso('PIN incorrecto', true);
  }
  intentoPin = false;
  render();
});

socket.on('disconnect', frescura);
socket.on('error_app', m => aviso(m, true));

// El reporte de "cargar orden" tiene varias partes y hay que poder leerlo.
socket.on('aviso_app', m => aviso(m, false, 14000));

// Cambió la competencia entera: lo que hay en pantalla ya no existe. Los demás
// recargan al instante; el que la cargó tiene unos segundos para leer el reporte.
socket.on('recargar', () => location.reload());
socket.on('aviso_app', m => {
  if (/Competencia nueva cargada/.test(m)) setTimeout(() => location.reload(), 5000);
});

// Atajos para quien usa la mesa con teclado o pedal.
document.addEventListener('keydown', e => {
  if (!autorizado || e.target.tagName === 'INPUT') return;
  if (e.code === 'Space' || e.key === 'ArrowRight') { e.preventDefault(); socket.emit('siguiente'); }
  if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); socket.emit('deshacer'); }
});
