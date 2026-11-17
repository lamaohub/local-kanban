# A check task (the `check` label): acceptance handed over

Part of the kanban skill: how to carry out a check the board started.

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
     what you found, in full — not "all good". The board then moves the check task itself to done:
     `kb review` answers `<check-key> done 📝`.
