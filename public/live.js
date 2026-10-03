'use strict';

const ringId = location.pathname.split('/').filter(Boolean)[1];
// Qué pista se está mirando. Sin `?pista=` es la que está corriendo.
let pistaId = new URLSearchParams(location.search).get('pista') || null;
const CACHE_KEY = `snap:${ringId}:${pistaId || 'activa'}`;

const el = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let snap = null;
// Lo que el corredor puso para reconocerse: su dorsal, o el nombre del perro
// cuando en esa pista no se reparten números (los G0, por ejemplo).
let miClave = localStorage.getItem('miClave') || localStorage.getItem('miDorsal') || '';
let recibidoEn = 0;

/* ── formato ─────────────────────────────────────────────────────────── */

function minutos(seg) {
  const m = Math.round(seg / 60);
  if (m < 1) return 'menos de 1 min';
  if (m === 1) return '1 min';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function reloj(segDesdeAhora) {
  const d = new Date(Date.now() + segDesdeAhora * 1000);
  return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

function plural(n, uno, muchos) { return n === 1 ? uno : muchos; }

const normal = s => String(s ?? '').trim().toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// Un perro con dorsal se reconoce SÓLO por su dorsal; uno sin dorsal, por su
// nombre. Así los dos perros que se llaman igual nunca se confunden entre sí:
// el matcheo por nombre se usa nada más donde no hay números que comparar.
function esMio(i, clave = miClave) {
  if (!clave) return false;
  return i.dorsal ? String(i.dorsal) === String(clave).trim() : normal(i.perro) === normal(clave);
}

// El recuadro del dorsal se omite cuando no hay número, para no dejar un hueco.
const dorsalDe = (i, clases = 'dorsal') =>
  i.dorsal ? `<span class="${clases}">${esc(i.dorsal)}</span>` : '';

// Altura y grado del perro. En la misma pista corren todos mezclados, así que
// son el dato que dice quién es cada uno. Se omite la etiqueta que el CSV no
// traiga, para no dejar un recuadro vacío colgando.
function etiquetas(i) {
  return [i.altura, i.categoria]
    .filter(Boolean)
    .map(t => ` <span class="etiq">${esc(t)}</span>`)
    .join('');
}

/* ── render ──────────────────────────────────────────────────────────── */

function render() {
  if (!snap) return;

  el('ringNombre').textContent = snap.ring.nombre;
  el('pistaNombre').textContent = snap.pista
    ? snap.pista.nombre
    : 'sin pista abierta';
  document.title = snap.pista
    ? `${snap.pista.nombre} · ${snap.ring.nombre}`
    : `${snap.ring.nombre} · RevTrack`;

  renderPistas();

  const lista = snap.lista;
  const enPista = lista.find(i => i.estado === 'en_pista');
  const pendientes = lista.filter(i => i.estado === 'pendiente');

  // En pista
  el('pistaCuerpo').innerHTML = enPista
    ? `<div class="pista-fila">
         ${dorsalDe(enPista, 'dorsal pista-dorsal')}
         <span class="pista-quien">
           <span class="pista-nombre">${esc(enPista.perro)}</span>
           <span class="pista-sub">${esc(enPista.guia)}${enPista.raza ? ' · ' + esc(enPista.raza) : ''}${etiquetas(enPista)}</span>
         </span>
       </div>`
    : !snap.pista?.arrancada && pendientes.length
      // Una pista que todavía no largó: no hay "nadie en pista", no arrancó.
      ? `<p class="pista-vacia">Todavía no arrancó</p>
         <p class="pista-nota">${lista.length} ${plural(lista.length, 'anotado', 'anotados')}${
           snap.activa && !snap.esActiva ? ` · ahora corre ${esc(snap.activa.nombre)}` : ''}</p>`
      : pendientes.length
        ? `<p class="pista-vacia">Nadie en pista</p>
           <p class="pista-nota">Faltan ${pendientes.length} ${plural(pendientes.length, 'perro', 'perros')} en esta pista</p>`
        : `<p class="pista-vacia">Pista terminada</p>
           <p class="pista-nota">${snap.pistas.some(p => p.estado === 'pendiente')
              ? 'Esperando que la mesa abra la siguiente'
              : 'No queda nada más por correr'}</p>`;

  renderTurno(lista, pendientes);
  renderCola(lista, pendientes);
  renderVista();
  frescura();
}

// Selector de pistas del ring: deja mirar el orden de cualquiera, no sólo la que
// está corriendo. Cambia sin recargar la página.
function renderPistas() {
  const cont = el('pistas');
  if (!cont) return;
  if (!snap.pistas || snap.pistas.length < 2) { cont.innerHTML = ''; return; }

  cont.innerHTML = snap.pistas.map(p => `
    <button class="chip ${p.id === snap.pista?.id ? 'activa' : ''} ${p.estado === 'cerrada' ? 'cerrada' : ''}"
            data-ver="${p.id}">${esc(p.nombre)}${p.esActiva || p.id === snap.activa?.id ? ' ·' : ''}</button>`).join('');

  cont.querySelectorAll('[data-ver]').forEach(b => {
    b.onclick = () => {
      pistaId = b.dataset.ver;
      const url = new URL(location.href);
      url.searchParams.set('pista', pistaId);
      history.replaceState(null, '', url);
      cargarSnapshot();
    };
  });
}

function renderTurno(lista, pendientes) {
  const cont = el('turnoCuerpo');
  const seccion = el('turno');
  seccion.className = 'turno';

  // En una pista sin dorsales (los G0) se pide el nombre del perro; en una con
  // números, el dorsal. Si hay de los dos, se aclara.
  const conDorsal = lista.some(i => i.dorsal);
  const sinDorsal = lista.some(i => !i.dorsal);
  const pide = conDorsal && sinDorsal
    ? { texto: 'Poné tu dorsal, o el nombre de tu perro si no tenés número', ph: '47', modo: 'text', etiq: 'Tu dorsal o el nombre de tu perro' }
    : conDorsal
      ? { texto: 'Poné tu dorsal', ph: '47', modo: 'numeric', etiq: 'Tu dorsal' }
      : { texto: 'Poné el nombre de tu perro', ph: 'OREO', modo: 'text', etiq: 'El nombre de tu perro' };

  if (!miClave) {
    cont.innerHTML = `
      <p class="eyebrow">Tu turno</p>
      <p class="cuenta-txt" style="margin-top:6px">${pide.texto} y te digo cuántos perros faltan para que te toque.</p>
      <div class="dorsal-set">
        <input id="inDorsal" type="text" inputmode="${pide.modo}" placeholder="${pide.ph}" aria-label="${pide.etiq}">
        <button class="btn" id="btnDorsal">Guardar</button>
      </div>`;
    el('btnDorsal').onclick = guardarClave;
    el('inDorsal').onkeydown = e => { if (e.key === 'Enter') guardarClave(); };
    return;
  }

  const mio = lista.find(i => esMio(i));
  const cambiar = `<div class="dorsal-set"><button class="btn fantasma chico" id="btnOtro">Cambiar (${esc(miClave)})</button></div>`;

  if (!mio) {
    cont.innerHTML = `<p class="eyebrow">Tu turno</p>
      <p class="cuenta-txt" style="margin-top:6px">${esc(miClave)} no está en esta pista.</p>
      <p class="cuenta-sub">Puede ser que corras en otra pista.</p>${cambiar}`;
  } else if (mio.estado === 'en_pista') {
    seccion.className = 'turno es-vos';
    cont.innerHTML = `<p class="eyebrow">Tu turno</p>
      <div class="cuenta"><span class="dorsal cuenta-n">Ya</span>
      <span class="cuenta-txt">Estás en pista.<br><span class="cuenta-sub">Suerte.</span></span></div>${cambiar}`;
  } else if (mio.estado !== 'pendiente') {
    seccion.className = 'turno ya';
    cont.innerHTML = `<p class="eyebrow">Tu turno</p>
      ${mio.estado === 'ausente'
        ? '<p class="cuenta-txt" style="margin-top:6px">Figurás como ausente en esta pista.</p>'
        : miResultado(mio)}${cambiar}`;
  } else if (!snap.pista?.arrancada) {
    // La pista no largó todavía: la hora estimada sería inventada, porque no se
    // sabe cuándo arranca. Se dice la posición, que sí es un dato firme.
    const puesto = pendientes.indexOf(mio) + 1;
    seccion.className = 'turno';
    cont.innerHTML = `
      <p class="eyebrow">Tu turno</p>
      <div class="cuenta">
        <span class="dorsal cuenta-n">${puesto}º</span>
        <span class="cuenta-txt">de ${pendientes.length} en esta pista
          <br><span class="cuenta-sub">Todavía no arrancó${
            snap.activa && !snap.esActiva ? `; ahora corre ${esc(snap.activa.nombre)}` : ''}.</span>
        </span>
      </div>
      <p class="cuenta-sub">Cuando la mesa la abra vas a ver cuántos perros faltan y a qué hora aproximada te toca.</p>
      ${cambiar}`;
  } else {
    const faltan = pendientes.indexOf(mio);
    const seg = faltan * snap.segPerro;
    seccion.className = 'turno es-vos';
    cont.innerHTML = `
      <p class="eyebrow">Tu turno</p>
      <div class="cuenta">
        <span class="dorsal cuenta-n">${faltan}</span>
        <span class="cuenta-txt">${faltan === 0 ? 'Sos el próximo.' : `${plural(faltan, 'perro', 'perros')} antes que vos`}
          <br><span class="cuenta-sub">${faltan === 0 ? 'Andá al ingreso.' : `aprox. ${minutos(seg)} · cerca de las ${reloj(seg)}`}</span>
        </span>
      </div>
      ${tally(faltan)}
      <p class="cuenta-sub">${snap.estimadoRealista
        ? `Calculado con el ritmo real de la pista: ${snap.segPerro} s por perro.`
        : `Estimado con ${snap.segPerro} s por perro. Se ajusta cuando la pista arranca.`}</p>
      ${cambiar}`;
  }

  const btn = el('btnOtro');
  if (btn) btn.onclick = () => {
    miClave = '';
    localStorage.removeItem('miClave');
    localStorage.removeItem('miDorsal');
    render();
  };
}

// Marcas de conteo agrupadas de cinco: una raya por perro que falta.
function tally(n) {
  if (n === 0) return '';
  const tope = Math.min(n, 30);
  let html = '<div class="tally" aria-hidden="true">';
  for (let g = 0; g < Math.ceil(tope / 5); g++) {
    html += '<span class="tally-grupo">';
    for (let i = g * 5; i < Math.min((g + 1) * 5, tope); i++) {
      html += `<i class="${(i + 1) % 5 === 0 ? 'alta' : ''}"></i>`;
    }
    html += '</span>';
  }
  if (n > tope) html += `<span class="tally-mas">+${n - tope}</span>`;
  return html + '</div>';
}

// La pista entera, en orden de salida: los que ya corrieron grisados, el que
// está en pista marcado, y los que faltan con su hora estimada.
const MARCA = {
  corrido:  { clase: 'corrido',   nota: 'corrió' },
  en_pista: { clase: 'corriendo', nota: 'en pista' },
  ausente:  { clase: 'ausente',   nota: 'ausente' }
};

function renderCola(lista, pendientes) {
  const ul = el('cola');

  if (!lista.length) {
    ul.innerHTML = '<li class="vacio">Esta pista no tiene a nadie anotado.</li>';
    return;
  }

  ul.innerHTML = lista.map(i => {
    const marca = MARCA[i.estado];
    const idx = pendientes.indexOf(i);
    const clases = ['cola-item'];
    if (esMio(i)) clases.push('vos');
    if (marca) clases.push(marca.clase);
    return `<li class="${clases.join(' ')}">
      ${dorsalDe(i)}
      <span class="cola-quien">
        <span class="cola-nombre">${esc(i.perro)}</span><br>
        <span class="cola-sub">${esc(i.guia)}${etiquetas(i)}</span>
      </span>
      ${i.res
        ? resCola(i.res)
        : `<span class="cola-eta mono">${marca
            ? marca.nota
            : snap.pista?.arrancada ? reloj(idx * snap.segPerro) : `${idx + 1}º`}</span>`}
    </li>`;
  }).join('');
}

/* ── resultados ──────────────────────────────────────────────────────── */

const fmt = Resultados.fmt;

// Penalización arriba, tiempo abajo: lo primero es lo que ordena el podio.
function resCola(res) {
  return `<span class="cola-eta cola-res mono">${res.eliminado
    ? '<b>E</b>'
    : `<b>${fmt(res.total)}</b>`}<br><span class="cola-res-t">${
      res.tiempo !== null ? `${fmt(res.tiempo)} s` : ''}</span></span>`;
}

function miResultado(mio) {
  if (!mio.res) {
    return `<p class="cuenta-txt" style="margin-top:6px">Ya corriste esta pista.</p>
      <p class="cuenta-sub">Tu resultado todavía no está cargado.</p>`;
  }
  const podio = (snap.clasificacion || []).find(p => p.filas.some(f => f.id === mio.id));
  const provisorio = podio && podio.faltan
    ? ` Provisorio: ${podio.faltan === 1 ? 'falta 1' : `faltan ${podio.faltan}`} por correr en tu podio.` : '';
  return `
    <div class="cuenta">
      <span class="dorsal cuenta-n">${mio.puesto ? `${mio.puesto}º` : 'E'}</span>
      <span class="cuenta-txt">${mio.puesto
        ? `de ${podio.clasificados} en ${esc(mio.podio)}`
        : `Eliminado en ${esc(mio.podio)}`}
        <br><span class="cuenta-sub">${esc(Resultados.resumenCorto(mio.res))} · ${esc(Resultados.desglose(mio.res))}</span>
      </span>
    </div>
    ${provisorio ? `<p class="cuenta-sub">${provisorio.trim()}</p>` : ''}`;
}

// Orden de salida o clasificación. La pestaña sólo aparece cuando hay algún
// resultado: antes, "Clasificación" sería una pantalla vacía.
let vista = 'orden';
try { vista = localStorage.getItem('vista') === 'clasif' ? 'clasif' : 'orden'; } catch { /* sin storage */ }

function renderVista() {
  const hay = (snap.clasificacion || []).some(p => p.filas.length);
  const enClasif = hay && vista === 'clasif';
  el('vistaTabs').innerHTML = hay ? `
    <button class="tab ${enClasif ? '' : 'activa'}" id="tabOrden">Orden de salida</button>
    <button class="tab ${enClasif ? 'activa' : ''}" id="tabClasif">Clasificación</button>` : '';
  el('colaTitulo').hidden = hay;
  el('cola').hidden = enClasif;
  el('clasif').hidden = !enClasif;
  if (enClasif) renderClasif();
  if (!hay) return;
  const elegir = v => () => {
    vista = v;
    try { localStorage.setItem('vista', v); } catch { /* sin storage */ }
    renderVista();
  };
  el('tabOrden').onclick = elegir('orden');
  el('tabClasif').onclick = elegir('clasif');
}

// "TRS 42,44 s · 191 m a 4,5 m/s": de dónde salió, para quien quiera hacer la cuenta.
function trsTexto(r) {
  if (!r?.trs) return 'sin TRS';
  const libre = n => n.toLocaleString('es-AR', { maximumFractionDigits: 2 });
  return `TRS ${fmt(r.trs)} s${r.largo ? ` · ${libre(r.largo)} m a ${libre(r.velocidad)} m/s` : ''}`;
}

function renderClasif() {
  // Un solo TRS para toda la pista: se dice una vez, arriba de los podios.
  el('clasif').innerHTML = `<p class="clasif-trs mono">${trsTexto(snap.trs)}</p>` +
    snap.clasificacion.filter(p => p.filas.length).map(p => `
    <div class="podio">
      <p class="podio-tit">${esc(p.nombre)}</p>
      <ol class="cola-lista">${p.filas.map(f => `
        <li class="cola-item ${esMio(f) ? 'vos' : ''} ${f.res.eliminado ? 'eliminado' : ''}">
          <span class="dorsal puesto">${f.puesto ?? 'E'}</span>
          <span class="cola-quien">
            <span class="cola-nombre">${esc(f.perro)}</span><br>
            <span class="cola-sub">${f.dorsal ? `${esc(f.dorsal)} · ` : ''}${esc(f.guia)}${etiquetas(f)}
              <span class="etiq calif ${f.res.calif === 'Cero Exc' ? 'cero' : ''}">${esc(f.res.calif)}</span></span>
          </span>
          ${resCola(f.res)}
        </li>`).join('')}</ol>
      ${p.faltan ? `<p class="podio-nota">Provisoria · ${p.faltan} por correr</p>` : ''}
    </div>`).join('');
}

function guardarClave() {
  const v = el('inDorsal').value.trim();
  if (!v) return;
  miClave = v;
  localStorage.setItem('miClave', v);
  render();
}

/* ── frescura del dato ───────────────────────────────────────────────── */

// "En vivo" ahora es directamente el estado de la suscripción de Realtime, no
// un pulso de servidor: mientras el canal está conectado no hace falta nada
// más para saber que lo que se ve sigue vigente.
let conectado = false;

function frescura() {
  const seg = Math.round((Date.now() - recibidoEn) / 1000);
  const pulso = el('pulso');
  const txt = el('frescura');
  if (!conectado) {
    pulso.className = 'pulso muerto';
    txt.textContent = seg < 90 ? 'sin señal' : `sin señal · ${minutos(seg)} atrás`;
  } else {
    pulso.className = 'pulso';
    txt.textContent = 'en vivo';
  }
}
setInterval(() => { if (snap) { frescura(); } }, 15000);

/* ── avisos ──────────────────────────────────────────────────────────── */

let avisoTimer = null;
function aviso(msg, esError) {
  const a = el('aviso');
  a.textContent = msg;
  a.className = 'aviso' + (esError ? ' error' : '');
  a.hidden = false;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => { a.hidden = true; }, 4000);
}

/* ── carga + tiempo real ─────────────────────────────────────────────── */

function guardarCache() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ snap, recibidoEn })); }
  catch { /* sin espacio: no es motivo para romper la vista */ }
}

try {
  const guardado = localStorage.getItem(CACHE_KEY);
  if (guardado) {
    const c = JSON.parse(guardado);
    snap = c.snap;
    recibidoEn = c.recibidoEn;
    render();
  }
} catch { /* caché corrupta, se ignora */ }

// Si el ring de la URL no existe, la pantalla quedaba en "Cargando…" sin
// salida ni explicación.
function ringInexistente() {
  document.querySelector('main').innerHTML = `
    <div class="wrap">
      <p class="eyebrow">Esta competencia no existe</p>
      <h1>${esc(ringId)}</h1>
      <p class="pie">Puede ser que se haya cargado otra competencia desde entonces,
      o que la dirección esté mal escrita.</p>
      <p style="margin-top:14px"><a class="btn" href="/" style="text-decoration:none">Ir al inicio</a></p>
    </div>`;
}

async function cargarSnapshot() {
  try {
    const q = pistaId ? `?pista=${encodeURIComponent(pistaId)}` : '';
    const r = await fetch(`/api/ring/${encodeURIComponent(ringId)}${q}`);
    if (r.status === 404) return ringInexistente();
    // Un 500 trae { error }, no un snapshot: pisar el estado con eso rompía la pantalla.
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    snap = await r.json();
    recibidoEn = Date.now();
    guardarCache();
    render();
  } catch {
    aviso('No pude conectarme al servidor.', true);
  }
}

// El broadcast manda un snapshot por cada pista del ring; sólo importa el de
// la que estoy mirando (o, si no elegí ninguna, el de la que sea la activa en
// este momento — así se sigue el puntero cuando la mesa cierra una pista y
// abre la próxima).
function alRecibirSnapshot(s) {
  if (pistaId ? s.pista?.id === pistaId : s.esActiva) {
    snap = s;
    recibidoEn = Date.now();
    guardarCache();
    render();
  }
}

cargarSnapshot();
RT.suscribir(`ring:${ringId}`, { snapshot: alRecibirSnapshot }, c => { conectado = c; frescura(); });
// La mesa cargó otra competencia: lo que está en pantalla ya no existe. Se
// limpia la caché de este ring para no repintar un evento que se fue.
RT.suscribir('global', {
  recargar: () => {
    try { localStorage.removeItem(CACHE_KEY); } catch { /* nada que hacer */ }
    location.reload();
  }
});

document.addEventListener('visibilitychange', () => {
  // Los navegadores mobile pausan el websocket con la pestaña en segundo
  // plano; al volver, un fetch nuevo es más seguro que confiar en que no se
  // haya perdido ningún mensaje mientras tanto.
  if (!document.hidden) { frescura(); cargarSnapshot(); }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
