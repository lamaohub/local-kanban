---
name: kanban
description: Local kanban task board (the `kb` CLI, localhost:3100). Triggers — "what's on the board", "add a task", "work through project X", "do TIC-3", "take the next task", "accept TIC-3", "send TIC-3 back", "show the board", "block this task". Statuses and comments are mirrored to GitHub automatically (when sync is configured) — you never have to think about it.
---

# Kanban (kb)

Every task lives in a local SQLite database behind the `kb` CLI. GitHub (issues + Projects v2) is a mirror; the sync is optional and runs in the background — ignore it.
Tasks are addressed by key: `TIC-3` (project prefix + number). Case does not matter.

Statuses: `backlog` → `todo` → `prep` → `doing` → `deploy` → `review` → `done` (+ `cancelled`). Blocked is a flag.
`prep` is where you study the task before writing code (reading CLAUDE.md, reading files). The work timer does NOT run there — only `doing` and `deploy` count as work. `kb take` puts a task in `prep`; the moment you start writing code, run `kb mv <key> doing`.

## Commands

```
kb take <proj>                # take the next task from todo → prep (a card the human pinned,
                              # 📌 in the output, is taken first); prints the description,
                              # the checklist as "- [ ] item" / "- [x] item" lines (that IS the
                              # spec — do every open item, and verify them one by one before
                              # review), the issue as "issue: #N <link>" (#N goes into commit
                              # messages; kb show prints the same line), EVERY note the
                              # human left since your last report, dated — "> 👤 [2026-09-02 11:30]
                              # …" (if the task was sent back, act on them!) and the paths of
                              # attached screenshots as "📎 <path>" — OPEN those with Read, they
                              # are context for the task.
                              # started writing code → kb mv <key> doing.
kb review <key> "note"        # move to review, then leave the note. A rejected move stores no note
                              # (backlog and todo cannot go straight to review — go through prep or
                              # doing first; prep→review is fine). Comments are not de-duplicated:
                              # a second kb review on a task in review adds a second note.
kb p                          # projects: slug (PREFIX) b0 t2 pp0 d1 dp0 r1 ✓5 !1  (pp = prep)
kb ls <proj> [-s st] [-a]     # tasks (without -a, backlog/done/cancelled are hidden); 📌 = pinned
                              # by the human — it needs attention
kb show <key>                 # details + checklist + issue + comments: the last five plus every
                              # human note since your last report. Marks: 🤖 yours, 👤 the
                              # human's, ⎇ a commit stat the board attached by itself (not the
                              # human speaking), ☑ the record of an answer the human gave you
                              # from the card (you already got it — nothing new to act on).
                              # "… N more comments not printed" = the rest are
                              # on the board — nothing is dropped silently.
kb add <proj> "title" [-d "desc"] [-p high|med|low] [-s todo]   # goes to backlog by default!
kb mv <key> todo|prep|doing|deploy|review   # never done/cancelled: those are kb done / kb cancel
kb done <key> · kb cancel <key> · kb pri <key> high|med|low|none
kb lbl <key> +bug -ui         # labels: bug docs duplicate enhancement ui feature security noclaude ask …
                              # noclaude = done by hand (without Claude) → counted separately on the dashboard;
                              #   such a task is the human's: kb take never gives you one
                              # ask = ask clarifying questions and WAIT for an answer before starting
                              #       (see Special cases)
                              # check = a check task the board made (see Special cases) — not yours to put
                              # ⚠️ only labels from the palette (LABELS in github.js): kb lbl / kb add
                              #    reject an unknown label immediately (exit code 2). A genuinely new
                              #    label goes into the LABELS palette first, and into this file.
kb desc <key> "description"   # set or overwrite a task description (used when grooming the backlog)
kb note <key> "text"          # a standalone comment (rarely needed — kb review covers it)
kb check <key> <n>            # tick checklist item n (from 1, in the order show/take print them)
                              # · kb uncheck <key> <n> clears it. Answers "- [x] item (2 open)"
kb link <key> <key> [child|parent]   # link two tasks (the board draws a line); `child` makes the
                              # second task a sub-task of the first, `parent` its parent, no word
                              # = plain related · kb unlink to unlink
kb block <key> "why" · kb unblock <key>
kb info <proj>                # path, deploy_skill, server, pm2, domain, the project's description
                              # (the owner's context for work — read it) and "docs: CLAUDE.md,
                              # README.md" — the documents to read before the task; "docs: no
                              # CLAUDE.md — read README.md instead" is a signal, not an empty line
kb svc <proj>                 # live status of the project's services (local pm2 or your own PANEL_URL)
kb sync                       # state of the sync queue (or "sync is off" in local-only mode)
```

## A new project goes on the board FIRST (hard rule)

**The moment you create or start a new project — a new folder, site, bot, service — register it
on the board before writing any task or any code for it.** Otherwise the work happens off the
board: it has no task key and no deploy metadata. The board does NOT register projects on its own:
local folders under `LOCAL_ROOT` (`~/claude-projects`) appear in the sidebar with an "+ add" row,
but a project living anywhere else has to be registered by hand.

Register it through the API rather than raw SQL — the API emits an SSE event so the board updates
live, and the GitHub project is provisioned on the first task:

```python
# python3, so quoting doesn't get in the way
import json, urllib.request
body = {
  "slug": "myproj", "name": "myproj.com",
  "path": "<path to the project's code>",
  "deploy_skill": "deploy",        # or empty if there is no deployment
  "server": "<host>", "domain": "myproj.com",
  "category": "<sidebar group>",
  "description": "…",
}
req = urllib.request.Request("http://localhost:3100/api/projects",
    data=json.dumps(body).encode(), method="POST",
    headers={"Content-Type": "application/json"})
print(urllib.request.urlopen(req, timeout=10).read().decode())   # 201 + the object, including prefix
```

Registry fields (PATCHABLE): `name, prefix, path, server_path, deploy_skill, server,
pm2_services, domain, category, description, pinned, archived`. `slug` and `name` are required;
`prefix` (the `PREFIX-N` task key) is generated for you. Edit later with
`PATCH /api/projects/:slug`. When a human registers a project by hand, their path is the
"＋ Add project" wizard at the bottom of the sidebar; the API snippet above is yours.

**Verify it landed (do not skip):** `kb info <slug>` (path/deploy_skill/server/domain filled in),
`kb p | grep <slug>` (visible on the board), `kb sync` (the queue is not stuck). Only then create
tasks (`kb add`) and start working.

## The working loop ("work through project X")

Claude takes a task as far as *review* and stops. Only the user moves anything to done/cancelled —
except when the user hands acceptance over with a check task (see Special cases).

**When the prompt lists specific keys** (the 📋 button on the "To do" column produces them) those
are SPECIFIC tasks, not a queue. **Read ALL of them before starting the first** — `kb show <key>` for
every key, in one go (NOT `kb take`, which pulls ONE next task from the project's `todo`): tasks of one
batch often answer each other — a key, a decision or a file another task needs, two tasks on one place —
and reading them one at a time means doing the first without what the third one says. Then plan the order,
take together what is solved together (see Special cases), and **move each to prep right away:
`kb mv <key> prep`** — `kb show` does not change the status. A task the board started you on with ▶ inside the board or in a
terminal is in prep already: the move only confirms it is yours (a start in the Claude app leaves it where it was). If that answers `<key> is already taken: it is in prep`, another
Claude session holds the task: leave it — do not work on it or move it some other way — say so in chat
and go on with the next key. A key whose task is labelled `noclaude` is the human's own work: leave it too
and say so, unless the human asked for that very task in chat. If `kb show` printed `> 👤 [date] Send back: …`, the task was
returned — the date tells a fresh send-back from an old one you already answered: open the `📎` screenshots with Read and act on that note FIRST. Then follow steps 2–6
for each. Use `kb take X` only when asked to "work through project X" without specific keys.

1. `kb take X` — take a task (lands in prep; description and issue are already in the output).
   "empty" → report it and stop. "empty (N blocked)" is NOT an empty column: every card in To do
   is blocked — list them (`kb ls X -s todo`) and report that, not "nothing to do". "empty (N by hand: KEY …)"
   (possibly after "M blocked, ") means every card left in To do is the human's own work (label `noclaude`):
   say "no tasks for Claude; To do holds N done by hand: KEY, …" and stop — do not offer to remove the label. `> 👤 …` lines are what the human wrote since your last report
   (a send-back and its follow-ups) — act on all of them first.
   `📎 <path>` — open the screenshot with Read.
2. **HARD RULE — starting a task (never skip, even for a one-line change).** `kb info X` → go to
   `path`; its `description:` and `docs:` lines say what the owner wants you to know and which
   documents the project has. Before any code you MUST read: (a) the project's `CLAUDE.md` if it has one — **and if
   it does not, find where the project keeps its architecture or research document (`README.md`,
   `EXPERIMENTS.md`, `docs/`) and read that; apply the "doc in the same commit" rule to it**;
   (b) the deploy skill at `deploy_skill_path` from `kb info`, if one is set. The matching commit
   rule: **if you change code whose behaviour is documented in the project's `CLAUDE.md`, update
   that section in the SAME commit.** When you edit a document with a script, gate the commit on
   the script succeeding in one chain (`python … && git add … && git commit …`): a script that
   failed on a missing anchor will not stop the next shell command, and the commit would go out
   without the document. Started writing code → `kb mv X doing` (the timer starts).
3. Reference the task's issue in commit messages: `git commit -m "... (#<N>)"` (or `owner/repo#<N>`
   when you commit outside the issues repo) — N comes from the `take`/`show` output. The board
   attaches commit stats to the task on the move to `review`: it looks for a commit that really
   references the issue (`git log -1 --grep=#N`). **When sync is off** (the task has no issue
   number) stats come from the last commit made while the task was in progress, so move the task
   to `doing` BEFORE its commits. Commit with `git -C <path>` or after `cd <path>` — the shell's
   cwd may be outside the repository. A project not under git simply skips the commit step; that
   is normal. **Several tasks touching one file** → either one commit referencing both issues
   (`… (#A, #B)`), or the "revert the hunk → commit → restore it" trick; with 3+ interleaved
   changes, slice the full diff into per-issue patch files and apply them with `git apply`,
   committing in between.
4. If the project has a `deploy_skill`: `kb mv <key> deploy` → run the deployment with that skill →
   step 5. Without a deploy_skill, go straight to step 5. Take the skill from `deploy_skill_path`
   in `kb info` (if the skill is not in the available list, just read its SKILL.md at that path).
   The generic `deploy` skill ships with the board (`skills/deploy/`) and works purely off
   `kb info` data. Production commands (ssh/rsync) will ask for confirmation — that is expected.
5. `kb review <key> "<two plain sentences: 1) what the problem was 2) how you solved it>"` → take
   the next one. **If the task has a checklist, tick each item as you finish it (`kb check <key>
   <n>`).** Before review every item is either ticked or named in the note as not done — the human
   accepts the task by those boxes, and an unticked done item reads as undone.
6. Stuck, or the decision is the human's → `kb block <key> "reason"` and move on.
7. At the end, a one-line summary: how many in review, how many went back to To do after a
   discussion (`ask`), how many blocked.

## Grooming the backlog

Triggered by a prompt like `Groom the backlog [of X] (grooming mode):` with a list of keys (the 📋
button on the "Backlog" column). This is NOT "do the tasks" — no code is written, no statuses move,
**every task stays in the backlog**. The goal is to declutter and prepare.

For each key: 1) `kb show` — title, description, comments; 2) no description → `kb desc <key> "…"`
(one or two sentences, invent nothing); 3) classify: `kb pri` by meaning (unclear — leave it) plus
`kb lbl`; 4) anything unclear → ask via `kb note`, do not guess; 5) do not change the status.
One line of summary at the end.

## User commands for a task in review

- "accept TIC-3" → `kb done TIC-3`.
- "send TIC-3 back: <what's wrong>" → `kb unblock` if needed, `kb mv TIC-3 doing`, fix it, then the
  loop again from step 4. **First REPRODUCE the exact scenario from the note** (curl or a browser,
  following the real flow) and confirm the actual cause — only then fix it. A second attempt at a
  returned task often cures a plausible but wrong cause.
- "cancel TIC-3" → `kb cancel TIC-3`.
- "do TIC-3" (a specific task in any status except done) → `kb show TIC-3` (the `👤` note comes
  first; open `📎` screenshots with Read) and **`kb mv TIC-3 prep` right away**, then steps 2–6
  (`already taken` means another Claude session holds it — see above).

## Special cases

- **The `ask` label on a task** (visible in `kb show`/`kb take` output) → this is a BLOCKING step:
  study the task in `prep`, then ask your clarifying questions in chat — how you understood the
  task, what you intend to change and where — EVEN IF everything looks obvious, and WAIT for an
  answer. Do not move to `doing` or write code until the human replies.
  **How an `ask` task ends.** Agreed and done → the normal loop up to `review`. The turn passes to
  the human with the work NOT done — you hand it back with questions, you proposed options and the
  choice is theirs, they postponed it → `kb note <key> "…"` with the outcome of the discussion (what
  you asked, what the human answered, what was agreed, what is still open) and **`kb mv <key>
  todo`**; when they answer in chat, `kb mv <key> prep` and carry on. Not `review`: that column holds
  finished work, and a bare proposal there reads as delivered. Not left in `prep` either: only Claude
  moves that column, so the human cannot pull the card out, and your turn with the questions may be
  the last one in the session. The note is mandatory — the chat does not survive between sessions,
  and the next one would start the discussion from scratch.
- **You found an unrelated problem along the way** → do not fix it silently. Create a task
  (`kb add <proj> "..." -d "..."`) and ask in chat: do it now, defer it, or is it for the human.
- **Related tasks solved together** → take both at once (both in doing), fix them in one pass and
  link them with `kb link`. `kb show`/`kb take` print a task's links as `↑ parent KEY title
  (status)`, `↓ subtask …`, `↔ related …` — look at them before you start: a linked task in To do
  is usually meant to go together with this one, and a parent explains why the task exists.
- **A discussion or question task** (no code): study it in `prep`, put the full answer in
  `kb note <key> "..."`, then `kb mv <key> review`. **With the `ask` label it goes back to `todo`
  instead** (see above): there the discussion is a step before the work, not the work itself. You
  write no code and do not move it to done.
- **A check task (the `check` label): the user hands acceptance over.** The board's *Claude review*
  section makes one per project, titled in the board's language ("Check the tasks in Review with
  different tests and simulate failures, then move them to Done"); its description lists the tasks in
  Review at that moment. Tell it by the label, not by the title. It is the one case where you move
  tasks to `done`, and only the ones listed. Do it, do not glance at it:
  1. A check of your own for every task, tied to what the task was about: the page serves the right
     HTML, the number on it matches the real one, the endpoint answers. The list comes from the
     description, not from memory.
  2. Simulate failures, not only the happy path: a 500 or a dropped connection wherever the code talks
     to something — the page says so honestly and carries on. And walk the happy path at least once for
     real, with nothing stubbed: a stubbed 200 only proves your stub works.
  3. Break the code itself — in a scratch copy, one change at a time — and see the project's checks go
     red. A green suite proves nothing until it is red on a restored bug.
  4. What passes → `kb done <KEY>`, one command per task and the key exactly as the description
     writes it, with nothing around it — no loop, no script, no `; echo` or redirection: a check the
     board started may run exactly those commands without asking, and anything else goes to the
     permission check of Claude Code, which may refuse it. The tool shows the return code of each. What fails stays in `review`: fix it and check again, or leave a `kb note`
     on it when the fix is not yours to make.
  5. The report goes on the check task, `kb review <check-key> "…"`: what you checked in each task and
     what you found, in full — not "all good". The check task itself stays in review for the user.
- A "check whether the service is alive" task → `kb svc <proj>` (one line per service, no ssh).
- Work time is measured for you: doing/deploy runs the timer, review/done stops it.
- Verifying the result: text and config changes — curl/grep (cheap). Compiled projects — **a build**
  is the cheap check (`cargo build`, `go build ./...`, `tsc --noEmit`, …). **For layout and visual
  changes a screenshot IS the cheap check** — curl and grep never catch a broken layout: serve the
  project from its root and screenshot the page with a headless browser (playwright), on desktop
  (1280) and on mobile (390/360). Mobile "cut off" bugs are horizontal overflow — compare
  `scrollWidth` with `clientWidth` and find elements whose `getBoundingClientRect().right >
  clientWidth`, ignoring those inside an `overflow-x:auto` ancestor.
- **Driving the board's own UI in a browser** (drag & drop, drawer, SSE): use playwright directly,
  `page.goto('http://localhost:3100', { waitUntil: 'domcontentloaded' })` — NOT `networkidle`, the
  SSE connection never closes. Wait for `waitForSelector('#projects .proj')`. **The dashboard is
  what opens on start**, so click a project in the sidebar first, then wait for `.col-body .card`.
  Top-level functions are exposed on `window` (`openDrawer`, `getSetting`, …); `state` is not —
  read state from the DOM. Test mutations on a throwaway task (`POST /api/tasks` → check →
  `DELETE /api/tasks/<key>`); task numbers are not reused, which is normal. For copy buttons, grant
  the clipboard permissions to the browser context or `readText()` silently returns empty. Call
  actions that open a confirmation modal without returning the promise:
  `page.evaluate((k) => { window.deleteTask(k); })` — returning it deadlocks; click the modal as a
  separate step.

## Token rules (hard)

- Never dump the whole board into the chat. One action, one line of `kb` output, no retelling.
- `kb show` only when you need the description in order to work.
- **Going into the database directly: it is `data/kanban.db`, NOT a `kanban.db` in the repo root.**
  Gotcha: `sqlite3 <path>` SILENTLY creates an empty file when nothing is there, so a typo leaves a
  junk 0-byte `.db` in a clean repository. Check the path before running it, and look at
  `git status` after any sqlite session.
- Read task details with `kb show`/`kb take`, not `curl /api/tasks…|jq`: descriptions contain raw
  newlines and a shell JSON parser chokes on them. If you truly need the API, save the response to
  a file and parse it leniently (`python3 … strict=False`).
- **Bulk-create tasks or comments with a script** (`subprocess.run([kb,'add',…])` / `execFile`)
  rather than assembling shell commands: backticks, quotes and newlines get mangled by the shell.
  `kb add` prints the key as the first word of its output — take it and attach labels with `kb lbl`.
- **Bulk moves (`kb mv`/`kb review`) from a script must check `returncode`, not printed output**: a
  rejected move exits non-zero. Verify with `kb p` at the end that the counts add up.
- Removed an element from a page — verify with grep on **the text or markup**, not the class name
  (the CSS rule of the same name stays behind).
- The review comment is **exactly two plain sentences, no jargon**: (1) what the problem was,
  (2) how you solved it.
- The final chat message is one line per task: `TIC-3 review — summary board is ready`.
- `kb: board is not responding` → restart the board's server (`pm2 restart kanban` / `npm start`),
  wait two seconds and retry once. **Exit codes are distinct: `1` — the board is down (a restart
  and a retry make sense), `2` — the request was rejected (retrying is pointless, read the
  message), `3` — `kb` itself broke (stack trace under `KB_DEBUG=1`), `4` — the board answered,
  but with a failure of its own (5xx) or with something that is not JSON. Gate on the code, not on
  the message text.** Code `4` is worth reading closely: it means the board falls over on this
  request, or `KB_URL` points at something that is not the board at all.
- The web board is for the human: http://localhost:3100 — do not open it, do not scrape it.
