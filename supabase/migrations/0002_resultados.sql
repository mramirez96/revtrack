-- Resultados: tiempo, faltas y negativas (rehúses) de cada perro, y el TRS de cada pista.
--
-- Se guarda sólo lo que tipea la mesa — la penalización y los puestos se
-- calculan al leer (public/resultados.js). Así, corregir un TRS a mitad de la
-- pista recalcula a todos sin volver a cargar ningún resultado.
--
-- `resultado` es null mientras el perro no tenga uno cargado:
--   { tiempo: number|null, faltas: int, rehuses: int, eliminado: bool }
-- `trs` es el TRS de la pista, uno solo para todos los que la corren. Largo
-- y velocidad son opcionales: si están, el TRS salió de dividirlos.
--   { largo: 191, velocidad: 4.5, trs: 42.444444 }   ó   { trs: 51.33 }   ó   {}
-- jsonb igual que `marcas`: siempre se lee y se escribe junto con su fila.

alter table inscripciones add column if not exists resultado jsonb;
alter table pistas add column if not exists trs jsonb not null default '{}'::jsonb;
