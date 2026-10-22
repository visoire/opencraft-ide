# Security policy

## Supported versions

| Version | Supported |
| :--- | :--- |
| 1.0.x | yes |
| earlier development builds | no |

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report them privately through [GitHub security advisories](https://github.com/visoire/opencraft-ide/security/advisories/new).
Include the version or commit, your system and browser, the steps to reproduce and what an attacker
could do. You get an answer within a few days; OpenCraft is a small project, so fixes are made as
fast as one person can.

## Security model in short

- The server listens on `127.0.0.1` only. Home network mode (`npm run dev:lan`, `npm run start:lan`)
  needs a pairing token; other devices without it are refused.
- Requests from other origins are rejected (DNS rebinding and cross-site protection); the IDE pages
  and the apps get a strict Content Security Policy.
- API keys stay in `~/OpenCraft/config.json` on your machine; the browser sees masked values only.
  In browser mode without a desktop, keys stay in memory until a reload, and keeping them in the
  browser's storage is an opt-in behind a warning. Local-only mode blocks every cloud provider.
- MCP tools that change things outside the project or run commands ask for approval; external MCP
  servers run in a sandbox with an approval rule.
- No third-party scripts and no CDN.

In scope: the IDE frontend, the Node server, the MCP server and tools, home network pairing.
Out of scope: the four engines themselves (report to their repositories under
[github.com/storytold](https://github.com/storytold)) and models or providers you connect.
