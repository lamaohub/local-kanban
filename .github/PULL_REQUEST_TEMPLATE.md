## What & why

## Checklist

- [ ] `node --test` passes
- [ ] Schema changed? → numbered migration in `src/db.js` + `src/schema.sql` + check in `test/migrations.test.js` (see CONTRIBUTING)
- [ ] New user-visible strings are English inside `tr('…')`; translations go to `I18N_RU` in `public/js/core.js`
- [ ] Architecture affected? → matching section of `ARCHITECTURE.md` updated in the same commit
