Append-only build/run learnings. Newest last.

- 2026-07-24 (M0): pi's in-app branding (APP_NAME/APP_TITLE) is read from the coding-agent package's own package.json `piConfig`, resolved against its install path — a wrapper package cannot override it. `vibe` binary + process title rebranded via SDK wrapper (`packages/vibe`); interior "pi" strings remain until we either carry a tiny patch to packages/coding-agent/package.json or land an upstream PR making branding wrapper-configurable. Rule: prefer the upstream PR — smallest permanent merge burden.
- 2026-07-24 (M0): SDK embedding does NOT auto-set PI_CODING_AGENT=1 for child-process detection; wrappers must set it explicitly (upstream cli.ts does this itself).
- 2026-07-24 (M1): repo tsconfig sets `erasableSyntaxOnly` — TS `enum` is forbidden; use const-object + union-type pattern (`ClaimStatus` does this). Applies to all future vibe packages.
- 2026-07-24 (M1): spec amendment — re-recording the SAME status with new evidence (e.g. widening a tested range at TESTED_SMALL_CASES) is a legal transition; equal rank is neither strengthening nor weakening. Encoded in vibe-core transitions.ts; spec §7 should be read with this note.
