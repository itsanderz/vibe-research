# RESUME — pick the project back up here

*Written 2026-07-24 before a PC reinstall. This file is the durable checkpoint: everything needed to rebuild the machine and continue. The local `~/.claude` memory and `~/.pi` config do NOT survive a reinstall — this repo does.*

## Where we are

**HEAD: `4fe73a90`. Working tree clean, everything pushed. `packages/vibe-core`: 202/202 tests green.**

| Milestone | State |
|---|---|
| M0 — fork + environment | DONE |
| M1 — research core (ledger, runner, journal, dossier, tools, skill) | DONE (code); acceptance run exposed a bug, see below |
| M2 — autonomous loop (s1 skeleton, s2 role gate, s3 prereg/fuel/stop) | Code-complete at `4fe73a90` |
| M3 — verification depth (Wolfram → Lean → SAT/DRAT) | Designed, not built — `docs/research/verify-design.md` (design lives in this repo's history/scratch; re-freeze from PLAN if missing) |
| M4 — ingest + explore (persona lenses) | Not started |
| M5 — gauntlet, then open problems | Not started |

## THE NEXT THING TO DO (do this first, before M3)

**A real bug was found by the first live investigation and is NOT yet fixed.** Evidence preserved in `docs/research/evidence/2026-07-24-overclaim-bug/`.

What happened: a local Qwen3-30B investigation of *"30 divides n⁵ − n for every integer n"* tested `n ∈ [-100, 100]` — a finite sample of an **infinite** claim — and set the status to `COMPUTATIONALLY_VERIFIED`. The ledger accepted it. The dossier then printed *"The bounded/finite claim was exhaustively verified."*, which is false.

This violates `docs/research/vibe-math-v0-spec.md` §7 and acceptance criterion #6 (a universal claim tested over a finite range must remain `TESTED_SMALL_CASES`).

**Root cause:** `packages/vibe-core/src/ledger/transitions.ts` validates transition *ordering* (monotone strengthening) and *presence* of evidence, but never whether the evidence **semantically justifies** the target status. `report/phrasing.ts` then faithfully renders a false status in permitted language — the policy is only as honest as the status it trusts.

**The fix (spec):**
1. `Claim` gains `domain: "finite" | "infinite" | "unknown"`, supplied at `math_record_claim` time (tool description must explain: "for every integer n" = infinite; "for all n ≤ 20" = finite). Existing ledger lines without the field replay as `"unknown"`.
2. `assertLegalTransition` rejects `COMPUTATIONALLY_VERIFIED` when `domain !== "finite"`, with a message telling the caller to use `TESTED_SMALL_CASES` or produce a proof. `unknown` is also rejected — the finiteness must be asserted deliberately.
3. Exhaustive-verification evidence must state a scope; reject a bounded scope that does not claim to cover the whole domain.
4. **Auto-journaling:** the research tools journal their own actions (claim recorded/updated, experiment run with purpose) so the narrative exists even when the model never calls `journal_note`. In this run the journal was completely empty — optional instrumentation does not happen.
5. Regression test built directly from the preserved evidence: replaying that exact claim + evidence must now throw.

Secondary observation from the same run: the model went `UNTESTED → COMPUTATIONALLY_VERIFIED` in 12 seconds with no attack phase and no proof attempt. Consider whether the loop should require the attack phase before permitting any upgrade.

## Rebuilding the machine after reinstall

1. **Tools:** git, Node 25+, npm, `gh` (then `gh auth login`).
2. **Clone:** `git clone https://github.com/itsanderz/vibe-research.git C:\Users\drewm\code\vibe-research`; add upstream: `git remote add upstream https://github.com/earendil-works/pi.git`.
3. **Build:** `npm install --ignore-scripts` then `npm run build` from the repo root. Verify: `node packages/vibe/dist/cli.js --version`, `node scripts/check-research-extension.mjs`, and `npm test` inside `packages/vibe-core` (expect 202 passing).
4. **WSL2 + Python:** `wsl --install -d Ubuntu`; inside it ensure `python3` and `sympy` (`pip install sympy` or `apt install python3-sympy`). The experiment runner shells out to `wsl.exe -d Ubuntu -- timeout <n>s python3 <script>`.
5. **Lean 4** (needed for M3s2): inside WSL, `curl -sSf https://elan.lean-lang.org/elan-init.sh | sh -s -- -y --default-toolchain stable`. Was 4.32.1.
6. **Wolfram Engine 15** (M3s1): install the free Engine on Windows, then `wolframscript -activate` **interactively** with a Wolfram ID. Binary lives at `C:\Program Files\Wolfram Research\WolframScript\wolframscript.exe` and is often NOT on PATH — use the full path. Pass Wolfram code via `.wls` script files or single-quoted strings; PowerShell double quotes eat `$Version`-style symbols.
7. **Local models (free testing):** `winget install --id Ollama.Ollama`, then `ollama pull qwen3:30b-a3b` (18 GB) and optionally `ollama pull qwen3:8b`. Copy `docs/research/evidence/models.json.example` to `~/.pi/agent/models.json` — that is the exact provider config that worked (note the `compat` flags; local servers need `supportsDeveloperRole: false`).
8. **Model auth:** re-add keys — `/login` inside the CLI for a Claude subscription, and/or an OpenRouter key. Secrets are deliberately not stored in this repo.
9. **SAT lane (M3s3, when reached):** `cadical` is in apt (1.7.4-1); `drat-trim` is NOT packaged — build from source (`github.com/marijnheule/drat-trim`).

## Running it

```bash
# one-shot investigation
node packages/vibe/dist/cli.js --print --model "ollama/qwen3:30b-a3b" \
  "/investigate Prove or disprove: 30 divides n^5 - n for every integer n."

# autonomous loop (M2)
node packages/vibe/dist/cli.js run "<problem>"
node packages/vibe/dist/cli.js run --resume
```
Artifacts land in `./workspace/` (claims.jsonl, journal.md, runs/, dossier.md, prereg.jsonl, modelbook.jsonl).

## Working agreements (carry these forward)

- **Opus 5 orchestrates/plans/reviews; Sonnet 5 executes.** Every delegated slice is reviewed before it counts as done.
- **Single writer:** only one executor touches the repo at a time — concurrent pushes corrupt the husky pre-commit hook and lockfiles. The hook runs the full `check` gate automatically.
- **No TS enums** (`erasableSyntaxOnly`); const-object + union type instead.
- **Zero new npm dependencies** without an explicit reason.
- Validate before building forward — the bug above is why.
- Read `LEARNINGS.md`; it holds the hard-won environment and SDK gotchas.

## Not in this repo (back up separately if wanted)

- `C:\Users\drewm\Downloads\rr\ref\` — private visual reference images, deliberately gitignored (the distilled `visual-reference.md` in that folder is the shareable artifact).
- `~/.claude/` memory and `~/.pi/agent/auth.json` (secrets).
- The demo workspaces under `C:\Users\drewm\code\vibe-demos\` — the important one is already preserved as evidence here.
