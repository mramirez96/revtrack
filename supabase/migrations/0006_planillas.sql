-- Lo que piden las planillas de resultados y la app no tenía: el juez de cada
-- pista y quién organiza el evento ("ORG:" en la planilla). Los dos son texto
-- libre y opcional: sin ellos la planilla sale con el renglón en blanco.
alter table pistas add column if not exists juez text;
alter table evento add column if not exists organizador text;
