# ConJ — M1 Implementation Specification (Agent Build Brief)

*Version 1.0, July 2026. This document is the contract for building the first repository. Architecture is frozen per Design Review v2. Audience: an autonomous coding agent plus human reviewers. Everything in this document is normative unless marked "guidance."*

---

## 0. Final-pass deltas — what this spec adds to the frozen synthesis

Your synthesis was correct and is adopted wholesale. The final pass found nine gaps, all fixed in this document:

1. **`verifiers/` was missing from the module tree.** Certificate checking must live outside the adapters (an adapter's `certificates.py` *produces* certificates; an independent module *checks* them, wrapping verified external checkers). Trust boundary restored in §3.
2. **`engines/` was missing.** Counterexample search, exhaustive enumeration, and the SAT bridge are their own module — they are engines the orchestrator drives, not hypothesis-side utilities.
3. **`proposer/` was missing.** The LLM interface (model config, prompt assembly, retrieval-into-context, response parsing) must be one module with one seam, so models can be swapped and prompts versioned.
4. **`artifacts/` and policy-as-code were missing.** The artifact generator that *refuses* to emit "solved/proved" below Level 3 is a module, not a norm (§10).
5. **The research-iteration loop needed three inserted steps**: fingerprint dedup check *before* evaluation, budget accounting *around* every stage, and pre-registration verification *before* the first iteration of any problem (§8).
6. **"Equal compute" for the baseline was undefined.** Defined in §11 — without it the kill test is unfalsifiable.
7. **Operational separation of hidden benchmarks.** The hidden and false-sibling sets must NOT live in the repository the building/solving agent can read. They live in a separate private store mounted only by the evaluation harness (§12.1). A hidden benchmark in the agent-visible repo is contaminated by definition.
8. **Determinism contract.** Every sandbox run takes an explicit seed recorded in the ledger; unseeded randomness is a spec violation (§6).
9. **Schema-level fixes carried from v2 that the synthesis dropped**: `Claim.status` includes `FORMALLY_PROVED_UNAUDITED_STATEMENT`; `Evidence.independence` field; fingerprint `scheme_version`; permanent `numerical_ancestry` provenance flag; evaluator hash recorded in every scored experiment.

Also added: a testing/CI section (property-based and metamorphic tests are mandatory, §13), an explicit build order for the agent (§16), and — added in revision 1.1 — the **natural-language ingestion module** (`ingest/`, §15): the user states problems in plain English; the compiler produces candidate readings, differential-tests them on concrete instances, and freezes a reading only after human confirmation. This is the system's front door and ships in M1, with B1–B5 required to pass through it.

---

## 1. Scope and non-goals of M1

**M1 delivers:** the twelve core types as code; the append-only ledger with content addressing and DAG enforcement; the sandbox; the graph adapter's candidate/evaluator/canonicalization interfaces; the evolutionary archive; the proposer seam; the counterexample engine with SAT certificates and independent checking; the baseline harness (M1.5 is included in this build); pre-registration; five development benchmarks with false siblings; tests and CI.

**M1 does not deliver:** hypothesis triage beyond stubs (M4), retrieval beyond an OEIS/House-of-Graphs lookup stub (M2.5), formalization/audit (M5), polynomials (M6), matrix multiplication (M7), portfolio selection beyond pre-registration (M8). Stubs must exist as importable modules with typed interfaces and `NotImplementedError` bodies so downstream milestones are non-breaking.

**Language:** Python 3.12+, fully type-annotated, `mypy --strict` clean. Compiled code only via existing bindings (pynauty / networkx-nauty bridge, python-sat or subprocess kissat/CaDiCaL). No hand-written C. Certificate checking wraps external verified/independent checkers, never reimplements them.

---

## 2. Non-negotiable principles (enforced in code, not prose)

1. **The evaluator loop is the core engine.** No code path may mark a candidate successful without an exact evaluator result.
2. **The IR is a ledger, not a mathematical language.** Objects are executable generators + fingerprints + optional formal terms. Invariants are computed by adapter functions on demand and cached, never schema truth.
3. **Verification status is attached to every claim, and status transitions are monotone and audited.** The only component allowed to raise a verification level is `verifiers/`; the only component allowed to set `DISPROVED` is a verified counterexample path. Enforced by making status mutation private to those modules.
4. **Policy as code.** `artifacts/` refuses "proved/solved" language below Level 3; announcements of any named conjecture require an attached literature-check log (stub in M1, mandatory field regardless).

---

## 3. Repository layout (final)

Your tree, plus the four missing modules (`engines/`, `verifiers/`, `proposer/`, `artifacts/`) and `tests/`:

```text
conj/
├── core/                    # §4 — the twelve types, enums, status machine
│   ├── problem.py
│   ├── objects.py
│   ├── representations.py
│   ├── moves.py
│   ├── claims.py
│   ├── records.py
│   ├── barriers.py
│   ├── evidence.py
│   ├── certificates.py
│   ├── failures.py
│   └── obligations.py
├── ledger/                  # §5 — append-only event log, CAS, DAG, fingerprints
│   ├── event_log.py
│   ├── content_store.py
│   ├── dependency_graph.py
│   ├── fingerprints.py
│   └── provenance.py
├── sandbox/                 # §6 — execution contract
│   ├── runner.py
│   ├── limits.py
│   └── environment.py
├── orchestrator/            # §8 — loop, budgets, bandits, archive
│   ├── loop.py
│   ├── scheduler.py
│   ├── budgets.py
│   ├── bandits.py
│   └── evolutionary_archive.py
├── proposer/                # §8.2 — LLM seam (NEW)
│   ├── interface.py
│   ├── prompts.py           # versioned prompt templates
│   ├── context.py           # retrieval-into-context assembly
│   └── parse.py
├── adapters/
│   ├── base.py              # §7.1 — DomainAdapter protocol
│   └── graphs/              # §7.2
│       ├── generators.py
│       ├── moves.py
│       ├── evaluators.py
│       ├── invariants.py
│       ├── canonicalize.py
│       └── encodings.py     # SAT/ILP encodings (renamed from certificates.py — production side)
├── engines/                 # §9 — search engines the orchestrator drives (NEW)
│   ├── counterexample.py
│   ├── exhaustive.py
│   └── sat_bridge.py        # kissat/CaDiCaL + DRAT/LRAT emission
├── verifiers/               # §9.2 — independent checking, sole authority on levels (NEW)
│   ├── levels.py
│   ├── certificate_checker.py   # wraps drat-trim / cake_lpr; witness re-checkers
│   └── independent_reeval.py    # record-score re-evaluation path
├── hypothesis/              # M4 stubs with typed interfaces
│   ├── generators.py
│   ├── dalmatian.py
│   ├── falsification.py     # NOT a stub: falsification-first gate ships in M1 (§9.1)
│   ├── novelty.py
│   ├── tightness.py
│   └── anomalies.py
├── knowledge/               # M2.5; OEIS + House of Graphs lookup stubs in M1
│   ├── retrieval.py
│   ├── trust.py
│   └── novelty_check.py
├── formalization/           # M5 stubs
│   ├── translator.py
│   ├── backtranslate.py
│   ├── differential_test.py
│   └── audit.py
├── zoo/                     # §7.3
│   ├── store.py
│   ├── tags.py
│   └── counterexamples.py
├── baselines/               # §11
│   └── plain_agent.py
├── portfolio/
│   ├── tractability.py      # M8 stub; schema ships now (§4.1)
│   ├── preregistration.py   # §11.2 — ships in M1
│   └── selector.py          # M8 stub
├── artifacts/               # §10 — policy-as-code reporting (NEW)
│   ├── generator.py
│   └── policy.py
├── interface/               # §16 — dual-audience interaction layer (NEW; ships in M1, thin)
│   ├── session.py           # one API surface both modes share
│   ├── explore.py           # guided mode: plain-language, suggestions, safe defaults
│   └── expert.py            # expert mode: full control of every knob and ledger query
├── ingest/                  # §15 — natural-language problem intake (NEW; ships in M1)
│   ├── compiler.py          # NL → candidate compiled readings
│   ├── reading_check.py     # differential testing of a reading on small instances
│   └── confirm.py           # human confirmation gate; freezes the reading
├── benchmarks/
│   ├── development/         # §12 — five benchmarks, in-repo
│   └── harness.py           # loads hidden sets from EXTERNAL private store (§12.1)
└── tests/                   # §13
    ├── property/
    ├── metamorphic/
    └── integration/
```

Note the rename: `adapters/graphs/certificates.py` → `encodings.py`. Adapters *encode and produce*; only `verifiers/` *accepts*. No import from `verifiers/` into `adapters/` or vice versa; both depend only on `core/`.

---

## 4. Core type schemas

All types are frozen dataclasses serialized as canonical JSON (sorted keys, no floats where exactness matters — rationals as `[num, den]` strings). Every type has `uid` (content hash, §5.2) and `created_at`. Shown here with essential fields; the agent should add serialization, validation, and equality by content hash.

### 4.1 Problem

```python
class Mode(Enum):
    PROVE, DISPROVE, FIND_COUNTEREXAMPLE, IMPROVE_BOUND,
    CLASSIFY, CONSTRUCT, PROVE_INDEPENDENT

@dataclass(frozen=True)
class Problem:
    statement_informal: str
    statement_compiled: "Claim"        # the compiler's reading IS a claim: versioned, auditable
    mode: Mode
    domain: str                        # adapter key, e.g. "graphs"
    verification_policy: "LevelPolicy" # minimum level for success, per mode
    tractability: "TractabilityAssessment | None"

@dataclass(frozen=True)
class TractabilityAssessment:           # schema ships in M1; assessor logic is M8
    finite_attack_surface: bool | None
    known_barriers: list[str]           # Barrier uids
    decidable_fragments: list[str]
    adjacent_recent_progress: str | None
    recommended_budget: "Budget | None"
    independence_signature: bool | None
```

### 4.2 MathObject

```python
@dataclass(frozen=True)
class MathObject:
    generator_code: str                # executable Python producing/checking the object
    generator_language: str = "python"
    fingerprint: "Fingerprint"
    formal_term: str | None            # optional Lean term (M5)
    provenance: "Provenance"
    # NO invariants field. NO canonical_form field. Adapter functions compute; ledger caches.
```

### 4.3 Claim

```python
class ClaimStatus(Enum):
    PROPOSED, TESTED, NUMERICALLY_SUPPORTED, SYMBOLICALLY_VERIFIED,
    CERTIFIED, FORMALLY_PROVED_UNAUDITED_STATEMENT, FORMALLY_PROVED,
    DISPROVED

@dataclass(frozen=True)
class Claim:
    proposition: str                    # informal, canonicalized text
    formal_statement: str | None
    status: ClaimStatus
    verification_level: int             # 0–5; only verifiers/ raises it
    assumptions: list[str]              # Claim uids
    dependencies: list[str]             # Claim uids — DAG-enforced at insert (§5.3)
    evidence: list[str]                 # Evidence uids
    numerical_ancestry: bool            # True forever if any supporting lineage was purely numerical
    nonemptiness_witness: str | None    # MathObject uid; REQUIRED for any LLM-proposed lemma
```

Status transitions are a whitelist in `core/claims.py` (e.g., `DISPROVED` reachable only via a verified counterexample event; `FORMALLY_PROVED` only from `FORMALLY_PROVED_UNAUDITED_STATEMENT` via an audit event). Illegal transition = exception + ledger event.

### 4.4 Record

```python
@dataclass(frozen=True)
class Record:
    metric: str                         # e.g. "max_edges_triangle_free_n20"
    direction: Literal["min", "max"]
    value: str                          # exact scalar (int or rational string)
    witness: str                        # MathObject uid
    certificate: str | None             # Certificate uid
    predecessor: str | None             # previous Record uid — chain, never overwrite
    verification_level: int
```

### 4.5 Barrier

```python
@dataclass(frozen=True)
class Barrier:
    statement: str
    scope: str                          # which construction families / domains
    capped_move_classes: list[str]
    bound: str | None                   # e.g. "omega >= 2.3078 via laser+CW"
    evidence: str                       # Evidence uid (citation-type in M1)
    escape_requirements: list[str]      # the INVERTED SPEC: properties any escaping object must satisfy
```

### 4.6 Remaining types (essential fields only)

`Representation(name, encoding_adapter, probe_scores: dict, fingerprint_scheme)` — probe scores are empirical, written by bandit probes only.
`ResearchMove(name, input_types, output_types, preconditions, preserved_invariants, possible_losses, generated_obligations, implementation_ref)` — `preserved_invariants` are runtime-sampled (§13).
`Experiment(parent_state, move, inputs, outputs, evaluator_results, evaluator_version_hash, seed, budget_spent, sandbox_env_hash, failures, proof_obligations)` — `evaluator_version_hash` mandatory on every scored experiment.
`Evidence(type, source, exactness, certificate, verifier, independence)` — `independence: Literal["same_impl", "independent_impl", "verified_checker"]`; exhaustive-search evidence at `same_impl` caps at Level 2.
`Failure(failed_claim, reason, violated_constraint, smallest_counterexample, active_bottleneck, suggested_repair)` — unchanged from the original doc.
`ProofObligation(claim, route_hints, status, assigned_engine)`.
`Certificate(kind, payload_ref, checker, checker_version, size_bytes)` — `kind ∈ {drat, lrat, exhaustive_enum, witness, groebner, lp_dual, interval, lean}` (last four post-M1); payload stored in CAS, may be large.

---

## 5. Ledger

### 5.1 Append-only event format

Newline-delimited JSON (one file per problem run, plus a global index; SQLite index over uids for queries). Every event:

```json
{
  "event_uid": "<hash of this event body>",
  "prev_event_uid": "<hash chain within the run>",
  "run_id": "...",
  "timestamp": "...",
  "actor": "orchestrator|proposer|engine:<name>|verifier|human:<id>",
  "kind": "experiment|claim_created|status_transition|record_set|preregistration|policy_violation|...",
  "body_ref": "<CAS hash of the full typed object>"
}
```

Rules: no event is ever mutated or deleted; corrections are new events referencing the corrected one; the hash chain makes tampering evident; `policy_violation` events (illegal status transition attempts, sandbox breaches, budget overruns) are first-class and reviewed.

### 5.2 Content addressing

`uid = sha256(canonical_json(object))` with these normalizations: sorted keys; code fields normalized (strip trailing whitespace, normalize line endings — do NOT strip comments or reformat: the code the LLM wrote is the artifact); rationals in lowest terms; timestamps and uids excluded from their own hash. Experiments are identified by `sha256(generator_uid + inputs + evaluator_version_hash + seed + env_hash)` — a re-run with identical identity is a cache hit and MUST NOT re-execute (return the stored result, emit a `cache_hit` event).

### 5.3 Dependency DAG enforcement

`dependency_graph.py` maintains claims as a DAG. On any claim insert or dependency edit: cycle check (DFS from the new edges); on violation, reject, emit `policy_violation`, raise. Also provided: `support_closure(claim)` (transitive dependencies with statuses — used by verifiers to ensure nothing certified rests on anything below its own level) and `equivalence_flag(claim_a, claim_b)` hook for the circular-lemma sniff test (heuristic in M1: normalized-statement similarity + shared fingerprint of quantifier structure; flag for human review, never auto-reject).

### 5.4 Fingerprints

`Fingerprint(scheme: str, scheme_version: int, value: str)`. Graph scheme v1: nauty canonical form → sha256. Fingerprints from different `(scheme, version)` pairs are incomparable — never merged. Design rule: false-merge is forbidden; missed-duplicate is acceptable. Any new scheme version starts a fresh namespace.

---

## 6. Sandbox execution contract

`sandbox.run(code, entrypoint, inputs, limits, seed) -> SandboxResult`

Requirements: separate OS process; CPU-time limit (default 30 s), wall-clock limit (default 60 s), memory limit (default 1 GiB) via cgroups or `resource` + watchdog; **no network** (fail-closed: verify by attempting a connection in the harness test suite); filesystem = private tmpdir, read-only access to an allowlisted import set (`networkx`, `pynauty`, `itertools`, `math`, `fractions`, `random` — seeded, see below); no subprocess spawning.

Determinism: the runner injects `random.seed(seed)` and forbids `time`-based entropy; `seed` is recorded in the Experiment. Two runs with identical experiment identity must produce identical outputs; the integration suite verifies this on every benchmark evaluator.

`SandboxResult { status: ok|timeout|oom|exception|policy_breach, stdout, value_ref, resource_usage, breach_detail }`. Timeouts and OOMs are *normal data* — they are recorded as experiment outcomes, not errors, and feed the archive as negative signal.

---

## 7. Adapter and zoo interfaces

### 7.1 DomainAdapter protocol (`adapters/base.py`)

```python
class DomainAdapter(Protocol):
    key: str
    def candidate_schema(self) -> type: ...
    def canonicalize(self, obj) -> tuple[CanonicalForm, Fingerprint]: ...
    def invariants(self, obj, names: list[str]) -> dict[str, Exact]: ...   # computed on demand
    def evaluators(self) -> dict[str, Evaluator]: ...
    def moves(self) -> dict[str, ResearchMove]: ...
    def encodings(self) -> dict[str, Encoder]: ...      # e.g. to SAT
    def zoo_tags(self, obj) -> list[str]: ...
```

`Evaluator` contract: `evaluate(problem, candidate) -> Evaluation` where `Evaluation { score: Exact, passed: bool, features: dict, is_anomaly: bool, counterexample: MathObject | None, certificate_draft: ... }`. Evaluators must be **exact** (int/rational/bool — a float anywhere in an Evaluation is a type error), **pure**, **versioned** (module content hash = `evaluator_version_hash`), and **fast by default** (guidance: p95 under 100 ms on benchmark-scale inputs; anything slower must be budget-declared).

### 7.2 Graph adapter specifics

Candidate = graph6-encoded graph or a generator program returning `networkx.Graph`. Canonicalization via nauty (pynauty); never hand-rolled. Invariant library v1 (all exact): order, size, degree sequence, connectivity, girth, clique number (exact, small n), chromatic number (exact via SAT for small n), independence number, planarity, diameter, triangle count. Encodings v1: k-coloring → CNF; clique/independent-set → CNF; forbidden-subgraph → CNF. Moves v1: add/delete/contract edge, add/delete vertex, disjoint union, complement, subdivision, Mycielski construction, random-regular sample (seeded). Each move declares `preserved_invariants` honestly (e.g., Mycielski: preserves triangle-freeness, increments chromatic number).

### 7.3 Zoo

`zoo.store.add(obj, tags, source_experiment)` — dedup by fingerprint; tags include benchmark relevance, extremal-for-<invariant>, counterexample-to-<claim uid>, anomaly-<feature>. The zoo seeds evolutionary populations and the falsification gate. Ship with an initial import: all connected graphs on ≤ 9 vertices (nauty geng), plus named graphs (Petersen, Grötzsch, Mycielski ladder, icosahedron, Paley graphs ≤ 17).

---

## 8. Orchestrator: the executable loop

### 8.1 `research_iteration` (normative revision of your draft)

Your draft, with the three inserted steps (**bold**):

```python
def research_iteration(problem, archive, ledger, budget, prereg):
    assert prereg.is_registered(problem)              # ① no unregistered work

    representation = select_representation(problem, archive, strategy="bandit_probe")
    context = retrieve_relevant_history(problem, representation, ledger)
    proposal = proposer.propose_generator(problem, representation, context)

    with budget.charge("propose"):                    # ② every stage metered
        generator = parse_and_validate(proposal)

    fp = fingerprints.of_generator(generator)
    if ledger.seen(fp):                               # ③ dedup BEFORE execution
        ledger.append_cache_hit(fp); return

    with budget.charge("execute"):
        result = sandbox.run(generator, limits=budget.sandbox_limits, seed=budget.next_seed())

    with budget.charge("evaluate"):
        evaluation = adapter.evaluators()[problem.evaluator_key].evaluate(problem, result)

    ledger.append_experiment(generator, result, evaluation,
                             evaluator_version_hash=..., seed=...)
    archive.update(result, evaluation.score, evaluation.features)
    zoo.maybe_add(result, evaluation)

    if evaluation.is_anomaly:
        verifiers.independent_reeval.enqueue(result, evaluation)   # records re-checked before acceptance
        hypothesis.anomalies.enqueue(result)                        # M4 consumer; queue ships now
    if evaluation.counterexample is not None:
        engines.counterexample.certify(evaluation.counterexample, problem)
    if evaluation.suggests_hypothesis:
        hypothesis.falsification.enqueue(evaluation.hypothesis)     # falsification-FIRST, ships in M1
```

### 8.2 Proposer seam

`proposer.propose_generator(problem, representation, context) -> str` (code). Prompts are versioned files in `proposer/prompts.py`; every proposal event records prompt version, model id, and context refs. The proposer never sees hidden-benchmark reference results (enforced by the harness, §12.1). Parse failures are recorded experiments with `status=proposal_invalid` — they are data.

### 8.3 Evolutionary archive

MAP-Elites-style: behavioral descriptor = adapter-chosen feature vector (v1 for graphs: order, size, girth bucket, chromatic bucket); one elite per cell by exact score; sample parents by cell-coverage bandit; islands (default 4) with periodic migration. Archive state is derivable from the ledger (rebuildable by replay — verify this in integration tests).

### 8.4 Budgets

`Budget { cpu_core_seconds, llm_tokens, sandbox_limits, seed_sequence }` — charged per stage, persisted per problem, enforced hard (overrun = `policy_violation` + halt). This is the substrate for the equal-compute baseline comparison.

---

## 9. Engines and verifiers

### 9.1 Engines

`engines/exhaustive.py`: enumerate all graphs in a stated finite class (via nauty geng where possible) and check a property; output = `Evidence(type=exhaustive, independence=same_impl)` plus an enumeration certificate (class definition, generator identity, count, per-class result hash). Level 2 by itself; Level 3 requires either a second independent enumeration (different tool/author — geng vs. in-house counts cross-check) or a verified enumerator (future).

`engines/counterexample.py`: given a universal claim, search for a witness violating it — strategies: zoo scan first (cheapest), then archive-guided proposal, then SAT (encode negation, solve). Any witness found is **re-verified from scratch by `verifiers/`** (independent re-check of the defining property, not trust of the finder) before `DISPROVED` is set.

`engines/sat_bridge.py`: CNF in, result out, **always with proof logging on** (`--proof` DRAT). UNSAT results carry the DRAT file into CAS.

### 9.2 Verifiers (sole authority over `verification_level`)

`certificate_checker.py`: DRAT/LRAT checked by external `drat-trim` and, when available, `cake_lpr` (both wrapped via subprocess with version capture). Witness certificates re-checked by re-executing the property check in a *fresh* sandbox with an independent code path where one exists. `independent_reeval.py`: any record-breaking score or anomaly is re-evaluated before the Record/anomaly is accepted — different process, re-canonicalized input, evaluator re-imported from CAS.

Level assignment (M1 subset): L1 numerical/heuristic (should not occur in graphs v1), L2 exact computation same-impl, L3 certificate independently checked (DRAT via drat-trim/cake_lpr; witness via independent re-check; exhaustive via cross-enumeration), L4/L5 post-M5. `levels.py` computes a claim's level as `min(own evidence level, weakest level in support_closure)` — a certified claim resting on a tested lemma is L2, automatically.

---

## 10. Artifacts and policy

`artifacts/generator.py` renders a run into the research artifact: compiled problem + reading diff, claims with statuses and levels, records chain, certificates inventory (kinds, sizes, checkers), counterexamples with witnesses, budget report, pre-registration reference, reproduction instructions (exact uids + `conj replay <run_id>`), and a plain-language narrative. `artifacts/policy.py` enforces: the strings "proved", "solved", "resolved" may appear only for claims at level ≥ 3 (template-level enforcement — the renderer selects phrasing by level: L2 = "verified exhaustively for n ≤ N (uncertified enumeration)", L3 = "certified", etc.); any artifact mentioning a named conjecture requires a non-empty `literature_check_log` field (M1: may contain a manual entry; may not be absent).

---

## 11. Baseline protocol and pre-registration

### 11.1 Baseline (`baselines/plain_agent.py`)

The baseline is a plain LLM agent (same model as the proposer) with: the problem statement, a Python sandbox with the same allowlisted libraries, the same wall-clock and token budget, and *nothing else* — no ledger, no archive, no zoo, no adapters. **Equal compute defined as:** identical `llm_tokens` cap, identical total sandbox `cpu_core_seconds`, identical wall-clock cap, same model and temperature settings, N ≥ 3 independent runs per problem per system with different seeds. Its outputs are scored by the same harness and the same verifiers (its claimed counterexamples get independently re-checked; its claimed proofs are scored at the level its evidence actually earns — typically ≤ 2). Comparison metrics: success at required level (primary), best level reached, budget-to-first-certified-result, false-claim count (any assertion the verifiers reject — this is where the architecture should dominate).

### 11.2 Pre-registration format

Written to the ledger *before* the first iteration; immutable:

```json
{
  "kind": "preregistration",
  "problem_uid": "...",
  "engine_config_hash": "...",
  "budget": {"llm_tokens": ..., "cpu_core_seconds": ..., "wall_clock_hours": ...},
  "success_criteria": {"mode": "...", "required_level": 3},
  "sibling_uid": "... | null",
  "baseline_planned": true,
  "registered_at": "...",
  "registrant": "human:<id> | portfolio"
}
```

Every attempt appears in the reporting ledger regardless of outcome. The kill-test report is generated *only* from pre-registered attempts.

---

## 12. Benchmarks

### 12.1 Operational separation (critical)

`benchmarks/development/` (in-repo): the five below — the building agent may read them; they tune the engine. The **hidden** set and its false siblings live in a separate private repository/store readable only by `benchmarks/harness.py` at evaluation time via an injected path/credential; they are composed by humans, fresh where possible, never pasted into any prompt, issue, or log the proposer can see. Any hidden problem that leaks into agent-visible space is burned: retired and replaced.

### 12.2 Benchmark record format

```json
{
  "benchmark_uid": "...",
  "statement_true": "...",
  "statement_false_sibling": "...",
  "sibling_delta": "one-line description of the minimal perturbation",
  "domain": "graphs",
  "mode": "PROVE | CONSTRUCT | ...",
  "allowed_libraries": [...],
  "evaluator_key": "...",
  "budget": {...},
  "success_criteria": {"true_statement": "level>=3 certificate or bounded-exhaustive to n>=N",
                        "false_sibling": "counterexample witness at level>=3"},
  "reference_result_ref": "<hidden-store ref, null for development set>",
  "notes": "known-in-literature flags, Mathlib presence, etc."
}
```

Scoring per pair: full credit = certifies the true statement (at the stated bound) AND refutes the sibling with a certified witness; proving both = memorization flag + automatic failure; refuting both = evaluator or compiler bug, investigate.

### 12.3 The five development benchmarks

**B1 — Mantel/Turán (PROVE, bounded).** True: every triangle-free graph on n vertices has ≤ ⌊n²/4⌋ edges; verify exhaustively for n ≤ 10 (geng + cross-count) and by SAT (encode "triangle-free ∧ edges > ⌊n²/4⌋", expect UNSAT + DRAT) for n ≤ 14. Sibling: bound ⌊n²/4⌋ − 1 — expect counterexample K⌊n/2⌋,⌈n/2⌉. Note: statement is in Mathlib (novelty check should eventually flag it — that's a feature).

**B2 — Planar minimum degree (PROVE, bounded).** True: every planar graph has a vertex of degree ≤ 5 (exhaustive n ≤ 11 on planar graphs). Sibling: degree ≤ 4 — expect the icosahedron as counterexample (tests zoo scan: it's seeded).

**B3 — Ramsey R(3,4) = 9 (PROVE + DISPROVE pair, fully certified).** True: every 2-coloring of K9 contains a red K3 or blue K4 — SAT UNSAT + DRAT + cake_lpr check (Level 3, the flagship certificate path). Sibling: same statement on K8 — expect an explicit 2-coloring witness (SAT satisfiable), independently re-verified.

**B4 — Rédei's theorem (PROVE, bounded).** True: every tournament has a Hamiltonian path (exhaustive over tournaments n ≤ 8). Sibling: every tournament has a Hamiltonian cycle — counterexample: any transitive tournament (also tests move library: transitive tournaments are constructible).

**B5 — Triangle-free chromatic construction (CONSTRUCT).** Task: construct a triangle-free graph with chromatic number ≥ 5, delivered as witness + two certificates (triangle-freeness by independent re-check; χ ≥ 5 via SAT UNSAT for 4-coloring + DRAT). Sibling (impossibility flavor): construct a triangle-free graph with χ ≥ 5 on ≤ 20 vertices — expect certified failure/report (smallest known has 22 vertices; exhaustive refutation is out of budget-reach, so the correct engine behavior is a mapped-frontier report, NOT a false claim — this benchmark tests honesty under inability). Also seeds a `Record`: smallest triangle-free χ ≥ 5 graph found.

Coverage check: exhaustive certificates (B1, B2, B4), SAT/DRAT both polarities (B1, B3, B5), witness certificates (B2, B3, B4), CONSTRUCT mode + Record (B5), zoo utilization (B2, B4), honesty-under-inability (B5 sibling), memorization tripwire (all siblings).

---

## 13. Testing and CI (mandatory, not guidance)

Property-based tests (Hypothesis library) for: canonicalization (isomorphic inputs → identical fingerprint; non-isomorphic random pairs → distinct with graph6 cross-check), every evaluator (exactness — output types contain no floats; determinism under fixed seed; agreement with a naive reference implementation on small random instances), CAS round-trips, DAG enforcement (random graphs of claims with injected cycles must be rejected). Metamorphic tests for every move: apply move → recompute declared `preserved_invariants` → must hold on ≥ 1000 random cases per move per CI run. Integration: full loop on B1–B5 truncated budgets; archive rebuild-from-ledger equivalence; sandbox escape suite (network attempt, fork attempt, oversized alloc, infinite loop — all must be contained and recorded); determinism replay (same run twice → identical ledger event bodies modulo timestamps). CI gates merge on: mypy --strict, all tests, and a `policy_violation`-free integration run.

---

## 14. Definition of done for M1 + kill-test instrumentation

M1 is done when: (1) all five development benchmarks run end-to-end under pre-registration with the full loop, and B3 achieves Level 3 with cake_lpr-checked DRAT; (2) the baseline harness runs the same five at equal compute and the comparison report renders; (3) siblings are refuted with certified witnesses and no benchmark shows the both-proved memorization flag; (4) the artifact generator produces a complete artifact for B3 and refuses "proved" phrasing on an L2-only variant (tested); (5) test suite green, replay determinism verified; (6) every stub module imports cleanly with typed signatures. Kill-test instrumentation (consumed at M3): the reporting query "all pre-registered attempts with outcomes, levels, budgets, baseline deltas" must be a single function call from day one.

---

## 15. Natural-language ingestion (`ingest/`) — ships in M1

Natural language is the system's front door: the user states what they want to prove, refute, construct, bound, or experiment with, in plain English (or with fragments of notation), and everything downstream begins from that. The M1 flow:

**Step 1 — Compile.** `compiler.py` (an LLM call through the `proposer/` seam, with its own versioned prompts) parses the informal statement into one or more *candidate readings*: each a full `Problem` draft — mode, domain, quantifier structure, hypothesis and conclusion as a `Claim`, and a proposed evaluator from the adapter's registry. If the statement is ambiguous, the compiler must produce the distinct plausible readings rather than silently picking one. If the domain is unsupported, it says so and stops.

**Step 2 — Check the reading against reality.** `reading_check.py` differential-tests each candidate reading before the user ever confirms it: instantiate the hypothesis on small concrete objects (drawn from the zoo) and show the user which instances the reading classifies as satisfying/violating the hypothesis and conclusion. A reading that classifies the Petersen graph the wrong way is caught here, in seconds, instead of after a week of compute. Where the mode is IMPROVE_BOUND, the check also confirms the metric and direction against a known data point.

**Step 3 — Confirm and freeze.** `confirm.py` renders the chosen reading back in both plain English and precise form, records the user's confirmation (or edits) as a `human:` ledger event, freezes `statement_compiled`, and hands off to pre-registration. No engine budget may be spent on a problem whose reading is unconfirmed — enforced in `orchestrator/loop.py` alongside the pre-registration assertion. Later corrections create a *new* Problem version with a rendered diff of readings; runs are never silently re-pointed.

Unattended mode (guidance): when no human is present, the compiler may proceed on its highest-confidence reading only if the readings are non-divergent (all candidates classify the probe instances identically); otherwise the problem parks in `AWAITING_CONFIRMATION`. Divergent readings are never auto-resolved.

The five development benchmarks must themselves be ingested through this pipeline (their informal statements in, confirmed readings out) rather than hand-compiled — this makes B1–B5 the ingestion module's test suite for free, and guarantees the front door works before any hidden problem arrives through it.

---

## 16. Interaction layer — two audiences, one engine

The system must serve a curious beginner and a working mathematician without forking into two products. The design rule: **one engine, one ledger, one API (`interface/session.py`) — two presentations over it.** Capability is never gated by mode; only defaults, vocabulary, and verbosity change.

**Explore mode** (`explore.py`) — the default. Plain-language throughout: the user types a question or a hunch ("is it true that...?", "what's the biggest graph where...?", "show me something surprising about..."); the ingestion pipeline (§15) does its reading-confirmation with concrete pictures and examples rather than quantifier notation; budgets default to small and safe; results come back as the artifact narrative first (what was found, what it means, how sure we are — the verification level translated into plain language: "checked exhaustively for all graphs up to 10 vertices" rather than "Level 2"). Explore mode may also *suggest* — nearby questions from the zoo and hypothesis queue ("you asked about triangles; here's what happens with squares"). Nothing in explore mode can overstate: the same `artifacts/policy.py` phrasing rules apply, so a beginner is structurally protected from believing something was proved when it was only tested.

**Expert mode** (`expert.py`) — everything exposed: direct authoring or editing of compiled readings (skipping the guided confirmation), budget and scheduler control, representation pinning/banning, move-library extension, raw ledger queries (the full experiment DAG, support closures, certificate payloads), batch pre-registration, baseline invocation, and hint injection mid-run. Expert mode is also where the steering channel (§15, human events) lives in its full form.

Both modes write to the same ledger with `actor: human:<id>`, so a session that starts as exploration and gets serious loses nothing — an expert can pick up a beginner's run and vice versa. M1 ships this as a CLI/notebook API with the two modes; a web front end is deliberately out of scope until the engine survives its kill test. Guidance: when explore-mode language is ambiguous between readings, the differential-test step of §15 does the disambiguation *with examples, never with notation* — this single decision is most of what makes the system usable by non-mathematicians.

---

## 17. Build order for the agent

1. `core/` types + status machine + tests.
2. `ledger/` (CAS → event log → DAG → fingerprints) + tests.
3. `sandbox/` + escape suite.
4. `adapters/graphs/` canonicalize + invariants + evaluators (+ property tests) — evaluators before anything that uses them.
5. `engines/` (sat_bridge with DRAT logging → exhaustive → counterexample) + `verifiers/` together, with B3 as the tracer bullet: get K9/K8 certified end-to-end before generalizing.
6. `zoo/` seed import; `orchestrator/` (archive → budgets → loop); `proposer/` seam with prompts v1.
7. `ingest/` (compiler → reading_check → confirm), then `benchmarks/` harness + B1–B5 *ingested through it* (§15); `portfolio/preregistration.py`; `baselines/plain_agent.py`.
8. `interface/` session API with explore/expert modes (§16); `artifacts/` with policy tests; stubs for hypothesis/knowledge/formalization/portfolio-selector; CI wiring.
9. Full integration run of all five pairs + baseline; generate the M1 report artifact.

Guidance for the agent: when a decision is underdetermined by this spec, prefer the choice that keeps the ledger append-only, the evaluators exact, and the trust boundary between producers and verifiers intact — and record the decision as a ledger `note` event so humans can review it.
