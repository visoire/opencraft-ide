# AGENTS.md: OpenCraft IDE

Context for AI coding agents (Claude Code, Codex, Cursor and others) and for people new to the code.
Read it fully before you change anything. When this file and the code disagree, the code wins; fix
this file in the same change.

## What this repository is

The open-source OpenCraft IDE (MIT OR Apache-2.0): a local-first workspace in the browser with the
four office engines WordCraft, GridCraft, DeckCraft and PdfCraft as WebAssembly panels, a code editor,
a terminal, Git and an AI chat that drives every tool over MCP. A Node.js server (Hono) on
`127.0.0.1` serves files, projects, Git, the terminal, the AI router and the MCP server.

It is one of three repositories:

| Repository | Visibility | Contents |
| :--- | :--- | :--- |
| `visoire/opencraft-ide` | public | this IDE |
| `visoire/opencraft-home` | private | the website (homepage, portal, dashboard, PHP backend) |
| `visoire/opencraft` | private | both together; `scripts/split-repos.mjs` there writes the other two |

Changes usually start in the monorepo and are mirrored here. A pull request against this repository
is welcome and gets carried back.

## Directory map

```
index.html                 entry page, forwards to ide/
ide/index.html             the IDE page (CSP meta tag, CSS links, src/app/main.ts)
docs/index.html            documentation page, renders src/docs/content.md
src/app/                   shell
  main.ts                  entry: top bar, tool rail, menu, keyboard shortcuts, theme, boot
  settings.ts              interface prefs (localStorage opencraft.prefs), prefs.get/set
  bus.ts                   typed event bus (settings:change, workspace:change, chat:view, ...)
  theme-store.js (+ .d.ts) light/dark per scope ('ide' or 'home'), read/write/watch
  i18n.ts, i18n-de.ts      t() and tn(); English text is the key, German dictionary
  select.ts                the one dropdown: every <select> becomes a button plus listbox
  ui.ts                    dialog(), menu() (.ctx-menu), popover()
  palette.ts, search-ui.ts command palette (Ctrl/Cmd K), project search (Ctrl/Cmd Shift K)
  backend.ts               REST and WebSocket client, browser mode switch
  offline.ts, offline-extra.ts  browser mode (IndexedDB projects, no server)
  device.ts, notifications.ts, sounds.ts, status.ts, privacy.ts, logs.ts, util.ts (ROOT, h())
src/workspace/
  layout.ts                window manager: split tree, modes (normal, minimized, hidden, maximized), PiP
  registry.ts              tool registry: TOOLS, APP_IDS, accents, app versions (__OC_RELEASES__)
  pip.ts                   floating panels and native Document PiP for the chat
  pencil.ts, pdf-pen.ts    Apple Pencil and touch handling
  panels/craftapp.ts       an engine in an iframe: load, save, live sync, theme, render loop pause
  panels/code.ts, terminal.ts, git.ts, settings.ts, settings-extra.ts, common.ts
src/chat/
  sidebar.ts               chat UI: sidebar, Full Chat Mode, history drawer, tool cards, footer
  agent.ts                 the tool loop of one agent (validation, self-correction, approvals)
  team.ts, team-runner.ts, team-ui.ts   Team Mode: task DAG, scheduler, review, Mission Control
  adapters/claude.ts, gemini.ts, openai.ts   raw-fetch provider adapters (no SDKs)
  providers.ts, models.ts, params.ts, config.ts, http.ts   provider list, model rules, parameters
  budget.ts, tokens.ts, usage.ts, telemetry.ts             context budget and token numbers
  mentions.ts, markdown.ts, attachments.ts, history.ts, complete.ts, deepseek.ts
src/mcp/
  schemas.ts               every tool as a Zod schema (TOOL_DEFS); shared by server and browser
  orchestrator.ts          MCP client in the browser: validate, call, report, write locks
  locks.ts                 per-file write mutex (Team Mode)
  panel-server.ts, browser-server.ts, lazy.ts   MCP server for the panels inside the browser
src/project/               manager.ts (projects), fs.ts (file mirror), tree.ts (project tree)
src/server/                Hono backend (Node 20+)
  index.ts                 routes, security headers and CSP, static files from dist/, start
  ai.ts                    AI router and SSE streaming
  tools.ts, office/*       server side of the MCP tools (sheets, docs, slides, pdf, formula)
  mcp.ts                   Streamable HTTP MCP server at /mcp
  git.ts, terminal.ts, projects.ts, search.ts, memory.ts, snapshots.ts, trash.ts, graph.ts,
  objects.ts, export.ts, share.ts, sync.ts, plugins.ts, audit.ts, logs.ts, usage.ts, config.ts,
  lan.ts (home network pairing), paths.ts, fsutil.ts, seed.ts (sample project), tokenizer.ts
src/core/                  no DOM, no Node: search ranking, three-way sync, Markdown, defaults,
                           JSON repair, BPE tokenizer
src/styles/                tokens.css (colors, fonts, radii), base.css, workspace.css, tools.css
src/docs/                  content.md, main.ts (renderer, search, docs assistant), docs.css
public/
  craft-theme.js           runs inside each app: light/dark, theme scope, WordCraft/DeckCraft switches
  craft-frame.js           runs inside each app: viewport, pixel ratio, forced layout
  sw.js                    service worker (offline cache; APPS cache name per release)
  releases.json            single source of release data
  assets/                  icons, logos (.webp), sounds, tokenizers/deepseek-v4.bin
versions/v9-10/web/        the four engine web builds, tracked byte for byte (.gitattributes -text)
scripts/
  dev.mjs                  backend (tsx --watch-path=src) plus Vite
  copy-apps.mjs            web builds into dist/apps/, web zips into dist/downloads/
  patch-apps.mjs           startup fix for DeckCraft 0.9.0 (checks bytes first, idempotent)
  releases.mjs             release data, Vite plugin for /apps/ and /downloads/
  precache.mjs, postbuild.mjs, clean-urls.mjs, check-clean.mjs, build-tokenizer.mjs,
  github-metadata.mjs, pack-web-zips.ps1, web-launcher/serve.ps1
tests/
  server/*.test.ts         node:test through tsx (npm test)
  e2e.mjs                  Playwright, the main end-to-end run (npm run test:e2e)
  e2e-features.mjs         Playwright, trust and privacy features
  e2e-ipad.mjs             Playwright WebKit at iPad sizes
```

## Commands

```sh
npm install
npm run dev            # http://localhost:5175/ide/ (backend :5176)
npm run typecheck      # tsc -p tsconfig.json && tsc -p tsconfig.server.json --noEmit
npm test               # backend tests
npm run test:e2e       # PLAYWRIGHT_MODULE=<playwright or playwright-core> CHROMIUM=<chrome or edge>
npm run check:clean    # also runs as the pre-commit hook: git config core.hooksPath .githooks
npm run build          # dist/ and dist-server/
npm start              # production server
```

Run all five checks before you call a change done: typecheck, test, test:e2e, check:clean, build.

## State management rules

1. **Two theme scopes.** The IDE (shell, Full Chat Mode, PiP, the apps inside panels) uses scope
   `ide`: localStorage `oc-ide-theme` plus `oc-ide-theme-at`, cookie `oc_ide_theme=<theme>.<ms>`,
   BroadcastChannel `oc-ide-theme-channel`. The website, the docs page and an app opened on its own
   use scope `home`: `oc-home-theme`, `oc_home_theme`, `oc-home-theme-channel`. Changing one never
   changes the other. Use `readTheme(scope)`, `writeTheme(theme, scope)`, `watchTheme(fn, scope)`
   from `src/app/theme-store.js`; the head scripts and `public/craft-theme.js` inline the same logic.
   In the IDE the theme is `prefs.get('theme')`; `applyTheme` in `main.ts` posts
   `{ type: 'opencraft:theme', scope: 'ide' }` to every app iframe, which switches in place.
2. **Prefs.** `localStorage` key `opencraft.prefs` (`src/app/settings.ts`). Change with `prefs.set`,
   react to `bus.on('settings:change', ({ key }) => ...)`. Never write the key directly.
3. **Language.** English is the default and the source text. `localStorage` `oc-ide-lang` = `de`
   switches to German after a reload. Wrap visible strings in `t()` (or `tr()` where `t` is taken)
   and add the German entry to `src/app/i18n-de.ts`. Server messages, MCP tool descriptions and
   everything sent to a model stay English.
4. **Data on disk.** The backend owns `~/OpenCraft` (`OPENCRAFT_HOME`): `projects/<id>/` files,
   `<project>/.opencraft/` chats, layout, memory, index, snapshots; `config.json` settings and API
   keys (the browser only ever sees masked keys); `audit.jsonl`, `usage.json`, `.trash/`.
5. **Release data.** `public/releases.json` only. Code in `src/` must never import from `public/`
   (Vite refuses it in dev); the IDE gets the data through the define `__OC_RELEASES__`.
6. **Panels and iframes.** Panels move by repositioning; never re-parent an app iframe, it would
   restart the WebAssembly app and lose unsaved state.

## MCP tool schema rules

- Every tool is one entry in `TOOL_DEFS` in `src/mcp/schemas.ts`: `name` (kebab-case, verb first,
  for example `read-sheet`), `title`, English `description`, `app`, `side` (`server` or `client`),
  a Zod `input` object, plus `pathArg` (the edited file), `writes` (panels refresh) and `approval`
  (needs a confirmation) where they apply.
- The same definitions feed the backend MCP server, the browser orchestrator, the `/` commands and
  the tool definitions sent to models. Do not duplicate a schema anywhere else.
- Keep the order of existing tools. Tool lists go to the models in a fixed, sorted order so the
  provider's prompt cache hits; the e2e test checks it.
- Provider differences are handled by `compileToolSchema` (strict schemas for OpenAI and Claude,
  `functionDeclarations` for Gemini) and `normalizeToolArgs`. Validate every call with
  `validateArgs` before it runs; invalid arguments go back to the model once for a self-correction.
- Writes to the same file are serialized by `src/mcp/locks.ts`; reads never wait.
- A new tool needs: the schema, the implementation (`src/server/tools.ts` or the panel server), a
  test in `tests/server/`, and a line in `src/docs/content.md`.

## Conventions

- Strict TypeScript, ES modules, no `any` without a reason in a comment.
- English for code, comments, tests, commit messages and the sample project.
- Interface copy: plain words, no em dashes, no exclamation marks.
- Design: monochrome surfaces (light paper, dark carbon) with `.frame` and `.well`; app accents
  (`#335CFF` OpenCraft, `#3B82F6` WordCraft, `#10B981` GridCraft, `#F97316` DeckCraft, `#14B8A6`
  PdfCraft) only on app marks; DM Mono for labels and numbers; no gradients; links in ink with a
  quiet underline; 44 px touch targets on iPad; every color defined for light and dark.
- Selects are enhanced by `src/app/select.ts`, checkboxes are styled in `src/styles/tools.css`.
  Use plain `<select class="input">` and `<input type="checkbox">`; do not build another dropdown.
- No third-party scripts, no CDN. Fonts come from `@fontsource`.
- When rewriting files on Windows, keep UTF-8 and the existing line endings.

## Testing rules

- The e2e tests start their own stack on ports 5185, 5186 and 5299 with a temporary data folder.
  Never point a test at the dev server on 5175 and 5176: that one uses the real `~/OpenCraft`.
- Do not edit files under `src/` while an e2e run is going: the dev servers watch `src/` and reload.
- Mock model scripts strip the `<context>` and `<session>` blocks before matching keywords.
- `tests/server/releases.test.ts` skips the website checks here (no homepage in this repository).

## Do not

- Commit `~/OpenCraft` data, `.env` files, keys or databases (`check:clean` stops most of it).
- Copy anything from an engine's `docs/brand/` folder, or use the ArtCraft name or logos as branding.
- Change files in `versions/` by hand; use `scripts/patch-apps.mjs` and `releases.json`.
- Add network calls to services the user did not configure.
