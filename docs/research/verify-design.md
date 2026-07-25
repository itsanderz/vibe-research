# M3 — Verification Depth Design (`verify/`)

*Frozen design for the M3 build slices. Becomes docs/research/verify-design.md.*

## The governing principle

**Backends produce evidence; they never set status.** A verification backend returns an `Evidence` record with an honest independence level and an artifact path. Status changes still flow through the M2s2 gate: protected upgrades are *proposed*, and a checker session from a different model family approves them from artifacts. The Lean/SAT artifacts are exactly the `checkerArtifact` that `FORMALLY_VERIFIED` already requires — the pieces were built to meet here.

## The independence ladder (protocol §5, encoded)

`Evidence.independence` becomes a typed field, not prose:

| Level | Meaning | Earned by |
|---|---|---|
| `L0_REPEAT` | Same program run again | Re-execution. Worthless as verification; recorded anyway. |
| `L1_REWRITE` | Same engine, independently rewritten input | A second SymPy script written from the claim sheet |
| `L2_DIFFERENT_ENGINE` | Different engine or transparent independent implementation | Wolfram vs SymPy; hand-rolled exact arithmetic vs library |
| `L3_DIFFERENT_ARGUMENT` | Structurally different derivation | A proof by a different route; combinatorial vs algebraic |
| `L4_MACHINE_CHECKED` | External formal checker accepted it | Lean build, DRAT check |

**The derivation-provenance rule (the trap most systems miss):** every check records `derivedFrom: "claim_sheet" | "prior_script:<runId>"`. A Wolfram script *translated from* the SymPy script inherits its transcription errors and is **not** L2 — it is L1 at best. The tool enforces this: `verify_*` tools require the caller to declare `derivedFrom`, and translating a prior script caps the level automatically. Two agents reading the same source are not independent verifiers.

## Backend interface (`vibe-core/src/verify/`)

```ts
type VerifyRequest = {
  claimId: string;
  claimStatement: string;      // the frozen claim sheet text, not a paraphrase
  program: string;             // backend-specific source
  purpose: string;
  derivedFrom: "claim_sheet" | `prior_script:${string}`;
  timeoutSeconds?: number;
};
type VerifyResult = {
  backend: "sympy" | "wolfram" | "lean" | "sat";
  ok: boolean;                 // the check ran; NOT "the claim is true"
  verdict: "supports" | "refutes" | "inconclusive" | "error";
  independence: IndependenceLevel;
  artifactDir: string;         // source + raw output + engine version
  engineVersion: string;       // captured, never assumed
  evidence: string;            // formatted per spec §8, ready for the ledger
  warnings: string[];          // cheat/limit detections (see Lean lane)
};
```

Every backend captures its engine version into the artifact — a check whose engine version is unknown is not reproducible.

## Wolfram lane (slice M3s1)

- Invocation: **write a `.wls` script file and execute it**, never inline `-code` strings (LEARNINGS: PowerShell eats `$Version` and other `$` symbols in double quotes). Full path to `wolframscript.exe` (not on PATH in spawned shells).
- Runs on the Windows side (engine is installed there); Python stays in WSL. Both artifact layouts are identical.
- Records `$Version` in every artifact.
- Default job: exact symbolic identity / factorization / elimination — the class of check where a second CAS genuinely catches a first CAS's simplification assumptions.
- Extension tool `verify_wolfram {program, purpose, derivedFrom}` with a description that names the trap: *a Wolfram script transliterated from the Python one is not independent verification.*

## Lean lane (slice M3s2) — the one with teeth

Pipeline: informal proof (already `INFORMALLY_PROVED`) → agent writes Lean 4 → build in WSL → artifact → **statement-faithfulness audit** → proposal → cross-family checker approves → `FORMALLY_VERIFIED`.

- Project scaffold: a `lean/` workspace with a `lakefile` pinned to a mathlib revision; first build is slow (cached thereafter). Probe `leanAvailable()` like `wslAvailable()`; degrade honestly if absent.
- **Cheat detection (mandatory warnings, all block auto-approval):**
  - `sorry` anywhere → verdict `inconclusive`, never `supports`.
  - `axiom` declarations introduced by the agent → warning + listed in evidence (a `False` axiom proves anything).
  - `native_decide` → warning: trusts the compiler, weaker than kernel checking.
  - `#eval`-only "proofs" → not a proof; verdict `inconclusive`.
  - Unexpected `import`s of non-mathlib local files → warning.
  - Build must be checked by **exit code AND** absence of `error:` in output — a stale artifact must never read as success.
- **Statement faithfulness (the real failure mode):** a Lean proof of a *different theorem* is the classic false success. So the artifact stores the Lean `theorem` statement verbatim, and the checker session must confirm — from the claim sheet and the Lean statement alone, without the prover's transcript — that they say the same thing, explicitly checking quantifier order, domain/type (`ℕ` vs `ℤ` vs `ℝ`), strict vs non-strict inequalities, and hidden hypotheses. Rejection reason is recorded. Until that audit passes, the claim stays at `INFORMALLY_PROVED` with a "formalized, statement unaudited" note — we get ConJ's `FORMALLY_PROVED_UNAUDITED_STATEMENT` distinction without adding a status, because the proposal simply sits open.

## SAT/DRAT lane (slice M3s3)

Tooling status probed 2026-07-24 on this machine: `cadical` **is** available via apt in WSL Ubuntu (candidate 1.7.4-1); `drat-trim` is **not** packaged and must be built from source (single C file, `github.com/marijnheule/drat-trim`) — the slice must script that build and capture the binary's version/commit into every certificate artifact. No solver is currently installed, so the lane starts with an install step.

- For finite/bounded combinatorial claims: encode → solve → certificate.
- Solver in WSL (`cadical`/`kissat`), proof logging always on; UNSAT emits DRAT, checked by external `drat-trim`; SAT emits a witness model, **re-verified by an independent property check** (re-execute the defining property on the witness in a fresh run — never trust the finder).
- Certificate (possibly large) stored under the run artifact with size + checker version recorded.
- The encoding is the weak link: an encoding bug proves an unrelated formula. Mitigation shipped with the lane — every encoder must pass a **round-trip test** (decode a model back to the mathematical object and check the original property directly) and a **negative control** (a deliberately false sibling instance must come back SAT/refuted). No encoder ships without both.

## Slices

- **M3s1 — Wolfram**: backend interface + `IndependenceLevel` + `derivedFrom` provenance rule + Wolfram backend + `verify_wolfram` tool + dossier "Independent verification" section. Tests: version capture, script-file quoting, provenance capping (translated script cannot claim L2).
- **M3s2 — Lean**: scaffold + build runner + cheat detection + faithfulness audit wiring into the proposal/checker flow. Tests: `sorry` → inconclusive; `axiom`/`native_decide` warnings; a proof of a *mismatched* statement must be rejectable by the audit path (fixture).
- **M3s3 — SAT/DRAT**: solver + certificate checking + encoder round-trip/negative-control harness. Tests on a tiny known instance (pigeonhole UNSAT with DRAT checked; a satisfiable instance with witness re-verification).

Sequencing note: M3s1 unlocks genuine Level-2 replication for everything the harness already does; M3s2 is the credibility endgame; M3s3 can slip past the gauntlet without blocking it (per PLAN).
