-- Si la fecha es de ranking (Reglamento Nacional de Agility 2026, Art. 52 a
-- 56) o independiente (Art. 57). Sólo en una fecha de ranking las pistas de
-- G2/G3 dan puntos (Anexo I.A). De entrada, independiente.
alter table evento add column if not exists es_ranking boolean not null default false;
