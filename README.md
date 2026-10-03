# RevTrack

Live starting-order board for dog agility competitions.

A competitor opens the site on their phone and sees who is on course right now and
how many dogs are ahead of them. The scorekeeper's table advances the order with one
button, and every phone updates instantly.

Built for a real club in Argentina. **The interface is in Rioplatense Spanish**,
because that is what the people using it speak — at a windy showground, with a phone
in one hand and a dog in the other, "Sos el próximo · Andá al ingreso" reads at a
glance in a way a translation would not. The code and the domain vocabulary are in
Spanish for the same reason: the domain *is* Argentine agility (`pista`, `dorsal`,
`guia`, `altura`). This document is in English so the design decisions are readable
without speaking it.

---

## Architecture

RevTrack runs on **Vercel + Supabase**, at zero cost: Vercel serves the static
front end and a serverless function under `/api/*`; Supabase holds the state in
Postgres and pushes live updates to every phone over Realtime Broadcast. There is
no long-running process and no volume to mount — the previous single-process
Node + Socket.io + `data/state.json` design (still in `server.js`, still
deployable to Fly.io) is kept only as a fallback until the new path is proven in
production; see [Deploy](#deploy) below for why, and the *Decisions* section
further down for the reasoning behind each piece of the new design.

## Run it

There is no build step: the front end is plain HTML and JavaScript.

**Locally, against the new stack:**

```bash
npm install
supabase start                          # local Postgres + Realtime, via Docker
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2-)" \
  -f supabase/migrations/0001_init.sql   # once, to create the tables
SUPABASE_DB_URL=<from `supabase status`> \
SUPABASE_URL=<from `supabase status`> \
SUPABASE_ANON_KEY=<from `supabase status`> \
MESA_SECRET=<any long random string>    \
  vercel dev
```

With no data loaded yet, the first request seeds from `data/seed.example.csv`
(invented data) so a fresh clone works immediately. To load a real event ahead of
time: `SUPABASE_DB_URL=... npm run seed:supabase data/seed.csv`.

| Route         | Who         | What                                                    |
|---------------|-------------|---------------------------------------------------------|
| `/`           | anyone      | the day's programme: every round, the running one first  |
| `/ring/:id`   | competitors | live order for a round, plus *how long until my turn*    |
| `/mesa/:id`   | the table   | advance, mark absent, reorder, import, switch rounds     |

The table is behind a PIN (`1234` by default, `MESA_PIN=xxxx` to change it).

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54322/postgres npm test
```

189+ assertions across 5 suites — the integration suite needs a throwaway Postgres
(the local `supabase start` one works, or any disposable container) and creates its
own schema inside it, so it never touches real data.

## The problem it solves

At an agility competition the starting order is a sheet of paper taped to a board.
Competitors walk over, squint at it, count how many dogs are ahead, and try to guess
whether they have five minutes or forty. They miss their turn, or they stand at the
gate for half an hour. The table shouts names into the wind.

RevTrack is that board, live on everyone's phone, with the counting done for you.

## Domain model

A **competition** runs N **pistas** (rounds — Agility 1, Jumping 1, Final…), **one at
a time**. Each pista has one continuous starting order; all heights and grades run
mixed together, in sequence.

Four flat collections in `state`, related by id:

```
evento          { nombre, fecha }
rings[]         { id, nombre }                    the physical course
pistas[]        { id, ringId, nombre, orden, estado, segPerro, trs }
inscripciones[] { id, pistaId, orden, dorsal, guia, perro, altura, categoria, estado, resultado }
marcas{}        pistaId -> [timestamps]           used to measure real pace
```

Two state machines drive everything:

```
pista:        pendiente → en_curso → cerrada
inscripción:  pendiente → en_pista → corrido
                  └──────────┴──────→ ausente
```

`orden` exists at both levels: on `pistas` it is the programme order, on
`inscripciones` the starting order. Every query sorts by it.

`ring` is the physical course, and it is optional in the CSV — a single-course
competition (the normal case) doesn't need the column. It only matters when two
rounds run *simultaneously* on separate courses, in which case each course gets its
own table and its own running round, isolated from the other.

## Results

The table types, for each dog that ran: **time, faults, refusals** (*negativas* in the UI — the club's word), or *Eliminado*.
Only those raw inputs are stored (`inscripciones.resultado`); penalties and placings
are computed on read, so correcting a TRS mid-round re-scores everyone without
re-entering anything. The rules live in one file, `public/resultados.js`, shared by
the server (which broadcasts the computed results) and the table (which previews the
penalty while typing). These rules were checked against the club's own result
sheets (the spreadsheet's formulas and past regional results); `test/prueba.js` replays
real rows from them:

- 5 points per fault and per refusal; 1 point per second (hundredths count) over the
  **TRS**, added to the total — which is also why going over the TRS costs a clean
  run its *cero*. The third refusal eliminates. There is no TMR (maximum time): the
  club does not use one.
- TRS = course length ÷ speed (191 m ÷ 4.5 m/s = 42.44 s), **one per round**: the
  same number for every dog running it, even in an open where G1 and G2 run
  together. It can also be typed in directly.
- Ranked by total penalty, then time. Exact ties share a placing.
- Grading, same cut-offs as the club's spreadsheet: 0 *Cero Exc*, ≤5.99 *Exc*,
  ≤15.99 *MB*, ≤25.99 *B*, otherwise *No clasifica*.
- **Podiums merge heights**, as this club awards them: XS, Small and Midi share one;
  Intermediate and Large share another. Each is split by grade (G0 included), so the
  podiums read *Small/Midi G1*, *Intermediate/Large G2*…
- Entering results never blocks *Siguiente*: dogs that ran without one show up as
  "faltan cargar" and every result stays editable (and undoable).

Competitors see each dog's penalty and time in the running order, their own placing
under *Tu turno*, and a *Clasificación* tab (marked provisional while dogs are still
to run).

## Loading a competition

One row per entry in `data/seed.csv`:

```csv
ring,pista,categoria,altura,dorsal,guia,perro,raza
Copa Ejemplo,Agility 1,G2,Small,102,Diego Sosa,TANGO,Kelpie
```

- `altura` and `categoria` (height and grade) **do not split the round** — they are
  per-dog labels, shown as badges next to the name. The table needs them visible to
  set the jump heights between dogs.
- `dorsal` may be empty. Some grades don't hand out bib numbers, so those competitors
  identify themselves by their **dog's name** instead. See *Decisions* below.
- Fields containing commas go in quotes: `"Ruiz, Marta"`.
- The table can also load a whole new competition from a file, mid-life, without
  touching a terminal.

`data/seed.csv` is **gitignored on purpose**: at a real event it holds the names of
40 real people. Only the invented example is versioned.

## Decisions worth explaining

These are the places where the obvious implementation was wrong, and why.

**Heights always run smallest to largest.** It is a rule of the sport, not a property
of how the file happened to be sorted, so it is enforced at seed time and on every
reorder — never merely assumed. Row order decides the sequence *within* a height. If
the file arrives out of order it gets fixed and says so on the console.

**A dog with a bib number is matched only by its number; a dog without one, by name.**
Two different dogs in the same round are both called ROCKY. Matching by name
everywhere would silently confuse them; matching by number only would exclude the
grades that have no numbers. The per-entry rule makes both work with no ambiguity.

**Advancing the order is one action, not two.** `siguiente()` marks the dog on course
as finished *and* brings the next one in, in a single step, because that is one
gesture at the table — the dog finished, send the next one.

**Reordering only moves what hasn't started, and only among itself.** The arrows swap
a dog with the adjacent *pending* dog, not with the adjacent row. An absent dog
sitting between two pending ones used to absorb the swap, so the arrow appeared to do
nothing.

**"Live" has to be honest in both directions.** The header degrades from *en vivo* to
*hace 3 min* to *sin señal* rather than showing stale data as fresh. But the server
also sends a heartbeat every 30 s, because during a slow round there is nothing to
broadcast and silence is not the same as staleness.

**Estimates say which kind they are.** The *time until your turn* starts at 35 s per
dog and switches to the measured pace of the round once there is data — average gap
between the table's last advances, floored at 15 s, capped at 90 s, discarding gaps
under 10 s or over 4 minutes (that's the table correcting itself, not dogs running).
The view states which of the two it is using. For a round that hasn't started there is
no honest clock, so it shows the position (`5º de 32`) instead of inventing a time.

**Permissions are enforced on the server.** Hiding the buttons is not access control:
every table action is rejected unless it carries a valid signed token for *that*
course — issued only after the PIN checks out, verified server-side on every single
request (`lib/auth.js`), not just once at connect time. Five wrong PIN attempts locks
that IP out for a minute, which turns guessing four digits from seconds into a day.

**Every action is one Postgres transaction, serialized behind a lock.** Each table
action loads the whole state, mutates it with the same functions the single-process
version used (`lib/estado.js`), and writes it back inside one transaction holding a
Postgres advisory lock (`lib/db.js:conLock`) — same serialization guarantee a single
Node event loop gave for free, made explicit now that there's no single process. It
also fixes the one real limitation the old design had: two people operating the table
at once no longer means last-write-wins.

**Broadcast is per ring, filtering happens on the phone.** After an action, the server
publishes a snapshot for every course in that ring to one Supabase Realtime channel
(`lib/realtime.js`) — not a message routed per viewer, because there's no persistent
connection left to route from. Each phone already knows which course it's looking at
and ignores the rest (`alRecibirSnapshot` in `live.js`/`mesa.js`); the same guarantee
as before — a change in Ring 2 never touches what a Ring 1 phone shows — just enforced
on the other end of the wire.

## Layout

```
api/index.js        the Express app behind /api/* — routes only, no business logic
lib/dominio.js       pure functions: CSV parsing, height ordering, sembrar()
lib/estado.js        queries + actions (siguiente, mover, deshacer…) — same shape
                      as the old server.js, operating on a `state` passed in
lib/db.js             Postgres: load/save the whole state, per-ring undo, the lock
lib/auth.js           PIN check, rate limit, signed mesa tokens
lib/realtime.js        publishes snapshots to Supabase Realtime after each action
supabase/migrations/   the Postgres schema
scripts/seed.js         load a real event's CSV into Supabase ahead of time
public/index.html    programme
public/ring.html     competitor view  + live.js
public/mesa.html     table control    + mesa.js
public/rt.js          tiny Supabase Realtime subscription helper, shared by all three
public/app.css        all three views
public/sw.js           shell cache, so the page opens with no signal
test/run.js            npm test
server.js, fly.toml,   the previous single-process deploy — kept as a fallback,
Dockerfile              see Deploy below
```

Reading path: `dominio.sembrar()` shows the whole model, `estado.snapshot()` shows
everything the views can possibly render, `estado.siguiente()` is the core action, and
`api/index.js:accionRing()` is the wrapper every table action goes through.

## Deploy

**Primary: Vercel + Supabase, at zero cost.**

1. Create a Supabase project, run `supabase/migrations/0001_init.sql` against it
   (SQL editor, or `psql "$SUPABASE_DB_URL" -f supabase/migrations/0001_init.sql`).
2. On Vercel, import the repo and set: `SUPABASE_DB_URL` (the pooled connection
   string, Transaction mode), `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, `MESA_PIN`, `MESA_SECRET` (any long random string —
   signs the mesa session token, distinct from `MESA_PIN`).
3. Deploy. The first request auto-seeds from `data/seed.example.csv`; load the real
   event beforehand with `SUPABASE_DB_URL=... npm run seed:supabase data/seed.csv`.

No volume, no always-on process, nothing to patch — Vercel and Supabase's free tiers
cover a club running a few events a year comfortably.

**Fallback: Fly.io**, via `server.js` + `fly.toml` + `Dockerfile` — the original
single-process design, kept deployable until the Vercel path has run a real event.
Needs a persistent volume (see the comments in `fly.toml`) for `data/state.json` to
survive deploys and restarts. Once the new path is proven, these three files —
and `data/seed.csv`'s role as the on-disk seed — go away.

## Tests

189+ assertions, no browser and no test framework:

- **Integration** (`test/prueba.js`) boots the real `api/index.js` against a
  throwaway Postgres schema and exercises every action and every guard —
  permissions, PIN lockout, cross-course isolation, per-course undo, CSV quoting,
  order imports, competition reload, survival across a server restart.
- **View suites** run `live.js` and `mesa.js` inside `node:vm` against a minimal DOM,
  which is enough to assert what actually gets rendered — including that a
  broadcast for a course you're not looking at gets ignored.

The integration suite creates its own Postgres schema, named after the process id, and
drops it when it's done — it never touches real data, and two runs in parallel don't
collide. Needs `TEST_DATABASE_URL` (or `SUPABASE_DB_URL`) pointing at *some* disposable
Postgres — `supabase start` locally, or any throwaway container.

## Limits

- **The PIN is a PIN**, not authentication. The mesa session token it hands out lives
  in `localStorage` on the phone. Enough to stop a curious bystander from advancing
  the order.
- **Results are typed, not timed.** The table enters each dog's time, faults and
  refusals by hand (see *Results* above); there is no link to an electronic timer. The
  order for a round that depends on the previous round's results is still imported
  from a file.
- **"Live" depends on Supabase Realtime's connection state**, not a server heartbeat
  (the old design had one; see the note in `public/live.js`). A dropped websocket
  reads as "sin señal" almost immediately, same as before — just measured differently.

---

RevTrack · Powered by Revamp
