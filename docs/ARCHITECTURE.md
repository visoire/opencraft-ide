# Architecture

How the OpenCraft IDE is put together: what runs in your browser, what runs on your computer, how the
two talk, and where your data ends up. For the file-by-file map, see [AGENTS.md](../AGENTS.md).

## Two halves

OpenCraft has two parts that always run on the same machine (or on your home network):

| Part | Runs in | Built with | Does |
| :--- | :--- | :--- | :--- |
| **Frontend** | your browser | strict TypeScript, Vite | the workspace, the four apps as WebAssembly panels, the code editor, the chat, the MCP orchestrator |
| **Backend** | Node.js 20+ on your computer | TypeScript, Hono | files and projects, Git, the terminal, the AI router, the MCP server, search, memory, snapshots, the audit log |

The four apps (WordCraft, GridCraft, DeckCraft, PdfCraft) are compiled from Rust to WebAssembly and
run entirely in the browser. They draw with WebGPU when the browser offers it and fall back to WebGL2
otherwise. Your documents are never processed on a server.

The backend listens on `127.0.0.1` only. It exists for the things a browser cannot do safely on its
own: read and write a project folder, run Git and a shell, keep API keys out of the page, and talk to
AI providers.

```
Browser                                              Your computer
+-------------------------------------------+        +--------------------------------+
| ide/   workspace shell (src/app)          |  REST  | src/server/  Hono on 127.0.0.1 |
|  - panels: WordCraft GridCraft DeckCraft  |<------>|  files, projects, Git,         |
|            PdfCraft (WebAssembly iframes) |  SSE   |  terminal, AI router,          |
|  - code editor, terminal, Git, settings   |  WS    |  MCP server (/mcp), search,    |
|  - chat, Full Chat Mode, Team Mode        |  MCP   |  memory, snapshots, audit      |
|  - MCP orchestrator (src/mcp)             |        |            |                   |
+-------------------------------------------+        |            v                   |
                                                     |  ~/OpenCraft (your files)      |
                                                     +--------------------------------+
```

## Channels

| Channel | Path | Carries |
| :--- | :--- | :--- |
| REST | `/api/*` | files, projects, Git, settings, chats, layout, search, usage, trash, snapshots |
| Server-Sent Events | `/api/ai/chat` | streamed tokens, reasoning and tool calls from the AI router |
| WebSocket | `/ws` | live file events for panel sync, terminal input and output, tool activity |
| MCP (Streamable HTTP) | `/mcp` | every project tool, for the built-in chat and for external MCP clients |

In development, Vite serves the frontend on port 5175 and forwards `/api`, `/mcp` and `/ws` to the
backend on port 5176. In production (`npm start`) the backend serves everything on port 5175.

## What happens when you ask the AI to do something

1. You type a prompt in the chat, maybe with `@finances.xlsx` or `/read-sheet`.
2. The chat (`src/chat/agent.ts`) builds the request: system prompt, tool schemas sorted by name, the
   project context, the history, then your message. This order keeps the provider's prompt cache warm.
3. The backend's AI router (`src/server/ai.ts`) sends it to the provider you picked, through a native
   adapter (`src/chat/adapters/`), and streams the answer back over SSE.
4. When the model calls a tool, the MCP orchestrator (`src/mcp/orchestrator.ts`) validates the
   arguments with the tool's Zod schema, asks for your approval if the tool needs it, and calls the
   backend's MCP server or the browser's panel server.
5. The tool writes the file into the project. The backend announces the change over the WebSocket,
   and every open panel showing that file loads the new version without restarting the app.
6. Before the first write of an answer, the backend takes a snapshot, so **Undo changes** under the
   answer can restore every file at once.

## Where data lives

The backend owns `~/OpenCraft` (on Windows `C:\Users\<name>\OpenCraft`; change it with
`OPENCRAFT_HOME`).

| Path | Content |
| :--- | :--- |
| `projects/<id>/` | the files of each project |
| `<project>/.opencraft/` | chats, layout, memory, search index, snapshots, object store, project graph |
| `config.json` | settings and API keys (file mode `0600` on macOS and Linux) |
| `audit.jsonl` | one line per outgoing request, metadata only |
| `usage.json`, `metrics.json` | token numbers and optional performance metrics |
| `.trash/` | deleted projects and files, kept for 30 days |
| `plugins/` | plugins that add MCP servers |

None of this is ever part of the repository.

### API keys

- **Desktop with the backend running:** keys are stored by the backend in `config.json`. The page only
  ever receives a masked hint such as `...a1b2`, so a script in the page cannot read a key. A key
  leaves the computer only inside a request to the provider it belongs to.
- **Browser mode (iPad without a desktop):** there is no protected key store. Keys stay in memory
  until a reload. Keeping them in the browser's `localStorage` is an explicit opt-in, shown with a
  warning that anything with access to the browser profile can read them.

## Browser mode

When `/api/health` does not answer, `src/app/offline.ts` serves the same `/api` paths from IndexedDB:
projects, files, chats, layout and settings. The four apps, the chat (with your own key), file import
and export and the Apple Pencil in PdfCraft keep working. The terminal, Git and the office tools of the
AI need the desktop. The Status page shows **Browser mode**, and a notice offers to switch back as
soon as the desktop is reachable.

## Nothing from a CDN

Every byte the IDE loads comes from your own computer:

- fonts (Inter and DM Mono) are bundled from npm (`@fontsource`);
- icons are inline SVGs from `src/app/icons.js`;
- the four apps, their workers and their WebAssembly modules are served from `versions/v9-10/web/`;
- the DeepSeek tokenizer data is `public/assets/tokenizers/deepseek-v4.bin`;
- the service worker (`public/sw.js`) caches the IDE and the apps for offline use.

There are no third-party scripts. Local-only mode (Settings, Privacy) adds a strict `connect-src`
policy on top, so the page cannot reach any cloud host.

## Security boundaries

- The backend rejects foreign `Host` headers (DNS rebinding) and foreign `Origin` headers.
- Every path is resolved inside the project folder; ZIP imports are checked for path traversal.
- `run-command` and `sign-pdf` need a confirmation per call, checked by the backend with a
  single-use token.
- External MCP servers and plugins run in a sandbox (clean environment, own folder, and for `strict`
  the Node permission model) with an approval rule per server.
- Home network mode is opt-in. Every device except the desktop itself needs the access token.

See [SECURITY.md](../SECURITY.md) for how to report a problem.

## Release data and the apps

`public/releases.json` is the single source of the app versions, dates and file sizes. The build, the
dev server and the IDE's app registry read it (`__OC_RELEASES__`); `tests/server/releases.test.ts`
checks the README and the service worker against it. `scripts/patch-apps.mjs` applies one startup fix
to the DeckCraft 0.9.0 web build ([storytold/deckcraft#959](https://github.com/storytold/deckcraft/issues/959));
the `.wasm` file stays byte for byte upstream.

| App | Version | Formats |
| :--- | :--- | :--- |
| WordCraft | 0.9.0 | `.docx`, `.odt`, `.md` and more |
| GridCraft | 0.9.0 | `.xlsx`, `.csv`, dynamic arrays |
| DeckCraft | 0.9.0 | `.pptx`, vector morph |
| PdfCraft | 0.10.1 | `.pdf`: deep zoom, local signing, redaction |

## Related guides

- [MCP-TOOLS.md](MCP-TOOLS.md): every tool, its arguments and how to call it from other clients
- [AI-PROVIDERS.md](AI-PROVIDERS.md): providers, keys, reasoning, caching, token counts, Team Mode
- [IPADOS-GUIDE.md](IPADOS-GUIDE.md): pairing, Apple Pencil, Magic Keyboard, browser mode
