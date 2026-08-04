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

## Run it

```bash
npm install
npm start
```

Open `http://localhost:3000`. There is no build step: the front end is plain HTML and
JavaScript, served by the same Node process that handles the websocket.

With no `data/seed.csv` present it seeds from `data/seed.example.csv` (invented data)
so a fresh clone works immediately.

| Route         | Who         | What                                                    |
|---------------|-------------|---------------------------------------------------------|
| `/`           | anyone      | the day's programme: every round, the running one first  |
| `/ring/:id`   | competitors | live order for a round, plus *how long until my turn*    |
| `/mesa/:id`   | the table   | advance, mark absent, reorder, import, switch rounds     |

The table is behind a PIN (`1234` by default, `MESA_PIN=xxxx npm start` to change it).

```bash
npm test    # 189 assertions across 5 suites
```

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
pistas[]        { id, ringId, nombre, orden, estado, segPerro }
inscripciones[] { id, pistaId, orden, dorsal, guia, perro, altura, categoria, estado }
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
every table action is rejected unless it comes from an authenticated connection, and
is validated against the course that connection joined. Five wrong PIN attempts locks
that IP out for a minute, which turns guessing four digits from seconds into a day.

**Writes are atomic and bounded.** `state.json` is written to a temp file and renamed,
so a power cut cannot truncate it; if it is ever unreadable the server sets it aside,
says so loudly, and reseeds rather than refusing to start. Consecutive changes are
coalesced into one write, with a ceiling so a burst can't postpone persistence for as
long as the burst lasts.

**Broadcast is per connection, not per room.** Two people can be looking at different
rounds of the same competition, so each receives the snapshot of what is actually on
their screen.

## Layout

```
server.js          state, actions, snapshots, sockets (~760 lines, 6 sections)
data/seed.csv      the event (gitignored)
data/seed.example.csv  invented data, so a clone runs
public/index.html  programme
public/ring.html   competitor view  + live.js
public/mesa.html   table control    + mesa.js
public/app.css     all three views
public/sw.js       shell cache, so the page opens with no signal
test/run.js        npm test
```

Reading path: `sembrar()` shows the whole model, `snapshot()` shows everything the
views can possibly render, `siguiente()` is the core action, and `accion()` is the
wrapper every table action goes through.

## Tests

189 assertions, no browser and no test framework:

- **Integration** boots the real server in a throwaway sandbox and exercises every
  action and every guard — permissions, PIN lockout, cross-course isolation, per-course
  undo, corrupted state recovery, CSV quoting, order imports, competition reload.
- **View suites** run `live.js` and `mesa.js` inside `node:vm` against a minimal DOM,
  which is enough to assert what actually gets rendered.

The integration suite never touches the working `data/` directory — it copies the
project into a sandbox first. That is not paranoia; it is a bug that already happened
once.

## Limits

- **Single process, JSON state.** Fine for one event. Two people operating the same
  table at once can overwrite each other — last write wins. Postgres when that matters.
- **The PIN is a PIN**, not authentication. It travels over the websocket and is stored
  on the phone. Enough to stop a curious bystander from advancing the order.
- **No HTTPS**, so the service worker only registers on `localhost` or behind a TLS
  proxy. Offline mode needs a certificate in production.
- **No timing or scoring.** No times, faults, eliminations or results — deliberately.
  Starting order is the problem this solves; the order for a round that depends on the
  previous round's results is imported from a file instead.

---

RevTrack · Powered by Revamp
