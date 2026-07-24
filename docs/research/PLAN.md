# vibe-research — Plan for the Open-Science Autonomous Research Harness

## Context

Drew wants to build the missing piece of the "vibe mathing" wave: AI can already find counterexamples and proofs (Erdős problems, the claimed Jacobian counterexample, Duke's counterexample projects), but **no harness exists that runs autonomously until breakthrough while refusing to overclaim**. Verification — not generation — is the bottleneck everyone skips. The goal is an open-source, model-agnostic research harness that becomes the industry standard for open science, starting with mathematics.

Three existing docs feed this: `docs/SPEC.md` (Vibe Math v0 — claim ledger + verification statuses), `n_docs/autonomous-proof-research-agent.md` (the state-machine protocol, v1.0 here; v2.1 exists in the prior project), and `docs/conj_m1_build_spec.md` (ConJ — certified-verification engine, deferred to a later milestone). The repo `rr` also contains Karpathy's autoresearch, the model for the overnight keep/discard loop.

## Decisions locked (interview, 2026-07-24)

| Decision | Choice |
|---|---|
| Base | **Hard fork of pi** (earendil-works/pi, MIT) — keep `upstream` remote, merge periodically |
| V1 shape | Fork + math domain pack + autonomous loop; generic domains later; ConJ engine later |
| Representation language | **Grow from the ledger**: v1 = dual-rendered claim/experiment format (compressed canonical for models, plain-language for humans); log which representations crack problems; design the real AI-first language in v2 from that evidence |
| Verification back-ends (v1, sequenced) | SymPy exact → Wolfram Engine (2nd CAS) → Lean 4 (optional lane) → SAT+DRAT certificates (last) |
| Success bar | **Gauntlet first**: known-answer problems + false siblings; must prove true, refute fake, never overclaim. Only then open problems |
| Runs & budget | Local Windows PC, ~$50–200/mo API spend; checkpointed resume; efficiency first-class |
| Observability | **Live research journal** — continuous plain-language narrative of hypothesis/experiment/surprise/next-move, `tail`-able, doubles as shareable artifact |
| Explorer | V1 `explore` mode: cheap-model (DeepSeek-class) question/conjecture fan-out + triage gate before expensive verification |
| Sharing | Self-contained git-native dossiers now; hosted platform later at **wxrlds.com** |
| Naming | Harness/repo **vibe-research**, CLI **`vibe`**, math pack/skill **vibe-mathing** |
| Model knowledge | Auto-stats in ledger (per-model outcomes by role/task/cost) + curated `models/` handbook |
| Checker rule | **Enforced**: any claim reaching proved/verified requires an adversarial pass by a *different model family* in an isolated session (artifacts exchanged, not conclusions) |
| License | MIT |
| Sandbox | Experiments execute inside **WSL2** (harness on Windows) |
| Problem sources | erdosproblems.com, Drew's Whatifology/Daedalus streams, **and natural-language custom problems** (NL ingest → reading check → confirm) |
| Repo visibility | Public from first commit |
| Build routing | Fable 5 = planner/orchestrator/reviewer; Sonnet 5 = all execution (code, browser, runs); Opus only when Sonnet quality is at risk — **latest Opus generation (Opus 5 when it exists; currently Opus 4.8)** |

## Architecture

Fork of the pi monorepo. pi's packages (`pi-ai` provider layer — 20+ providers, mid-session model switching; `pi-agent-core`; `pi-tui`; `coding-agent`) stay structurally intact to keep upstream merges feasible. The `coding-agent` package is rebranded to the `vibe` CLI; research capability lands as new packages/modules, not scattered edits:

```
vibe-research/                       (fork of earendil-works/pi)
├── packages/
│   ├── pi-ai / pi-agent-core / pi-tui   (tracked from upstream, minimal diffs)
│   ├── vibe/                        (was coding-agent — CLI, rebrand, research system prompt)
│   └── vibe-core/                   (NEW — the research engine)
│       ├── ledger/        claims.jsonl + events; statuses per SPEC.md §7; content-hash dedup
│       ├── journal/       live research journal writer (plain language, append-only)
│       ├── runs/          reproducible experiment runner → WSL2 sandbox; purpose/source/result saved
│       ├── loop/          run-until-stopped engine: checkpoint, resume-from-ledger, budget meters
│       ├── roles/         reasoner / adversary / checker / librarian session management
│       ├── verify/        backends: sympy, wolfram, lean, sat (uniform Evidence interface)
│       ├── modelbook/     auto-stats recorder + models/*.md handbook
│       ├── ingest/        NL problem → candidate readings → differential check → confirm
│       ├── explore/       cheap-model fan-out + triage gate (testable? decidable? interesting?)
│       └── dossier/       report generator with phrasing policy (status→language law)
├── skills/vibe-mathing/             the v2.1 protocol as the built-in investigation workflow
├── models/                          model handbook (GPT/Claude/DeepSeek/Kimi/Qwen/GLM/Grok…)
├── benchmarks/gauntlet/             true+false-sibling pairs
└── LEARNINGS.md                     append-only; promoted into skills/handbook per learning loop
```

**Core invariants** (from SPEC.md + protocol, enforced in code, not prose):
- Claim statuses: `UNTESTED → TESTED_SMALL_CASES / COUNTEREXAMPLE_FOUND / COMPUTATIONALLY_VERIFIED / INFORMALLY_PROVED / FORMALLY_VERIFIED`; finite testing never verifies a universal claim.
- Falsification before proof construction (cheap decisive tests first: `priority = decisiveness × error-likelihood ÷ cost`).
- Status upgrades to proved/verified require the cross-model checker pass; the dossier renderer selects phrasing by status and structurally cannot say "proved" below it.
- Every experiment: exact arithmetic where the claim is exact, saved source + purpose + result, seed recorded.
- Efficiency: fingerprint dedup before execution, prompt-cache-friendly context assembly, explore-gate before expensive verification, two-strike escalation, hard budget caps per run.
- Every ledger event records the representation used; "what representation cracked it" is a first-class field — the dataset that designs the v2 language.

## Milestones (each ends runnable; indie-sized)

**M0 — Fork & ground truth (≈week 1).** Fork pi → public repo `vibe-research` (MIT, upstream remote kept). `vibe` CLI boots with rebranded identity. Environment: WSL2 distro provisioned (Python/SymPy verified inside), Wolfram Engine (free dev license) installed + smoke-tested, Lean 4 + mathlib toolchain installed (build only). New home outside Downloads: `C:\Users\drewm\code\vibe-research`.

**M1 — Research core (≈weeks 2–4).** `vibe-core`: ledger + statuses, experiment runner through WSL2, journal writer, dossier generator with phrasing policy. `/investigate` implements the protocol state machine (INGEST→NORMALIZE→TRIAGE→VERIFY→REPLICATE→EXPLAIN→STRESS_TEST→SYNTHESIZE→STOP). Single-session first — matches SPEC v0 acceptance criteria 1–10.

**M2 — Autonomous loop + roles (≈weeks 4–6).** `vibe run <problem>`: checkpointed run-until-stopped loop (autoresearch keep/discard pattern generalized: plan → experiment → verify → journal → learn), resume-from-ledger after sleep/crash. Role separation with per-role model config; **cross-model checker enforcement**; budget meters/caps; modelbook auto-stats recording.

**M3 — Verification depth.** Wolfram Engine as independent second CAS (protocol Level 2 replication); Lean lane (informal proof → formalization attempt; compiles with no `sorry` → `FORMALLY_VERIFIED`); SAT+DRAT lane for finite combinatorial claims (certificate stored, externally checked). Sequenced in that order; later two may slip to v1.x without blocking the gauntlet.

**M4 — Ingest + explore.** NL problem intake (compile → differential-test readings on concrete instances → user confirms → frozen); `vibe explore <topic>`: DeepSeek-class fan-out generating candidate questions/conjectures (seeded by Whatifology corpus / erdosproblems), triage gate scores them, survivors enter the loop.

**M5 — Gauntlet, then open problems.** ~10 benchmark pairs (true statement + subtly-false sibling) across number theory/combinatorics/inequalities. Pass = true ones reach honest status, siblings refuted with witnesses, zero overclaims, both-proved = automatic failure (memorization tripwire). Then: overnight runs on erdosproblems.com targets + Drew's streams; publish first dossiers.

**Later (explicitly staged, not dropped):** generic domain-adapter interface + second science domain; ConJ-style certified engine as the graduate version of `verify/`; the AI-first representation language designed from ledger evidence; wxrlds.com community platform consuming the dossier format.

## Verification of the build itself

- Each milestone ships with tests runnable via `npm test` (harness) and `pytest` in WSL2 (experiment tooling); statuses/phrasing policy get table-driven tests (illegal upgrade attempts must throw; dossier renderer must refuse "proved" below status).
- M1 acceptance: run SPEC.md's worked example (`n^5 − n` divisible by 30) end-to-end — claim recorded, counterexample search saved, exhaustive bounded check → `COMPUTATIONALLY_VERIFIED` for the bounded claim, universal claim stays `TESTED_SMALL_CASES` until proof; dossier language matches.
- M2 acceptance: kill the process mid-run; `vibe run --resume` continues from ledger. Checker pass demonstrably uses a different provider (ledger records model IDs).
- M5 acceptance: full gauntlet report generated from the ledger in one command.
- Live run behavior verified by actually running overnight sessions and reviewing journal + spend against budget caps.

## Risks / cautions on record

- **Jacobian claim**: the wider record still lists the conjecture as open; treat the pwhite.org claim as unverified shared-source material (matches prior LEARNINGS).
- **Fork maintenance**: mitigated by minimal diffs in upstream packages + all new code in `vibe-core`; periodic upstream merges scheduled.
- **Scope discipline**: the language, the platform, and ConJ rigor are all staged behind a working loop — the plan's ordering is the defense.
- **Security**: Reddit/X session cookies were pasted into chat on 2026-07-24 — Drew should rotate/log out those sessions.
