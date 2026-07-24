# M2 — Autonomous Loop Design (`vibe run`)

*Frozen design for the M2 build slices. Lives at docs/research/loop-design.md once committed.*

## Shape

`vibe run "<problem>"` / `vibe run --resume` — a Node entry in packages/vibe that drives **programmatic agent sessions** via pi's SDK (`createAgentSession` + the research extension), not the interactive TUI. The loop is the conductor; sessions are musicians; the workspace is the score.

## The iteration

```
plan → act → gate → journal → learn → checkpoint
```

1. **plan** — LoopController reads ledger + journal + loop-state, decides the next objective for this iteration (continue protocol state, address a pending obligation, or run a pre-registered empirical experiment). Deterministic given state; the decision is journaled with its reason.
2. **act** — spawn a fresh agent session for the appropriate ROLE with surgical context (claim sheet + relevant artifacts only, never the whole history). The session works with the research tools; the loop caps its turns/tokens.
3. **gate** — protected-status enforcement (below). Anomalies (claimed proof, record score, counterexample) queue a checker obligation instead of taking effect.
4. **journal** — iteration summary appended (what was attempted, result, surprise) — the live "watch it think" stream.
5. **learn** — modelbook.jsonl gets {role, model, provider, task-type, tokens, cost, outcome, overclaim-incidents}.
6. **checkpoint** — loop-state.json written atomically; crash/sleep-safe.

## Roles & the checker gate (the trust core)

Config `workspace/vibe.config.json`:
```json
{
  "roles": {
    "reasoner":  {"model": "openrouter/anthropic/claude-sonnet-5"},
    "adversary": {"model": "openrouter/deepseek/deepseek-v4"},
    "checker":   {"model": "openrouter/openai/gpt-5.3"},
    "librarian": {"model": "openrouter/anthropic/claude-haiku-4.5"}
  },
  "budget": {"maxTokens": 5000000, "maxWallClockHours": 8, "maxIterations": 100}
}
```

**Enforcement (tool-level, not prompt-level):** the research extension gains a session role parameter. In reasoner/adversary/librarian sessions, `math_update_claim` REFUSES upgrades to `INFORMALLY_PROVED`/`FORMALLY_VERIFIED` — it records a *proposed* transition (new ledger event kind) and tells the model a checker will decide. Only a **checker session** may apply protected upgrades, and the loop refuses to start a checker session whose model *family* (provider+vendor prefix) equals the proposing session's. Checker sessions receive artifacts (claim sheet, proof text, experiment paths), never the reasoner transcript. Every ledger event records `actor: role:model-id` — auditable independence.

`COUNTEREXAMPLE_FOUND` additionally requires: the checker session re-verifies the witness with a FRESH experiment (different implementation) before the status lands. (Protocol: verify hypotheses, verify conclusion failure, verify distinctness.)

## Budgets & provider health

- Charged per session from pi SDK usage; accumulated in loop-state; hard stop + journal entry on overrun (never silent).
- 402/insufficient-balance/exhausted-key errors mark the provider unhealthy in loop-state; the role falls back per an ordered `fallbacks` list in config; no fallback → loop pauses with a clear journal entry (`AWAITING_FUEL`), resumable.
- Two-strike rule per objective: 2 failed sessions → escalate (different model or park as obligation), never loop blindly. Same error twice after two different fixes = stop and journal.

## Empirical lane (VISION: growing-CA-style)

Before the first empirical iteration on a problem: `workspace/prereg.json` — {hypothesis, metrics[{name, direction, successThreshold}], budget} written and journaled. Empirical iterations run experiments via the existing runner, score against pre-registered metrics only, keep/discard recorded in ledger as TESTED evidence. No post-hoc metric swaps: prereg is append-only (amendments are new entries referencing the old).

## Resume & stop

- `--resume`: loop-state.json + ledger replay reconstruct everything; a crash mid-iteration re-plans that iteration (ledger dedup makes re-execution cheap).
- Stop when: main claim reaches a terminal/target status AND checker-confirmed; or STOP conditions of the protocol hold (no material gaps, no new information); or budget exhausted; or user interrupt. Stopping reason always journaled + dossier regenerated at stop.

## Build slices (each delegated, reviewed, pushed)

- **M2s1**: loop skeleton — config load/validate, LoopController with plan/act stubs driving ONE real SDK session, budgets, atomic checkpoint, `--resume`, `vibe run` CLI entry. Unit tests for state/budget/resume (no API needed); SDK integration test gated on key availability.
- **M2s2**: roles + protected-transition gate (proposed-transition ledger events, role-aware extension, family-difference enforcement) + modelbook stats. Tests: gate refuses same-family checker; proposed events replay correctly.
- **M2s3**: empirical prereg lane + provider-health/fallbacks + stop conditions + `AWAITING_FUEL` pause + dossier-on-stop. Integration: full short run against a live model when credits exist.
