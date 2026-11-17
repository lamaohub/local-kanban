# Driving the board's own UI in a browser

Part of the kanban skill.

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
