# kb, the database and scripts

Part of the kanban skill: the technical rules behind its short lines.

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
- `kb: board is not responding` → restart the board's server (`pm2 restart kanban` / `npm start`),
  wait two seconds and retry once. **Exit codes are distinct: `1` — the board is down (a restart
  and a retry make sense), `2` — the request was rejected (retrying is pointless, read the
  message), `3` — `kb` itself broke (stack trace under `KB_DEBUG=1`), `4` — the board answered,
  but with a failure of its own (5xx), with something that is not JSON, or it broke off in the middle
  of the answer (what was asked may or may not have happened). Gate on the code, not on
  the message text.** Code `4` is worth reading closely: it means the board falls over on this
  request, or `KB_URL` points at something that is not the board at all.
