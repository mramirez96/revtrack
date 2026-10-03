// PIN de mesa + token de sesión. Reemplaza el par socket-conectado/`esMesa`
// booleano de server.js: acá no hay conexión persistente que recuerde quién
// se autenticó, así que el cliente recibe un token firmado y lo manda en cada
// pedido. Sigue siendo "un PIN, no autenticación" — el token sólo prueba que
// en algún momento alguien tipeó el PIN correcto para ESE ring.

import crypto from 'node:crypto';
import { pool } from './db.js';

const MESA_PIN = process.env.MESA_PIN || '1234';
// Sin fallback, a propósito: a diferencia del PIN (adivinable a mano, y
// protegido por el límite de intentos), este es un secreto criptográfico —
// firma los tokens de mesa. Un default conocido en el código, aunque fuera
// "sólo para desarrollo", serviría igual si algún deploy lo dejara puesto por
// error. Mejor que reventar temprano y claro que confiar en detectar
// "producción" correctamente.
const MESA_SECRET = process.env.MESA_SECRET
  || (() => { throw new Error('Falta MESA_SECRET en el entorno (cualquier string largo y random sirve).'); })();

// Intentos de PIN por IP antes de un bloqueo corto. Un PIN de 4 dígitos sin
// esto se agota por fuerza bruta en segundos.
const PIN_INTENTOS = 5;
const PIN_BLOQUEO_MS = 60000;
// Cuánto dura la sesión de mesa antes de tener que volver a tipear el PIN.
const TOKEN_MS = 24 * 60 * 60 * 1000;

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function firmar(payload) {
  return crypto.createHmac('sha256', MESA_SECRET).update(payload).digest();
}

function emitirToken(ringId) {
  const payload = JSON.stringify({ r: ringId, e: Date.now() + TOKEN_MS });
  const cuerpo = base64url(payload);
  const firma = base64url(firmar(cuerpo));
  return `${cuerpo}.${firma}`;
}

// Devuelve el ringId autorizado por el token si es válido, o null. No lanza:
// un token con formato roto es exactamente lo mismo que uno inválido.
function verificarToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [cuerpo, firma] = token.split('.');
  const esperada = base64url(firmar(cuerpo));
  const a = Buffer.from(firma || '');
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { r, e } = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8'));
    if (typeof e !== 'number' || e < Date.now()) return null;
    return r || null;
  } catch {
    return null;
  }
}

async function pinBloqueado(ip) {
  const { rows } = await pool.query('select hasta from pin_intentos where ip = $1', [ip]);
  if (!rows.length) return 0;
  const hasta = new Date(rows[0].hasta).getTime();
  return hasta > Date.now() ? Math.ceil((hasta - Date.now()) / 1000) : 0;
}

async function pinFallado(ip) {
  await pool.query(
    `insert into pin_intentos (ip, n, hasta) values ($1, 1, 'epoch')
     on conflict (ip) do update set
       n = case when pin_intentos.n + 1 >= $2 then 0 else pin_intentos.n + 1 end,
       hasta = case when pin_intentos.n + 1 >= $2
                 then now() + ($3::text || ' milliseconds')::interval
                 else pin_intentos.hasta end`,
    [ip, PIN_INTENTOS, PIN_BLOQUEO_MS]);
}

async function pinOk(ip) {
  await pool.query('delete from pin_intentos where ip = $1', [ip]);
}

// Único punto de entrada del PIN: valida el bloqueo, compara, y devuelve el
// token o el motivo por el que no lo da.
async function entrar(ip, ringId, pin) {
  const espera = await pinBloqueado(ip);
  if (espera) return { ok: false, mensaje: `Demasiados intentos. Probá de nuevo en ${espera} s.` };
  if (String(pin) !== MESA_PIN) {
    await pinFallado(ip);
    return { ok: false, mensaje: null };   // PIN incorrecto, sin más detalle — igual que hoy
  }
  await pinOk(ip);
  return { ok: true, token: emitirToken(ringId) };
}

// Middleware Express: exige `Authorization: Bearer <token>` válido para ESTE
// ring. El chequeo de ring es el mismo que hacía `pistaDeInscripcion` a nivel
// de conexión — un token de un ring no sirve para actuar sobre otro.
function requiereMesa(req, res, next) {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const ringAutorizado = token && verificarToken(token);
  if (!ringAutorizado || ringAutorizado !== req.params.ringId) {
    return res.status(401).json({ error: 'Necesitás el PIN de mesa para cambiar el orden.' });
  }
  next();
}

// Para /api/nueva_competencia: no es una acción sobre un ring en particular,
// alcanza con un token válido para cualquiera (mismo PIN para todos).
function requiereMesaGlobal(req, res, next) {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !verificarToken(token)) {
    return res.status(401).json({ error: 'Necesitás el PIN de mesa para cargar una competencia.' });
  }
  next();
}

// `x-real-ip` lo pone el borde de la plataforma, no lo puede pisar quien
// manda el pedido — a diferencia de `x-forwarded-for`, que un cliente puede
// prellenar con un valor propio antes de que el proxy le agregue el suyo, y
// tomar "el primero de la lista" leería el falso. Se usa como respaldo nada
// más para correr en local, donde no hay ningún proxy poniendo nada.
const ipDe = req => req.get('x-real-ip')
  || (req.get('x-forwarded-for') || '').split(',')[0].trim()
  || req.socket.remoteAddress;

export { entrar, verificarToken, requiereMesa, requiereMesaGlobal, ipDe };
