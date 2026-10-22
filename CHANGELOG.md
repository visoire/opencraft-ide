# Changelog

All notable changes to OpenCraft IDE. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Projects

- A new installation, and every new browser in browser mode, starts with an empty project of its own
  (**My project**) instead of shared demo files.
- **Load sample data** in the empty project tree and the project menu opens the sample project as a
  separate project, created the first time (`POST /api/projects/sample`). Your own project stays
  untouched.
- `OPENCRAFT_FIRST_PROJECT=sample` starts a new installation with the sample project (test stacks,
  demo machines).

### Version

- The backend, the Status page, browser mode and the MCP servers and clients now report the release
  version 1.0.0 from one place, `src/core/version.ts` (before: 1.2.0, and 0.2.0 for MCP). A test keeps
  it equal to `package.json`.

### Documentation

- New guides in `docs/`: `ARCHITECTURE.md`, `MCP-TOOLS.md`, `AI-PROVIDERS.md` and `IPADOS-GUIDE.md`.
- README: quick start for Windows, macOS, Linux and iPadOS, where API keys are kept, the keyboard
  shortcut and chat operator tables, and links to the guides.
- In-app documentation: new pages for keyboard shortcuts, iPad and Apple Pencil, AI providers and
  Team Mode; the full list of chat commands; using `/mcp` from Claude Code.

## [1.0.0] - 2026-10-22

The first public release of OpenCraft IDE.

### Workspace

- WordCraft 0.9.0, GridCraft 0.9.0, DeckCraft 0.9.0 and PdfCraft 0.10.1 as WebAssembly panels
  (WebGPU, WebGL2 as a fallback), with live sync between the panels and the project files.
- Code editor with AI completion, a real terminal (PowerShell or Command Prompt on Windows, a PTY
  with node-pty), local Git with staging, commits and history.
- Window manager: split columns, rows and grid, maximize, minimize to the dock, picture in picture,
  focus mode; apps keep their WebAssembly state through every layout change.
- Projects: create, switch, rename, export and import as ZIP, delete with confirmation, a sample
  project with documents, sheets, slides and a PDF.
- Command palette, project search, memory, snapshots, trash, project graph, audit log.

### AI and MCP

- MCP orchestrator with Zod-validated tools for sheets, documents, slides, PDFs, files, search,
  commands, Git and panels; invalid calls go back to the model for a self-correction.
- Streamable HTTP MCP server at `/mcp` for external MCP clients.
- Providers: Claude, ChatGPT, Gemini, DeepSeek, Ollama and OpenAI-compatible endpoints, with native
  adapters, reasoning streams and replay, prompt caching and per-model token telemetry.
- Team Mode: a Team Leader plans a task graph, specialist agents work in parallel with per-file
  write locks, Mission Control shows progress, usage per role and the sub-agent transcripts.
- Full Chat Mode, floating chat, chat history, attachments, export as Markdown and JSON.

### Interface

- Separate light and dark mode for the IDE (`oc-ide-theme`); the apps in the panels switch in place.
- English by default, German optional (`oc-ide-lang`).
- One custom dropdown and flat checkboxes across the IDE, keyboard accessible.
- iPadOS: touch, Apple Pencil, Magic Keyboard, Stage Manager, home network pairing, browser mode.

### Repository

- Dual license MIT OR Apache-2.0, contributor credits, issue and pull request templates,
  contributing guide, security policy, AGENTS.md and CLAUDE.md for coding agents.
