# Vibe Math for Pi — v0 Product Specification

**Status:** Draft for implementation  
**Version:** 0.1  
**Target runtime:** Pi  
**Primary use:** Exploratory mathematics with explicit evidence and verification boundaries

## 1. Product definition

Vibe Math is a Pi extension and skill that turns an open-ended mathematical prompt into a traceable investigation.

The system is not designed to make the model sound more certain. It is designed to make mathematical uncertainty visible, preserve the evidence behind each conclusion, and require adversarial checking before a result is presented as established.

A successful investigation produces more than an answer. It produces:

- a precise claim;
- explicit assumptions and domain;
- reproducible computational artifacts when computation is used;
- a record of counterexample searches;
- an informal proof or concrete counterexample when available;
- a claim ledger showing the status and evidence for each important statement;
- limitations and the next strongest verification step.

## 2. Problem statement

General-purpose language models often collapse several different things into one confident-looking answer:

- examples;
- finite computational checks;
- heuristic patterns;
- informal arguments;
- machine-checked proofs.

These categories are not interchangeable. Vibe Math provides a workflow and persistent state that keep them separate.

## 3. Design principles

### 3.1 Precision before exploration

The system must state what is being claimed before testing or proving it. Quantifiers, domain, assumptions, and edge cases are part of the claim.

### 3.2 Falsification before proof construction

The system must attempt to disprove the main claim before investing in a proof. A small counterexample is more valuable than a long argument for a false statement.

### 3.3 Evidence is scoped

Every computational result must identify the exact domain, range, sampling method, arithmetic mode, and program that produced it.

### 3.4 Computation is not an infinite proof

Testing finitely many cases may support a universal claim, but it does not prove it. A finite claim may be computationally verified only when the checked domain is complete.

### 3.5 Verification should be independent

A check should use a different derivation, implementation, representation, or tool whenever practical. Repeating the original reasoning is review, not independent verification.

### 3.6 Failure is a first-class result

Counterexamples, failed proof strategies, inconclusive checks, and tool errors must be preserved rather than hidden.

### 3.7 The final report must match the evidence

The wording of the conclusion must never exceed the strongest supported claim status.

## 4. Target users

### 4.1 Primary

- students exploring conjectures;
- engineers and scientists checking mathematical assumptions;
- researchers performing early-stage mathematical experimentation;
- developers building agentic mathematics workflows on Pi.

### 4.2 Not the primary target

- high-assurance formal verification without a proof assistant;
- autonomous claims of mathematical novelty;
- production execution of untrusted generated code;
- replacement for expert peer review.

## 5. Core user journey

The primary entry point is:

```text
/investigate <mathematical problem or conjecture>
```

Example:

```text
/investigate Prove or disprove that n^5 - n is divisible by 30 for every integer n.
```

The system then performs six phases.

### Phase 1 — Formalize

The system:

1. rewrites the prompt as one or more precise claims;
2. records the main claim;
3. identifies definitions, quantifiers, domain, and assumptions;
4. states what would constitute a counterexample;
5. asks for clarification only when ambiguity materially changes the mathematics.

**Exit condition:** The main claim is precise enough to test or reason about.

### Phase 2 — Explore

The system generates representative cases, including where applicable:

- smallest valid values;
- zero and sign changes;
- parity classes;
- boundary and degenerate cases;
- random samples;
- structured adversarial samples;
- symbolic simplifications;
- exact numerical experiments.

**Exit condition:** Initial behavior is characterized and all experiment artifacts are saved.

### Phase 3 — Attack

The system tries to falsify the claim by:

- searching for the smallest counterexample;
- testing omitted boundary conditions;
- negating the conclusion;
- weakening or removing assumptions;
- checking stronger variants likely to expose failure;
- examining undefined operations and domain mismatches.

**Exit condition:** A counterexample is found, or a documented attack pass completes without one.

### Phase 4 — Reason

If the claim survives attack, the system attempts an informal proof.

The proof must be decomposed into explicit steps or lemmas. Any step relying on a named theorem, computation, approximation, or hidden assumption must be marked.

**Exit condition:** An informal proof exists, or the investigation is explicitly marked inconclusive.

### Phase 5 — Check

The system enters a skeptical checker phase and attempts to invalidate the proposed result.

Checks may include:

- a fresh implementation;
- a different algebraic derivation;
- exact arithmetic replacing floating point;
- exhaustive enumeration for a bounded domain;
- symbolic simplification;
- independent checking of each lemma;
- comparison with known theorems supplied by the user or available tools.

In v0, this phase occurs in the same Pi session and is therefore procedural rather than fully isolated.

**Exit condition:** Each load-bearing claim has a status and supporting evidence, or is marked untested.

### Phase 6 — Report

The final report contains:

1. the precise main claim;
2. the result in evidence-matched language;
3. a proof, counterexample, or explanation of why the result remains unresolved;
4. a compact verification table;
5. links or paths to experiment artifacts;
6. limitations and unresolved assumptions;
7. the next highest-value verification action.

## 6. Claim model

Each claim ledger entry has the following logical shape:

```ts
type Claim = {
  id: string;
  statement: string;
  assumptions: string[];
  status: ClaimStatus;
  evidence: string[];
  createdAt: string;
  updatedAt: string;
};
```

### 6.1 Claim requirements

A claim statement should be independently understandable and include its mathematical scope.

Bad:

```text
It always works.
```

Good:

```text
For every integer n, 30 divides n^5 - n.
```

Evidence entries should identify what was done rather than merely state confidence.

Bad:

```text
Looks correct.
```

Good:

```text
Exhaustively checked every integer n in [-10,000, 10,000] using exact integer arithmetic; run artifact workspace/runs/...
```

## 7. Claim status semantics

Statuses describe the strongest completed verification step for the exact recorded claim.

### `UNTESTED`

The claim has been recorded but has no meaningful supporting or refuting check.

### `TESTED_SMALL_CASES`

The claim has survived a finite, non-exhaustive set of examples. Evidence must state the tested range or sampling strategy.

This status must be used for a universal claim that has only been tested on finitely many cases.

### `COUNTEREXAMPLE_FOUND`

A valid input satisfying the claim's assumptions has been found for which the conclusion fails. Evidence must include the counterexample and enough calculation to reproduce the failure.

### `COMPUTATIONALLY_VERIFIED`

The exact recorded claim has been exhaustively checked over its complete finite domain, or reduced to a complete decidable computation whose execution succeeded.

This status must not be applied to an infinite universal claim merely because a large finite range was tested.

### `INFORMALLY_PROVED`

A complete human-readable proof has been produced and survived the v0 checker phase. This is not a machine-checked guarantee.

### `FORMALLY_VERIFIED`

An external formal proof checker accepted a formalization matching the recorded claim and assumptions. The evidence must name the checker and reference the proof artifact.

V0 includes this status for forward compatibility but does not provide a built-in formal proof tool.

## 8. Evidence model

Each evidence entry should capture as many of these fields as relevant:

- method;
- scope;
- arithmetic representation;
- independent or derived status;
- artifact path;
- result;
- known limitations.

Recommended textual format for v0:

```text
method=<method>; scope=<domain/range>; arithmetic=<mode>; artifact=<path>; result=<result>; limitations=<limitations>
```

Example:

```text
method=exhaustive enumeration; scope=n in [-10000,10000]; arithmetic=exact integers; artifact=workspace/runs/2026...; result=no counterexample; limitations=does not prove the universal claim
```

## 9. Tool contracts

### 9.1 `math_run_python`

**Purpose:** Run a reproducible Python experiment or independent calculation.

**Inputs:**

- `code`: a complete self-contained Python program;
- `purpose`: the exact question the run is intended to answer;
- `timeout_seconds`: optional, 1–60 seconds.

**Outputs:**

- run identifier;
- artifact directory;
- process exit code;
- timeout flag;
- captured stdout and stderr;
- saved source and result metadata.

**Behavioral requirements:**

- use exact arithmetic when possible;
- make finite scope explicit;
- never infer proof solely from successful execution;
- write a new implementation for an independent check rather than copying the first program.

**Security boundary:** Per-run directories and timeouts are operational controls, not a security sandbox.

### 9.2 `math_record_claim`

**Purpose:** Add a precise claim to the project ledger.

**Required inputs:** statement and assumptions.

**Default status:** `UNTESTED`.

### 9.3 `math_update_claim`

**Purpose:** Attach evidence and move a claim to the strongest justified status.

**Requirements:**

- the evidence must state what check was completed;
- status changes must obey the semantics in Section 7;
- `FORMALLY_VERIFIED` requires an external formal checker artifact.

### 9.4 `math_list_claims`

**Purpose:** Display the current investigation state and expose unsupported claims.

## 10. Workspace and artifacts

```text
workspace/
├── claims.jsonl
├── problems/
└── runs/
    └── <run-id>/
        ├── experiment.py
        ├── purpose.txt
        └── result.json
```

V0 uses a project-level ledger. A future version should associate claims and runs with explicit investigation identifiers.

## 11. Required final-report language

The conclusion should use wording tied to status.

| Status | Permitted conclusion language |
|---|---|
| `UNTESTED` | “The claim has not been tested.” |
| `TESTED_SMALL_CASES` | “No counterexample was found in the tested cases.” |
| `COUNTEREXAMPLE_FOUND` | “The claim is false; here is a counterexample.” |
| `COMPUTATIONALLY_VERIFIED` | “The bounded/finite claim was exhaustively verified.” |
| `INFORMALLY_PROVED` | “An informal proof was produced and checked procedurally.” |
| `FORMALLY_VERIFIED` | “The formalized claim was accepted by the named proof checker.” |

The system must not use “proved,” “verified,” or “always” when the strongest status is only `TESTED_SMALL_CASES`.

## 12. V0 functional requirements

### FR-1 — Investigation command

`/investigate <problem>` loads the vibe-mathing workflow with the supplied problem.

### FR-2 — Persistent claim ledger

The system can record, update, and list claims in `workspace/claims.jsonl`.

### FR-3 — Reproducible Python runs

Every Python experiment is saved with its purpose, source, and result metadata.

### FR-4 — Counterexample-first protocol

The skill instructs the model to perform an attack phase before proof construction.

### FR-5 — Evidence-matched reporting

The final report states the exact verification level and does not overclaim.

### FR-6 — Failed checks are visible

Tool errors, timeouts, failed proof paths, and counterexamples are surfaced in the report.

## 13. Non-functional requirements

### NFR-1 — Inspectability

A user can inspect every program used as mathematical evidence.

### NFR-2 — Reproducibility

A saved run contains enough information to rerun the same computation in the same project environment.

### NFR-3 — Minimality

V0 remains one extension, one skill, one prompt, and a file-based ledger. No database or distributed agent framework is required.

### NFR-4 — Honest degradation

When a tool is unavailable or a check is inconclusive, the system reports the limitation and retains the weaker status.

### NFR-5 — Local-first behavior

V0 does not require a hosted service or external state store.

## 14. V0 acceptance criteria

V0 is acceptable when all of the following can be demonstrated:

1. `/investigate` starts the required workflow.
2. The main claim is recorded before substantive proof construction.
3. At least one counterexample search is attempted and saved for a suitable problem.
4. A successful Python run creates `experiment.py`, `purpose.txt`, and `result.json`.
5. A timed-out or failed run is reported without being treated as evidence.
6. A universal claim tested over a finite range remains `TESTED_SMALL_CASES`.
7. A bounded claim exhaustively checked over its complete domain may become `COMPUTATIONALLY_VERIFIED`.
8. A discovered counterexample moves the claim to `COUNTEREXAMPLE_FOUND`.
9. `FORMALLY_VERIFIED` is never used without an external checker artifact.
10. The final answer contains a verification table, limitations, and next step.

## 15. Explicit v0 limitations

- The reasoner and checker share one model context and one Pi session.
- Python execution is not securely sandboxed.
- The ledger is append-oriented JSONL and lacks investigation-level indexing.
- Evidence is stored as strings rather than structured objects.
- No built-in Lean, Coq, Isabelle, SMT, CAS, or literature-search integration exists.
- The system cannot establish mathematical novelty.
- The quality of an informal proof still depends on model and user review.

## 16. Proposed v1

V1 should prioritize verification independence rather than adding more generative features.

Recommended order:

1. isolated checker Pi session through RPC or SDK;
2. structured evidence objects and investigation IDs;
3. claim dependency graph;
4. dedicated SymPy and bounded-counterexample tools;
5. optional formal checker integration;
6. exportable investigation report;
7. literature and novelty checking as a separate, clearly labeled workflow.

## 17. Definition of done for an investigation

An investigation is complete when:

- the main claim and assumptions are explicit;
- the attack phase has been performed;
- all load-bearing claims appear in the ledger;
- all computational evidence is reproducible and scoped;
- the result is either refuted, supported, informally proved, formally verified, or explicitly inconclusive;
- the final wording does not exceed the evidence;
- limitations and the next verification action are stated.
