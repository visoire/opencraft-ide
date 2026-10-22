# CLAUDE.md

Claude Code reads this file at the start of a session. The project context lives in AGENTS.md (shared
with other coding agents), imported here:

@AGENTS.md

## Short version

- Five checks before a change is done: `npm run typecheck`, `npm test`, `npm run test:e2e`,
  `npm run check:clean`, `npm run build`.
- Theme scopes: `oc-ide-theme` for the IDE and the apps in its panels, `oc-home-theme` for the docs
  page and standalone apps. Always pass the scope to the theme-store functions.
- English is the default language; German strings go into `src/app/i18n-de.ts`.
- Tools are Zod schemas in `src/mcp/schemas.ts`; never reorder them.
- Never run tests against the dev server on ports 5175 and 5176 (real user data).
