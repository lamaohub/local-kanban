# Changelog

Notable changes, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [semantic versioning](https://semver.org/).

Anything not shipped yet is collected under **Unreleased**; releasing renames that section to the
version it goes out as and opens an empty one again. Released sections are history and stay as they are.

## [Unreleased]

## [1.16.0]

### Added

- **Health: how big the instructions Claude reads are.** Switch it on in Settings → Health, and the sidebar gets a
  section that measures every project: its own CLAUDE.md in lines and characters, and everything a session started in
  its folder reads (the CLAUDE.md of the folders above, imports, rules, auto memory), against the norms — under 200
  lines per CLAUDE.md, as the Claude Code docs ask, and the 40,000 and 120,000 characters from which Claude Code itself
  warns. The CLAUDE.md files of subfolders are listed apart.
- **Claude done by time.** A switch over the section shows the runs as before, or every task Claude finished in one
  list, the latest on top, with its project on the row. The choice is kept in the browser.
- **Automations: a check of Review that starts by itself.** Switch them on in Settings → Claude Code, and the sidebar
  gets a section where a rule reads "When [project] finishes its work, wait [3] min and start a check of the tasks in
  Review". Once every task Claude took in that project has reached Review and nothing waits for you, the board counts
  the pause down — beside ▶ of Review and over Claude now — and starts the check inside the board, as the button does.
  A rule runs once; the page may be closed. A question of Claude, a task handed back to To do or a used-up limit holds
  it, and the pause starts again after.

- **An answer cut off by a lost connection goes on by itself.** When the connection to the API breaks in the middle of
  Claude's answer, Claude Code ends the turn and waits — nothing told you the work had stopped. Now the card says
  "connection lost · going on", and the board tells its own Claude to go on from where it stopped (up to three times in
  a row, after 15 s, 1 min and 3 min). When it cannot — a Claude started outside the board, or it broke again — the card
  says "answer broke off" and the board notifies you. A second "Claude is waiting for you" (or question) of the same
  task now shows its banner and sound as well — it used to replace the first one silently.
- **The board over Wi-Fi.** Settings → Wi-Fi (and the Wi-Fi button beside Settings, orange while it is on) opens the
  board to people on the same network: a QR code and a link open it on their phone or laptop. The address has no
  password — anyone on that network who opens it can do on the board what you can, including talking to Claude on your
  computer — so keep it on only on a network of people you trust. Switching off closes the board to the network.
- **The first-run wizard says what the board is now** — the card's chat with questions as a form, Claude now with every
  Claude side by side and Continue — and asks whether to show Claude as a chat or a terminal. The check of the computer no
  longer reads "Claude's questions: not connected": the board gives its own Claude the hook. Every board sees the wizard
  once more after the update.
- **Continue a Claude of the board that has stopped.** A Claude started inside the board and stopped from outside (or
  ended by itself) keeps its terminal: the card says "Session interrupted" and opens on it, and Continue — in the card's
  terminal, in its chat, and in Claude now (the list and Terminals) — starts Claude again in that terminal with its
  conversation, where it waits for your word. Claude now keeps an interrupted run in sight instead of folding it among
  the ones nobody leads.
- **Claude as a chat.** A card has a Chat tab in place of "Claude's work": the conversation of its Claude in turns —
  your words, what Claude wrote, its steps folded under "N steps" with their time and a ✗ where one failed, and how long
  each turn took. What a command returned is never shown. The Claude the board started can be answered right there:
  words go at once to a Claude waiting at its prompt, and to a busy one they wait in a queue (✕ takes them back) and
  go once it has been free for two seconds; a question Claude asks is answered right in the chat, with the keys of its
  terminal. A Claude in Terminal or the Claude app is read, not spoken to. Whether a card and a column of Claude now →
  Terminals show Claude as its chat or its terminal is one choice in Settings → Claude Code. The tasks over a column
  open and close like a shutter, and opened steps fold back. A picture pasted, dropped or picked with the clip goes
  with the message as a picture — a thumbnail over the field, ✕ takes it out — and Claude gets it as an image, not
  as the path of a file in your words. Claude's answers read as Markdown: headings, lists, tables, quotes and code.
  A message reaches Claude for certain: words left in its input field are cleared first, the board sees the message
  arrive before it presses Enter and leave after it, and when it does not, the chat says why instead of looking sent.
  A Claude at work can be stopped from the chat (■ next to Send) — as Esc in its terminal, never twice at once.
  ⌘↵ (Ctrl+↵ off a Mac) sends at once even while Claude works — it takes the words into the turn going on — and a
  waiting message has its own Now; words sent mid-turn show in that turn.
  A block of code in Claude's answer has a copy button, and a command (a block of a shell) runs in a new Terminal
  window in the project's folder once you have seen it whole and said yes — only a command Claude wrote in that chat.
  ⛶ in a chat of Claude now → Terminals spreads that column over the window, smoothly, and takes it back the same way
  (Esc too) — the same chat, what you typed and the place you read kept.
- **⌘F opens the search over projects and tasks** (Ctrl+F off a Mac) — from any screen, from a field too. Pressed
  again while the search (or any other window) is open, it is the browser's own find. The shortcut can be changed in
  Settings → Hotkeys.
- **A task moves to another project.** "Move to project…" in the card's ⋯ menu and in the right-click menu of a card:
  the task keeps its comments, attachments, checklist, links and issue, takes the next number of that project, and
  its old key still leads to it (the card's timeline and `kb show` say where it came from). A task Claude is working
  on is not moved until it is handed in.
- **A screenshot reaches Claude from its terminal.** Paste a picture (or drop one) into the answer field of the card's
  Terminal tab or of a column in Claude now → Terminals: it is kept as an attachment of the task, and its path goes
  into the field, so Claude opens the picture when the answer is sent.
- **The answer field suggests handing the task in.** While Claude waits for a word on a task in Doing or Deploy, the
  empty field shows a grey hint — "Move KEY to Review, so I can check it later"; Tab puts it in, typing hides it.
- **A check of Review can think at its own level.** Settings → Claude Code has a second "How hard Claude thinks", for
  checks: a check started from Claude review or the Review column takes it, every other task the level of all starts.
  Left as it is, a check thinks as every task does.
- **Claude now → Terminals: every run of Claude side by side, each with its terminal.** A switch at the top of the
  section lays the live runs out as columns, like an agents window: the tasks of the batch above, and — for a Claude
  the board started — its screen, its keys and a field to answer it, without opening a card. A Claude in the Terminal
  app or the Claude app has no screen here; its column says where it is.
  A ✕ beside "Open in the card" closes a column's terminal: a Claude that is done and has nothing to ask goes off
  the section at once (a Claude still running is asked about first).
- **Settings → As an app: how to make the board an app of its own.** The steps for the browser the page is open in
  (Chrome and other Chromium browsers, Edge, Safari on a Mac, iPhone and iPad, Android; Firefox on a computer is told
  to use another browser), the others folded below, and an *Install* button where the browser offers it. A board
  opened over plain http at a LAN address is told why Chrome greys the menu item out. The installed app opens light.
- **The terminal of a card shrinks and grows.** Drag the short bar over its keys (or press ↑/↓ on it) to make the
  screen lower or taller; a double click gives back the usual height. The height is remembered on this computer.
- **A new look, in the spirit of the new Claude app.** Near-black (or, with the light theme, cream) monochrome, a
  white main button, neutral highlights instead of orange, serif titles, icons in the sidebar, thin borders and
  rounder cards, a *New task* row at the top of the sidebar and soft transitions for screens, the task card, windows
  and lists. Behind the board, clouds and waves made of grey symbols drift from right to left in three layers of
  depth — the far ones smaller, dimmer and slower, the near ones hiding them — and a click on empty space (not on a
  button, card or field) sends a sonar pulse that lights them up in blue as it spreads, the lit side of every form
  brighter than its shadow. It moves at the display's frame rate, can be turned off in *Settings → Appearance →
  Symbols in the background*, and stops with reduced motion and on a hidden tab. The theme still picks light or dark.
- **A welcome wizard that asks how you want to use the board — and it comes back once after an update.** Besides the
  language, it now asks how ▶ should start Claude (inside the board, in Terminal, in the Claude app or only copy the
  prompt — the ways this computer lacks are greyed with the reason), what the board shows (Claude's usage, limits,
  work feed, compact cards) and the GitHub sync, which it shows as it is when it is already on. A board that was in
  use before goes through it once after updating, without the demo step; its projects, tasks and settings stay as
  they are, and only what you change is written. *Settings → About* can open it again, and has a line with a
  Telegram contact for questions.
- **A card knows which Claude sessions worked on it.** Claude Code gives every command it runs a
  session id, and `kb` now sends it along. When a session moves a task into work, leaves a note on
  it or ticks its checklist, the board ties the two together: the card shows how many sessions
  worked on the task and when the latest one did, and `kb show` prints the same, plus the transcript
  of an earlier session — so a task sent back for rework can be picked up knowing what was already
  tried. Grooming a backlog card does not count as work on it. Nothing of this leaves your machine.
- **Claude's work, live, in the card.** A task some Claude session worked on gets a switch next to
  its comments: *Claude's work* lists what the session did on this task — the person's request, what
  Claude wrote, every step (commands, files read and edited, searches, helper agents and how long
  they ran), which steps failed and what the person answered to its questions. It updates by itself
  while Claude works. A session that works through several tasks is cut by task, so each card shows
  only its own part. Read from Claude Code's own transcripts on this machine; nothing is sent anywhere.
- **A card in work says whether Claude is working on it, waiting for you, or gone.** The badge follows
  the Claude session live: *working*, *waiting for you* (a question, a permission, or it simply stopped
  with the task still in work) and *session closed* when nobody is working on it anymore. The
  dashboard's *Waiting for you* lists these tasks with how long they have waited, and when Claude
  stops to wait for you the board plays the same sound and shows the same notification as for a task
  ready for review, under the same settings.
- **▶ starts the tasks in Claude.** The *To do* column has ▶ next to its copy button, and a card that
  Claude has not taken yet has ▶ in its header (a manual task, labelled `noclaude`, has none — and loses it
  the moment it is labelled so): the board opens Claude in the project's folder with the
  job already written — a new session in the Claude app, or a terminal running `claude`. A card some
  session already worked on gets ↗, which opens that very session (or resumes it in a terminal) — the
  quick way to answer a Claude that is *waiting for you*. **Settings → Claude Code → Start tasks** chooses
  the app, the terminal, or copying the prompt only; *Automatically* takes the app when it is there.
- **Claude works right inside the board.** With `tmux` on the machine, ▶ opens nothing at all: Claude
  starts at once in the background, in the project's folder, and the card opens on its new *Terminal*
  tab — Claude's screen as it is, a field to answer it, the keys its questions need (a digit to pick an
  option, the arrows, Esc, Shift+Tab) and a button to stop it. Claude keeps working when the board
  restarts, and a Claude that has finished leaves its last screen. A second ▶ on a task that Claude is
  already working on shows that Claude rather than starting another one. **Settings → Claude Code** has
  *Inside the board* as a way to start tasks (and *Automatically* takes it first), and what Claude may
  do there without asking: decide by itself what is safe (the default), edit files, ask about
  everything, or only make a plan — skipping the checks altogether is not offered. A project without a
  folder on this computer gets a one-click way out right there: create a new empty folder for it, or
  choose the one with its code — and Claude starts as soon as it is set. The `claude` command keeps its
  own sign-in, apart from the Claude app: when it is not signed in, the tab says so and signs it in
  with one button, and the web addresses on its screen (the sign-in one included) are links. Claude
  started there runs the board's own commands (`kb take`, `note`, `review`…) without asking, whatever
  its mode — but not `kb done`, `cancel` or `rm`, and `kb mv` only to the working columns; and when it asks about every command in the manual
  mode while the board is set to auto, the tab offers to switch it to auto in one click. It runs the
  board's own `kb`, whatever version is on your PATH, and its card shows *Claude's work* even when the
  `kb` it used did not say which session it was. Claude does not quit after handing a task in — it waits
  for your answer — so the board closes its terminal by itself once every task it worked on is accepted,
  cancelled or deleted; a task in *Review* keeps it, and a Claude in the middle of a reply finishes first.
  The tab keeps the card as wide as the other tabs do: Claude's screen is laid out for the card, rather
  than the card growing for the screen. A comment can go to that Claude too: the **>_** button next to the
  send arrow hands it to Claude in the terminal and saves it, so Claude carries on with the task or the
  talk without you switching tabs. It does that only while Claude waits for you at its prompt; while it
  works or asks a question there, nothing is typed and the comment stays in the field.

- **Claude now: what Claude is working on, top to bottom.** A new item under *Dashboard* in the sidebar
  lists every task in work across the projects, grouped by the run of Claude that holds it. A run says
  how much of it is handed in (*handed in 1 of 3*, with a ring); each task shows its step and how far it
  is — by its checklist when it has one, by its stage otherwise (Prep 25%, Doing 50%, Deploying 75%,
  Review 100%). The task Claude is on right now is marked, the ones waiting their turn follow it, and
  runs nobody leads any more — the session closed, or nothing moved for two hours — are folded at the
  bottom, so stuck work is easy to find. The sidebar item counts the tasks in work and shows a dot while
  some Claude is working; it all updates live, checklist ticks included.
- **Claude review: hand the acceptance of a project to Claude with one button.** A new sidebar item
  under *Claude now* lists the tasks in Review by project, in the order of the sidebar. *Check in Claude* makes a check task in that
  project — the tasks in Review at that moment are listed in it — and starts a fresh Claude on it: it
  checks every task with tests of its own, simulates failures, moves what passes to Done and leaves the
  report on the card of the check. While a check is open the button shows it instead — including when its Claude waits for an answer in the terminal, which opens right there — so the same tasks
  are never checked twice at once — even two tabs pressing at once make one check. A check carries the
  `check` label, so it is recognised on a board in any language, and the Claude started on it inside the
  board moves exactly the tasks it lists to Done without asking; once that Claude has exited, the check
  says its session is closed rather than that Claude is checking. The `kanban` skill says how such a
  check is done.
- **The sidebar shows how much of your Claude limits is used.** The 5-hour and weekly windows of a Pro or
  Max subscription sit at the foot of the sidebar, with the time the board heard of them. Claude Code hands
  these figures only to its status line, so `kb statusline` forwards them: put it in front of your own
  status line (`kb statusline | your-command`) or use `kb statusline --line` on its own. A window whose
  reset time has passed is not shown, and with nothing current the footer says why: *not connected · connect* when
  the status line does not go through the board (*not connected · how* when your own status line has to take
  `kb statusline` by hand), *go to another board* when another board holds it, and *no data*
  otherwise — which is what a board used only from the Claude desktop app gets, since the app runs no status line.
  A click on it opens **Settings → Claude Code**. A board that hangs does
  not slow your status line down: kb sends the figures and hangs up without waiting for an answer. Switch to
  another Claude account (`/login`) and the footer shows that account's figures from its first reading on.
- **Answer Claude from the card.** When Claude Code is about to ask you something — a permission, a
  question, a plan to approve — the PermissionRequest hook `kb hook permission` puts the request on top of
  the card of the task the session works on, and the card's badge says *needs your answer*. Allow or deny it
  with a reason, pick the answers (or write your own), approve or reject the plan with what to change.
  Claude's own dialog stays usable all along, and whichever side answers first wins; a request answered in
  Claude leaves the card by itself. An answer given the moment Claude has already taken one in its own window
  does not pass for a given one: the card says it did not reach Claude. A tab whose answer lost to another tab's
  says so, and a request the board lost when it was restarted is named on the card instead of vanishing. The whole command is shown, never cut short, and every answer is written
  into the task's history — never sent to GitHub. Answers are taken from the board's page, which keeps other
  web sites out but not programs on your computer — Claude included, if it may run `curl` without asking.
- **Connect the board to Claude Code in one command.** `local-kanban hooks install` adds the two entries
  above to Claude Code's settings.json — the status line through `kb statusline`, in front of your own, and
  the PermissionRequest hook — after showing what it will change and asking. Your other hooks and settings
  stay, the previous file is kept in the board's backups, and `local-kanban hooks uninstall` takes off
  exactly what it added. A settings.json made read-only, or a folder it cannot write, is reported and left as
  it was. Your status line keeps getting all of its input whatever shape its command has,
  and keeps working even if kb cannot start; a settings.json that is a link stays a link with the same
  permissions, a file Claude Code changed while you read the change is not written over, and running the
  command again after a Node upgrade brings the board's entries up to date. Your settings.json keeps its own
  indentation and line ends, and the copy of the previous one is a `.json` file in the board's data folder —
  in the setup wizard, the folder you chose there. A board removed without disconnecting it leaves Claude Code
  quiet: the hook checks that the board is still there before it runs, and the README says how to take the
  entries out by hand. The setup wizard offers the same step.
- **Settings → Claude Code.** One place to see whether the board's work with Claude Code can work on this computer:
  the `claude` program, `tmux`, the Claude app and a terminal — the ways ▶ starts a task; the Claude folder, the
  board's skill in it, the sessions and transcripts the cards read; whether the status line and Claude's questions
  go through the board, and when the limits came last. Every missing piece says what does not work without it and how
  to fix it, and a piece only one way of working needs — tmux, the Claude app, the connection — is marked as optional
  (–), not as missing (✕). A copy of the board's skill that is not the version this board ships — one left from an
  earlier version, or changed by hand — is said to be so, and **Settings → Skills** takes the board's version in one
  click, keeping the old file among the backups. **Connect** writes the board's two entries into Claude Code's settings.json — the same as `local-kanban
  hooks install`, after showing exactly what it will write — and **Disconnect** takes them off again. How tasks start
  and what Claude inside the board may do moved here from General. The two switches at its top, **Show on the
  board**, hide Claude's usage (the dashboard block and the card's line) and the limits footer — for anyone who
  would rather not see them, or whose footer only ever says "no data" because they work in the Claude app. With two
  boards on one computer only one can be connected: the section names the board that holds the connection, and
  connecting this one asks before it takes the connection over.
- **What a task cost.** A card some Claude session worked on shows a usage line under its sessions: the
  tokens first, then roughly what they would cost on the API (≈, at the prices of the date shown — with a
  subscription the money is notional), and how full the conversation memory was on the last answer; hover it
  for the breakdown (input, output, cache reads and writes). Helper agents started for the task count as its
  usage. `kb show` and `kb take` print the same line. The dashboard shows Claude's usage for the chosen
  period and the tasks that cost the most — click one to open it. It is counted from Claude Code's
  transcripts on this machine, once and then only what is added; nothing is sent anywhere. Claude Code often
  leaves out the final count of a helper's answers, so their output is under-recorded — the card says so
  instead of pretending the number is exact.
- **Claude done.** A section under *Claude review* lists what Claude has finished in the last seven days: every
  run — a batch started with ▶ or a single task — once none of its tasks is left in work, the most recently
  finished on top, with how many of its tasks wait in Review and how many are accepted. Hand-ins made without a
  session the board knows are put together by project and time and say so.
- **Check the Review column from the board.** The Review column of a project has the same button as *Claude
  review*: it makes a check task for the tasks in the column and starts Claude on it; while a check is open, the
  button opens its card instead.

### Changed

- **A phone opens the board its own way.** Until you pick otherwise, a phone gets the dark theme, Claude as a chat, and
  Claude now on the chats of its runs (Terminals); the language follows the phone's, as on a computer. A computer —
  and a tablet — keeps the light theme, the terminal and the list.
- **Claude reads a whole batch of tasks before starting the first.** Given several keys at once (▶ or 📋 on To do), the
  board's skill had Claude read and do them one by one — what a later task said (a key, a decision, the same place)
  reached it only after the first was done. Now it reads them all first and plans the order.
- **The first run is a whole screen.** The welcome wizard no longer sits in a small window: the words and the
  choice are on the left, and on the right a live picture of the step — a card going to Claude and back for your
  check, Claude's terminal on a card, what this computer has for Claude Code (the same check as Settings → Claude
  Code), the board as the switches leave it, the task and its GitHub issue. Pointing at a way of starting Claude shows
  what ▶ does that way. Under "reduce motion" the pictures stand still; on a narrow screen the words come alone.
  A board that went through the earlier wizard shows the new one once after the update; projects, tasks and settings
  stay as they are.
- **The project of a run opens its board.** In Claude now, Claude review and Claude done the project name at the top of
  a run or a group is a link to that project's board.
- **The terminals of Claude now → Terminals are as wide as their columns.** A column lays its terminal out to its own
  width again (the card's narrower width left the right part of it empty), and keeps showing the old screen while
  Claude reprints the conversation for the new width, so the start of the session no longer scrolls by — the card's
  Terminal tab does the same. When a card and a column (or two tabs) show one terminal, its window takes the narrower
  width instead of changing back and forth. A screen scrolled up has a ↓ in its lower right corner that takes it back to the end.
- Enter in the title of a card moves on to its description instead of leaving the field.
- **The light theme is crisper.** Text is near-black instead of grey, borders and the selected item stand out from the
  cream, the sidebar has a tone of its own, and the symbols in the background are a quieter haze.
- **The board opens in the light theme until you pick one.** It used to follow the system, so a computer in dark
  mode got a dark board without anyone choosing it. *System* is still there in *Settings → Appearance*, and a theme
  you already picked stays.
- **Two themes: light and dark.** The theme *Claude* looked the same as *Dark* in the new look, so it is gone; a board
  set to it opens dark, and the theme cards show the real colours of each theme. *System* still follows the computer.
- **No note pops up at the bottom right when Claude starts to wait for you.** The board still rings, the system
  notification still goes out when it is on, and the block on top of the sidebar lists what waits.
- **A long list inside a window shows its scrollbar** — the skills in *Settings → Skills* and an open dropdown such
  as the deploy skill of a project — narrow and grey, so it is clear there is more below.
- **The sections of the sidebar start with a small grey icon** — the first letter of the name ("Pinned", "Other",
  your own sections) — in line with the icons of Dashboard and Settings above them; the projects carry none.
- **The title of a screen stands alone.** The line of description right of it (counts, the key and domain of a
  project, "quick task capture") is gone.
- **The header of the Terminal tab fits one line**: a few words ("Working", "Waits for you", "Waits for your
  answer", "Finished · code 3") and a short "Stop" or "Close" button next to them, instead of a sentence that
  wrapped to two lines and pushed the button down.
- **"Claude now" puts no dot in front of its tasks** — the run's badge already says what its Claude is doing — only
  ✓ in front of one handed in, and the task Claude is on is not highlighted — the line under its title says it.
- **The board no longer zooms by accident.** A pinch on a trackpad or a phone screen, Ctrl with the mouse wheel
  and a double tap used to zoom the whole page, and the board slid past the edges of the window. These gestures
  do nothing now; ⌘/Ctrl with + and − and the browser's View menu still zoom for whoever needs larger text.
- **Claude's work is a tab you switch on.** It is off by default now: *Settings → Claude Code → Show on the
  board → Claude's work*. Off, the card does not show the tab or read the transcript for it, and a card with no
  terminal shows no tabs at all — switched off while a card stands on that tab, the card goes back to its comments.
- **A card in work opens on its Terminal.** A task in Preparation, Doing or Deploy whose Claude runs inside the
  board opens on the *Terminal* tab — there are no comments yet, and the terminal is what is going on.
- **The terminal of a card scrolls back.** Claude inside the board starts with Claude Code's classic renderer
  (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`): the fullscreen one draws on the terminal's alternate screen, which keeps
  no history, so the card showed the 40 rows in sight and nothing above them. The card's screen now reaches 1000
  lines back, and what you read up there stays put while Claude goes on printing. Terminals started before this keep
  no history.
- **Words typed to the terminal of a task back in To do move it to Preparation**, and of a task in Review — back to
  *Doing*, as the move of that Claude: it keeps the task when it takes it itself. Keys alone (Esc, the arrows, a bare Enter), a digit answering a question of
  Claude's and a manual task move nothing.
- **"Claude now" shows a Claude of the board that is still at work** with none of its tasks in work — busy, or
  with commands running in the background after handing its task in (*working in the background*). Such a run is
  not in *Claude done* meanwhile.
- **A project Claude is at work in has a green pulsing dot** in the sidebar, in place of the orange one — also while
  Claude works with commands in the background, or goes on after handing its tasks in; and a Claude that comes back
  from the background to its prompt rings *waiting for you*.
- **A Claude of the board stopped at the usage limit says so.** Its tasks say *limit reached · until 12:50am* (the
  reset as Claude Code gives it), the outline of a card in work stops turning, *Claude now* and *Waiting for you* say
  the same, and the board rings and notifies once when Claude stops — before, the cards went on saying *working*. A
  look at the terminals that tmux did not answer keeps the stop rather than ringing it again, and a dialog that only
  quotes the limit's line is no stop.
- **Check in Claude waits for the work of its project.** While Claude is still at work on a task of the project
  (Preparation, Doing or Deploy), the button in *Claude review* and the ▶ of the Review column are off, and a press
  on them names those tasks. A blocked task, a task whose Claude session has closed, and one stuck for two hours with
  no Claude on it do not hold the check. The press reads the project's tasks afresh, so a search narrowing the board
  neither lets a check past work nor leaves tasks out of it.
- **The Terminal tab of a card says what its Claude is doing** — working, at its prompt with commands running in
  the background, waiting for an answer, stopped at the usage limit, or done with its turn and waiting for a word —
  instead of *Claude works in the background* over every live terminal, also of a Claude that handed its task in
  hours ago.
- **"Claude review" no longer lists the report of a check**; a project with only reports in Review has no group, and
  the count of the section in the sidebar leaves them out too.
- **The lists of "Waiting for you" on the dashboard fold** by their heading and stay folded on this computer.
- **The folders not on the board fold** under one row of the sidebar, folded by default.
- **No footer of Claude's limits while the status line does not go through the board** — it said *not
  connected · connect* to everyone who works without it. Connecting stays in *Settings → Claude Code*.
- **Settings → Claude Code says why macOS keeps asking "node would like to access data from other apps".** Claude
  inside the board runs under the board's `node` when pm2 runs the board (else under the app the board was started
  from), macOS asks in its name and keeps no answer for a program without an app bundle. The row names which one to
  give *Full Disk Access* — the path of that `node`, or the app — and opens that list.

- **The board finds Claude Code where it is, not only on its PATH.** Besides the PATH it looks where the installers put
  `claude` and, on a Mac, at the copy of Claude Code the Claude app keeps for itself — so ▶ keeps starting Claude
  inside the board when the command-line install is gone. Settings → Claude Code says where it was found; when it is
  nowhere, the section shows the install command itself.
- **▶ in the Claude app no longer moves the tasks to Preparation.** The app only gets the prompt — you send it — and the
  task waited in Preparation, a column only Claude moves, even when nothing was sent. Claude moves its tasks itself.
- **`kb take` names the cards left for you.** When To do holds only tasks you do by hand, `kb take`
  and `kb next` answer `empty (2 by hand: CK-12 CK-14)` instead of a bare `empty`, so Claude tells you
  there is nothing for it rather than that the column is empty.
- **`kb take` takes the task in one step on the board, a pinned card first.** Two sessions that took a
  task at the same moment could both get the same one; now the board picks and moves it at once. A card
  the person pinned (📌) in To do is taken first, and `kb` prints the pin in its lists. `kb lbl` adds and
  removes labels instead of writing the whole set back, so calls side by side keep each other's labels.
- **The server runs on Fastify 5.** Fastify 4 went out of support on June 30, 2025, and was never
  meant for Node 24 and 26, which the board supports. Nothing changes in how the board looks or
  behaves; the same security headers are sent with every page.
- **A task you start goes to *Prep* at once.** ▶ on *To do* or on a card used to leave the tasks in *To do* until
  Claude came up and took them — a good ten seconds, and in the Claude app until you pressed Enter there. Now they
  move to *Prep* the moment Claude starts, whichever way it is started, and the card says *starting* until Claude
  is up. The Claude that was started holds them, so another session cannot take them meanwhile — a second ▶ while the
  first one is still starting Claude is refused, and a second Claude is not given a task another one works on. A start that is
  refused or fails leaves the tasks where they were.
- **Claude started inside the board shows no next-prompt suggestions.** In the card's terminal the dim
  suggestion Claude Code puts in its empty prompt looked like text typed and not sent, and the card's ↵ on an
  empty field sends a bare Enter. The board now starts its Claude with suggestions off — the variable Claude
  Code documents for it, `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`. Claude you start yourself keeps them.
- **Updating from Settings → About brings the Claude Code skills along.** The skills the setup copied into the Claude
  folder were left as they were, so Claude kept reading the rules of the version it was installed with until you ran
  `local-kanban skills`. Now a copy that matches the board's version is brought up to date with the board, and one
  that already differs from it stays as it is — for the board's own skill **Settings → Claude Code** says so and leads
  to the button that takes the board's version. `local-kanban skills` and that button never write through a link —
  a skill file linked to a file of your own is left alone. The README's steps for updating by hand say to restart
  the board too.
- **`kb mv` no longer closes a task.** Done and Cancelled are your word, so they are `kb done` and `kb cancel`
  only: `kb mv <key> done` (or `cancelled`) is refused with exit code 2 and names the command to use. Claude started
  inside the board runs `kb mv` without asking, and through it could move any task to Done without the question
  `kb done` gets.
- **A card in work is easier to see and to read.** Its moving contour is twice as thick and visible all the way
  round, and the card has a warm tint under its text; the middle is drawn on a layer of its own, so a browser that
  composites with the graphics card does not let the moving colour through under the text.
- **The icon left of a section's title** is as tall as the title's capitals and centred on them.

### Fixed

- **Typing the title of a new task on an iPhone no longer throws the card down.** Once the task was created, the board
  scrolled its new card into sight, and with the keyboard up that moved the whole page: the title went off the top and
  the comment field took its place. On a narrow screen the board now scrolls only its own columns.
- **A picture can be added to a task from a phone.** A phone can neither paste nor drop a picture, and a new task had no
  way to add one at all. The card now has a "picture" chip beside "+ label": it picks pictures from the device, and a new
  task is created by them as by a pasted one.
- **No scroll bar in a column on an iPhone.** iOS drew its own bar at the edge of a column scrolled with a finger,
  whatever the page asked; the column now cuts that strip off.
- **`kb review` leaves no note when the move is refused.** It wrote the note first and moved the task after, so a task
  that could not go to review (straight from To do) still got the note, and the retry added a second one. Now the task
  moves first and the note follows; if the note does not save, kb says the task is in review and how to add it.
- **Words sent to a Claude at work no longer vanish from the chat.** Claude Code holds what you send while Claude is in
  the middle of a step (a command of several minutes, say) and takes it only when the step ends; the chat said
  "sending…" for a minute and then dropped the words, as if they were lost. Now the chat shows them as "Claude reads it
  when the step it is on ends" for as long as Claude Code holds them — after a reload and on another device too.
- **A note from another Claude no longer takes the task away from the Claude working on it.** A Claude of one session
  that left a note (or ticked a checklist item) on a task another Claude was working on became that task's latest
  session — the card lost "session interrupted" and Continue of the real one. Now a note or a tick ties a new session to
  a task only when no other session works on it; moving its status still does.
- **Claude sessions go on after the computer restarts.** When the Mac froze or restarted, every terminal of the board
  went with it, and its sessions read "session closed" with no way back — the chat even said the Claude was not started
  inside the board. Now such a session reads "session interrupted" with **Continue** in the card's chat, in Claude now
  and in its column of Terminals, as long as its conversation is on disk: Claude comes back to the same conversation.
  Such sessions have their own view, **Broken terminals**, beside Terminals in Claude now (with how many there are), so
  Terminals keeps only the Claudes that are running.
- **The board on a phone.** The sidebar stood beside everything and left the board, a card and the columns of Claude
  now 170 points of 390 — the page ran off the side. On a narrow screen the sidebar now hides: ☰ in the top bar opens
  it over the page, and a pick in it, a tap beside it or Esc closes it; a card opens over the board, the whole width.
  Closed, the panel is out of the way of Tab too — the focus no longer goes into it unseen.
- **A long link or line in a comment wraps** instead of running past the edge of the card, where it was cut off unread.
- **The session of a chat is chosen in the chat's own style** — a quiet chip with a chevron, like the model in the
  field, and its list the chat's menu with a check by the session shown.
- **A session picked in a chat that does not load says so.** The chip named the session picked while the chat, and its
  field, stayed on the other one, with no word; the list now goes back to the session shown and the chat says why.
- **A command of the chat runs as its block says.** Typed into the zsh of a Mac's Terminal, a block was read by zsh: a
  `# comment` ran as a command or became the arguments of the one before it (`rm -f x # old log` removed `old` and
  `log`), a `!` in a string failed, and a ```bash block split its words the zsh way. The block now goes whole to the
  shell it names (bash, or zsh for a ```zsh block). A block longer than the board runs has no Run button.
- **Continue, once.** A Claude of the board killed outright (SIGKILL) read "Finished" and folded away instead of
  "Session interrupted" with Continue; two Continues of one session from two of its cards at once started it twice
  (the second failed, or stopped the first); and Continue took a task the session never held along with its own.
- **The pictures of a message do not weigh on the board.** The ten pictures of one message, asked for together, each
  read and parsed the whole message — 400 MB of memory for 30 MB of pictures; the message is read once for them now.
  A WebP or JPEG thumbnail keeps its place before it decodes, as a PNG did (the next words no longer jump), and a wide
  thumbnail beside a tall one keeps its shape.
- **A question read off the screen keeps an option's description apart from its label** — at a narrow width a label
  that ended near the edge took the description in, and the "recommended" mark was lost — and keeps the lines of its
  text.
- **A chat spread over the window leaves the chats beside it where they were read.** In Safari the columns beside it
  jumped by a few lines as it went over the window.
- **Opened steps come into view.** "N steps" right over the chat's field opened under the edge, and the steps had to be
  scrolled to; the chat now scrolls along as the steps open, until the last of them is over the field (or the head of a
  long list is at the top).
- **Every question of Claude in the chat is a form.** A question whose request never reached the board (the board was
  restarted while it waited, or it waited past half an hour), and a permission Claude asks in its terminal, were the last
  rows of its screen — cut off at the top — with the keys 1 2 3. The chat now reads it off the screen and shows the same
  form as any question: the whole text, a row per option with its description, an answer of your own; a long one fades
  at its edge while there is more below.
- **The board away for a moment.** A refresh of the board while it did not answer left "Failed to fetch" uncaught —
  in the browser's console and, once the board was back, in Settings → Errors — and the list unread. The board now
  says "tasks did not load" by the title and reads them again once it answers, and a card the board reopens after a
  move no longer stacks "The board is not responding" over the window: it follows the move when the board is back.
- **A cleanup of leftover hooks no longer stops Claude's sessions of the board.** The board's hook for Claude's questions
  went on the command line of every Claude it started, so `pkill -f "kb hook permission"` (meant for leftover hooks)
  stopped all of them at once. The hook now goes to Claude as a file in the board's data folder. Other words of the
  command line (the task's key, the allowed `kb` commands) are still there — never stop processes by a pattern.
- **A command Claude Code moved to the background is background work.** A command that outruns its two minutes goes on
  in the background by itself, and a skill can run as a helper there; the chat now names such work over its field with
  the time it started, and a Claude done with its turn while only such commands run is said to wait for you — not
  «Claude works in the background…» over nothing.
- **The chat holds up under odd answers and a busy hand.** A long run of spaces in a heading, deep quotes or a line of
  brackets in Claude's answer no longer hangs the tab or blanks the chat, and a wide table scrolls instead of squeezing
  its words to a letter a line. Words the board could not deliver come back to the field of their own task, before
  anything typed since, even after you went to another task; a picture put to a message and sent at once goes with it;
  the light of a stopped Claude goes out after a failed look too, and a closed card stops asking the board. Words sent
  "Now" from the queue stay in the chat until Claude takes them, and the queue waits its two seconds after them.
- **The chat says why a message was not sent.** With too many messages already waiting for a busy Claude, the refusal
  flashed and went; it now stays under the chat, in words that say what is wrong, until the words are edited. A chat
  that could not load says so and tries again instead of "Loading…" for good, and background work Claude stopped
  itself no longer runs in the chat forever.
- **A chat column on a phone has a height of its own**, as the terminal has: it no longer grew to the whole
  conversation and opened at its first words.
- **⌘F in fields.** The search shortcut rebound to a bare letter no longer swallows that letter while typing in a
  field, and ⌘F opens the search from the chat's field too.
- **The first-run wizard.** A change of language no longer leaves the page one solid colour when the board does not
  answer; Back stands with its arrow on the edge of the words above it; and a failed check of the computer in the step
  Permissions says so with a button to check again, instead of the macOS row silently going.
- **A check of Review moves what passes to Done without asking again.** Its Claude moved the tasks with a loop, which
  the permission check of Claude Code sometimes refused, and the person had to say "move them yourself". The check now
  tells it to move each task with a command of its own — the one the board allows it.
- **A card left open while its task moves to another project follows it.** Moved from another tab or by `kb`, the
  task's open card went on showing its old key and no "Moved from"; it now opens again under the new key, with an edit
  in progress saved and a half-typed comment kept.
- **The answer field of Claude now → Terminals no longer lags.** With a few columns open, every letter typed laid out
  their screens of a thousand rows again; a key now costs what it costs with no screens at all.
- **Words typed to a task in Review that are not about it no longer leave it in Doing.** Typing into the terminal of a
  handed-in task sends it back to Doing, as before; once Claude's turn is over, a task it did not touch — no move, no
  note, no commit and no changed file in the project, an edited file git does not track yet included — goes back to
  Review by itself, with the time it had. So does one whose Claude moved on another of its tasks in that turn: the
  words were about that one. The card's timeline says which moves were made by typed words and which the board undid.
- **`kb` stops quietly when the reader of its output goes away** (`kb show KEY | head -1`), instead of printing a
  stack and exiting with the code that means "the board is not responding".
- **Claude now shows a Claude that put its task back to To do and waits for your answer.** An `ask` task goes back
  to To do with Claude's questions; its terminal waited at the prompt, and the section was empty. A task the person
  moved to To do afterwards does not count.
- **A terminal in Claude now → Terminals opens at its end, not at the start of the session.** A column widened its
  terminal's window on every opening of the section, and Claude Code then printed the whole conversation again from
  its first line. A column now only narrows a window its lines do not fit.
- **The background of symbols no longer fades out and back when the window is hidden.** The last frame stays, and
  the clouds go on from where they were once the window is back.
- The ✕ of a column in Claude now → Terminals is as tall as "Open in the card" beside it.
- **A task handed in stays in Review when you go on to the next one in the same terminal.** Words typed to a card's
  terminal send its task from Review back to Doing — and after a hand-in, words like "now take the next one" did that
  too: the finished task sat in Doing and kept its run in Claude now. When the same Claude takes another task into work
  without having touched this one since, it goes back to Review with the time it had — and the task Claude went on to
  is the one its card and Claude now say it works on.
- **Copying from a short terminal screen keeps the lines Claude ended apart.** On a fresh screen, where no text had
  reached the edge yet, the longest line was taken for the width of the window, and `git push` under
  `git commit -m "…"` was copied as part of it.
- **New task shows every task added last.** A task added from outside right after another (`kb add` in a batch) did not
  show under the form until something else happened on the board.
- **Handing in one of two tasks in work leaves Claude on the other.** A Claude with two tasks in Doing that handed one
  in was on no task at all: the card of the other did not say "working", and Claude now marked none of its tasks.
- **Text copied from a terminal is the text Claude wrote.** A selection on the screen of a card's Terminal tab or of
  a Terminals column used to copy the screen's rows: a command Claude laid out over three rows of a narrow window came
  with line breaks and indents inside it and broke in the shell. Now the rows the width broke go back together, the
  indent the whole selection shares goes, and lines Claude ended stay ended.
- **A Claude that waits for a command of its own no longer calls you.** When the turn that just ended started work in
  the background (a measurement, a build, a background agent) that is still running, the card and Claude now say
  "working in the background" and nothing rings: the end of that work wakes Claude by itself. A tunnel or a dev server
  left running does not count — Claude does not wait for those — and after two hours it calls you again.
- **Claude now no longer says "working" over runs whose tasks are all done.** Newer Claude Code marks a Claude at
  its prompt with commands still running in the background as `shell`, and the board took the unknown word for a
  turn in progress. Such a Claude now reads "working in the background" — on cards, in *Claude now* and in the
  card's *Terminal* tab — and a terminal whose tasks were all accepted closes again. A Claude with no task in work
  that has sat at its prompt for over two hours, a background command still running, leaves *Claude now* for
  *Claude done*: a command that long with no turn of Claude is a leftover, not work.
- **Terminals of the board that only wait no longer pile up.** A terminal whose tasks are all in Review (or put
  back), with its Claude idle at the prompt for six hours, now closes by itself, as one whose tasks were accepted
  does; a question on its screen or a command still running in the background keeps it. Forty such terminals,
  some ten days old, held 12 GB of a 16 GB Mac. The conversation stays: ↗ on the card picks it up again.
- **The tabs of a card stay on one line.** In a card 360 pixels wide *Claude's work* and its count, and
  *Terminal* and its dot, broke onto a second line. A count over 999 is written short (*1k*), and only the
  words of a tab give way, so the count and the dot always show.
- **A clicked card keeps its ring while it opens.** A board event arriving meanwhile (Claude moving cards) put the
  ring back on the card open before; and the answer to an earlier, slower click no longer replaces the last one.
- **Claude's screen on the Terminal tab follows its answer.** Pressing a key or sending an answer lets go of a
  selection on the screen, which used to hold the screen still; a mouse button pressed on the screen holds the
  redraw too, so a slow drag selects.
- **A question of a board's Claude always rings.** One that the page first heard of from its own refresh used to
  be taken as known and never rang; a line of Claude quoting a question's footer no longer reads as a question.
- **One run is never in *Claude now* and *Claude done* at once.** A manual task in work stands on its own in
  *Claude now* and no longer holds Claude's run there.
- **The Review column's ▶ wakes up after another tab made the check,** instead of staying dead until a refresh.
- **Settings:** the install command of Claude Code (and every command shown to be run) can be selected and
  copied; the effort list stays inside the Settings window; a stored effort level the board does not know is not
  sent; the advice for an API key names both places it comes from; *GitHub sync* says above its fields that the
  repository is made by you and that `gh` needs the `project` scope.
- **Settings → Claude Code tells the truth in more corners.** "The status line runs" is shown only for a recent
  reading while the status line goes through this board; a `KB_CLAUDE_DIR` pointing at a missing folder disables
  Connect instead of creating it; a `KB_CLAUDE_BIN` pointing nowhere is blamed on the variable; a Claude folder that is
  not writable no longer offers Connect or keeps a copy of settings.json on every try; a refusal is said once; losing
  the connection keeps the list on screen; and a double click on Connect no longer closes the confirmation.  Installing or refreshing a skill — from Settings → Skills, by an update, by `local-kanban skills` or the setup — no
  longer creates a missing `KB_CLAUDE_DIR` folder either. An update of a clone no longer logs that its own skill "did
  not come along".
- **Smaller fixes found while accepting this release.** A hook written by an earlier version of the board reads as
  "written by an earlier version — Connect brings it up to date", not as a board that moved. Duplicate on one of two
  open checks opens the other one instead of advising ▶, which that check would refuse. A tmux that does not answer in
  time no longer turns a fresh start of Claude into "session closed". An open card's status log keeps two moves made
  outside that end where they began. Answering the refusal of Send back keeps the reason you typed. Settings → Skills
  says a refusal in the board's words, not the server's.
- **Settings → Skills names the right folder.** It used to say the skills live in `~/.claude/skills` even when the
  board reads them from `KB_CLAUDE_DIR` or `CLAUDE_CONFIG_DIR`; it now shows the folder it really uses and where that
  comes from, as Settings → Claude Code does.
- **`local-kanban hooks` and `local-kanban skills` keep their copies with the right board.** Run from a terminal,
  they kept the copy of the file they replaced in the data folder of their own process, so a board with its data
  elsewhere never showed it under Backups. They now ask the running board where its data is; when it does not
  answer, they write nothing unless you name the folder with `--data <dir>`.
- **A refusal of the board is said in its words, everywhere.** On a task deleted in another tab, removing a
  link, adding a checklist item, deleting a comment, Send back, Accept and ▶ now say the task is gone and close
  its card, instead of failing without a word. An edit of an open task the board fails or refuses is said in the
  card — a failure waits behind "not saved" and is sent again — instead of being lost. Settings, the project
  wizard, the project's page and Chaos say why something was refused in the board's language.
- **An image too large for the board is said to be too large in Safari too.** Pasting an image over 6 MB
  into a card, a comment or Chaos said "no connection to the board" in Safari about half the time; the board
  now checks the size before sending and says the image is larger than it takes.
- **An open card's status log follows a move made elsewhere.** When a task is moved by `kb mv`, in another
  tab or by starting Claude, the open card's status log now shows the new line at once, not only after the card
  is opened again.
- **Uploading a backup can no longer delete files.** A JSON request to the upload route could name any
  file — the board's own database included — and the board deleted it; the route now takes only the uploaded
  file itself, and a broken upload no longer blocks every later one. A board opened from a backup no longer
  writes to the live board's files, takes no snapshots of itself and cannot update the code it shares with
  the live board, and copying its attachments no longer freezes the live board for half a second.
- **A snapshot is never rotated away right after it is taken.** From schema version 10 on, the snapshot
  taken before a migration would have been deleted at once; west of Greenwich, *Back up now* right after the
  update deleted the snapshot it had just taken; saving the `deploy` skill removed the snapshots
  of `deploy-tickets` and its own; two saves within a second lost the previous text. Unfinished snapshot
  files left by a crash are cleaned up at start, and snapshot names and the times under Backups follow the
  local clock instead of UTC — the snapshot taken before a migration, the one made with *Back up now* and the
  copies kept when a skill or a project's CLAUDE.md is saved included, with the UTC offset in their names so that older names still sort
  in their true order.
- **The card keeps your edits, and only yours.** An edit made elsewhere while the cursor sat in a field is
  no longer undone by the next click in the card; a card left open on the dashboard or in Chaos follows the
  task; a closed card is never saved again as a copy (Cmd+Enter with the sidebar pinned, or a retry after
  the server came back), and an edit made while the server was down reaches it even after the card is
  closed. Project settings and the CLAUDE.md and skill editors ask before dropping typed text, Save sends
  only what changed, the board's keys stay out of open windows, and an open tab picks up a new version of
  the page's markup or styles.
- **A big board stays light.** The card loads Claude's work only on its tab, and a session with dozens of
  helper agents no longer re-reads all their transcripts on every update (with 30 helpers that kept the
  board above its memory limit). A note, a link or an attachment changes one card instead of reloading the
  whole list in every tab, a burst of events is drawn once, the dashboard stops recounting on events that
  change none of its numbers, and the endless pulses no longer redraw the page every frame (reduced motion
  stops them). The list of all projects no longer comes back empty from 16,384 tasks on.
- **Search shows the answer to what you typed.** A slow answer to an earlier, shorter query could stay on
  the board as the result; now only the latest request counts, typing waits a little longer before asking,
  and a task that arrives while a search is on is filtered like the rest.
- **`kb` and the API refuse malformed input instead of acting on it.** A task key went into the address
  as is (`kb note '../backups?' …` took a database snapshot), `kb constructor` crashed, a foreign service on
  `KB_URL` passed for the board, `prefix: null` renamed every task to `NULL-N`, and a slug with `../` wrote
  outside the data folder. Errors now name the field. The error log no longer loses its history to one
  failure repeated on many tasks; `local-kanban skills` refreshes the skills in place and keeps a copy of
  what it replaces; `--data=~/x` lands in the home folder; deleting the demo closes its GitHub issues.
- **Claude's exit code shows on Linux too.** tmux there sometimes missed the signal of Claude's exit, and
  the card said only "Claude has finished"; the board now reminds tmux once.
- **A task you have just made is a whole card at once.** A task made with **+** had no ▶ in its card, no
  *+ link*, no status log and no *Cancelled* among its statuses until the card was closed and opened again —
  so it could not be started in Claude right away. Now they are there as soon as the task is made.
- **Smaller interface fixes.** A right-click change or a comment made while the server is down waits for it
  instead of failing silently; the Russian board writes sizes and hours with a decimal comma, names the
  Local and Other sections in Russian and puts the word for "subfolders" in the right form for the number.
- **Claude inside the board: a language, long replies, an honest start.** A board run by pm2 has no
  `LANG`, so its Claude worked in the C locale — `grep -i` missed capital Cyrillic, `wc -m` counted bytes;
  it now gets the person's language or a UTF-8 one. A reply or a comment longer than about 8 000 Cyrillic
  letters failed with "command too long"; text now reaches Claude whole up to the promised 14 336
  characters, and a key name in a reply (`C-c`) is typed, not pressed. A prompt longer than tmux takes is
  refused before anything starts, and *auto* takes it to the app or the Terminal instead. A project whose
  folder is not on this computer no longer starts Claude in the home folder from the Terminal or the app —
  the board offers to make the folder, as it already did inside the board. The *working* badge no longer
  trusts a process id that another program got later. The Terminal tab looks at the screen only after the
  last look came back, with one call to tmux, and is sent the screen only when it changed.
- **A retried GitHub issue no longer comes twice.** When the answer to creating an issue was lost, the
  retry looked for the issue through GitHub's search, which indexes minutes late — exactly when the retry
  comes — and made a second one. It now looks among the newest issues first, and searches only after that.
- **▶ right after the last Claude of the board was stopped no longer fails.** tmux was still shutting down
  its server, and the start got "server exited unexpectedly"; the board now tries such a start once more.
- **The board always starts on matching page and code.** Safari, and the board installed from it as an app,
  reopens a window and goes back and forward from its cache without asking the board — telling it to check
  first does not stop that. After an update this could pair the new code with the old page: the board stayed
  on its loading placeholder and then came up empty, and *New task* did nothing. The page, its code and its
  styles are no longer kept in the browser cache, the installed app takes the page from the board every time,
  and should a script of the board still fail while the board loads, the page reloads once by itself.
- **Found while these fixes were accepted.** One helper transcript the board cannot read no longer turns the
  whole *Claude's work* tab into an error; a board whose first load failed (the server answered 500 for a
  moment) tries again instead of staying empty until the page is reloaded; `kb lbl` against a board that was
  updated but not restarted says to restart it instead of printing labels it did not set; and `local-kanban
  skills` names a skill it could not refresh and exits with code 1. Twenty requests for *What's new* or the
  update check that arrive together share one trip to GitHub instead of twenty (and one run of `gh` when the
  anonymous request is refused); a `kb take` of an older version can no longer take a task another session
  already has in *Prep* — it is told the task is taken, and the kanban skill tells Claude to leave such a task
  and say so; and a page whose code failed to download at start
  reloads once instead of staying empty.
- **The Update button on a clone installs the dependencies too.** It ran `git pull` and nothing else, so
  a release that changed the dependencies restarted the board on new code with the old packages. It
  now runs `npm install` after the pull, the way `npm run update` always has. A clone that picks up
  this release with a plain `git pull` (which is all the button did until now) keeps working on its old
  packages until `npm install` runs.
- **Claude's work keeps the step that handed a task in.** Status changes are stored to the second, so a `kb
  review` run within the same second as the move fell out of the task's feed, or showed up in the next
  task's. That second now belongs to the task handed in, and a step whose answer came after the move shows
  how long it took and whether it failed.
- A card that Claude takes while it is open now locks right away (also in Preparation) and hides “+ label”,
  “ask?”, “+ link” and the link and checklist delete buttons; when the task leaves work the card unlocks
  with those buttons back and shows what Claude changed meanwhile — no need to reopen it. Before, a label
  picked on such a card showed up but was never saved, and taking `noclaude` off a task in work was lost. The card's ⋯ menu and the link picker, if open at that moment, close too.
- When the server does not answer while you switch projects or search, the board keeps the project and the
  tasks you had, tells you so (“project did not open”, “search did not reach the server” next to the title),
  and finishes the switch or the search by itself once the connection is back — a click on the notice
  retries at once. When the server answers with an error instead, the board says so and tries again by itself in a few seconds; the first load of a board that fails shows its columns with a note and a “Try now” button, and a switch that takes a moment shows the loading skeleton instead of the previous project's cards under the new title. Before, the board went blank and lost the selected project without a word.
- A change made with the right click on a task that was deleted elsewhere now says “This task no longer
  exists” in the board's language and takes the leftover card off the board, instead of “Not saved: task not
  found”.
- The rest of the task card speaks the board's language too. The link picker, typing into Claude's
  terminal, starting Claude and pasting an image say why the server refused in the board's words instead
  of its English (“the task to link to was not found”, “limit of attachments per task: 30”); pinning,
  cancelling or deleting a task that was deleted elsewhere says so and clears the leftover card instead
  of doing nothing. A server error now says the board answered with an error and that the details are
  under Settings → Errors, rather than that the board is not responding.
- A comment sent while the server is down now stays in the card's comments as “not sent — goes out once the
  connection is back” (with × to drop it) and is sent once when the connection returns; sending the same
  text again while it waits no longer makes a duplicate.
- The “working” dot of the card's Terminal tab goes out when Claude exits — no need to reopen the card, and also when the task was still in To do or Backlog.
- A new task the server does not create says why at the top of its form — no connection, a server error
  (it is retried from the “not saved” badge or with your next change) or a refusal in the board's words —
  instead of failing silently, and typing on no longer sends a request for every letter.
- **Claude is never started on a task you do by hand.** ▶ and the copy button on *To do* put every task of the
  column into Claude's job, the ones labelled `noclaude` too, and `kb take` could pick such a task. Now both buttons
  leave manual tasks out (a column of manual tasks only has neither), the board refuses to start Claude on one —
  also from a tab that has not heard of the label yet, which then says why and loses its ▶ — and `kb take` passes
  manual tasks by.
- **The button that archives a project says so on the Russian board.** It read as the name of the settings
  section: the Russian dictionary held the word twice and the second translation won without a word. Each
  word is in the dictionary once now (the English name of that settings section is *Archived*), and a test
  keeps it that way.
- **The status line's limits reach a board that reads the request a moment late.** `kb statusline` hung up the
  moment its request was out, and a board with an asynchronous step before reading it lost the reading. kb now
  waits up to 300 ms for the board's answer — a board that never answers still costs the status line a moment,
  not a second.
- **A second open check is no longer made silently.** Putting the check label on a task, or sending the report of
  an earlier check back to To do, while the project has an open check goes through and says so — on the page and in
  `kb`. *Duplicate* on the open check itself says it is still open and how to start it again, instead of opening the
  same card, and no longer lands in Settings → Errors; a check in Backlog can be copied.
- **A Claude that exited at once, or a start nobody sent in the Claude app, no longer reads as starting or
  checking.** A Claude started inside the board that exited right away (not signed in, crashed) showed *starting*
  for two minutes; now its card says *session closed* at once. A task or a check started in the Claude app says
  *waiting to start in the app* until someone presses Enter there, and *session closed* after two hours — the
  Claude review section used to say *Claude is checking* for good.
- **Claude started in the Terminal or the Claude app works with the board that started it.** Its `kb` went to
  the board on the default port (3100), so on a board on another port Claude moved tasks on a different board.
  The Terminal command now carries the board's address, and for the Claude app (and a copied prompt) the prompt
  ends with a line naming it — only when the board is not on the default port.

### Security

- **`@fastify/static` 10.1.3 closes two advisories** — a path-traversal bypass of route guards
  (GHSA-83w8-p2f5-377r) and a bypass of `allowedPath` (GHSA-8pvw-jcv7-9cmj). The board was not
  exposed to either, because it protects every request the same way rather than individual static
  files, but `npm audit` reported them to everyone who installed the package. The version is pinned
  on purpose: later releases need Node 22.12 or newer, and the board still supports all of Node 22.

## [1.15.0]

### Added

- **A column can be sorted by task number.** Every column with more than one card has a sort button
  in its header: by priority and your own order (as before), by number with the newest first, or by
  number with the oldest first. Pinned cards stay on top either way. The choice is remembered per
  board and column in this browser and changes only what you see: the order `kb take` follows stays
  the same. While a column is sorted by number its cards cannot be reordered by hand, and a card
  dragged in from another column lands where its number puts it.

### Fixed

- **`kb link` refuses a link type it does not know, whatever the word.** `kb link A B constructor` (or
  `toString`) was taken for a valid type, because every object answers for those names, and the
  board quietly made the link `related`. Now it is refused with exit code 2 before anything is
  written, like any other unknown word.

## [1.14.1]

### Changed

- **An `ask` task goes back to To do when the discussion ends without the work.** The skill told
  Claude to ask and wait, but not what comes after: a task that was only discussed went to Review,
  where a bare proposal reads as delivered, or stayed in Prep, a column the human cannot move a card
  out of. Now Claude leaves the outcome of the discussion as a note and moves the card back to To do;
  Review is only for work that was actually done.

## [1.14.0]

### Added

- **`kb` shows how tasks are linked, and can make a sub-task.** The board keeps parents, sub-tasks and
  related tasks, but `kb show` and `kb take` printed none of them, so Claude could not know that two
  tasks were meant to go together. Both commands now print one line per link: `↑ parent`,
  `↓ subtask`, `↔ related`, with the key, title and status. `kb link A B child` makes B a sub-task
  of A, `kb link A B parent` makes it A's parent; without a third word the link is related, as before.
- **`kb info` prints the project's description and its documents.** The description is where owners
  keep the context for work, and it never reached Claude. A `docs:` line now lists the documents to
  read before a task (`CLAUDE.md`, `README.md`, `ARCHITECTURE.md` …) and says so plainly when there is
  no `CLAUDE.md` or the project folder is not on this machine.
- **`kb check <key> <n>` / `kb uncheck` tick checklist items from the CLI.** Claude could read the
  checklist but not tick it, so at acceptance every box was empty and the human could not tell what
  of the list was done. The item is addressed by its number in the order `kb show` prints it.
- **`KB_GH_BIN` points the board at `gh` when it lives somewhere unusual.** The board looks for `gh`
  in the usual install locations (Homebrew, `/usr/bin`, `~/.local/bin`) and then on `PATH`; a copy
  anywhere else can now be named explicitly.

### Fixed

- **`kb` no longer loses what the human wrote in a card.** `kb take` printed only the latest note
  from the human, so a send-back followed by a second note lost the first; `kb show` printed the last
  five comments of any author, and Claude's own notes plus the commit stats pushed the human's note
  out without a word. Both now print every note the human left since Claude's last report, each
  comment carries its date and time, and anything left out is counted ("… 3 more comments not
  printed") instead of dropped silently.
- **A commit stat is no longer printed as the human speaking.** `kb show` marked everything that was
  not Claude's with 👤, including the commit stat the board attaches on its own. It is marked ⎇ now.
- **`kb take` tells a blocked To do from an empty one.** When every card in To do was blocked it
  answered a bare `empty`, and Claude reported an empty column while the human could see cards in
  it. It now says `empty (2 blocked)`; `kb next` does the same.
- **`kb take` and `kb show` print the issue the same way** — `issue: #42 <link>`. One printed the
  number and the other the link.
- **The checklist now reaches Claude.** A card's checklist is shown on the board right under the
  description, but `kb show` and `kb take` printed everything about the task except it — the CLI is
  the only channel Claude has, so the items simply did not exist for it: a card with three checklist
  items and an empty description arrived as a bare title. Both commands now print the items as
  `- [ ]` / `- [x]` lines, in the board's order, right after the description.

## [1.13.0]

### Added

- **The board tells you what's new.** The changelog was written for every release and shown nowhere:
  the only place to read it was the package page on npm. The About screen now has a "What's new"
  block. For the version you are running it reads the `CHANGELOG.md` that ships next to the code, so
  it needs no network at all. When an update is waiting, it shows the notes of the version you do
  *not* have yet, read from that release's page on GitHub — the decision to update is made on what
  actually changed, not on a version number. Releases now get such a page: publishing puts the
  changelog section for that version into it, which also gives the npm page real releases to link to.

### Fixed

- **A folder the board is not allowed to read is no longer reported as missing.** The Check button
  next to the project folder answered every refusal the same way — "no such folder on this computer" —
  whether the folder was absent, was a file, or simply could not be read. For a folder without
  permissions that is plainly untrue: it is there, the board was not let in, and the answer sent you
  off to fix a path that was already correct. Each case now says what actually happened, and a check
  that could not reach the server says so instead of blaming the path.

## [1.12.0]

### Added

- **The wizard answers before you press Create.** Three checks with one result line each: the ssh host
  ("Check" runs a real connection, and says *why* it failed — unknown host, refused key, unknown host
  key, no answer — rather than handing you ssh's stderr), the project folder, and the project key,
  whose availability now shows while you type instead of arriving as a refusal after Create. The key
  line also shows the task prefix you are going to get, which until now you first saw on your first
  task and could never change.

- **A third way to add a project: let Claude do it.** Half of the form (ssh host, server path, pm2,
  deploy skill) needs you to go and look something up, and Claude is right there and can look. The
  first step now offers a ready prompt to copy: it makes Claude inspect the folder, verify the ssh
  access itself, ask you one question at a time, and register the project when you have both agreed.

- **The git clone mode says where the repository lands.** It was called "clone from a git URL…" and
  said nothing else. It now shows the actual destination path on this computer, and the two facts you
  could not have guessed: an existing folder is refused rather than overwritten, and git credentials
  are never asked for here.

## [1.11.0]

### Fixed

- **Where the SSH key or password goes: nowhere, and that is now said out loud.** The fields told
  you access "comes from your `~/.ssh/config`", which answers where it comes from and not what you
  are supposed to do. The board holds no credentials at all: it runs `ssh <host>`, and a password
  cannot work even in principle, because it connects without prompts — key-based access is required.
  The short test is in the hint now: if `ssh <host>` works in your terminal, it works here. The same
  paragraph went into the security section of both READMEs, which said nothing about ssh until now.
  The server fields also got a heading of their own, and the host field shows an address as an
  example rather than a description of one.

- **The server fields say which side they are about.** "SSH host" and "Server path" gave no hint of
  whether they meant this computer or the machine you deploy to — a fair question, and the owner of
  the board asked it. A line above the group now answers it, and the ssh field says the part you
  cannot guess: the user, port and key come from your own `~/.ssh/config`, and the board stores no
  secrets. Leaving them empty is a normal state — the project simply stays local. On a Russian board
  the ssh placeholder used to stay in English, and the server path field on the project page had no
  example at all.

## [1.10.0]

### Fixed

- **The deploy skill list only offers deploy skills.** On the project settings page it listed
  everything in your skills folder — on a real board that is ten entries when one of them is an
  actual deploy skill, and the board's own skill sits among them, offered as a way to deploy your
  project. The wizard already filtered this; the project page did not, because the rule lived in
  the wizard's file. Now both ask the same function. A skill your project already points at stays
  in the list even if it falls outside the filter, so saving never quietly clears the field.

- **A dropdown opens where there is room.** The custom select always opened downward with a fixed
  height, so near the bottom of a dialog its list ran past the dialog and under the buttons. It now
  measures the space first — against the dialog, not just the window — and flips up when it has to.
  The rule already existed for the picker menus; there is one copy of it now instead of one and a
  half.

- **The Add project form is not cut off.** Its body was capped at 62% of the window height while
  the dialog itself used far less, so on a 800px-tall window the last field lost 37 pixels and the
  hint under it never showed at all. The cap now follows the space actually available.

- **Picking the project folder starts with the folder, not with a list.** The step opened with
  every unregistered folder in your projects directory — 31 entries on a real machine, eight of
  them visible — and the path field and "Choose…" button were hidden behind an entry near the
  bottom of that same list. The list now holds only the three modes (a folder, no folder, clone
  from git), and the folder one — the default — shows the path field and the button straight away.
  The system dialog no longer opens by itself just because you reached the step. Your project
  folders are still one click away: the built-in browser opens on that very directory.

## [1.9.0]

### Added

- **You can pick the project folder instead of typing it.** The wizard offered a list of folders
  from one directory and, past that, a text field where a typo produced a project pointing nowhere.
  There is now a "Choose…" button: it opens the real system folder dialog, and where there isn't one
  (a server with no desktop, another OS) the board falls back to its own folder browser. Either way
  the path is checked before the project is created. A browser page cannot read an absolute path by
  itself, so the board's own server does the looking.

- **The sync section explains itself now.** It used to be two empty fields and no context: what
  this does, whether it applies to one project or the whole board, and what exactly ends up on
  GitHub. It now says all of it before you type anything, including the part that matters most:
  the repository holds the issues for the whole board, you should make it private, and task titles,
  descriptions and comments are copied there in full. That is the only feature here that sends
  anything off your machine, so it says so out loud.

- **The deploy skill is picked from a list now.** The wizard asked for a "custom deploy skill" as
  free text, which assumes you already know which skills you have, and an empty field quietly turned
  into the shared `deploy` skill: nobody chose it, it was simply assigned. The list shows deploy
  skills rather than everything in your skills folder, says where to make your own, and "not set"
  stays a real answer, because a project without a deploy is a normal project.

### Fixed

- **The folder dropdown was drawn by the operating system**, which ignores everything about how the
  rest of the board looks. It now uses the same control as every other dropdown here. The field was
  also labelled "Project key", the same words as the task-key field two rows above it.

- **A failed update now ends with the command to run.** The most common way an update fails is that
  the global package directory is not writable, and there is nothing the board can do about that
  by itself — only you, in a terminal, can. It used to answer with the path to an npm debug log,
  because it picked the longest line npm marked as an error, and npm's longest lines are its own
  stack frames and file paths. It now names the cause and shows the exact command it just tried,
  with the same `--prefix`, so the one you run updates the copy that is actually running.

- **The update dialog says what happens to your work.** Two things you cannot check for yourself:
  your tasks are untouched, because they live in the data directory apart from the code, and — for
  an npm install — the Claude Code skills are a *copy*, so after updating they need
  `local-kanban skills`. Without that Claude keeps reading the instructions from the old version
  and gives no sign of it.

- **The sync section links to the README**, where the same thing is written out in more detail.

## [1.8.4]

### Changed

- **Releases publish themselves again, and carry provenance.** Publishing is now authorised by a
  trusted publisher — npm trusts this repository's release workflow directly — instead of a token
  that the account's two-factor policy would not accept anyway. Every version from here on is signed
  by the build that produced it, which anyone can check on the package page; 1.6.3 through 1.8.3 were
  published by hand and carry no such signature.

## [1.8.3]

### Added

- **A roadmap at the end of both READMEs.** More interface languages, working with Codex the way it
  works with Claude Code, plugins with declared permissions instead of blind trust, a board a team
  can share over a local network, and attaching a CLI straight to a card. Plans, not promises —
  written down so the direction is visible to anyone deciding whether to build on this.

## [1.8.2]

### Added

- **The README now opens with how you actually use the thing.** It described what the board is and
  how to install it, and left the loop itself — the part someone came for — to be inferred: write
  the task in *Backlog*, move it to *To do*, copy that column as a job for Claude, and let it work
  until it stops at *Review* for you to accept. Including the trick that makes it pay off: let
  *Review* pile up, then ask for the whole column to be checked in one pass, from a fresh chat.

### Fixed

- **The update line no longer draws over itself.** With both a status and a button on the right,
  the two together were wider than the row had left, and the status — which was not allowed to
  shrink — spilled leftwards across the label: 104 pixels of one text printed on top of another.
  The status and the button now wrap onto their own line, and the command hint next to the button
  is gone, because the button is the action and two instructions for one thing only made the row
  longer.
- **Pressing the button now visibly does something.** `npm install -g` takes tens of seconds and
  says nothing while it runs, so the board looked frozen and inviting a second click. It counts
  out loud instead — *installing… 12s*, then *restarting… 3s* — and the button reads *Updating…*
  until the page reloads itself.

## [1.8.1]

### Changed

- **The documentation caught up with the update button.** `POST /api/update` was missing from
  `docs/API.md` altogether, and both READMEs still sent you to a terminal for something the board
  now does itself. The API reference explains what the endpoint answers and — the part that is easy
  to get wrong — that `update_available: null` means the check could not be made, not that you are
  up to date. `ARCHITECTURE.md` states the rule behind it: the board never promises a restart it
  cannot perform.

## [1.8.0]

### Added

- **The board updates itself from a button.** Until now the update line told you a command to type
  in a terminal; now there is a button next to it, and it appears only when an update is actually
  waiting. It installs the update the way the board was installed — `git pull` for a clone,
  `npm install -g` for a package — and installs it into the copy that is running, not into whatever
  prefix the machine happens to prefer. Under pm2 the board then restarts itself and the tab
  reloads on its own; started by hand, it says plainly that the update is in place and the board
  has to be started again, because promising a restart nobody can perform would leave you looking
  at a dead tab.

## [1.7.1]

### Fixed

- **The update check asked the registry in a format it answers with an error.** The request carried
  npm's abbreviated media type, which is meant for a package document and not for the `/latest`
  address: the registry replies 406 with an empty body, so an npm install was told "cannot check"
  again. A cached response let it through often enough to look like a flaky network — it was not.
  Caught on a clean install of 1.7.0 minutes after it was published.

## [1.7.0]

### Added

- **An npm install can finally see that a new version is out.** The update check asked git for the
  current commit, and a package installed from npm has no git repository — so it answered "cannot
  check" every single time, and the About section showed the date of a frontend file instead of a
  version number. The board now reports its own version and compares it against the registry:
  *update available 1.6.3 → 1.7.0*, next to the command that installs it. A clone keeps the git
  check, which says more: the commit, the tag, and how many commits are waiting for a release.

### Fixed

- **A failed update check no longer sticks around for an hour.** The answer was cached for an hour
  whether it worked or not, so a single lost request kept the board saying "cannot check" long after
  the network came back. A failure is now remembered for a minute; a real answer still for an hour.

## [1.6.3]

### Changed

- **A commercial invoice is asked for by email now, not through a public issue.** Wanting to pay
  for something you use at work is not a thing anyone should have to announce in public, and the
  first line of an invoice request is the company name. `docs/COMMERCIAL.md` names an address
  instead, and asks for the two things an invoice needs: the country and how many people use the
  board.

### Fixed

- **The install section described a question the wizard never asks.** It said the wizard asks
  *where* to put the Claude Code skills. There is no choice of place — the path is
  `~/.claude/skills` — and the question is whether to install them at all; it installs two, the
  board's own skill and the deploy one. Both READMEs now describe what the program actually does.

## [1.6.2]

### Added

- **A quiet ask for companies that use the board at work.** It stays MIT-licensed and free for
  everyone — nothing is switched off, nothing to activate, and it still never contacts a server —
  but if the board earns you money, $12 a year per person keeps it maintained. The ask is one line
  in the README and one row in Settings → About, both pointing at `docs/COMMERCIAL.md`, which spells
  out what this is and, just as plainly, what it is not: not a licence purchase, not a support
  contract, and not a subscription that switches anything off when it lapses.

### Fixed

- **The bulk-registration script sent you to a file that does not exist.** `contrib/bootstrap.js`
  loads a registry of projects from `contrib/seed-projects.json`, and when that file was missing it
  told you to run `contrib/seed-from-panel.js` first — a script that is git-ignored and has never
  been in the repository, as `contrib/README.md` says a few lines below. The directory is not part
  of the published package, but it is part of the repository, so the first thing a reader of a fresh
  clone was told to do could not be done at all. The message now names
  `contrib/seed-projects.example.json`, which sits right next to the script: copy it, edit it, run
  the script. Only `slug` and `name` are required, and a test keeps the example in step with the
  fields the script actually reads — an example promising fields that are silently ignored is the
  same broken promise, only quieter.

## [1.6.1]

### Fixed

- **The buttons in the skills section could act on the previous skill instead of the one on
  screen.** Creating a skill left two requests in flight — the section re-renders and opens its
  first row, then the code opens the new skill — and whichever answered last owned the panel's
  state. In that gap the page showed the new skill while "load the shared version" fetched the text
  of another one and "delete" would have removed it: with the guard deliberately switched off, 19
  frames out of 30 showed one skill's row above another skill's path. An answer that is no longer
  the current one is now discarded, the section opens exactly one skill instead of two, and the
  buttons stay disabled until its text has arrived.

## [1.6.0]

### Changed

- **The skills section lists only what the board is about.** A skills directory holds every skill
  its owner uses in Claude Code — most of it has nothing to do with the board — and burying the rest
  behind a "show the others" line was not enough: the section is about deploy instructions. It now
  shows the board's own skill and deploy skills: the shared one, the ones registered projects use,
  and the ones created here. The full list is still where it is needed — in the deploy-skill picker
  on the project page.
- **A skill created from the board no longer disappears from the list.** Nothing on disk tells a
  skill created here apart from the rest of the library, so the board now remembers its own.
  Entering the name of a skill that already exists adopts it into the list instead of failing —
  without that, a skill outside those groups could be neither opened nor deleted.

### Added

- **A skill can be deleted from the settings**, with the resolved path in the confirmation and a
  snapshot of the file kept beforehand. **A skill that is a symlink loses only the link** — the file
  it points to usually lives in another repository and is left alone; the dialog says so before you
  press the button, not after.

### Fixed

- **"Load the shared version" no longer answers with a raw error on your own skill.** The board has
  no shared version of a skill it does not ship, so the button is simply disabled there and says why.

## [1.5.0]

### Added

- **The deploy skill of a project is picked from a list instead of typed in.** The field took a
  free-form name, so a typo left the project without a deploy and said nothing; now it offers the
  skills the board actually found, plus "not set", plus a line explaining what the field is for. A
  name that is stored but not installed stays in the list, marked as such, rather than quietly
  disappearing on the next save.
- **A skill can be created from the settings.** "New skill" asks for a name and writes the file; if
  this package ships a skill under that name, the file starts as that shared version — so taking the
  ready-made one and starting your own are the same action with a different name. The new skill
  shows up in the project's deploy-skill list immediately.
- **The project's own notes and its skill are editable where they are shown.** The viewer opened
  from project settings was deliberately read-only, which was the wrong call: a rule is worked out
  while doing a task, and writing it into `CLAUDE.md` belongs right there. Saving takes the same
  lock as a skill — it confirms the resolved path, the server checks that path itself, and the
  previous contents are snapshotted into the data directory first.

### Changed

- **The skills list is grouped.** A skills directory holds everything its owner uses in Claude Code,
  most of it unrelated to the board. The section now leads with the board's own skill and the deploy
  skills of registered projects, and keeps the rest behind a "other Claude skills" line.

## [1.4.1]

### Fixed

- **A skill used by a dozen projects broke its own row in the new "Skills" section.** The label
  listed every project by name, so it wrapped onto a second line and pushed the size and date off
  the right edge of the list. Past two projects the label now counts them ("used by 12 projects")
  and the names move into the tooltip.

## [1.4.0]

### Added

- **Project settings are a page inside the project instead of a popup at the cursor.** The popup
  was 250 pixels wide with its own scrollbar and a collapsible "paths & deploy" block, and it had
  long stopped fitting what belongs there — seven registry fields. The same places open it (the
  `⋯` button in the topbar, a right-click on a board in the sidebar); clicking `⋯` again, or Esc,
  goes back to the board.
- **The page shows what Claude reads before it starts working:** the project's own `CLAUDE.md`
  (plus `README.md` and the like when they exist) and the deploy skill it uses — the shared one or
  its own — with absolute paths, a copy button and a read-only viewer. A missing `CLAUDE.md` is
  listed too: that absence is worth knowing, since the agent will start the task without those
  notes.
- **A "Skills" section in the settings.** Skills are the instructions Claude actually reads, and
  they live outside the board, in `~/.claude/skills`; until now the board only wrote them once, at
  install time, and never mentioned them again. The section lists every skill it can find, says
  which projects use which, and shows the text of the selected one.
- **Loading the shared version of a skill and writing it to disk are two separate buttons.** A
  skill directory is often a symlink to a file in another repository — a customised copy somebody
  keeps deliberately — so a single "update" button would silently overwrite it. Loading only fills
  the editor and names the source (GitHub, or the copy that shipped with the package) and the
  language; saving is a second, explicit step that asks about the resolved path it is about to
  overwrite, and keeps a snapshot of the previous contents in the data directory first.

## [1.3.2]

### Fixed

- **The GitHub sync stopped as soon as a label differed only in capitalisation.** GitHub treats
  label names as case-insensitive; the board compared them exactly. A board whose repository
  already had, say, `NoClaude` while the palette asks for `noclaude` did not recognise it, tried to
  create it, and GitHub answered "a label with that name already exists" — which brought down the
  whole issue creation, so every task after that reported "the issue does not exist yet" and the
  error log filled up. Dropping `--force` in 1.3.0 is what exposed it: `--force` never complained
  about a label that was already there. A label that already exists is no longer treated as a
  failure at all, and a repository whose labels could not be listed is retried on the next
  operation instead of being written off until a restart.

## [1.3.1]

Three fixes found by testing the previous release rather than by using it — each one a place where
the 1.3.0 change was right in intent and incomplete in reach.

### Fixed

- **A board with its own data directory could not create a project folder.** Keeping an isolated
  instance out of the owner's live `~/claude-projects` (1.3.0) moved project folders next to the
  data directory — but nothing ever created that directory, so the first "create a folder" answered
  with an error and the feature simply did not work for anyone who chose a custom data directory
  during setup. The failure was also invisible: it never reached the error log.
- **The dashboard funnel still counted archived boards.** Archiving was made to remove a board from
  every card and every total, and it does — except for the bar chart of how many tasks sit at each
  stage, which was left counting the archived board's tasks. On one screen that put a set of
  consistent numbers next to one inconsistent one.
- **A deleted issue was retried instead of failing.** The list of GitHub answers that mean "this
  will never succeed" spelled the article one way, and GitHub writes it the other way for half the
  entries — so an issue that no longer exists was treated as a passing network problem and retried
  fifteen times before giving up.

## [1.3.0]

A full audit of the board — stability, performance and error handling — went through every part of
it, and this release is the answer to it. The headline is the tab you leave open all day: it used
to go quiet without ever saying so.

### Added

- **The board tells you when a change did not save.** With the server down, the board used to stay
  silent: a dragged card slid into its new column and drifted back on its own two seconds later, a
  description you typed went nowhere, and the title of a new task vanished without a trace — the
  only record was a failed request in the console, because the error report itself goes to the
  server that is down. A change that cannot reach the server now rolls back, lights up a "not
  saved" badge in the header, and is sent again as soon as the connection returns.
- **Archived boards can be brought back.** Archiving hid a board from the sidebar and there was no
  way back short of a raw HTTP request. Settings now has an Archive section listing what was
  archived, with a button to restore it.
- **`local-kanban skills` refreshes the Claude Code skills.** Installed from npm they were copied
  once and then never updated by anything, so the board moved forward while the instructions the
  agent reads stayed on an older version.
- **Search covers the whole description.** It only ever looked at the first 180 characters, so a
  word further in was simply not found — no result, no error, no hint that the search was partial.

### Fixed

- **A tab that lost its event stream never noticed.** The check for a dead stream ran only when the
  window was hidden or refocused — and the board is normally visible and focused all day, so
  neither ever happened. After a laptop sleep or a network timeout the board froze: finished tasks
  did not appear, and anything done from the frozen board overwrote what had happened meanwhile.
  Liveness is now checked on a timer, and a stream that recovers on its own catches up on what it
  missed.
- **A burst of events left only the last one.** Five tasks created in a row showed up as one; five
  tasks moved in a row left four cards sitting in their old column — which is worse, because a
  missing card is visible and a card in the wrong column is not. Every event in a burst is now
  applied.
- **The task panel overwrote changes made elsewhere.** It sent every field it held on any edit,
  while only refreshing the status, so setting a priority or a label from the CLI or another tab
  was rolled back within half a second. It now sends only what actually changed, shows what came
  from elsewhere, and closes itself if the task was deleted.
- **Every board render held on to the previous one.** Memory grew with each redraw for as long as
  the tab stayed on one board — tens of megabytes over a day of activity.
- **A task forgotten in a working column counted the whole time as work.** One task left in
  "doing" over a weekend turned the week's work time into fiction. A single stretch is now capped,
  and a capped number is marked as approximate instead of pretending to be exact.
- **Two snapshots taken in the same second destroyed each other,** leaving a zero-byte file under
  the final name that was listed, downloadable and counted as a backup.
- **A failing daily backup said nothing.** With the snapshot directory unwritable the board started
  normally, took no snapshots, logged nothing, and tried again six hours later. The Backups section
  now shows the last success and the last failure, and a failure is retried in minutes.
- **Attachments were in no backup at all.** Images are now mirrored alongside the snapshots and
  restored into the preview board.
- **A board opened from a backup could outlive the one that started it,** holding a port and
  serving a full copy of every task with nothing left to stop it.
- **Uploading a backup buffered the whole file in memory** and lifted the size limit from every
  other route as a side effect. The body is now streamed to disk and the limit is scoped.
- **The error log washed itself out.** A few hundred identical broken requests erased the whole
  ring, real failures included; repeats are now collapsed with a counter. A genuine server failure
  also reaches the process log — previously its only copy was the table, and if that table was the
  problem, the board pointed at a section that answered with the same failure.
- **Malformed input answered 500 instead of 400** on ten routes, and in one of them a request could
  come back 200 while writing the wrong value into a project field.
- **`kb` could not tell a refusal from a failure.** A board erroring on a request exited with the
  same code as a lawful refusal, and a reply that was not JSON — what you get when the address
  points at something else — exited zero and reported a move that never happened.
- **GitHub sync could create a second issue for one task** if the process restarted at the wrong
  moment, and an unparsed answer from `gh` started stamping out new ones. An ordinary network
  failure was also filed as permanent and never retried, and labels recoloured by hand were reset
  on every restart.
- **Archiving a project hid it from the sidebar only.** Its cards stayed on the combined board, its
  tasks stayed in "waiting for you", and it was still named in the top projects.
- **Dashboard windows were cut in UTC but drawn in local days,** so the edge of the week fell in
  the middle of a day that the calendar showed in full. The header and the dashboard also counted
  the same week by different rules.
- **A board with its own data directory still used the live project folder of the account,** listed
  it and created folders in it.
- **A relative or `~`-prefixed data directory** created a real directory named `~` and then died on
  a raw stack trace.
- **The install check in CI passed on a package that installs but does not open,** and it was not
  called on the publishing path at all.
- **A broken database died on a raw driver stack** instead of pointing at the snapshots next to it.
- **A group drag that was refused explained nothing** — the reason was computed, translated and
  thrown away.
- **Deleting the demo project left its attachments on disk,** still served over a direct link.

### Performance

Groundwork for larger boards; on a board of a couple of thousand tasks the difference today is a
few milliseconds. The task list no longer reads full descriptions off disk to return a 180-character
preview, the link map is built only for the tasks being shown, the dashboard stops scanning the whole
event log for one minimum, project counters got a covering index, and an edit that changes neither
the column nor the order redraws one card instead of the whole board. Search input is debounced.

## [1.2.1]

### Fixed

- **Creating a task threw an error every single time.** The board splits its frontend into ES
  modules, and two of them wrote to a variable owned by another module. An import is a read-only
  binding, so the assignment threw a `TypeError` and took the rest of the function with it. Three
  things were broken by it at once: a freshly created card was never scrolled into view, the board
  refresh that follows creation never ran, and the sync badge stopped updating — which also meant
  a board with no GitHub sync configured still promised "creating issue…" on every new task. Each
  creation also left an entry in the error log; on a board in daily use they were 82 of the last
  100 records.
- **A task deleted in another tab filled the error log.** The panel re-reads the task it shows on
  every board refresh, so a task deleted elsewhere logged the same "task not found" line again and
  again. Opening one now says so plainly, closes the panel and refreshes the board, and the
  periodic re-read no longer treats an expected miss as a failure.

## [1.2.0]

### Added

- **A long status history no longer buries the rest of the task.** A task that has been moved
  around for weeks collects a couple of dozen timeline rows, and they pushed everything else in
  the panel out of view. Anything longer than six entries now shows the three most recent ones
  with an arrow to expand the rest — and to fold them back.

### Fixed

- **`kb info` crashed on a project whose pm2 services were stored as a plain string.** The field
  is documented as "a comma-separated string or JSON" and both forms exist in real databases, but
  every reader parsed it as JSON only: the command exited with an error instead of printing the
  project, `GET /api/projects/:slug/status` answered 500, and the project settings showed an empty
  pm2 field that the next save would have wiped. Both forms are now read, and new values are
  stored in one canonical shape.

### Changed

- `package.json` no longer declares a `test` script. The tests are not part of the published
  package, so inside an installed one the command exited successfully having run nothing at all —
  a green check for a check that never happened. Tests are run from a clone with `node --test`.

## [1.1.0]

### Changed

- **Node 22 is now the minimum, and installing on a current Node no longer builds from source.**
  The database driver is a native module that ships prebuilt binaries per Node version. The
  pinned version had them for Node 18 through 23 only, so anyone installing on Node 24 LTS or 26
  — which is what you get if you install Node today — silently fell through to compiling the
  driver locally: minutes of waiting, a C++ toolchain required, and an outright failure on a
  machine that has none. The driver is updated to a release with binaries for Node 22, 24, 25 and
  26, `engines` states that range, and CI now tests both ends of it plus a real install on the
  current LTS. Node 20 drops out of the range: the new driver has no binaries for it and Node 20
  itself stopped receiving releases in March 2026.

## [1.0.2]

### Fixed

- **The bundled Raycast command did not work.** `scripts/raycast/open-kanban.sh` ships in the
  package, and the export step removed its `@raycast.title` and `@raycast.description` lines as
  if they were prose. They are not — Raycast parses them, and without a title it never registers
  the command. The script is now written in English and the export refuses to drop a directive.

### Changed

- `package.json` no longer advertises `bootstrap` and `seed:panel`. Neither could run from an
  installed package: one points into a directory that is not shipped, the other at a file that
  was never in the repository. The `contrib/` helpers are run directly from a clone.

## [1.0.1]

### Fixed

- **The board could not be stopped.** Neither `Ctrl+C` nor `SIGTERM` had any effect — only
  `SIGKILL` did. A module-level signal listener was registered on import and did nothing, which
  is enough to cancel Node's default terminate-on-signal. Handlers now live only for as long as
  the thing they clean up, and they exit explicitly.
- **"Stop" on a restored backup lied.** The second board opened from an uploaded backup ignored
  the stop button, the thirty-minute expiry and the next upload — same root cause — so preview
  boards piled up, each still serving a copy of the data on an open port.
- **The wizard's manual instructions assumed a git clone.** Anyone who installed from npm was
  told to run `npm link` and to symlink `skills/` from a directory they do not have; `kb` ships
  with the package and the wizard already copies the skills. The final step now branches on how
  the board was installed.
- Missing Russian translation for the dashboard "Streak" card, which never went through the
  translation layer at all.
- `npm run update` printed git's raw `fatal: not a git repository` before its own explanation of
  how to update an npm install.
- The release preflight reported "something was committed straight to main" when the real problem
  was that no local `main` branch existed.

### Changed

- The README no longer claims parts of the settings are Russian-first — English is the source
  language of the interface and a string with no translation stays English.

## [1.0.0]

First public release. A local kanban board built to work in tandem with Claude Code: the human
plans and accepts, Claude takes tasks from the queue through the `kb` CLI and stops at review.

- Board, dashboard, chaos capture, horizon and calendar views; drag and drop, task links,
  checklists, attachments, comments with images.
- `kb` — a token-efficient CLI for the whole task loop (`take`, `show`, `mv`, `review`, `done`).
- Optional one-way GitHub mirror: every task becomes an issue, every project a Projects v2 board.
- SQLite with versioned migrations, a pre-migration snapshot and rotating backups.
- Local-first by design: binds to loopback, checks request origin, ships no external resources.
- English and Russian interface, installed and set up by `npx local-kanban`.
