# OpenCraft IDE

**One local workspace for documents, sheets, slides, PDFs and code, with an AI assistant that can use every tool.**

OpenCraft IDE runs the open-source office engines **WordCraft**, **GridCraft**, **DeckCraft** and **PdfCraft** as WebAssembly panels side by side, next to a code editor, a real terminal, Git and an AI chat. The assistant drives all of them through the Model Context Protocol (MCP), so a request like "chart the Q3 numbers from the sheet on slide 3 and attach it to the contract" becomes a chain of tool calls you can watch, check and undo. Everything runs on your machine: the frontend in your browser, a small Node.js server bound to `127.0.0.1`, your files in a folder you own.

Version **1.0.0**, licensed **MIT OR Apache-2.0**. Ships with WordCraft 0.9.0, GridCraft 0.9.0, DeckCraft 0.9.0 and PdfCraft 0.10.1.

| | |
| :--- | :--- |
| **Multi-panel WebAssembly IDE** | The four engines as panels (WebGPU, WebGL2 as a fallback), plus code editor, terminal and Git. Split, maximize, minimize to the dock, picture in picture, focus mode. Apps keep their state while you rearrange them. |
| **MCP orchestrator** | Every tool (read and write sheets and documents, create slides, read and sign PDFs, turn images into a PDF, search the project, run a command, commit with Git, open panels) is one Zod schema in `src/mcp/schemas.ts`. Calls are validated before they run, invalid ones go back to the model for a correction, and the same tools are served at `/mcp` for Claude Desktop, Claude Code or any MCP client. |
| **Team Mode** | A Team Leader plans a task graph, specialist agents for sheets, documents, slides, PDFs and code work in parallel, the leader reviews each result. Writes to the same file wait in line, reads never do. Mission Control shows it all live. |
| **Multi-provider AI** | Claude, ChatGPT, Gemini, DeepSeek, Ollama and any OpenAI-compatible endpoint, with native adapters, reasoning streams, prompt caching and exact token telemetry per model. Bring your own key, or stay fully local with Ollama. |
| **iPadOS and Apple Pencil** | Touch, Apple Pencil (pressure and tilt), Magic Keyboard, Stage Manager. Pair the iPad with your desktop over the home network, or use the browser mode on the iPad alone. |
| **100 % local, zero CDN** | Fonts come from npm, icons are inline SVGs, the apps and their workers are served by your own machine, and there are no third-party scripts. The server listens on `127.0.0.1` by default. Local-only mode blocks every cloud provider with one switch. |

---

## Quick start

You need **Node.js 20 or newer** and **Git**. `node-pty` is optional: with it the terminal is a full terminal; without it, each line runs as a command in PowerShell, cmd.exe or `/bin/sh`.

### Windows, macOS and Linux

```sh
git clone https://github.com/visoire/opencraft-ide.git
cd opencraft-ide
npm install
npm run dev
```

Open `http://localhost:5175/ide/`. You start in an empty project of your own (**My project**). Import your files, or press **Load sample data** to open a separate sample project with a document, a spreadsheet, a presentation and a PDF; your own project stays untouched. Add a model under Settings, **AI models**: an API key, your own endpoint, or Ollama for fully local work.

On Windows, PowerShell and Command Prompt both work, and the IDE's terminal panel lets you switch between them. On macOS and Linux the terminal uses your `$SHELL`.

| Command | What it does |
| :--- | :--- |
| `npm run dev` | Backend (Hono, port 5176) and Vite (port 5175) with hot reload. The IDE is at `http://localhost:5175/ide/`. |
| `npm run dev:lan` | The same, shared with an iPad on your Wi-Fi (pairing link in the output). |
| `npm run build` | Frontend, the four apps, the service worker list and the server into `dist/` and `dist-server/`. |
| `npm start` | Production server from the build on `http://localhost:5175/ide/` (opens the browser). |
| `npm run start:lan` | The production server, shared with an iPad on your Wi-Fi. |
| `npm run typecheck` | Strict TypeScript for frontend and backend. |
| `npm test` | Backend integration tests (files, projects, Git, terminal, AI routing, MCP, Team Mode, releases). |
| `npm run test:e2e` | Playwright end to end with a mock model (see [Tests](#tests)). |
| `npm run check:clean` | Blocks API keys, private files, database files and brand assets before a commit. |

### iPadOS

1. On your desktop, run `npm run dev:lan` (or `npm run build` and `npm run start:lan`).
2. Open the pairing link it prints (`http://<your PC>:5175/pair?token=...`) once in Safari on the iPad.
3. From then on, `http://<your PC>:5175/ide/` opens the IDE with your desktop projects. Share, **Add to Home Screen** makes it a full-screen app.

Without a desktop, the IDE runs in browser mode with projects stored on the iPad. See the [iPadOS guide](docs/IPADOS-GUIDE.md).

### Your data and API keys

Your data lives in `~/OpenCraft` (on Windows `C:\Users\<name>\OpenCraft`, change it with `OPENCRAFT_HOME`): one folder per project, chats and history in `<project>/.opencraft/`, settings and API keys in `config.json`. Nothing of it is ever part of this repository.

- **Desktop:** API keys are stored by the local server in `config.json` (mode `0600` on macOS and Linux), outside the reach of scripts in the page. The browser only sees a masked hint, and a key is only sent to the provider it belongs to.
- **iPad in browser mode:** keys stay in memory until you reload. Keeping them in the browser's storage is an opt-in behind a clear warning.

The user documentation opens from the IDE menu, or at `http://localhost:5175/docs/`.

### Guides

| Guide | Covers |
| :--- | :--- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | browser and server halves, channels, data on disk, key storage, zero CDN, security boundaries |
| [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md) | every tool with its arguments, approvals, using the tools from Claude Code or other clients, adding a tool |
| [docs/AI-PROVIDERS.md](docs/AI-PROVIDERS.md) | Claude, ChatGPT, Gemini, DeepSeek, Ollama and custom endpoints, reasoning, caching, token counts, Team Mode |
| [docs/IPADOS-GUIDE.md](docs/IPADOS-GUIDE.md) | pairing over Wi-Fi, browser mode, Apple Pencil, Magic Keyboard, Retina, limits |

---

## Architecture

```
Browser                                              Your machine
┌──────────────────────────────────────────┐        ┌───────────────────────────────┐
│ ide/  workspace shell (TypeScript, Vite)  │ REST   │ src/server/  Hono on 127.0.0.1 │
│  ├ panels: WordCraft GridCraft DeckCraft  │◄──────►│  files, projects, Git,         │
│  │         PdfCraft (WebAssembly iframes) │  SSE   │  terminal, AI router,          │
│  ├ code editor, terminal, Git, settings   │  WS    │  MCP server (/mcp), search,    │
│  └ AI chat, Full Chat Mode, Team Mode     │  MCP   │  memory, snapshots, audit      │
│     └ MCP orchestrator (src/mcp/)         │        │        │                      │
└──────────────────────────────────────────┘        │        ▼                      │
                                                     │  ~/OpenCraft (your files)     │
                                                     └───────────────────────────────┘
```

| Channel | Use |
| :--- | :--- |
| REST `/api/*` | files, projects, Git, settings, chats, layout, usage |
| SSE `/api/ai/chat` | token streaming from the AI router, including native tool calls |
| WebSocket `/ws` | live file events for panel sync, terminal I/O, tool activity |
| MCP `/mcp` | Streamable HTTP MCP server with all project tools, also for external MCP clients |

### The apps

| App | Accent | Hex | Formats |
| :--- | :--- | :--- | :--- |
| **OpenCraft** (workspace) | Blue | `#335CFF` | projects, chat, code |
| **WordCraft** | Blue | `#3B82F6` | `.docx`, `.odt`, `.md` |
| **GridCraft** | Green | `#10B981` | `.xlsx`, `.csv`, dynamic arrays |
| **DeckCraft** | Orange | `#F97316` | `.pptx`, vector morph |
| **PdfCraft** | Teal | `#14B8A6` | PDF: deep zoom, local signing, redaction |

The accents appear only on app marks. Surfaces are monochrome: warm light paper or a deep carbon dark theme, with quiet `.frame` and `.well` borders.

### App releases

| App | Version | Released | Web build (`versions/v9-10/web/`) | Web zip (`zip-web/`) | Windows portable x64 / x86 / ARM64 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **WordCraft** | `0.9.0` | 2026-10-21 | `wordcraft-web-0.9.0/` (42.1 MB) | 15.7 MB | 95.5 / 92.7 / 92.6 MB |
| **GridCraft** | `0.9.0` | 2026-10-20 | `gridcraft-web-0.9.0/` (18.3 MB) | 6.8 MB | 17.8 / 16.4 / 16.4 MB |
| **DeckCraft** | `0.9.0` | 2026-10-21 | `deckcraft-web-0.9.0/` (29.2 MB), patched, see below | 10.4 MB | 77.4 / 75.4 / 74.5 MB |
| **PdfCraft** | `0.10.1` | 2026-10-21 | `pdfcraft-web-0.10.1/` (37.5 MB) | 13.8 MB | 82.4 / 78.8 / 78.9 MB |

`public/releases.json` is the one place release data lives. The build, the dev server and the IDE registry read it; `tests/server/releases.test.ts` checks this table, the service worker and the web builds against it. DeckCraft 0.9.0 carries a startup fix applied by `scripts/patch-apps.mjs` until upstream ships one ([storytold/deckcraft#959](https://github.com/storytold/deckcraft/issues/959)); the `.wasm` stays byte for byte upstream.

---

## Keyboard shortcuts and chat operators

`Ctrl` on Windows and Linux, `Cmd` on macOS and on an iPad with a Magic Keyboard.

| Shortcut | Does |
| :--- | :--- |
| `Ctrl/Cmd+K` | command palette |
| `Ctrl/Cmd+J` | show or hide the chat |
| `Ctrl/Cmd+Shift+J` | Full Chat Mode |
| `Ctrl/Cmd+Shift+P` | float the focused panel (picture in picture) |
| `Ctrl/Cmd+Shift+K` | project search |
| `Ctrl/Cmd+Shift+E` | project tree |
| `Ctrl/Cmd+Shift+F` | focus mode |
| `Ctrl/Cmd+Shift+Enter` | maximize the focused panel |
| `Ctrl/Cmd+Shift+M` | minimize the focused panel to the dock |
| `Alt+1` to `Alt+9` | jump to a panel |
| `Alt+\` | AI completion at the cursor in the code editor (`Tab` accepts, `Escape` dismisses) |
| `Enter` / `Shift+Enter` | send the chat message / new line |

| Operator | Examples | Does |
| :--- | :--- | :--- |
| `@` file or folder | `@finances.xlsx`, `@sheets/` | attaches the content: sheets as Markdown tables, documents and PDFs as text, folder listings |
| `@` app or panel | `@wordcraft`, `@gridcraft`, `@deckcraft`, `@pdfcraft`, `@terminal` | attaches the panel state and points the model at that app's tools |
| `@` agent | `@team`, `@leader`, `@grid-agent`, `@word-agent`, `@deck-agent`, `@pdf-agent`, `@dev-agent` | runs Team Mode, or gives the prompt to one specialist |
| `/` tool | `/read-sheet`, `/write-document`, `/create-slide`, `/sign-pdf` | forces an MCP tool; with complete arguments it runs without a model: `/read-sheet @finances.xlsx range=A1:E6` |
| `/` command | `/clear`, `/new`, `/history`, `/export-chat`, `/search`, `/model`, `/persona`, `/remember`, `/memory`, `/undo`, `/snapshot`, `/find`, `/team`, `/roster`, `/help` | chat, memory, history and team commands |

---

## Light and dark mode, language

The IDE has its own light or dark choice, stored as `oc-ide-theme` (plus the cookie `oc_ide_theme`). The top bar, the chat history and Settings all change the same value, and the apps inside the panels switch in place, without a reload and without losing the open document. An app opened on its own (`/apps/<app>/`) and the docs page follow the separate website choice `oc-home-theme`.

The interface is English by default. German is optional under Settings, Appearance and layout, **Language of the IDE** (stored as `oc-ide-lang`).

---

## Tests

```sh
npm run typecheck
npm test
npm run test:e2e        # needs Playwright: npm i -D playwright (or PLAYWRIGHT_MODULE=<path to playwright-core>)
npm run test:ipad       # WebKit at iPad Pro sizes (npx playwright install webkit)
npm run check:clean
npm run build
```

The end-to-end test starts its own backend and Vite on ports 5185 and 5186 with an empty temporary data folder and an OpenAI-compatible mock model on 5299, so your own `~/OpenCraft` is never touched. Set `CHROMIUM` to a Chrome or Edge executable to use an installed browser. It covers the `@` and `/` menus, custom endpoints and DeepSeek, the GridCraft to WordCraft to DeckCraft tool chain with live panel updates, validation and self-correction, panel layouts without losing WebAssembly state, projects, export, Team Mode, the theme scopes and the custom controls.

---

## Architecture and context map for AI coding agents

Read [AGENTS.md](AGENTS.md) before you change anything; it is the full version of this map.

```
ide/index.html            IDE entry (the app lives under /ide/; index.html at the root forwards there)
docs/index.html           user documentation page (src/docs/)
docs/*.md                 guides: ARCHITECTURE, MCP-TOOLS, AI-PROVIDERS, IPADOS-GUIDE
src/app/                  shell: main.ts (entry, top bar, rail, keys), settings.ts (prefs), theme-store.js,
                          i18n.ts + i18n-de.ts, select.ts (dropdown), ui.ts (dialogs, menus), palette.ts
src/workspace/            layout.ts (window manager), registry.ts (tools), pip.ts, pencil.ts,
                          panels/ (craftapp.ts, code.ts, terminal.ts, git.ts, settings.ts)
src/chat/                 sidebar.ts (chat views), agent.ts (tool loop), team*.ts (Team Mode),
                          adapters/ (Claude, Gemini, OpenAI), providers.ts, models.ts, usage.ts
src/mcp/                  schemas.ts (all tools, Zod), orchestrator.ts, locks.ts, panel-server.ts
src/project/              project manager, file mirror, tree
src/server/               Hono backend: index.ts (routes, CSP), ai.ts, tools.ts, git.ts, terminal.ts, ...
src/core/                 shared without DOM or Node: search, sync, Markdown, BPE tokenizer
src/styles/               tokens.css, base.css, workspace.css, tools.css
public/                   craft-theme.js and craft-frame.js (run inside the apps), sw.js, releases.json
versions/v9-10/web/       the four engine web builds (tracked, byte for byte, see .gitattributes)
scripts/                  dev.mjs, copy-apps.mjs, patch-apps.mjs, precache.mjs, check-clean.mjs, ...
tests/                    server/*.test.ts (node:test via tsx), e2e.mjs, e2e-features.mjs, e2e-ipad.mjs
```

| Rule | Where |
| :--- | :--- |
| Theme of the IDE is `oc-ide-theme` / cookie `oc_ide_theme`; the website and standalone apps use `oc-home-theme` / `oc_home_theme`. Always pass the scope to `readTheme`, `writeTheme`, `watchTheme`. | `src/app/theme-store.js`, `public/craft-theme.js` |
| Interface prefs live in `localStorage` `opencraft.prefs`; change them with `prefs.set`, listen on the bus event `settings:change`. | `src/app/settings.ts`, `src/app/bus.ts` |
| English text is the i18n key: `t('Open settings')`. Add the German entry to `i18n-de.ts`. Server messages, MCP descriptions and model context stay English. | `src/app/i18n.ts` |
| Tools are defined once in `TOOL_DEFS` (Zod). Never reorder existing tools (prompt cache), keep descriptions English, set `pathArg`, `writes` and `approval`. Validate with `validateArgs`. | `src/mcp/schemas.ts` |
| Never import from `public/` in `src/`; release data arrives as `__OC_RELEASES__`. | `vite.config.js` |
| Panels reposition iframes, they never re-parent them (that would restart the WebAssembly app). | `src/workspace/layout.ts`, `pip.ts` |
| Never run tests against the dev server on 5175/5176: it uses the real `~/OpenCraft`. | `tests/e2e.mjs` |

---

## Contributors

- **visoire** ([github.com/visoire](https://github.com/visoire)): creator, lead maintainer and architect of OpenCraft.
- **storytold, the ArtCraft Team and contributors** ([github.com/storytold](https://github.com/storytold)): creators of the open-source engines WordCraft, GridCraft, DeckCraft and PdfCraft.
- **Claude** (Anthropic): AI fullstack architecture, systems engineering and code pairing.

See [CONTRIBUTORS.md](CONTRIBUTORS.md) and [CONTRIBUTING.md](CONTRIBUTING.md) to join in. Security problems: [SECURITY.md](SECURITY.md).

---

## Upstream Engine Separation and License Attribution

OpenCraft maintains a strict architectural and organizational separation between the OpenCraft workspace and the embedded crafting engines:
- **OpenCraft Workspace:** OpenCraft provides the IDE workspace shell, window management, multi-split and picture-in-picture window manager, project file tree, local companion server (Hono on `127.0.0.1`), terminal and Git integrations, project snapshots, and the Model Context Protocol (MCP) orchestration layer that coordinates automated workflows. The OpenCraft IDE codebase is open source under `MIT OR Apache-2.0`.
- **Embedded Crafting Engines:** WordCraft, GridCraft, DeckCraft, and PdfCraft are independent open-source engines developed by storytold, the ArtCraft team, and contributors ([github.com/storytold](https://github.com/storytold)) under their respective open-source licenses (`MIT OR Apache-2.0`).
- **Notice Preservation:** All upstream copyright notices, author credits, and license files are maintained intact in every distribution under `versions/v9-10/web/` and `ide/`.

---

## Trademark and Compatibility Disclaimers

- **Independent Community Project:** OpenCraft is an independent project and is **not affiliated with, endorsed by, or sponsored by Adobe Inc., Microsoft Corporation, or their affiliates**.
- **Ownership of Trademarks:** All product names, logos, and brands (such as Microsoft Word, Microsoft Excel, Microsoft PowerPoint, Adobe Acrobat, Adobe Photoshop, and others) are the property of their respective owners. Their mention in this repository does not imply any affiliation, sponsorship, or endorsement.
- **Technical File Format Compatibility:** References to standard file formats (`.docx`, `.xlsx`, `.pptx`, `.pdf`) are used **solely for technical compatibility and interoperability descriptions** under nominative fair use.
- **Upstream & AI Marks:** ArtCraft, WordCraft, GridCraft, DeckCraft, and PdfCraft belong to storytold and the ArtCraft team. Claude, ChatGPT, Gemini, DeepSeek, and Ollama are trademarks of their respective owners.

---

## As-Is Provision, Limitation of Liability, and DMCA Contact

- **As-Is Provision:** THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS, CONTRIBUTORS, OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY.
- **Intellectual Property & Takedown Notices:** Rights holders may submit inquiries or notices of claimed infringement to our designated contact:
  - **Email:** [visoire@proton.me](mailto:visoire@proton.me)
  - **Subject:** `[IP Notice] OpenCraft`
  - See [docs/LEGAL.md](docs/LEGAL.md) for full legal text and takedown procedures.

---

## License

OpenCraft IDE is licensed under either of [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE) at your option (see [LICENSE](LICENSE)). The four engines in `versions/` keep their own MIT or Apache-2.0 license files in each app folder. WordCraft, GridCraft, DeckCraft and PdfCraft are Crafting Apps by the ArtCraft team; the ArtCraft name and logos are trademarks of their owners and are not part of this repository. OpenCraft is an independent community project and is not affiliated with Microsoft or Adobe; Word, Excel, PowerPoint and Acrobat are trademarks of their owners.
