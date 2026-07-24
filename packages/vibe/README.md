# vibe

Thin wrapper package that gives vibe-research its own `vibe` binary.

It imports `main` from `@earendil-works/pi-coding-agent` (the upstream
[earendil-works/pi](https://github.com/earendil-works/pi) coding agent SDK)
and invokes it programmatically, rather than forking or mass-editing the
upstream package. Functionally this is the same CLI as upstream `pi` today;
vibe-specific behavior lands here incrementally.

Build: `npm run build` (produces `dist/cli.js`). Run: `vibe` or
`node dist/cli.js`.
