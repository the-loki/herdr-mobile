# 0005 — React + Tailwind, built by Vite

**Status:** accepted · 2026-11-10

## Context

The first cut of the client was one hand-written HTML file, a stylesheet and a
vanilla module: no build step, nothing to install. It worked, but the UI needs
derived state (snapshot + selection + poll + SSE), a dialog flow, and two
responsive layouts; hand-rolled DOM updates were becoming the bulk of the code.

## Decision

- **React 19** for the client, **Tailwind CSS 4** for styling, **Vite 8** to
  build. Output goes to `web/dist`, which the Node server serves.
- The UI dependencies live in `web/package.json`; the server stays
  dependency-free (Node built-ins only) so `npm test` needs no install.
- Tailwind semantic colours are CSS variables mapped through `@theme inline`
  (`bg-bg`, `bg-surface`, `text-fg`, `border-line`, `bg-accent`, …), so a
  component never hard-codes a palette and dark/light follows one block.
- Production builds are produced by the plugin manifest's `[[build]]` steps
  (`npm --prefix web ci` then `npm --prefix web run build`). A local
  `herdr plugin link` skips them, so `src/main.mjs` refuses to start with a
  clear message when `web/dist/index.html` is missing.

## Consequences

- `herdr plugin install` from GitHub needs a Node toolchain on the machine,
  once. The server itself still needs only `node`.
- `web/dist` and `node_modules` are not committed; the container test builds
  them the same way a user would.
- The bundle is ~240 kB (~75 kB gzipped) for the whole client, which is fine
  over a tailnet and cached by the service worker afterwards.
