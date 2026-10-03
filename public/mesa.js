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

// Resultado que se está cargando: a qué perro (null = el que propone la mesa,
// el último que corrió sin resultado) y lo tipeado hasta ahora. Vive acá y no
// sólo en el input porque cada snapshot que llega repinta la pantalla entera,
// y lo que se estaba tipeando no se puede perder.
let editando = null;
let borrador = null;
// Lo tipeado en el TRS de cada pista, hasta que se guarda.
const trsBorrador = {};
// La lista de resultados ya cargados se muestra corta salvo que se pida entera.
let todosCargados = false;
// Resultados que se mandaron y todavía no volvieron. Mientras tanto se los
// trata como cargados, así la mesa salta al próximo perro sin esperar al
// servidor (y un snapshot que llegue en el medio no la hace volver atrás).
const guardando = new Set();

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

  // A quién se le carga el resultado: el que eligió la mesa o, si no eligió,
  // el último que corrió sin resultado (el que acaba de salir de la pista), y
  // si no hay, el que está en pista.
  const corrieron = lista.filter(i => i.estado === 'corrido' || i.estado === 'en_pista');
  const sinResultado = corrieron.filter(i => !i.resultado && !guardando.has(i.id));
  const objetivo = (editando && corrieron.find(i => i.id === editando))
    || sinResultado.filter(i => i.estado === 'corrido').pop()
    || sinResultado.find(i => i.estado === 'en_pista')
    || null;
  if (!objetivo) borrador = null;
  else if (!borrador || borrador.id !== objetivo.id) borrador = borradorDe(objetivo);

  // Repintar con innerHTML le saca el foco al input en el que se está
  // tipeando (llega un snapshot de otra mesa a mitad del tiempo): se anota y
  // se devuelve.
  const activo = document.activeElement;
  const foco = activo && activo.id
    ? { id: activo.id, ini: activo.selectionStart, fin: activo.selectionEnd } : null;

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

    ${seccionResultado(objetivo, sinResultado, corrieron.filter(i => i.resultado))}

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

    ${seccionTrs()}

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
  if (btnSig) btnSig.onclick = () => accion('siguiente', undefined, btnSig);
  const btnAus = el('btnAusente');
  if (btnAus) btnAus.onclick = () => {
    const objetivo = enPista || pendientes[0];
    if (!objetivo) return;
    const quien = `${objetivo.perro} (${objetivo.guia}${objetivo.dorsal ? `, dorsal ${objetivo.dorsal}` : ''})`;
    if (confirm(`¿Marcar ausente a ${quien}?`)) {
      accion('ausente', { id: objetivo.id }, btnAus);
    }
  };
  const btnDeshacer = el('btnDeshacer');
  btnDeshacer.onclick = () => accion('deshacer', undefined, btnDeshacer);

  const btnVolver = el('btnVolverActiva');
  if (btnVolver) btnVolver.onclick = () => verPista(null, btnVolver);
  const btnAbrir = el('btnAbrirEsta');
  if (btnAbrir) btnAbrir.onclick = () => {
    if (confirm(`¿Abrir ${snap.pista.nombre}? La que está en curso queda en pausa.`)) {
      accion('abrir_pista', { id: snap.pista.id }, btnAbrir);
      verPista(null);
    }
  };

  el('app').querySelectorAll('[data-mover]').forEach(b => {
    b.onclick = () => accion('mover', { id: b.dataset.mover, delta: Number(b.dataset.delta) }, b);
  });
  el('app').querySelectorAll('[data-ausente]').forEach(b => {
    b.onclick = () => accion('ausente', { id: b.dataset.ausente }, b);
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
    lector.onload = () => accion('cargar_orden', { pistaId, csv: String(lector.result), invertir }, btnOrden);
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
    lector.onload = () => nuevaCompetenciaSubmit(String(lector.result), btnNueva);
    lector.readAsText(archivo, 'utf-8');
  };

  // Tocar un chip sólo cambia lo que la mesa está viendo. Abrir una pista —que
  // pausa la que está corriendo— es el botón aparte, con confirmación.
  el('app').querySelectorAll('[data-ver]').forEach(b => {
    b.onclick = () => verPista(b.dataset.ver, b);
  });
  el('app').querySelectorAll('[data-mpista]').forEach(b => {
    b.onclick = () => accion('mover_pista', { id: b.dataset.mpista, delta: Number(b.dataset.delta) }, b);
  });

  conectarResultado(objetivo);
  conectarTrs();

  if (foco) {
    const n = el(foco.id);
    if (n && n.focus) {
      n.focus();
      try { n.setSelectionRange(foco.ini, foco.fin); } catch { /* no es un input de texto */ }
    }
  }

  frescura();
}

/* ── resultados ──────────────────────────────────────────────────────── */

const fmt = Resultados.fmt;

function borradorDe(i) {
  const r = i.resultado;
  return {
    id: i.id,
    tiempo: r && r.tiempo !== null ? fmt(r.tiempo) : '',
    faltas: r ? r.faltas : 0,
    rehuses: r ? r.rehuses : 0,
    eliminado: r ? r.eliminado : false
  };
}

const nombrePodio = i => i.podio || Resultados.podioDe(i).nombre;

// La penalización de lo que está tipeado, antes de guardar: mismo cálculo que
// el servidor (public/resultados.js), así lo que se ve es lo que va a quedar.
function vistaPrevia() {
  const t = Resultados.leerNumero(borrador.tiempo);
  if (!borrador.eliminado && t === null) {
    return borrador.tiempo.trim() ? 'El tiempo no es un número.' : 'Falta el tiempo.';
  }
  const regla = snap.trs;
  const calc = Resultados.calcular({
    tiempo: t, faltas: borrador.faltas, rehuses: borrador.rehuses, eliminado: borrador.eliminado
  }, regla);
  if (calc.eliminado) return `→ ${Resultados.desglose(calc)} · No clasifica`;
  return `→ ${fmt(calc.total)} pen. · ${calc.calif} · ${Resultados.desglose(calc)} · ${
    regla ? `TRS ${fmt(regla.trs)} s` : 'sin TRS cargado'}`;
}

const contador = (campo, nombre) => `
  <div class="res-campo"><span>${nombre}</span>
    <div class="res-cont">
      <button class="iconbtn" data-cont="${campo}" data-d="-1" aria-label="Restar ${nombre.toLowerCase()}"
              ${borrador[campo] ? '' : 'disabled'}>−</button>
      <b class="mono">${borrador[campo]}</b>
      <button class="iconbtn" data-cont="${campo}" data-d="1" aria-label="Sumar ${nombre.toLowerCase()}">+</button>
    </div>
  </div>`;

function seccionResultado(objetivo, sinResultado, cargados) {
  if (!snap.pista?.arrancada) return '';
  const otrosSin = sinResultado.filter(i => i.id !== objetivo?.id);
  // Los más recientes primero: lo que se corrige suele ser lo último cargado.
  const recientes = [...cargados].reverse();
  const visibles = todosCargados ? recientes : recientes.slice(0, 5);
  return `
    <section class="mesa-seccion">
      <p class="eyebrow">Resultado${sinResultado.length ? ` · faltan cargar ${sinResultado.length}` : ''}</p>
      ${objetivo ? `
        <div class="res-editor">
          <div class="mesa-actual-fila">
            ${dorsalDe(objetivo)}
            <span><span class="mesa-item-quien">${esc(objetivo.perro)}</span><br>
            <span class="mesa-item-sub">${esc(objetivo.guia)}${etiquetas(objetivo)} · ${esc(nombrePodio(objetivo))}${
              objetivo.estado === 'en_pista' ? ' · en pista' : ''}</span></span>
          </div>
          <div class="res-campos">
            <label class="res-campo"><span>Tiempo (s)</span>
              <input id="resTiempo" type="text" inputmode="decimal" autocomplete="off" placeholder="38,52"
                     value="${esc(borrador.tiempo)}"></label>
            ${contador('faltas', 'Faltas')}
            ${contador('rehuses', 'Negativas')}
          </div>
          <label class="orden-check"><input type="checkbox" id="resElim" ${borrador.eliminado ? 'checked' : ''}> Eliminado</label>
          <p class="res-previa mono" id="resPrevia">${esc(vistaPrevia())}</p>
          <div class="res-btns">
            <button class="btn" id="btnResGuardar" style="background:var(--chalk);color:var(--turf)">Guardar resultado</button>
            ${objetivo.resultado ? '<button class="mesa-link" id="btnResBorrar">Borrar resultado</button>' : ''}
            ${editando ? '<button class="mesa-link" id="btnResCancelar">Cancelar</button>' : ''}
          </div>
        </div>`
      : `<p class="mesa-actual-sub" style="margin-top:8px">Todos los que corrieron tienen su resultado.</p>`}
      ${otrosSin.length ? `
        <p class="mesa-actual-sub" style="margin:14px 0 0">También ${otrosSin.length === 1 ? 'falta' : 'faltan'}:</p>
        <div class="mesa-pistas">${otrosSin.map(i =>
          `<button class="chip" data-editar="${i.id}">${esc(i.dorsal || i.perro)}</button>`).join('')}</div>` : ''}
      ${recientes.length ? `
        <p class="mesa-actual-sub" style="margin:14px 0 0">Cargados · tocá uno para corregirlo</p>
        <ul class="mesa-lista">${visibles.map(i => `
          <li class="mesa-item ${i.id === objetivo?.id ? 'viendo' : ''}">
            ${dorsalDe(i)}
            <button class="mesa-pista-sel" data-editar="${i.id}">${esc(i.perro)}
              <span class="mesa-item-sub">${esc(Resultados.resumenCorto(i.res))}${
                i.puesto ? ` · ${i.puesto}º en ${esc(i.podio)}` : ''}</span>
            </button>
          </li>`).join('')}</ul>
        ${recientes.length > 5 ? `<button class="mesa-link" id="btnTodosCargados">${
          todosCargados ? 'Ver sólo los últimos' : `Ver los ${recientes.length}`}</button>` : ''}` : ''}
    </section>`;
}

function conectarResultado(objetivo) {
  el('app').querySelectorAll('[data-editar]').forEach(b => {
    b.onclick = () => { editando = b.dataset.editar; borrador = null; render(); };
  });
  const btnTodos = el('btnTodosCargados');
  if (btnTodos) btnTodos.onclick = () => { todosCargados = !todosCargados; render(); };
  if (!objetivo) return;

  const inT = el('resTiempo');
  if (inT) {
    // Tipear no repinta: sólo actualiza la vista previa, así no se pierde el cursor.
    inT.oninput = () => { borrador.tiempo = inT.value; el('resPrevia').textContent = vistaPrevia(); };
    inT.onkeydown = e => { if (e.key === 'Enter') guardarResultado(objetivo, el('btnResGuardar')); };
  }
  el('app').querySelectorAll('[data-cont]').forEach(b => {
    b.onclick = () => {
      const campo = b.dataset.cont;
      borrador[campo] = Math.max(0, borrador[campo] + Number(b.dataset.d));
      render();
    };
  });
  const elim = el('resElim');
  if (elim) elim.onchange = () => { borrador.eliminado = elim.checked; render(); };
  const btnG = el('btnResGuardar');
  if (btnG) btnG.onclick = () => guardarResultado(objetivo, btnG);
  const btnB = el('btnResBorrar');
  if (btnB) btnB.onclick = () => {
    if (confirm(`¿Borrar el resultado de ${objetivo.perro}?`)) guardarResultado(objetivo, btnB, true);
  };
  const btnC = el('btnResCancelar');
  if (btnC) btnC.onclick = () => { editando = null; borrador = null; render(); };
}

async function guardarResultado(i, btn, borrar) {
  if (borrar) {
    if (!(await accion('resultado', { id: i.id, borrar: true }, btn))) return;
    editando = null;
    borrador = null;
    aviso(`Resultado de ${i.perro} borrado.`);
    return cargarSnapshot();
  }

  // Lo que el servidor va a rechazar seguro se frena acá, antes de saltar:
  // si no, la mesa pasaría al próximo perro y tendría que volver.
  if (!borrador.eliminado && Resultados.leerNumero(borrador.tiempo) === null) {
    return aviso(borrador.tiempo.trim() ? 'El tiempo no es un número.' : 'Falta el tiempo.', true);
  }

  // Salta ya al próximo perro y guarda en segundo plano. Si el servidor dice
  // que no, vuelve a este perro con lo que se había tipeado.
  const tipeado = borrador;
  const body = { id: i.id, tiempo: tipeado.tiempo, faltas: tipeado.faltas, rehuses: tipeado.rehuses, eliminado: tipeado.eliminado };
  guardando.add(i.id);
  editando = null;
  borrador = null;
  render();
  const inT = el('resTiempo');
  if (inT && inT.focus) inT.focus();   // listo para tipear el tiempo del siguiente

  const ok = await accion('resultado', body);
  if (!ok) {
    guardando.delete(i.id);
    editando = i.id;
    borrador = tipeado;
    render();
    return;
  }
  aviso(`Guardado: ${i.perro}.`, false, 1800);
  await cargarSnapshot();
  guardando.delete(i.id);
}

/* ── TRS ─────────────────────────────────────────────────────────────── */

// Largo y velocidad sin ceros de relleno: "191" y "4,5", como en la planilla.
const fmtLibre = n => n.toLocaleString('es-AR', { maximumFractionDigits: 2 });

function valorTrs() {
  if (trsBorrador[snap.pista.id]) return trsBorrador[snap.pista.id];
  const r = snap.trs;
  return {
    largo: r?.largo ? fmtLibre(r.largo) : '',
    velocidad: r?.velocidad ? fmtLibre(r.velocidad) : '',
    trs: r?.trs ? fmt(r.trs) : ''
  };
}

// Con largo y velocidad, el TRS sale de la cuenta y no se tipea; sin ellos,
// se puede cargar directo.
function trsCalculado(v) {
  return Resultados.trsDe(Resultados.leerNumero(v.largo), Resultados.leerNumero(v.velocidad));
}

function seccionTrs() {
  if (!snap.pista || !snap.lista.length) return '';
  const v = valorTrs();
  const calc = trsCalculado(v);
  const campo = (c, nombre, unidad, valor, extra = '') => `
    <label>${nombre} <input id="trs-${c}" data-trs="${c}" type="text"
           inputmode="decimal" autocomplete="off" placeholder="—" value="${esc(valor)}" ${extra}> ${unidad}</label>`;
  return `
    <section class="mesa-seccion">
      <p class="eyebrow">TRS · ${esc(snap.pista.nombre)}</p>
      <p class="mesa-actual-sub" style="margin:8px 0 6px">
        Uno para toda la pista: largo del recorrido ÷ velocidad, como en la planilla.
        Si ya tenés el TRS calculado, dejá largo y velocidad vacíos y cargalo directo.
        Cada segundo por encima del TRS suma un punto.
      </p>
      <div class="trs-fila">
        ${campo('largo', 'Largo', 'm', v.largo)}
        ${campo('velocidad', 'Velocidad', 'm/s', v.velocidad)}
        ${campo('trs', 'TRS', 's', calc ? fmt(calc) : v.trs, calc ? 'disabled' : '')}
        <button class="btn chico" id="btnTrsGuardar" style="background:var(--chalk);color:var(--turf)">Guardar</button>
      </div>
    </section>`;
}

function conectarTrs() {
  el('app').querySelectorAll('[data-trs]').forEach(inp => {
    inp.oninput = () => {
      const v = { ...valorTrs(), [inp.dataset.trs]: inp.value };
      trsBorrador[snap.pista.id] = v;
      // El TRS se recalcula mientras se tipea, sin repintar (no perder el cursor).
      const inTrs = el('trs-trs');
      const calc = trsCalculado(v);
      if (inTrs && inp !== inTrs) {
        inTrs.disabled = !!calc;
        inTrs.value = calc ? fmt(calc) : v.trs;
      }
    };
  });
  const b = el('btnTrsGuardar');
  if (b) b.onclick = async () => {
    const v = valorTrs();
    const body = { pistaId: snap.pista.id, largo: v.largo, velocidad: v.velocidad };
    // Con largo y velocidad manda la cuenta; el TRS tipeado sólo cuenta sin ellos.
    if (!v.largo && !v.velocidad) body.trs = v.trs;
    if (!(await accion('trs', body, b))) return;
    delete trsBorrador[snap.pista.id];
    aviso(v.trs || v.largo ? 'TRS guardado. Los resultados se recalcularon.' : 'TRS borrado.');
    cargarSnapshot();
  };
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
  const btnPin = el('btnPin');
  const enviar = () => entrarConPin(el('inPin').value.trim(), btnPin);
  btnPin.onclick = enviar;
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

async function entrarConPin(pin, btn) {
  if (!pin) return;
  conCarga(btn, true);
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
  } finally {
    conCarga(btn, false);
  }
}

/* ── acciones + tiempo real ──────────────────────────────────────────── */

// El botón muestra un spinner apenas se toca en vez de esperar a que vuelva
// el servidor — en la nube cada acción es un viaje a Postgres, no la llamada
// en memoria de antes, y sin esto el toque se sentía como que no pasó nada.
function conCarga(btn, on) {
  if (!btn) return;
  if (on) {
    btn.dataset.htmlPrevio = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
  } else if (btn.isConnected) {
    btn.disabled = false;
    if (btn.dataset.htmlPrevio !== undefined) btn.innerHTML = btn.dataset.htmlPrevio;
    delete btn.dataset.htmlPrevio;
  }
}

async function accion(ruta, body, btn) {
  conCarga(btn, true);
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
    return true;
  } catch {
    aviso('No pude conectarme al servidor.', true);
  } finally {
    conCarga(btn, false);
  }
}

async function nuevaCompetenciaSubmit(csv, btn) {
  conCarga(btn, true);
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
  } finally {
    conCarga(btn, false);
  }
}

function verPista(id, btn) {
  viendo = id;
  cargarSnapshot(btn);
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

async function cargarSnapshot(btn) {
  conCarga(btn, true);
  try {
    const q = viendo ? `?pista=${encodeURIComponent(viendo)}` : '';
    const r = await fetch(`/api/ring/${encodeURIComponent(ringId)}${q}`);
    if (r.status === 404) return ringInexistente();
    // Un 500 trae { error }, no un snapshot: pisar el estado con eso rompía la pantalla.
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    snap = await r.json();
    recibidoEn = Date.now();
    render();
  } catch {
    aviso('No pude conectarme al servidor.', true);
  } finally {
    conCarga(btn, false);
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
  if (e.code === 'Space' || e.key === 'ArrowRight') { e.preventDefault(); accion('siguiente', undefined, el('btnSiguiente')); }
  if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); accion('deshacer', undefined, el('btnDeshacer')); }
});
