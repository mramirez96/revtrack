export function minutos(seg) {
  const m = Math.round(seg / 60);
  if (m < 1) return 'menos de 1 min';
  if (m === 1) return '1 min';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function reloj(segDesdeAhora) {
  const d = new Date(Date.now() + segDesdeAhora * 1000);
  return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

export const plural = (n, uno, muchos) => (n === 1 ? uno : muchos);

export const normal = s => String(s ?? '').trim().toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '');

// Un perro con dorsal se reconoce SÓLO por su dorsal; uno sin dorsal, por su
// nombre. Así dos perros que se llaman igual nunca se confunden entre sí: el
// matcheo por nombre se usa nada más donde no hay números que comparar.
export function esMio(i, clave) {
  if (!clave) return false;
  return i.dorsal ? String(i.dorsal) === String(clave).trim() : normal(i.perro) === normal(clave);
}

// Largo y velocidad sin ceros de relleno: "191" y "4,5", como en la planilla.
export const fmtLibre = n => n.toLocaleString('es-AR', { maximumFractionDigits: 2 });

// localStorage puede no estar (modo privado, almacenamiento bloqueado): nunca
// tiene que romper la pantalla.
export const guardado = {
  leer(k) { try { return localStorage.getItem(k); } catch { return null; } },
  escribir(k, v) { try { localStorage.setItem(k, v); } catch { /* sin espacio o sin storage */ } },
  borrar(k) { try { localStorage.removeItem(k); } catch { /* sin storage */ } }
};
