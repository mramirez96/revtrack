-- G2 y G3 corren unificados salvo que la mesa los separe (Reglamento Nacional
-- de Agility 2026, Art. 34: sólo se abre G3 con al menos 10 duplas G3 de una
-- misma altura). Es del evento entero, no de una pista: en false, los podios
-- de G2 y G3 se juntan en uno solo, "G2/G3".
alter table evento add column if not exists separar_g3 boolean not null default false;
