-- Combinados (Reglamento Nacional de Agility 2026, Art. 53 y 55; Anexo I.B):
-- dos pistas que se suman, típicamente un Jumping y un Agility. Es opcional y
-- de a pares: `combina_con` es el id de la otra pista del par (las dos se
-- apuntan entre sí), o null si la pista va sola.
alter table pistas add column if not exists combina_con text;
