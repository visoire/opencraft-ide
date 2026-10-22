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
5. New MCP tools: schema in `src/mcp/schemas.ts`, implementation, a test, a line in the docs.
6. Run the checks:

```sh
npm run typecheck
npm test
npm run test:e2e
npm run check:clean
npm run build
```

7. Open the pull request with the template filled in.

## Commit messages

Short imperative subject (under 72 characters), a blank line, then what changed and why. One topic
per commit.

## License of contributions

By contributing you agree that your contribution is licensed under MIT OR Apache-2.0, like the rest
of the IDE (see [LICENSE](LICENSE)), without any additional terms.

## Conduct

Be kind and specific. Critique code, not people. Maintainers may edit or close anything that does not
fit this.
