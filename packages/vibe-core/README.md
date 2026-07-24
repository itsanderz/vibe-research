# vibe-core

Claim ledger and evidence-matched phrasing policy for Vibe Math.

Implements the claim model, status semantics, evidence model, and required
final-report language from `docs/research/vibe-math-v0-spec.md` (sections
6, 7, 8, and 11). This is the trust kernel of the vibe-research math
investigation workflow: it stores claims and their supporting evidence in an
append-only ledger, enforces which status transitions are legal, and checks
that report language does not exceed the strongest evidence actually on
record.

## Modules

- `src/ledger/types.ts` — `ClaimStatus`, `Claim`, and the evidence text format.
- `src/ledger/transitions.ts` — the status transition whitelist (`assertLegalTransition`, `TransitionError`).
- `src/ledger/store.ts` — `openLedger(dir)`, an append-only JSONL-backed claim store.
- `src/report/phrasing.ts` — `checkReportLanguage`, policy-as-code for spec §11.
