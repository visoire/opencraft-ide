# Changelog

All notable changes to OpenCraft IDE. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

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
