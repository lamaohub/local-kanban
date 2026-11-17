# Verifying the result

Part of the kanban skill: how cheap each check is and what each kind of change needs.

- Verifying the result: text and config changes — curl/grep (cheap). Compiled projects — **a build**
  is the cheap check (`cargo build`, `go build ./...`, `tsc --noEmit`, …). **For layout and visual
  changes a screenshot IS the cheap check** — curl and grep never catch a broken layout: serve the
  project from its root and screenshot the page with a headless browser (playwright), on desktop
  (1280) and on mobile (390/360). Mobile "cut off" bugs are horizontal overflow — compare
  `scrollWidth` with `clientWidth` and find elements whose `getBoundingClientRect().right >
  clientWidth`, ignoring those inside an `overflow-x:auto` ancestor.
- Removed an element from a page — verify with grep on **the text or markup**, not the class name
  (the CSS rule of the same name stays behind).
