-- Esquema de RevTrack en Postgres. Traducción directa de las cuatro colecciones
-- planas que ya describe el README (evento, rings[], pistas[], inscripciones[],
-- marcas{}) — no es un rediseño de modelo, sólo de dónde vive.
--
-- `marcas` (los timestamps de avance, para el cálculo de ritmo) vive como una
-- columna jsonb en `pistas` en vez de en tabla aparte: es un array chico
-- (MARCAS_TOPE = 20) que siempre se lee/escribe junto con su pista, así que no
-- gana nada por estar normalizado y sí complica cada consulta con un join.
--
-- `evento` y `seed_actual` son singleton: sólo puede existir una fila (el truco
-- `id boolean primary key default true` lo garantiza a nivel de constraint).

create table if not exists evento (
  id boolean primary key default true,
  nombre text not null,
  fecha date not null,
  constraint evento_singleton check (id)
);

create table if not exists rings (
  id text primary key,
  nombre text not null
);

create table if not exists pistas (
  id text primary key,
  ring_id text not null references rings(id) on delete cascade,
  nombre text not null,
  orden int not null,
  estado text not null default 'pendiente',
  seg_perro int not null default 35,
  marcas jsonb not null default '[]'::jsonb
);
create index if not exists pistas_ring_idx on pistas(ring_id);

create table if not exists inscripciones (
  id text primary key,
  pista_id text not null references pistas(id) on delete cascade,
  orden int not null,
  dorsal text,
  guia text,
  perro text not null,
  raza text,
  altura text,
  categoria text,
  estado text not null default 'pendiente'
);
create index if not exists inscripciones_pista_idx on inscripciones(pista_id);

-- Deshacer: una fila por acción, recortada a las últimas 25 por ring en la
-- misma transacción que la inserta (ver lib/estado.js:marcarUndo).
create table if not exists undo_pila (
  id bigserial primary key,
  ring_id text not null,
  etiqueta text not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists undo_pila_ring_idx on undo_pila(ring_id, id desc);

-- Intentos de PIN por IP. Reemplaza el `Map` en memoria de server.js: acá
-- tiene que ser una tabla porque no hay proceso persistente que lo sostenga
-- entre invocaciones de la función serverless.
create table if not exists pin_intentos (
  ip text primary key,
  n int not null default 0,
  hasta timestamptz not null default 'epoch'
);

-- El último CSV cargado, equivalente a data/seed.csv: permite resembrar sin
-- tener que volver a subir el archivo a mano.
create table if not exists seed_actual (
  id boolean primary key default true,
  csv text not null,
  constraint seed_actual_singleton check (id)
);

-- Respaldo completo antes de un "cargar otra competencia" (irreversible desde
-- la app). Equivalente a la copia state.json.anterior-<timestamp> de hoy.
create table if not exists respaldos (
  id bigserial primary key,
  motivo text not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);
