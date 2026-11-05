-- Supabase expone el esquema public por su API REST, y la anon key es pública
-- (el navegador la pide en /api/config para escuchar Realtime). Sin RLS,
-- cualquiera con esa key podía leer, cambiar y borrar todas estas tablas sin
-- pasar por el PIN de la mesa.
--
-- RLS prendido y SIN políticas es a propósito: anon y authenticated no ven ni
-- tocan ninguna fila. La app no se entera, porque nunca usa la API REST: el
-- backend entra por SUPABASE_DB_URL con el rol postgres, que es dueño de las
-- tablas y además tiene BYPASSRLS, y los navegadores sólo usan Realtime
-- Broadcast, que no lee tablas.
--
-- Una tabla nueva tiene que sumarse acá: test/prueba.js falla si alguna queda
-- sin RLS.
alter table evento enable row level security;
alter table rings enable row level security;
alter table pistas enable row level security;
alter table inscripciones enable row level security;
alter table undo_pila enable row level security;
alter table pin_intentos enable row level security;
alter table seed_actual enable row level security;
alter table respaldos enable row level security;
