# The human's commands for a task in review

Part of the kanban skill: the full text behind its short lines.

- "accept TIC-3" → `kb done TIC-3`.
- "send TIC-3 back: <what's wrong>" → `kb unblock` if needed, `kb mv TIC-3 doing`, fix it, then the
  loop again from step 4. **First REPRODUCE the exact scenario from the note** (curl or a browser,
  following the real flow) and confirm the actual cause — only then fix it. A second attempt at a
  returned task often cures a plausible but wrong cause.
- "cancel TIC-3" → `kb cancel TIC-3`.
- **The user's words in your terminal bring the task you handed in back** from `review` to `doing` by
  themselves, with no command from you (a note of yours moves nothing). Finished the turn those words
  asked for → `kb review TIC-3 "…"` again (`kb mv TIC-3 ready` where `kb info` says "ships on the
  word"). Words about something else, with nothing changed for this task, and the board puts it back in
  `review` on its own. While it waits in `doing`, every `kb` command you run (on it or on any other
  task — `kb add` then also offers `kb link`) prints `kb: warning — TIC-3 is in doing …` to stderr: hand
  it in again, and name its status in your report from `kb show`, not from memory.
- "do TIC-3" (a specific task in any status except done) → `kb show TIC-3` (the `👤` note comes
  first; open `📎` screenshots with Read) and **`kb mv TIC-3 prep` right away**, then steps 2–6
  (`already taken` means another Claude session holds it — see the working loop).
