# Contributing to OpenCraft IDE

Thanks for helping. OpenCraft is a small community project, so clear issues and focused pull requests
go a long way.

## Before you start

- Look through the [open issues](https://github.com/visoire/opencraft-ide/issues). For anything larger
  than a fix, open an issue or a discussion first so the direction is agreed.
- Problems inside WordCraft, GridCraft, DeckCraft or PdfCraft themselves belong to their repositories
  under [github.com/storytold](https://github.com/storytold).
- Read [AGENTS.md](AGENTS.md): it explains the layout, the state rules and the MCP tool rules. It is
  written for AI coding agents and works just as well for people.

## Set up

```sh
git clone https://github.com/visoire/opencraft-ide.git
cd opencraft-ide
npm install
git config core.hooksPath .githooks   # runs check:clean before every commit
npm run dev                           # http://localhost:5175/ide/
```

## Making a change

1. Branch from `main`: `git switch -c fix/short-description`.
2. Keep the change focused. Strict TypeScript, English code and comments, the existing style.
3. Interface strings go through `t()`; add the German entry to `src/app/i18n-de.ts`.
4. Interface changes follow the design rules in AGENTS.md (light paper and dark carbon, accents only
   on app marks, DM Mono labels, 44 px touch targets). Attach light and dark screenshots.
5. New MCP tools: schema in `src/mcp/schemas.ts`, implementation, a test, and a line in
   `src/docs/content.md` and [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md).
6. Behavior changes: update the README, `AGENTS.md` and the guide in `docs/` that covers it.
7. Run the checks:

```sh
npm run typecheck
npm test
npm run test:e2e
npm run check:clean
npm run build
```

8. Open the pull request with the template filled in.

## Commit messages

Short imperative subject (under 72 characters), a blank line, then what changed and why. One topic
per commit.

## License of contributions

By contributing you agree that your contribution is licensed under MIT OR Apache-2.0, like the rest
of the IDE (see [LICENSE](LICENSE)), without any additional terms.

## Upstream Attribution and Engine Separation

1. **Workspace vs. Crafting Engines:** OpenCraft provides the IDE workspace shell, window management, project tree, local companion server, and MCP orchestration layer. WordCraft, GridCraft, DeckCraft, and PdfCraft are independent open-source engines created by storytold and the ArtCraft team ([github.com/storytold](https://github.com/storytold)) under `MIT OR Apache-2.0`.
2. **Notice Preservation:** All upstream copyright notices, author credits, and license files in `versions/` and `ide/` must remain completely intact.
3. **Trademark & Compatibility Disclaimers:** OpenCraft is independent and is not affiliated with Adobe Inc. or Microsoft Corporation. References to `.docx`, `.xlsx`, `.pptx`, and `.pdf` formats are used solely for technical compatibility descriptions.
4. **As-Is Provision & IP Inquiries:** The IDE is provided "as is" without warranty of any kind. Rights holders may direct intellectual property or takedown inquiries to `visoire@proton.me`. Comprehensive legal notices are available in [docs/LEGAL.md](docs/LEGAL.md).

## Conduct

Be kind and specific. Critique code, not people. Maintainers may edit or close anything that does not
fit this.
