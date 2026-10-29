# Architecture

How the board is built, for people changing its code. How to *use* the board is in
[README.md](README.md); the HTTP contract for external tools is in [docs/API.md](docs/API.md).

## Design constraints

These are deliberate and predate most of the features. Changes that break them need a good reason.

- **Local-first.** One SQLite file on one machine. The server binds `127.0.0.1` and has no auth —
  the machine is the trust boundary (the opt-in Wi-Fi door, `src/share.js`, admits the private network the computer is on). GitHub sync is optional and off until configured.
- **No build step.** The frontend is vanilla ES modules served straight from `public/`. Edit a
  file, reload the page. No bundler, no transpiler, no framework.
- **Three runtime dependencies** — Fastify 5, better-sqlite3, `@fastify/static`. Everything else is
  the Node standard library. Adding a fourth is a decision, not a detail.
- **The supported Node range follows the driver's prebuilt binaries.** better-sqlite3 is a native
  module: for a Node version it has no prebuild for, `npm install` quietly falls back to compiling
  from source, which needs a toolchain most people do not have set up. So `engines` states the
  range that actually installs without one (currently Node ≥ 22), and CI tests its ends. Bumping
  the driver moves that range in both directions — check the low end too, not just the new high one.
- **Every runtime dependency loads with `require()` on the oldest Node in that range.** Node before
  22.12 cannot `require()` an ES-only package, and CI's "22" is the newest 22.x, where it can — so a
  dependency that went ES-only passes CI and still crashes the board on start for someone on 22.10.
  `test/runtime-deps.test.js` reads the dependency tree instead of starting the server, and fails on
  any Node. This is why `@fastify/static` is pinned to 10.1.3: later 10.x releases pull in an ES-only
  `content-disposition`. Moving past it means raising `engines` to `>=22.12` on purpose.
- **Synchronous database access.** better-sqlite3 is sync by design; route handlers read and write
  the DB directly, with no connection pool or async layer to reason about.
- **The board never promises a restart it cannot perform.** It can install its own update, but
  picking it up means starting again — and only a process manager can do that. Under pm2 the board
  exits and comes back; started by hand it says the update is in place and stops there, because a
  button that silently kills the board is worse than a button that asks for one more step.
- **Token-efficient CLI.** `kb` exists so an AI agent can drive the board with one line of output
  per action instead of scraping a web page. Terse output is a feature.

## Layout

| Path | Responsibility |
|---|---|
| `src/server.js` | app composition: static mounts, origin guard, error handler, listen |
| `src/config.js` | the only place environment variables are read |
| `src/db.js` | opens the DB, runs migrations, exposes `db` and small kv/queue helpers |
| `src/schema.sql` | DDL for a fresh install, replayed on every start (`CREATE TABLE IF NOT EXISTS`) |
| `src/origin-guard.js` | rejects cross-origin and unexpected `Host` requests |
| `src/share.js` + `src/qr.js` | Settings → Wi-Fi: an opt-in door that admits the private network (no secret in the address — a lost cookie used to lock a browser out; another site may only open the board as a page) and passes requests on to the loopback board; what stays the owner's (the computer's settings, windows on its screen) is refused to a guest twice — at the door by the decoded path and on the board by the route its router matched (`guestGuard`); the link's QR code |
| `src/bus.js` | in-process event bus + SSE connection ceiling |
| `src/routes/tasks.js` | tasks, comments, checklists, attachments, links |
| `src/routes/projects.js` | project registry, folders, categories, service status |
| `src/routes/dashboard.js` | aggregate queries behind `/api/stats` and `/api/dashboard` |
| `src/routes/system.js` | labels, sync config, error log, backups, about/update |
| `src/routes/skills.js` | reading, updating and fetching the shared version of a skill |
| `src/skills.js` | where skills live on disk: lookup, read, write with a snapshot |
| `src/file-snapshot.js` | one copy of the previous contents before the board overwrites someone's file |
| `src/stamp.js` | the time in a snapshot's name: local, with the UTC offset where a rotation orders by it |
| `src/routes/events.js` | the SSE stream |
| `src/claude-sessions.js` | which Claude Code sessions worked on a task, and where their transcripts are |
| `src/work-feed.js` | the work feed: transcripts cut by task, and watching the ones in work |
| `src/chat-feed.js`, `src/routes/chat.js` | the chat of a session: its transcript in turns, watched while a page looks at it |
| `src/chat-queue.js` | words for a busy Claude of the board, sent once it has waited at its prompt for two seconds |
| `src/terminal-say.js` | typing into the board's terminal of a task — the one place the Terminal tab and the chat share |
| `src/claude-usage.js` | what a task cost: tokens, money at API prices and the conversation memory, counted from the same stretches as the work feed |
| `src/claude-live.js` | the Claude state of tasks in work (working, waiting, session closed) from Claude Code's registry |
| `src/api-break.js` | a turn that ended on a broken connection to the API: read off the transcript; the board's own Claude is told to go on, at most three times in a row, otherwise the person is called |
| `src/claude-now.js` | "Claude now": the tasks in work grouped by the run of Claude that holds them, with how far each is; "Claude done": the runs that finished lately |
| `src/claude-limits.js`, `src/routes/claude.js` | the subscription's rate limits reported by the terminal status line (`kb statusline`), merged across sessions |
| `src/claude-asks.js` | what Claude Code asks the person (permission, question, plan) through the PermissionRequest hook `kb hook permission`, answered on the board |
| `src/claude-hooks.js` | what `local-kanban hooks install/uninstall` changes in Claude Code's settings.json: the status line through `kb statusline`, the PermissionRequest hook — and nothing else |
| `src/claude-settings.js` | Claude Code's settings.json read, and written with the board's entries — one careful write for `local-kanban hooks` and Settings → Claude Code |
| `src/claude-setup.js` | Settings → Claude Code: what the board needs of Claude Code on this machine, found or not, and connecting it from the page |
| `src/launch.js` | starting Claude from the board: the app link, the terminal command, their quoting |
| `src/phantom.js` | Claude inside the board: a background tmux session per launch, its screen, typing into it |
| `src/routes/terminal.js` | the card's Terminal tab: the screen, answers and keys, stopping |
| `src/routes/horizons.js` | time-horizon goals |
| `src/health.js`, `src/routes/health.js` | "Health": how big the instructions Claude Code reads in each project are (CLAUDE.md up the folders, imports, rules, auto memory) against the norms of its docs and its own warnings |
| `src/sync/github.js` | every `gh` invocation, the label palette, Projects v2 plumbing |
| `src/sync/worker.js` | drains the sync queue in the background |
| `src/backup.js`, `src/restore.js` | scheduled snapshots; opening a backup as a second board |
| `src/task-shape.js` | one canonical shape for a task event, shared by routes and worker |
| `public/app.js`, `public/js/*.js` | frontend entry point plus the modules of `public/js/`, split by feature; `order.js`, `live-rules.js`, `review-rules.js`, `limits-rules.js`, `ask-rules.js` and `claude-setup-rules.js` are pure rules with no DOM, run by the tests in node |
| `bin/local-kanban` | install wizard, `start`, `skills` and `hooks install/uninstall` subcommands |
| `bin/kb` | the CLI; speaks HTTP to the board, no shared code with the server |
| `test/` | `node --test`, no test framework |

## Data

The database lives in `kanban.db` inside the data directory. The data directory is resolved in
`src/config.js`, in this order:

1. `KB_DATA_DIR` if set — explicit wins;
2. `<code>/data` if it already contains a `kanban.db` — a working install is never relocated;
3. `~/.local-kanban` when the code sits inside `node_modules` — an npm install must not keep its
   data inside a directory the package manager recreates on update;
4. `<code>/data` otherwise — a git clone.

Attachments and backups are subdirectories of the same data directory, never of the code
directory. Anything that writes user data resolves its path from `DATA_DIR`.

**Opening a backup** never touches the live database. The upload is a raw `application/octet-stream`
body — the route never takes a file path from a request — and the file is checked, then opened by a
second board on a temporary copy. That board inherits nothing that reaches the live board's own files
(the external panel, extra skill roots, the pm2 identity), runs no sync, takes no snapshots of its
copy and refuses to update the code it shares with the live board.

**Migrations** are versioned through `PRAGMA user_version`: an ordered array of steps in
`src/db.js`, each run once. `schema.sql` runs on every start *after* migrations, so new tables
reach old databases on their own; new *columns* on existing tables need a migration step. A
snapshot is written before any migration runs; the five newest are kept, ordered by the time in their
names, not by the names as strings.

**Claude Code sessions** are tied to tasks through `kb`: it sends the session id Claude Code gives
every command it runs (`X-Claude-Session`), and `src/claude-sessions.js` keeps the pairs in
`task_sessions` and finds each session's transcript under the Claude directory. Every status change
also records the session that made it (`task_events.session_id`), because one session often works
through several tasks and the transcript has to be cut by task. A session whose `kb` sends no id (an
older install on the PATH) has no changes of its own; its changes are then the unsigned changes of its
tasks since it was tied to them. Claude that the board starts itself runs the board's own `kb`, so this
is the exception rather than the rule. The board only reads the transcripts and the session registry
there; the one thing it writes in the Claude directory is a skill, in its `skills` folder, when the person
saves or deletes one from the board.

## Status model

```
backlog → todo → prep → doing → deploy → review → done        (+ cancelled)
```

The statuses model an agent's working loop, not a generic board. `prep` is study-before-code;
`doing` and `deploy` are the only statuses where the work timer runs — and only while the task's Claude session is alive: a closed session stops it, a Claude back on the task starts it again (`src/work-clock.js`).

Rules worth knowing before touching them:

- **Tasks may only be created in `backlog` or `todo`.** The server rejects anything else with 400.
  A task that appears directly in `done` is a phantom in the statistics with an open issue behind it.
- **`backlog`/`todo` → `review`/`done` is rejected** — work has to pass through the working
  statuses. The exception is tasks labelled `noclaude` (done by hand), checked on both sides.
  Claude is never started on such a task: ▶ and the copy button of *To do* leave it out, the server refuses a start
  that names one (whichever way Claude is started, and from a tab that missed the label), and `kb take` passes it by.
- `prep`/`doing`/`deploy` are read-only in the UI: those columns are moved by the CLI. The server
  does not forbid it — `kb` uses the same API.
- Frontend move rules live in **one** function, `moveBlocked(from, to, …)`. Every surface that can
  move a task — drag, drop, the drawer select, keyboard shortcuts, the context menu, group actions
  — asks it. Adding a surface means calling it, not reimplementing the rules.
- Every transition appends a row to `task_events`. The drawer timeline is built from that log, so
  a task that bounced between statuses shows its real history.
- **Taking the next task is one step on the server** (`POST /api/tasks/take`, which `kb take` calls):
  the task is picked and moved to `prep` in one transaction, through the same code as a `PATCH`, so
  two agents taking at once get two different tasks. The pick follows the board's column — a pinned
  card first, then priority and position; the order of `GET /api/tasks` stays as it is for everyone else.
- **▶ moves the tasks it starts Claude on to `prep` at once**, through the same code as a `PATCH`, once Claude has
  really started (inside the board or in the Terminal); a refused or failed start moves nothing. The Claude app is not
  a start: its link only puts the prompt in, the person sends it, so its tasks stay where they are until that Claude
  moves them itself.
  The Claude that was started holds those tasks: its own `kb mv <key> prep` goes through, another session's is
  refused. Inside the board and in the Terminal the board names the session itself (`claude --session-id`), so the
  move is that session's from the start; the Claude app names its own session, so the move belongs to the first
  session that takes the task (such moves are left from older versions — the app no longer moves anything). Until the
  started Claude shows up in Claude Code's registry the card says
  *starting*, not *session closed* — unless the board started it and its terminal there has closed already. A start
  in the Claude app moves no task (the person sends the prompt there, and Claude moves its tasks itself); a task an
  earlier version moved for such a start says *waiting to start in the app*, and *session closed* two hours later.
- Labels are written two ways: the board sends the whole set (`labels`), `kb lbl` sends what to add
  and what to remove (`labels_add`/`labels_remove`) and the server applies it to the stored set, so
  parallel edits add up instead of overwriting each other.

Changing the set of statuses means changing, in the same commit: the `CHECK` in `schema.sql`, a
migration in `db.js`, `GH_STATUS` in `sync/github.js`, the aliases in `bin/kb`, `ALL_STATUSES` on
the frontend, and the CLI skill documentation.

## API naming contract

One rule, visible to every external consumer: **a bare name is a collection, an `_n` suffix is a
count.** The task list returns `comments_n`, `attachments_n`, `linked_ids`; a single task returns
`links`, `attachments`, `checklist` as arrays of objects. Nested route parameters follow
`:<entity>Id`. Tests assert both that the new names exist and that the old ones do not.

New field or route: follow the rule and write it down in `docs/API.md`, which is what an external
integrator reads.

## Frontend

`public/app.js` is the entry point; feature modules live in `public/js/`. Because they are ES
modules, nothing lands on `window` implicitly — `app.js` assigns an explicit list of functions for
console use and browser-driven tests. A function that a test needs must be added to that list
rather than reached around.

**A module never assigns to a binding it imported.** An import is a read-only binding and modules
are always strict, so the assignment throws a `TypeError` at runtime rather than quietly missing —
and it takes the rest of the enclosing function with it. State shared across modules is changed
through a setter next to its declaration (`setGhSyncOn`, `setScrollToNewCardId`). The rule is
enforced statically by `test/frontend-imports.test.js`, because a module that no browser test
happens to execute would otherwise fail only in front of a user.

**An open form sends only what the person changed, and never overwrites what they are editing.**
The task card keeps a snapshot of the values it was filled from; autosave sends the fields that
differ from it. A change made elsewhere (another tab, `kb`) is pulled into the fields the person has
not touched; the field under the cursor takes it once the cursor leaves, and the snapshot moves only
for fields the form actually shows — otherwise the next save would send the stale value back as a
change. The rule lives in `public/js/unsaved.js`, a module without imports or DOM, so
`test/unsaved.test.js` runs it for real instead of matching the source.

**A change that did not reach the server is queued as data.** When the server is down, the card
queues the request itself — the task's key and the changed fields, or the body of a new task — and
resends it when the stream reconnects. It never queues a function that would read the form again:
by then the card may be closed, or open on another task. A closed card keeps nothing in its fields,
and Cmd+Enter saves only an open card with the cursor in it.

**A refusal of the server is said in the board's words.** The server answers in English and
technically ("task not found", "limit of attachments per task: 30"); the card never shows that text.
`refusalText` in `public/js/unsaved.js` reads what the refusal is about — the task itself, the task to
link to, the project, the board's Claude, a thing of the task — and gives a sentence of its own and a
reason to follow the name of the action ("Could not attach: …"). Only a missing task closes its card.
A test asks the real routes for their refusals, so a server message that changes its wording cannot
silently change what the board says.

Project settings are a **page inside the project** (`#projset`), not a popup: the topbar `⋯` and a
right-click on the board in the sidebar open it, `state.projSettings` decides the view while
`state.slug` stays on the project. It re-renders only when it opens or after a save — a background
refresh must not rebuild a form somebody is typing into — and Save sends only what the person
changed against the values the form was filled from, the same rule as the task card: comparing the
form with the *fresh* project sent back everything changed elsewhere since it opened. An editor with
unsaved text (a project's `CLAUDE.md`, a skill) asks before Esc, the backdrop or another section
throws it away. The deploy skill is picked from the skills the board actually found, not typed in;
the project's own notes and that skill open in an editor right there, so a rule discovered while
working on a task can be written down where it was found.

An open tab reloads itself when the board's front end changes on disk — any script, the page's
markup or its styles (`/api/ui-version`, the newest modification time among them) — but only while
nothing is open or typed: a window, a card, a filled-in form or an edit waiting to be resent keeps
the tab as it is until it is done.

SSE updates are applied **surgically**, a whole batch at a time: `applyEvents` in `public/js/live-rules.js`
decides what a batch of events changes — the board is redrawn (or the changed cards are replaced in
place) once per batch, and the project counters are fetched once. A note, an attachment or a link
changes one card from the counters and links the server puts into the event. A full refresh is the
fallback for events that change structure. The first load of the board starts once the event stream
is open, so it is not read twice; only a reconnect re-reads it. While a search is on, the server's
answer is trusted for the tasks it returned, and a task that came by an event since goes through
the same prefilter as typing; only the answer to the last search request lands on the board.

**One live link per browser.** The server speaks HTTP/1.1, where a browser gives a site six connections, and a stream
per tab took them all at the sixth tab. The tab holding a Web Lock (`public/js/live-link.js`) opens `/api/events` and
passes every message to the other tabs over a BroadcastChannel; when it closes, the browser hands the lock on. A
follower that hears nothing from the holder for the stale threshold asks it, and with no answer opens a stream of its
own. Reconnects go one at a time with a growing pause (3 s up to 30 s), and a link down for 5 s is said by a notice in
the top bar. The server keeps at most 5 of its 20 streams for guests of the Wi-Fi door, so the owner always has a
place, and a page whose stream failed asks `GET /api/events/room` whether it was refused or the server is gone. All
the streams together may hold at most 12 MB undelivered; over it the one holding the most is closed.

`task.work` is the one event that never reaches that fallback: it means "a session's transcript
grew", arrives every second and a half while Claude works, and only the open card's feed reads it.
Any new event type that is frequent needs its own branch in the SSE handler for the same reason.

**The chat** is what the drawer shows next to the comments (and a column of Claude now can show instead of the
terminal): one session of the task read whole, in turns, from the same transcript the work feed reads — the person's
words, Claude's text, its steps with their time and outcome, and how long each turn took. What a step returned is
never sent to the page. Only the board's own Claude of the task can be spoken to: words go at once to a Claude waiting
at its prompt, else into a queue kept by the board in memory, sent once that Claude has waited for two seconds in a
row — a pause between two steps of one turn is shorter. A transcript a page looked at in the last ten minutes is
watched, and its growth goes out as `session.chat`.

**The work feed** (`GET /api/tasks/:key/work`) is the older reading of the same transcripts, cut by task. `src/work-feed.js` reads the session's transcript once — a
megabyte at a time, so a transcript of tens of megabytes does not balloon the board — and then only
what was appended (a line still being written waits until it is whole); text the person pasted (the
Claude app wraps it in a tag) counts as their message. It cuts the transcript by task:
a session's status changes tell where its attention was — a task moved into work takes the focus,
except a `prep` while another task is still being worked on (a batch is prepped together); a
stretch between two tasks belongs to the next one, starting from the person's last message. Status changes are stored to the second, and the step that made one is written to the transcript
before it, so a change cuts at the end of its second: that second goes to the stretch before the change, and a call's
result is found wherever it landed. The
board watches only the transcripts of sessions whose tasks are in work, with `fs.watch` from the
standard library. A helper agent is three numbers to the card — steps, start, end — so its transcript
is kept as that summary, checked by path, size and mtime and read on from where it stopped, and only
the helpers started inside the task's stretch are read at all. The drawer fetches the feed only while
its tab is shown; behind another tab it asks for the count alone, and it never starts a request while
the previous one is in flight.

**Usage** — what a task cost — is counted from the same transcripts and the same stretches as the work feed:
every answer of the model carries its token counts (input, output, cache reads and writes), one answer is
written as several lines and is counted once by its id, and a helper started inside the task's stretch is the
task's usage. The board keeps tokens per task, session, local day and model in the database, and prices them
only when it shows them, from one price table with the date it was taken: a new price needs no re-reading, and
a model the table does not know is shown as unpriced rather than as zero. A session's transcript is read once
and then only what was appended, one session at a time for the whole board; if the task stretches change in a
part already read, the session is counted anew. The card shows tokens first, then the money with "≈" — with a
subscription it is notional — and how full the conversation memory was on the last answer; the dashboard shows
the period's usage and the tasks that cost the most. How it reads on screen is decided in
`public/js/usage-rules.js`, a module without imports or DOM, and `kb show` prints the same line through it.
Claude Code often leaves a helper's answers without their final line, so a helper's output is under-recorded;
the board counts such answers and says so instead of presenting the number as exact.

**The state badge** on a card in work ("working", "waiting for you", "session closed") comes from
Claude Code's registry of live sessions, checked against whether the process still runs: a registry
file outlives a crash. The server recomputes it every 3 s and sends `task.live` only on a change;
the card patches its badge in place. "Working" and "waiting" go only on the task the session is on
right now — the same focus as the work feed — so a batch does not light up as a whole.

**Claude now** is a section of its own in the sidebar: every task in work across the projects, top to
bottom, grouped by the run of Claude that holds it — the latest session tied to the task, the one its
badge follows. A run lists what it has handed in, the task it is on and what waits its turn, and says
how much of it is handed in; a task says how far it is by its checklist when it has one, by its stage
otherwise. Runs nobody leads any more — the session ended, or no session and no movement for two hours —
sit folded below the live ones. A Claude of the board with nothing in work that still works — busy, or at
its prompt with commands running in the background — keeps its run here, but not after two hours at the
prompt: a background command that long with no turn of Claude is a leftover, not work. So does one at its prompt
with a task of its run in Review, or one it put back to To do itself (an `ask` task with its questions): it waits for
the person, under the same two hours. The server computes it on request (`src/claude-now.js`); the section
reads it again on any task event, on `task.live`, and on `task.checklist`, which a checklist change sends
because the board's list of tasks carries no checklist. A switch at its top shows the live runs as columns
instead (*Terminals*, `public/js/now-terms.js`): each with the tasks of its batch above and — for a Claude the board
started in its own terminal — that terminal's screen, its keys and an answer field, the same as the card's Terminal
tab. The columns stay between repaints, so a screen keeps its scroll and a half-typed answer; their screens are looked
at once a second — the next look after the last one has answered. A column lays its terminal's window out to its own
width (wider only by more than two columns). A window laid out anew makes Claude Code print the whole conversation
again, so after the width changes the column keeps showing the old screen until the input box at the bottom is as
wide as the new window (at most 8 seconds) — otherwise it would show the session scroll by from its first line; the
card's Terminal tab holds its screen the same way (`public/js/term-reprint.js`). Of several pages looking at one
terminal the server lays the window out to the narrowest width asked for in the last 3 seconds, so a card and a
column never take turns. The terminal a card shows on its own Terminal tab is laid out by the card. The project name at the top of a run is a link
to that project's board. An answer typed and not sent outlives its column and keeps the tab from reloading silently.

**Claude review** is the section next to it: the tasks in Review, by project, and one button per project
that hands their acceptance to Claude. The button does not send Claude a bare prompt: it makes a check
task in the project — its title says what a check is, its description lists the tasks in Review at that
moment — and starts Claude on it the way ▶ on a card does. The check is a task so that its report has a
card to stay on, so that the board's own Claude, having moved every task it checked to Done, is still held
by a card in play, and so that the run shows in *Claude now*. A check is recognised by its `check`
label — its title is in the board's language, the label is not — and one still open for a project takes
the place of the button. The server keeps one open check per project: a second one is refused with the
key of the open check, so two tabs pressing the button at once make one check. Claude started inside the
board on a check may run `kb done` without asking for exactly the tasks the check lists that are in
Review at that moment — the press of the button is the person's word for those, and only for those. The rules live in `public/js/review-rules.js`, run by the tests
in node; the shipped `kanban` skill says how a check is done. The Review column of a project's board has the
same button (`startCheckIn` in `public/js/review.js`, shared by both): it is shown when the column's tasks are of one
project, and opens the open check's card instead while there is one.

**Automations** (a section shown only while Settings → Claude Code switches them on) start that check without the
press: a rule of a project says "once Claude has finished its work here, wait N minutes (3 by default) and check
Review". A rule fires once and goes to the section's history. The server runs it (`src/automations.js`, a look every
5 s), so the page may be closed. "Finished" is what opens ▶ of Review — no task of the project held by a Claude at work
on it (`holdsCheck`) — after the project has had such work since the rule was set: a rule set on a quiet project
waits for the next batch instead of checking what was already there. Nothing starts while something waits for the
person: a question on a screen of the board's terminal, a request of Claude in a card, a task handed back from work to
To do since the rule was set, a used-up subscription window — and while the project has an open check; the pause
begins again after each. The check is made and started through the board's own routes (`app.inject`, with the board's
own `Host` for the origin guard): `POST /api/tasks` with the `check` label, then `POST /api/launch` inside the board, so
every guard of ▶ holds. The words of the check and the permission and effort of the start are the page's, given with
the rule when it is set; a project with no folder here is refused then, not after the batch. A check that does not start
stays in To do, and the rule's history says why. A check made by hand after the rule was set ends the rule (`covered`) —
kept armed, it would check again whatever that check left in Review — and so does archiving the project.

**Claude done** lists what Claude has finished: the runs — the same latest session of a task as in *Claude
now* — with no task left in work and at least one handed in, the most recently finished first, from the last
seven days (`doneRuns` in `src/claude-now.js`). A run moves there when it leaves *Claude now*, and back while a task of it is sent back to work. Tasks in
Review or Done with no session tied to them — handed in by a `kb` that does not say its session — are put
together by project and time (a gap of more than an hour starts a new run); manual tasks are not Claude's work
and are left out.

**Starting Claude** (▶ on To do and on a card) is done by the server, so it behaves the same in every
browser and never depends on a browser's dialog for custom links. The page names the project and
sends the prompt — the same text the copy button copies; the folder comes from the project registry
only, and a project whose folder is not on this computer is refused whichever way Claude is started (it
would otherwise start in the home folder). Nothing is joined into a shell line from the request: the app
link is one argument to `open`, and the terminal command quotes the folder and the prompt as single shell
words inside an AppleScript string, both checked against a real shell and osascript with text built to
break out.

**Claude inside the board** (▶ when tmux is there) runs in a background tmux session on the board's own
socket, one per start, and outlives restarts of the board. It lives while its tasks are in play: once
every task it is tied to is accepted, cancelled or deleted, the board closes it — right then, at start,
and every two minutes. Review keeps it, because that is where the person answers Claude — but not for
good: a terminal with no task at work (prep, doing, deploy) whose Claude has sat idle at its prompt for six
hours closes too, unless a question is open on its screen or a command still runs in the background (each
idle Claude holds a few hundred MB with its helpers, and forty of them filled a 16 GB machine). A Claude in
the middle of a turn is left to finish it (its state is read by the pid of the process, which outlives a
`/clear`). The board knows its terminals by a list of the sessions it started (`board_sessions`), not by
their ties to tasks, which go away with a deleted task; a board that started nothing touches no terminal (at
its start it only lists the panes of its socket once, to take back sessions it started before it kept that
list), and another board's session on the same socket is never touched. A board opened from a backup gets a
socket of its own. A comment can go to that Claude as a message, but only while it waits at its prompt.
It runs the board's own commands without asking — `kb take`, `show`, `note`, `review` and the rest, and `kb mv`
to the working columns; closing a task (`kb done`, `kb cancel`) and `kb rm` are the person's word and go through
Claude Code's usual question. `kb mv` never closes a task, so the question cannot be stepped around with it.

`localStorage` keys are namespaced (`kb.set.*`, `kb.ui.*`, `kb.chaos.*`, `kb.session.*`). Renaming
a key silently loses whatever the user had saved, so a rename ships with a one-time value migration.

## Skills

A skill is the instruction file Claude reads, and it lives outside the board — in the `skills` folder
of the Claude directory (`~/.claude/skills`, or under `CLAUDE_CONFIG_DIR` when Claude Code was moved
there), often as a symlink to a file in another repository. The board therefore treats **loading** the shared
version and **writing** it to disk as two separate actions: the button only fills the editor and says
where the text came from (GitHub, or the copy shipped with the package), and saving is a second,
explicit step. The write requires the client to echo back the resolved path it meant to overwrite,
and the previous contents are snapshotted into the data directory first — never next to the original,
which usually sits in somebody else's git working tree. The same lock and the same snapshot cover a
project's `CLAUDE.md`. Every file keeps its own ten newest snapshots: they are told apart by the exact
"name-time" pattern, never by a name prefix (`deploy` must not rotate away `deploy-tickets`), and the
one just taken is never rotated away.

The skills directory holds everything its owner uses in Claude Code, most of it unrelated to the
board, so the section lists only what the board is about: its own skill and deploy skills — the
shared one, the ones registered projects use, and the ones created here. Nothing on disk marks the
last group, so the board remembers them itself. A new skill is created from the section; if the
package ships one under that name, the file starts as that shared version, and entering the name of
a skill that already exists adopts it into the list instead of failing — otherwise a skill outside
those groups could be neither opened nor deleted. Deleting keeps a snapshot, and a skill that is a
symlink loses only the link; a skill folder that holds more than `SKILL.md` (`references/`, `scripts/`)
keeps the rest. `local-kanban skills` refreshes the board's own skills in the same folder in place: it
writes only the files the package ships and snapshots each one that differs before writing it.

A copy of a packaged skill is compared with the files the package ships (files of the person's own next to
them do not count); a symlink is never compared and never written — a clone links its own `skills/`, and an
owner who links a version of their own keeps it their way. When the board's skill is not the version the board
ships, Settings → Claude Code and Skills say so, and one button takes the board's version through the same
copy as `local-kanban skills`; a path that goes through a link — the folder, a subfolder or a file — is never
written, by the button or by `local-kanban skills`. The board's own update brings the copied skills along: the
copies that were exactly what the package had put there before the install are refreshed after it; a copy that
already differed stays as it is — the board cannot tell one changed by hand from one an earlier update left
behind, so it calls both "not the board's version".

## Claude Code on this machine

Settings → Claude Code answers one question — can the board's work with Claude Code work here — from one request
(`GET /api/claude`). It lists what the board really uses: the `claude` program and `tmux` (Claude inside the board),
the Claude app and a terminal (the other ways ▶ starts a task), the Claude folder (`KB_CLAUDE_DIR`, else
`CLAUDE_CONFIG_DIR`, else `~/.claude` — the answer names which) with the board's skill, the registry of live sessions
and the transcripts in it, and the two entries in its `settings.json` — the status line through `kb statusline` and
the PermissionRequest hook — with the time the last reading of the rate limits came, which is the only proof that the
status line really runs. Every missing piece says what does not work without it and how to fix it; a piece needed
only for one way of working (tmux, the Claude app, the connection) is marked as optional, not as missing. Answering
starts nothing and sends nothing anywhere: files and folders are looked at, that is all. The limits footer with no
current figures says whether the status line goes through this board at all, and opens this section on a click;
connecting or taking off tells the footers of every open tab at once.

Connecting from the page (`PUT` / `DELETE /api/claude/hooks`) is the change `local-kanban hooks install|uninstall`
makes, through the same module (`src/claude-settings.js`): the page shows exactly what will be written and sends back
a fingerprint of the file it showed the change for, and a file that changed meanwhile is not written. A file that is
not JSON is never touched, a read-only one is never replaced through its folder, the previous file is copied into the
board's backups first, the new text keeps the file's own layout and goes in with one rename.


## GitHub sync

Optional, one-directional (board → GitHub), and invisible to the agent: it costs no tokens because
it runs in a background worker, not in the request path.

- Target `owner`/`repo` are configuration (env or the settings UI), never hardcoded, and validated
  strictly before use.
- Tasks become issues; projects become Projects v2 boards, created lazily. Status columns are
  created in the board's language, and the name→status map understands both locales plus GitHub's
  own defaults, so a renamed column still resolves.
- The queue payload is a **snapshot**, so an operation survives deletion of the task it describes.
  It drains FIFO; a failing `create_issue` blocks only the dependent operations of *that* task, not
  the whole queue.
- Labels must exist in the palette in `sync/github.js` — `gh` does not create labels on the fly, and
  a label outside the palette fails on sync forever, retrying the same missing name.

## Tests

`node --test` runs the suite over `test/` (there is no `npm test` script: `test/` is not part of the published package, so inside an installed package the command would pass without running anything). There is no test framework and no mocking library. Each
test isolates its database through `KB_DATA_DIR`, so running the suite never touches a real board.

Tests here are mostly **regression guards for behaviour that broke once**: rotation of backups,
queue blocking, move rules, API field names. When you fix something subtle, the test that pins it
down belongs in the same commit.

## Visual conventions

The board is deliberately plain, in the spirit of Linear. **One accent colour** (`--accent`,
brand orange) and a quiet palette of panel/border/muted tokens. All colours come from tokens —
hardcoded hex values are not accepted, because every colour has to work in every theme.

What not to add: multi-coloured strips above blocks, three or four accent colours in one component,
gradient fills, decorative frames. Before adding a visual element, look at how the neighbouring
blocks are built and reuse their language.

**An animation that runs forever animates only `transform` and `opacity`, on a layer of its own** (a
pseudo-element): the browser runs those on the GPU. Anything else — `box-shadow`, an SVG path's opacity,
a gradient angle in a custom property — makes it recalculate styles and repaint every frame for as long
as the tab is open, even when nothing on the board changes; one pulsing dot is enough. Under
`prefers-reduced-motion: reduce` such animations are turned off.

## Keeping this document honest

Change the architecture — statuses, queue, schema, endpoints — and update the matching section
here **in the same commit**. While you are in a section, check that what is already written still
describes the living code, and rewrite it if it does not. A stale entry is worse than a missing
one: it sounds authoritative and sends the next reader confidently down a path that no longer
exists.
