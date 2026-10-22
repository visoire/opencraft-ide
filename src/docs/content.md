<!-- page: introduction | Get started | Introduction | OpenCraft is a local-first workspace for documents, sheets, slides and PDFs with an AI that works across all four apps. -->

OpenCraft runs **WordCraft**, **GridCraft**, **DeckCraft** and **PdfCraft** side by side in one window, with a code editor, a terminal, Git and an AI assistant that edits the project files through the Model Context Protocol (MCP). Everything runs on your computer: a small Node.js backend on `127.0.0.1` keeps your projects, your keys and your history.

:::cards
- [Quickstart](#quickstart) Install, start and open the IDE in two minutes.
- [Your data and API keys](#privacy) What stays on the device and what leaves it.
- [Local-only mode](#local-only) One switch that blocks every cloud provider.
- [Search and memory](#search) Find any passage in Word, Excel, PowerPoint, PDF and chats.
- [Snapshots and undo](#snapshots) Undo an AI answer across all apps at once.
- [Plugin API](#plugins) Add PhotoCraft, Blender, ComfyUI and more as MCP servers.
- [AI providers](#providers) Claude, ChatGPT, Gemini, DeepSeek, Ollama and your own endpoint.
- [Team Mode](#team) A Team Leader and specialist agents working in parallel.
- [iPad and Apple Pencil](#ipad) Pair with your desktop over Wi-Fi, or work on the iPad alone.
- [Keyboard shortcuts](#shortcuts) Every shortcut, plus the `@` and `/` operators of the chat.
:::

> [!NOTE]
> This guide describes OpenCraft IDE 1.0. Every feature on these pages works without an account and without the cloud. Cloud models are optional and you can switch them off completely.

## What makes OpenCraft different

- **Local first.** Projects are folders in `~/OpenCraft/projects`. The backend listens on `127.0.0.1` only.
- **Your keys stay here.** API keys live in `~/OpenCraft/config.json` and reach the browser only masked.
- **You see what leaves.** The [audit log](#audit) lists every request that went to a provider, with metadata only.
- **One undo for everything.** Before the AI writes, OpenCraft keeps a [snapshot](#snapshots) of the whole project.

<!-- page: quickstart | Get started | Quickstart | Install OpenCraft, start the backend and open the IDE. -->

:::steps
1. **Install Node.js 20 or newer and Git.** On Windows, macOS and Linux.
2. **Install the dependencies.** Run `npm install` in the project folder.
3. **Start OpenCraft.** `npm run dev` for development or `npm run build` and `npm start` for production.
4. **Open the IDE.** Go to `http://localhost:5175/ide/`. Your own empty project opens. Import your files, or press **Load sample data** to open a separate sample project with a document, a spreadsheet, slides and a PDF.
5. **Pick a model.** Settings, AI models: add an API key, your own endpoint, or start Ollama for fully local work.
:::

```sh
npm install
npm run dev        # backend on :5176, interface on :5175
npm run build && npm start   # production on :5175
```

> [!TIP]
> Use `localhost` instead of `127.0.0.1` in the browser. Then the website and the IDE share the light or dark choice.

## Your own projects and the sample data

Every installation, and every browser in browser mode, starts with an empty project of its own called **My project**. Nobody shares demo files, and your documents stay in your own data folder.

**Load sample data** (in the empty project tree, or the project menu) opens the bundled sample project: a Word document, a spreadsheet with formulas, a presentation, a PDF and a bit of code. It is a project of its own, so trying things there never touches your files. Switch back in the project menu. **New project** in the same menu can also start a project with the sample files.

## Data folder

| Path | Content |
|---|---|
| `~/OpenCraft/projects/<id>/` | the files of a project |
| `<project>/.opencraft/` | chats, layout, memory, search index, snapshots, project graph |
| `~/OpenCraft/config.json` | settings and API keys (mode 0600 on macOS and Linux) |
| `~/OpenCraft/audit.jsonl` | audit log (metadata only) |
| `~/OpenCraft/.trash/` | deleted projects and files, 30 days |
| `~/OpenCraft/plugins/` | plugins (MCP servers) |

Set `OPENCRAFT_HOME` to move the folder, `OPENCRAFT_PORT` for the backend port and `OPENCRAFT_SHARE_PORT` for the home-network share (default 5179).

<!-- page: architecture | Get started | Architecture | How the interface, the backend, MCP and the apps work together. -->

The interface is a strict TypeScript app (Vite). The backend is Hono on Node.js. They talk over four channels:

| Channel | Use |
|---|---|
| REST `/api/*` | files, projects, settings, search, trash, snapshots, audit log |
| SSE `/api/ai/chat` | token streaming from the AI router |
| WebSocket `/ws` | live file events, terminal, tool activity |
| MCP `/mcp` | all project tools over Streamable HTTP, also for external MCP clients |

The AI router (`src/chat/providers.ts`) talks to Claude, ChatGPT, Gemini, DeepSeek, Ollama and any OpenAI-compatible endpoint. Requests go from the backend to the provider, never straight from the browser. Only browser mode on the iPad, without a desktop, sends requests from the browser.

> [!INFO]
> The four apps are WebAssembly builds. They expose no command API, so the AI works on the files and the apps show the new state live.

Nothing is loaded from a CDN. Fonts, icons, the apps, the tokenizer data and the service worker all come from your own computer.

<!-- page: shortcuts | Get started | Keyboard shortcuts | Every shortcut of the workspace, the code editor and the chat. -->

On a Mac or an iPad with a Magic Keyboard, use `Cmd` where the table says `Ctrl`.

| Shortcut | Does |
|---|---|
| `Ctrl K` | command palette |
| `Ctrl J` | show or hide the chat |
| `Ctrl Shift J` | Full Chat Mode |
| `Ctrl Shift P` | float the focused panel (picture in picture) |
| `Ctrl Shift K` | search the project |
| `Ctrl Shift E` | show or hide the project tree |
| `Ctrl Shift F` | focus mode |
| `Ctrl Shift Enter` | maximize the focused panel |
| `Ctrl Shift M` | minimize the focused panel to the dock |
| `Alt 1` to `Alt 9` | jump to a panel |
| `Alt \` | AI completion at the cursor in the code editor (`Tab` accepts, `Escape` dismisses) |
| `Enter`, `Shift Enter` | send the chat message, new line |

## Chat operators

| Type | To |
|---|---|
| `@file.xlsx`, `@folder/` | attach a file or a folder listing |
| `@wordcraft`, `@gridcraft`, `@deckcraft`, `@pdfcraft`, `@terminal` | attach the state of a panel and point the AI at its tools |
| `@team`, `@leader` | run the prompt in [Team Mode](#team) |
| `@grid-agent`, `@word-agent`, `@deck-agent`, `@pdf-agent`, `@dev-agent` | give the prompt to one specialist |
| `/read-sheet`, `/create-slide`, `/sign-pdf`, ... | run an MCP tool; with complete arguments it runs without a model |
| `/clear`, `/new`, `/history`, `/export-chat`, `/model`, `/help` | chat housekeeping, see [Chat and attachments](#chat) |

Arrow keys, `Tab` and `Enter` move through the `@` and `/` menus. Without a hardware keyboard, the header and the chat show quick buttons for the command palette, `@` and `/`.

<!-- page: ipad | Get started | iPad and Apple Pencil | Pair the iPad with your desktop over Wi-Fi, or use browser mode on the iPad alone. -->

OpenCraft runs on iPad mini, Air and Pro in Safari, or as a full-screen app from the Home Screen (Share, **Add to Home Screen**). It picks one of two modes on its own:

| Mode | When | What works |
|---|---|---|
| Home network | the desktop shares the IDE on Wi-Fi and the iPad is paired | everything: desktop projects, terminal, Git, Ollama on the desktop, all MCP tools |
| Browser | no desktop answers | the four apps, projects stored on the iPad (IndexedDB), the chat with your own key, file import and export, the Apple Pencil in PdfCraft |

## Pair the iPad with your desktop

:::steps
1. **Share the IDE on Wi-Fi.** On the desktop, open Settings, **iPad and network**, switch on **Share on Wi-Fi** and restart. Or start the IDE with `npm run dev:lan` or `npm run start:lan`.
2. **Open the pairing link.** The desktop shows an address such as `http://192.168.178.20:5175/pair?token=...`. Open it once in Safari on the iPad.
3. **Work.** From then on `http://<your PC>:5175/ide/` opens the IDE with your desktop projects.
:::

Every device except the desktop needs the access token. **Renew** in the settings disconnects all paired devices.

## Apple Pencil

- The pencil works like a precise mouse in the apps: cell ranges in GridCraft, shapes in DeckCraft and WordCraft, text selection. A hover ring shows where it will land.
- **PdfCraft pencil view**: sign, write notes, highlight and redact on the page with pressure and tilt. Redaction rebuilds the page as an image, so covered text is really removed.
- A finger scrolls, a long press opens the context menu, two fingers zoom. Palm rejection ignores your hand while the pencil writes or hovers.
- Scribble works in the chat input, search fields and the code editor, so handwritten prompts become text.

## Keyboard, screen and windows

- The Magic Keyboard has every shortcut with `Cmd`, see [Keyboard shortcuts](#shortcuts).
- The apps render at the iPad's full Retina resolution with correct sizes and pointer positions.
- Stage Manager, Split View, Slide Over and rotation resize the workspace without reloading the apps. Below 700 pixels width the project tree and the chat become drawers.
- The chat, the `@` and `/` menus and the terminal stay above the on-screen keyboard.

> [!NOTE]
> Over plain HTTP on the home network, Safari allows neither WebGPU nor offline caching. The apps then start with WebGL2 and the IDE runs without an offline cache. HTTPS through your own reverse proxy brings both back.

## API keys in browser mode

Without a desktop there is no protected key store. Keys stay in memory until you reload. Under Settings, **iPad and network** you can choose to keep them in this browser's storage; OpenCraft warns you first, because anything with access to the browser profile could read them. Use keys with a spending limit.

<!-- page: privacy | Privacy and security | Your data and API keys | What stays on your computer, what leaves it, and when. -->

OpenCraft is built so that you always know where your data is.

## API keys stay local

- Keys are stored by the backend in `~/OpenCraft/config.json`. On macOS and Linux the file has mode `0600`, on Windows it is protected by your user profile.
- The interface only ever sees a masked hint such as `…a1b2`.
- A key leaves the computer only inside a request to the provider it belongs to.
- In browser mode (iPad without desktop) keys stay in memory until a reload, unless you explicitly allow storing them in this browser.

## What a cloud model receives

When you chat with a cloud model (Claude, ChatGPT, Gemini, DeepSeek or a remote endpoint), the provider receives:

- your message and the earlier messages of the chat,
- the text of files you mention with `@` or attach, and images you attach,
- the results of tool calls in that answer, for example the rows of a sheet the AI read,
- the passages the [project memory](#memory) adds, and your [personal context](#personas),
- the list of tool definitions.

> [!WARNING]
> Data that reaches a cloud provider is handled under that provider's terms. Use [local-only mode](#local-only) or Ollama for confidential material.

## What never leaves

- Local document data, spreadsheet formulas, presentation slides, and PDF content remain strictly on your device and are never sent to external servers by OpenCraft.
- Optional third-party AI providers (Anthropic, OpenAI, Google, DeepSeek) process only data explicitly submitted by the user through their configured API keys.
- Your project files, unless they are part of a chat request as above.
- The search index and embeddings: they are computed by Ollama on this computer.
- Usage numbers, logs and metrics.
- Snapshots, the trash and the project graph.

## Check it yourself

The [audit log](#audit) lists every outgoing request with destination, model, size and the names of attached files. Blocked attempts are listed too.

<!-- page: local-only | Privacy and security | Local-only mode | One switch that blocks every cloud provider. Only Ollama and local files. -->

Local-only mode is the strongest trust switch in OpenCraft. Find it in **Settings, Privacy**.

When it is on:

- **The backend refuses every cloud provider.** Chat requests, connection tests and the automatic provider choice skip Claude, ChatGPT, Gemini, DeepSeek and remote endpoints. A blocked attempt shows a clear message and lands in the audit log with status *blocked* and zero bytes sent.
- **Local models keep working.** Ollama and your own endpoints on `localhost`, `127.x`, `10.x`, `172.16-31.x`, `192.168.x` or `.local` names stay allowed.
- **Remote MCP servers are blocked.** Plugins over HTTP must point to this computer or the home network.
- **The browser is locked down too.** The page adds a strict Content Security Policy that allows connections only to itself, this computer and the paired desktop. Switching the mode off needs a reload, because browsers cannot loosen a policy.

> [!TIP]
> A lock badge in the top bar and in the chat header shows while the mode is on. Click it to open the privacy settings.

## Local models

1. Install Ollama from ollama.com and start it.
2. Pull a model with tool support, for example `ollama pull qwen2.5:7b`.
3. In Settings, AI models, make Ollama the default.

<!-- page: audit | Privacy and security | Audit log | What left this device? Every outgoing request with metadata only. -->

The audit log answers one question: **what left this device?** Open it in **Settings, Audit log**.

Every entry has:

| Field | Meaning |
|---|---|
| Time | when the request started |
| Destination | the host, for example `api.anthropic.com` |
| Local or cloud | whether the host is this computer or the home network |
| Provider and model | for example Claude, `claude-sonnet-5-5` |
| Sent | size of the request body in bytes, number of images |
| Files | names, kinds and sizes of mentioned or attached files and memory passages, **never their content** |
| Result | sent, blocked or error, with input and output tokens |

Logged events: chat requests, connection tests, blocked attempts, local embeddings, home-network shares (every new device), syncs and calls of remote MCP servers.

The log lives in `~/OpenCraft/audit.jsonl` (browser mode: IndexedDB) and keeps the last 5000 entries. Export it as CSV or clear it. You can switch it off under Privacy, but keeping it costs nothing.

<!-- page: wipe | Privacy and security | One-click wipe | Delete API keys, projects and chat history securely, for demo devices or handing a device over. -->

**Settings, Privacy, One-click wipe** removes in one step:

- all API keys, your own endpoints and the home-network token,
- all projects with their chats, memory, snapshots, search index and the trash,
- usage statistics and metrics,
- the audit log and the logs,
- the personal context and personas,
- optionally plugins and MCP servers.

Type the confirmation word and press **Delete everything now**. OpenCraft overwrites each file with random data before it removes it, then starts again with an empty project.

> [!WARNING]
> Overwriting is a best effort. SSDs, copy-on-write file systems, snapshots of the operating system and backups can keep old blocks. For devices you hand over, use full-disk encryption as well.

In browser mode the wipe deletes all projects, chats, keys and settings of this browser.

<!-- page: security | Privacy and security | Security and sandbox | Network rules, Content Security Policy and the MCP sandbox. -->

## Network

- The backend listens on `127.0.0.1` and rejects foreign `Host` headers (DNS rebinding) and foreign `Origin` headers.
- Home-network mode is opt-in. Other devices need the access token; cookies count only from the PC's own address.
- The share server for read-only links is a separate small server on its own port. It only answers `GET` below `/s/<token>/`.

## Content Security Policy

The IDE pages carry a policy in the page and, in production, as an HTTP header: scripts only from the same origin, no plugins (`object-src 'none'`), no framing by other sites (`frame-ancestors 'self'`), forms only to the same origin. The apps get their own policy with `wasm-unsafe-eval`, which WebAssembly needs. Local-only mode adds a stricter `connect-src`. The server also sends `X-Content-Type-Options: nosniff`, a same-origin referrer policy and a permissions policy that only allows the camera for document scans.

## MCP sandbox

External MCP servers and plugins run with a sandbox level:

| Level | What it does |
|---|---|
| `strict` | clean environment (no API keys or tokens of the backend), working folder of the plugin, and for Node servers the Node permission model: read the plugin folder and the project, write only the project, no child processes |
| `standard` | clean environment and its own working folder |
| `off` | the full environment of the backend, only for servers you trust |

Every server also has an approval rule: `ask` (every call needs your confirmation), `read` (read-only tools run freely) or `all`. The backend checks a single-use approval token, so a client cannot skip the dialog. Calls time out after 120 seconds and results are capped at 200 KB.

> [!NOTE]
> The Node permission model applies to servers started with `node`. Other programs get the clean environment and the approval rule but no file system limits. Run untrusted tools in a container.

<!-- page: search | Productivity | Search | Full-text and semantic search across Word, Excel, PowerPoint, PDF and chats. -->

Press **Ctrl/Cmd ⇧ K**, type `/find` in the chat or use the command palette. The search covers:

- Word documents (`.docx`, `.odt`), Markdown and text,
- spreadsheets (`.xlsx`, `.csv`), with sheet and row range,
- presentations (`.pptx`), per slide,
- PDFs, per page,
- code files, per block of lines,
- the chats of the project.

Every hit names its place, for example *page 3*, *slide 2* or *Quarters rows 1-25*. Enter opens the file in its app.

## Modes

| Mode | How it ranks |
|---|---|
| Smart | full text and, with embeddings on, meaning combined |
| Exact words | BM25 full text with prefixes and German compounds |
| By meaning | embeddings only |

Without embeddings the full text already understands German and English word forms and a small set of business terms in both languages: "Umsatzprognose" finds "revenue forecast" and the other way round.

## Semantic search with Ollama

1. Start Ollama and run `ollama pull nomic-embed-text`.
2. Settings, Search and memory: switch on **Embeddings with Ollama**.
3. The index computes a vector per passage on this computer. Then "find the part with the revenue forecast" finds the right section even with other words.

The index lives in `.opencraft/index.json` of the project and updates a few seconds after a file changes. The AI can use the same search with the tool `search-project`.

<!-- page: trash | Productivity | Trash | Deleted projects and files stay 30 days and can be restored. -->

Deleting a file in the project tree or a whole project moves it into the trash (`~/OpenCraft/.trash`). Open **Settings, Trash** or the project menu.

- **Restore** puts a file back at its old path. If that path is taken, it comes back as `name (restored).ext`. A project comes back under its old ID or a new one.
- **Delete for good** overwrites and removes one entry. **Empty the trash** does it for all.
- Entries older than 30 days are removed on start and every six hours.

Snapshot restores and syncs also move replaced files into the trash, so nothing disappears silently.

<!-- page: snapshots | Productivity | Snapshots and undo | Undo across all tools: one snapshot of the whole project and the chats. -->

A snapshot keeps the whole project folder and the chats. Files are stored once in a content-addressed store (`.opencraft/objects`), so snapshots of unchanged files cost no extra space.

## Undo an AI answer

Before the AI writes the first file of an answer, the backend takes an automatic snapshot of that answer. Under the answer you then see **Undo changes**. One click restores every file the answer changed in WordCraft, GridCraft, DeckCraft, PdfCraft and the code editor, and moves files it created into the trash. `/undo` in the chat does the same for the last answer.

## Manual snapshots

- `/snapshot before the big rewrite` in the chat, the command palette, or **Settings, History and snapshots**.
- **Differences** shows what changed, what is new and what was deleted since.
- **Restore** brings back files and chats. Before every restore OpenCraft takes a safety snapshot, so a restore can be undone too.

OpenCraft keeps the last 30 automatic snapshots. **Free unused storage** removes objects that no snapshot and no file version uses.

<!-- page: export | Productivity | Export formats | ZIP, static HTML gallery, PDF portfolio and Markdown documentation folder. -->

Find all formats in the project menu, in the command palette and in **Settings, Share and sync**.

| Format | Result |
|---|---|
| ZIP | the project folder with chats and layout, importable again |
| HTML gallery | `index.html` with cards for every file, one page per file with its content as HTML, originals in `files/`; opens in any browser, no server needed |
| PDF portfolio | cover, contents, every document as text pages, sheets as tables, existing PDFs merged and images embedded |
| Markdown folder | `README.md` as index, one `.md` per file (Word, Excel, PowerPoint and PDF converted), originals in `assets/`, chats in `chats/` |

All formats are built locally. The REST call is `GET /api/projects/<id>/export/<format>` with `html`, `pdf` or `markdown`.

<!-- page: share | Productivity | Home network share and sync | A temporary read-only link on your Wi-Fi, and two-way sync between desktop and iPad. -->

## Read-only link

**Settings, Share and sync, Create link** shows the current project to someone on the same Wi-Fi, without the cloud and without an account.

- A separate small server listens on port 5179 only while a link is active.
- It answers only `GET` requests below `/s/<token>/`: a file list, a preview per file and, if allowed, the original.
- No API, no MCP, no writes. Hidden folders such as `.opencraft` and `.git` are never served.
- Links expire after the time you choose (15 minutes to 8 hours) and end at once when you revoke them.
- Every new device that opens a link lands in the [audit log](#audit).

## Sync between devices

The sync compares both sides with the state of the last sync (three-way):

- changed on one side: copied to the other,
- changed on both sides: the newer version keeps the name, the other one becomes `name (conflict <device> <date>).ext` on both sides,
- deleted on one side and unchanged on the other: deleted there too, into the trash.

**Desktop to desktop:** switch on home-network sharing on the other PC, then enter its IP address and access token under Share and sync. **iPad in browser mode:** under Settings, Share and sync, **Sync now** syncs the browser project with the same project on the paired desktop.

> [!INFO]
> From a page served over HTTPS, browsers block plain HTTP requests to the home network (mixed content). Open the IDE over `http://` on the iPad, or put the desktop behind HTTPS.

<!-- page: providers | AI | AI providers and models | Claude, ChatGPT, Gemini, DeepSeek, Ollama and your own endpoints, with reasoning, caching and token numbers. -->

Pick a provider in **Settings, AI models**, or switch it for one chat with `/model` or the model menu in the chat header.

| Provider | What you need | Reasoning | Prompt cache |
|---|---|---|---|
| Claude | Anthropic API key | adaptive thinking with an effort level | marked on the tools, the system prompt and large documents |
| ChatGPT | OpenAI API key | reasoning effort with summaries | per chat |
| Gemini | Google AI API key | thinking level or budget | automatic |
| DeepSeek | DeepSeek API key | thinking mode, shown as **Thought process** | prefix cache |
| Ollama | Ollama on this computer or your network | depends on the model | local |
| Custom | base URL, optional key and a model name of any OpenAI-compatible endpoint | depends on the endpoint | depends on the endpoint |

**Test connection** checks a key or endpoint and lists its models. Requests go from the local backend straight to the provider, never through OpenCraft. Only browser mode on the iPad sends them from the browser.

## Effort

The model chip in the prompt bar sets the effort per provider: Auto, Off, Low, Medium, High or Max. OpenCraft translates it into each API's own setting.

## Attachments

PDFs and images you attach go to Claude, Gemini and ChatGPT as real documents and images (up to 8 per message, 20 MB each). DeepSeek, Ollama and custom endpoints get the extracted text.

## Token numbers and costs

- DeepSeek counts are exact, thanks to a built-in V4 tokenizer. ChatGPT counts are exact too. Claude and Gemini are estimated (marked ≈), unless you switch on **Remote counting**, which asks their counting endpoints and sends the text to the provider.
- The chat footer shows the tokens of the chat, the cache hit ratio and the size of the next request while you type. The bar turns orange when the backend will shorten the request to fit, red when even that is not enough.
- **Settings, Usage and telemetry** breaks it all down per provider and model. Costs appear once you enter your provider's rates; local models always cost $0.00.

## DeepSeek presets

Standard chat, Thinking, Deep thinking, and Coding and FIM. The last one powers `Alt \` completions in the code editor. Overrides for max tokens, temperature and effort are in Settings, AI models.

> [!WARNING]
> A cloud provider receives what you send in the chat, see [Your data and API keys](#privacy). [Local-only mode](#local-only) blocks every cloud provider.

<!-- page: team | AI | Team Mode | A Team Leader plans, specialist agents work in parallel, and the leader reviews every result. -->

The switch in the chat header changes between **Single** (one agent) and **Team**. In Team Mode a Team Leader plans your prompt as a task graph, specialist agents work at the same time, and the leader reviews each result before it writes the answer.

| Role | Mention | Works with |
|---|---|---|
| Team Leader | `@leader` | plans, reviews and answers, no tools of its own |
| Data and Sheet Specialist | `@grid-agent` | GridCraft tools |
| Document and Copy Specialist | `@word-agent` | WordCraft tools |
| Presentation Specialist | `@deck-agent` | DeckCraft tools |
| PDF and Compliance Specialist | `@pdf-agent` | PdfCraft tools |
| Code and System Specialist | `@dev-agent` | code, terminal, Git and external MCP servers |

Every specialist can also read the project: `list-files`, `search-files`, `search-project` and `panel-status`.

## The roster

Open it with the roster button next to the switch, `/roster`, or **Settings, Team Mode**. Give the leader and each specialist its own provider, model and effort, for example a cloud leader with local Ollama specialists. Switch specialists on or off, set how many work at once (1 to 6), the review mode and the retries per task. Presets: Full Studio Team, Executive Launch Team, Financial Audit Team, Fullstack Dev Team and Fast Local/Hybrid Team. **Save as** keeps your own.

## How a team run works

:::steps
1. **Plan.** The leader turns your prompt and its `@` attachments into tasks with dependencies and target files.
2. **Work.** Every task whose dependencies are done starts at once, each specialist in its own thread with its own model.
3. **Review.** Each result is checked and reviewed by the leader, who can send one specialist back with a precise instruction. Then the leader answers.
:::

- **Files stay consistent.** Reads never wait. Two writes to the same file wait in line; writes to different files run in parallel.
- **Approvals.** `run-command` and `sign-pdf` ask inside the card of the agent that wants them; the others keep working.
- **Mission Control** shows the phase, the task graph, one lane per specialist with its current tool and file, and tokens, cache hits and cost per role. **Stop all agents** and **Cancel** per worker are always there.
- Open panels show a badge such as "WordCraft · writing" while an agent writes their file, then reload it.

`@team`, `@leader` or `/team` run the whole team for one prompt. One specialist mentioned alone, such as `@word-agent shorten the summary in @report.docx`, works directly without planning.

<!-- page: chat | AI | Chat and attachments | Mentions, slash commands, attachments, timeline and multi-step chains. -->

- `@` mentions attach content: `@finances.xlsx`, `@sheets/`, `@wordcraft`, `@terminal`.
- `/` picks a tool or a command. With complete arguments a tool runs directly without a model.
- Attach files with the clip, drag and drop or paste. They are saved under `/attachments/`.
- Tool calls show as timeline cards with parameters, duration and result.

## Commands

| Command | Does |
|---|---|
| `/find revenue forecast` | opens the project search |
| `/persona reviewer` | switches the persona |
| `/remember Prices are net` | keeps a note in the project memory |
| `/memory` | shows the project memory |
| `/undo` | undoes the file changes of the last answer |
| `/snapshot label` | takes a project snapshot |
| `/team write the Q3 report and slides` | runs one prompt in [Team Mode](#team) |
| `/roster` | opens the team configuration |
| `/search term` | searches the messages of this chat |
| `/clear`, `/new`, `/history`, `/export-chat`, `/model`, `/help` | chat housekeeping |

## Chat views

The chat docks left or right of the workspace, fills the window as **Full Chat Mode** (`Ctrl/Cmd Shift J`), or floats above a document as a picture-in-picture window. In desktop Chrome and Edge it can also pop out into its own always-on-top window. Switching views keeps a running answer and your draft.

<!-- page: vision | AI | Vision and scanning | Images, screenshots and document scans in the chat, for models that read images. -->

Drag images or screenshots into the chat, paste them, or press the image button next to the clip:

- On iPad and iPhone the button opens the camera. On desktops it opens the file dialog.
- A scan is cleaned up on the device: scaled to at most 2400 pixels, converted to grayscale and the contrast is stretched so text reads well.
- The image goes to the model as image content (scaled to at most 1568 pixels) and is saved under `/attachments/`.

Ask for example:

- "Extract the table from the screenshot into `/sheets/scan.xlsx`" (GridCraft, tool `write-sheet`)
- "Combine the scans into `/pdf/receipts.pdf`" (PdfCraft, tool `images-to-pdf`)

> [!NOTE]
> Images reach the model only if it reads images, for example Claude, GPT-5, Gemini or Ollama models such as `llava` or `qwen2.5vl`. Text-only models answer from the text.

<!-- page: personas | AI | Personas and personal context | Your own roles and system prompts, and the context the AI always knows. -->

**Settings, Personal context** holds two things.

## Personal context

A short text about you that goes into every chat: your role, your company, the language and units you prefer. You write it once and do not repeat yourself.

## Personas

Roles with their own system prompt. OpenCraft ships four you can edit: *No persona*, *Financial analyst*, *Copywriter* and *Strict reviewer*. Add your own with **Add persona**.

Switch the persona in the chat header or with `/persona reviewer`. The answer shows which persona wrote it.

> [!WARNING]
> The personal context and the persona prompt go to the model of the chat. With a cloud model they leave the device; with local-only mode they do not.

<!-- page: memory | AI | Project memory | The chat keeps the context of the current project on its own (RAG). -->

Before every question the chat adds a `<project_memory>` block with:

1. **Pinned notes and decisions.** Keep them with `/remember`, the **Remember** button under an answer, or Settings, Search and memory. The AI can save decisions itself with the tool `remember`.
2. **Recent AI steps.** Which tool wrote which file from which inputs, from the [project graph](#graph).
3. **Relevant passages.** The best passages of the [search index](#search) for this question, with path and place.

The memory lives in the project (`.opencraft/memory.json` and the local index), travels with the project ZIP (notes) and never leaves the device unless it goes to a cloud model as part of a chat. Under an answer you see how many notes and passages were used. Switch it off or set the number of passages in Settings, Search and memory.

<!-- page: graph | AI | Project graph | Assets, dependencies, version history and which file came from which MCP step. -->

The project graph is more than the file tree. For every file it keeps:

- **Versions.** The last 20 versions with time, size, origin (editor, app, tool, sync, snapshot) and the content in the object store, so any version can be restored.
- **Producer.** Which MCP step wrote it: the tool, its call ID and the chat answer (chain).
- **Dependencies.** Edges "derived from": a step that read `/sheets/finances.xlsx` and wrote `/documents/report.docx` links the two.

That makes multi-step pipelines traceable and reliable: you see where a slide came from and can roll back one file without touching the rest. Open it in **Settings, History and snapshots**, or ask the AI with the tool `file-history`.

<!-- page: plugins | Developers | Plugin API | Add PhotoCraft, ArtCraft, Blender headless, ComfyUI and more as MCP servers. -->

A plugin is a folder in `~/OpenCraft/plugins/<name>/` with an `opencraft.plugin.json`. OpenCraft starts it as an MCP server, adds its tools to the chat under `/` and keeps the core unchanged.

```json
{
  "name": "comfyui",
  "title": "ComfyUI",
  "version": "0.1.0",
  "description": "Image generation with a local ComfyUI",
  "mcp": { "transport": "http", "url": "http://127.0.0.1:8188/mcp" },
  "sandbox": "strict",
  "approval": "ask",
  "accent": "#A855F7"
}
```

## Fields

| Field | Values |
|---|---|
| `name` | lowercase letters, digits and dashes |
| `mcp.transport` | `stdio` with `command`, `args`, `env`, or `http` with `url` |
| `sandbox` | `strict`, `standard`, `off`, see [Security and sandbox](#security) |
| `approval` | `ask`, `read`, `all` |
| `accent` | color of the tool cards |

`${pluginDir}` and `${home}` in `command` and `args` are replaced. A stdio example:

```json
{
  "name": "photocraft",
  "title": "PhotoCraft",
  "mcp": { "transport": "stdio", "command": "node", "args": ["${pluginDir}/server.js"], "env": {} },
  "sandbox": "strict",
  "approval": "read"
}
```

**Settings, Plugins and sandbox** lists installed plugins with their status, the sandbox that applies and their tools, and a catalog with templates for ComfyUI, Blender headless, PhotoCraft, ArtCraft and the MCP test server. Templates start switched off, so you can check the command first.

Tool names of plugins get the prefix `ext-<server>-`. Files the tools write show in the apps like any other change.

<!-- page: tools | Developers | MCP tools | The tools the AI and external MCP clients can call. -->

OpenCraft is itself an MCP server at `http://localhost:5175/mcp` (Streamable HTTP). Every call is checked with a Zod schema.

| Tool | App | Does |
|---|---|---|
| `read-sheet`, `write-sheet` | GridCraft | read calculated values, write values and formulas |
| `read-document`, `write-document` | WordCraft | read as Markdown, write Markdown as `.docx` or `.md` |
| `read-slides`, `create-slide` | DeckCraft | read slide texts, create slides |
| `read-pdf`, `sign-pdf` | PdfCraft | read text, place a signature block (needs approval) |
| `images-to-pdf` | PdfCraft | combine images and scans into a PDF |
| `search-project` | project | full-text and semantic search across files and chats |
| `remember` | project | keep a note in the project memory |
| `file-history` | project | versions and lineage of a file |
| `list-files`, `search-files`, `read-file`, `write-file` | code | files and text |
| `run-command` | terminal | shell command with approval |
| `git-status`, `git-commit`, `git-log` | Git | version control |
| `open-panel`, `panel-status` | workspace | panels in the browser |

Add it to Claude Code with `claude mcp add --transport http opencraft http://localhost:5175/mcp`, or to any MCP client that speaks Streamable HTTP. Requests from other devices need the access token, like the REST API.

<!-- page: api | Developers | REST API | The endpoints of the local backend. -->

All paths are below `/api` on the backend port. From another device in the home network they need the access token (`x-oc-token` header or the pairing cookie).

| Endpoint | Use |
|---|---|
| `GET /search?q=&mode=&kinds=` | project search |
| `GET /search/status`, `POST /search/reindex` | index state, rebuild |
| `GET /memory`, `POST /memory`, `POST /memory/context` | project memory |
| `GET /trash`, `POST /trash/<id>/restore`, `DELETE /trash/<id>` | trash |
| `GET /snapshots`, `POST /snapshots`, `POST /snapshots/<id>/restore` | snapshots |
| `GET /snapshots/chain/<answer>` | the automatic snapshot of a chat answer |
| `GET /graph`, `GET /graph/file?path=`, `POST /graph/restore` | project graph and versions |
| `GET /projects/<id>/export/<format>` | export formats: `html`, `pdf`, `markdown` |
| `GET /share`, `POST /share`, `DELETE /share/<token>` | read-only links (desktop only) |
| `GET /sync/<id>/manifest`, `GET`, `PUT` or `DELETE /sync/<id>/file`, `POST /sync/peer` | home-network sync |
| `GET /plugins`, `POST /plugins/install`, `PUT /plugins/<name>` | plugins |
| `PUT /config/privacy`, `PUT /config/personal`, `PUT /config/search` | settings |
| `GET /audit`, `GET /audit/export`, `DELETE /audit` | audit log |
| `GET /logs`, `GET /metrics`, `GET /metrics/report` | observability |
| `GET /health/full`, `GET /health/resources` | health check, resources |
| `POST /wipe` with `{"confirm":"WIPE"}` | one-click wipe (desktop only) |

<!-- page: observability | Developers | Logs and metrics | A local log panel and optional performance metrics that never leave the device. -->

**Settings, Logs and metrics** shows one log of the backend and the interface: errors, warnings, MCP tool calls with their latency, AI requests with tokens, app start times, connection changes. Filter by level and text, save as a text file or clear it. The log is only on this computer; the backend keeps the last 2000 lines in memory.

## Performance metrics

Optional and off by default. When you switch them on, OpenCraft records locally in `~/OpenCraft/metrics.json`:

- start time of each WebAssembly app (`app:gridcraft`),
- latency per MCP tool (`mcp:read-sheet`),
- time to the first token per provider (`ttft:anthropic`),
- search time and the load time of the IDE.

The table shows p50, p95 and the maximum. **Export the anonymized report** writes a JSON file with tool and app names and numbers only, no file names, paths, host names or content. Nothing is sent anywhere; you decide whether to share the file.

<!-- page: health | Developers | Health check and monitor | Backend, MCP, WebAssembly, WebGPU, service worker and Ollama at a glance, plus memory per app. -->

## Health check

**Settings, Health check** runs these checks at once:

| Check | What it tells |
|---|---|
| Backend | version, Node, uptime, memory |
| MCP server | the backend connects to its own `/mcp`, counts tools and measures the list time |
| External MCP servers | status and tools of plugins |
| Ollama | reachable, version, models, embedding model present |
| Git, terminal, disk, system memory | the tools the IDE needs |
| WebAssembly | ready, SIMD, threads |
| WebGPU | adapter and GPU, otherwise the apps use WebGL2 |
| WebGL2 | renderer |
| Service worker | offline cache |
| Browser storage, secure context | quota and HTTPS |

## Memory and GPU monitor

**Settings, Memory and GPU** updates every two seconds and shows for each app panel the WebAssembly memory, an estimate of its GPU memory (WebGPU buffers and textures, WebGL buffers and textures), the start time and the state. **Kill** unloads one app at once; **Emergency stop** unloads all apps. A warning appears when the apps use more than about a third of the device memory.

> [!NOTE]
> GPU values are estimates from what the apps allocate. Browsers do not report the real GPU memory of a page.

<!-- page: faq | Help | FAQ | Short answers to common questions. -->

## Does OpenCraft send my files to the cloud?

Only when you chat with a cloud model and the file is part of that chat: mentioned with `@`, attached, read by a tool in that answer, or added as a memory passage. The [audit log](#audit) shows each case. With [local-only mode](#local-only) nothing goes to the cloud.

## Where are my API keys?

In `~/OpenCraft/config.json` on your computer. The interface sees only a mask. The [one-click wipe](#wipe) removes them.

## Can I undo what the AI did?

Yes. **Undo changes** under the answer, `/undo`, or a [snapshot](#snapshots).

## Does the search need Ollama?

No. Full-text search works without it. Ollama adds search by meaning.

## Does this documentation chat send my question somewhere?

The chat on these pages searches the documentation in your browser. When the OpenCraft backend runs, it asks your default model with the best passages; with a cloud model that question leaves the device like any chat and appears in the audit log. Without the backend it answers with the matching sections only.

## Are OpenCraft, Microsoft, and Adobe related?

No. OpenCraft is an independent project and is not affiliated with, endorsed by, or sponsored by Adobe Inc., Microsoft Corporation, or their affiliates. All product names, logos, and brands (such as Microsoft Word, Excel, PowerPoint, Adobe Acrobat, Photoshop) are the property of their respective owners. References to file formats (`.docx`, `.xlsx`, `.pptx`, `.pdf`) are used solely for technical compatibility descriptions.

## How are OpenCraft and the crafting engines separated?

OpenCraft provides the IDE workspace shell, window management, project tree, local companion server, and Model Context Protocol (MCP) orchestration layer. WordCraft, GridCraft, DeckCraft, and PdfCraft are independent open-source engines developed by storytold and the ArtCraft team ([github.com/storytold](https://github.com/storytold)) under `MIT OR Apache-2.0`. All upstream copyright notices and license references are maintained intact.

## What warranty and liability protections apply?

The OpenCraft IDE, local companion server, and embedded crafting engines are provided "as is", without warranty of any kind, express or implied. For intellectual property notices or DMCA takedown requests, rights holders may email `visoire@proton.me`. Complete terms and disclaimers are set forth in [docs/LEGAL.md](LEGAL.md).
