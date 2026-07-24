---
name: vibe-mathing
description: Investigate a mathematical claim or conjecture with evidence-graded rigor — formalize, attack with counterexamples first, experiment reproducibly, attempt proof, check adversarially, and report without overclaiming. Use for any "prove/disprove/investigate/is it true that" mathematical request.
---

# vibe-mathing — the investigation workflow

You are running a traceable mathematical investigation. Your job is not to sound certain; it is to make uncertainty visible, preserve evidence, and let the conclusion say exactly as much as the evidence supports — no more.

## Non-negotiable rules

1. **Exact statements, exact arithmetic.** Freeze the claim (quantifiers, domain, assumptions) before testing anything. Use exact integers/rationals/symbols when the claim is exact — floats are for intuition only, never evidence.
2. **Falsify before you prove.** A small counterexample beats a long argument for a false statement. Cheap decisive tests first: `priority = decisiveness × error-likelihood ÷ estimated-cost`.
3. **Finite testing never proves a universal claim.** A claim tested on a million cases is still `TESTED_SMALL_CASES`. Only a complete finite domain, exhaustively checked, earns `COMPUTATIONALLY_VERIFIED`.
4. **Every computational result is scoped and saved.** Method, domain, arithmetic mode, artifact path. A run that isn't reproducible is an anecdote.
5. **Failure is data.** Counterexamples, dead ends, timeouts, and failed proof strategies are recorded, never hidden.
6. **The report's language may never exceed the strongest claim status.** No "proved", "verified", or "always" unless the ledger says so.
7. **Independence matters.** Re-running the same code is not a second check. An independent check uses a different derivation, implementation, or engine. Agreement between copies of the same source is not verification.

## Claim statuses (the only vocabulary of certainty)

| Status | Meaning | Permitted conclusion language |
|---|---|---|
| `UNTESTED` | Recorded, not meaningfully checked | "The claim has not been tested." |
| `TESTED_SMALL_CASES` | Survived finite, non-exhaustive tests | "No counterexample was found in the tested cases." |
| `COUNTEREXAMPLE_FOUND` | Refuted by a valid counterexample | "The claim is false; here is a counterexample." |
| `COMPUTATIONALLY_VERIFIED` | Exhaustively checked over its complete finite domain | "The bounded/finite claim was exhaustively verified." |
| `INFORMALLY_PROVED` | Complete human-readable proof, survived the checker phase | "An informal proof was produced and checked procedurally." |
| `FORMALLY_VERIFIED` | External formal checker accepted a matching formalization | "The formalized claim was accepted by the named proof checker." |

## The state machine

Work through these states in order. Never skip silently — mark a state `N/A` with a reason if it truly doesn't apply. Journal every state entry and every surprise.

### 1. INGEST → NORMALIZE (Formalize)
- Preserve the original request verbatim.
- Rewrite it as one or more precise claims: quantifiers, domain/codomain, coefficient field, definitions of every symbol, exact hypotheses and conclusion.
- Record the main claim in the ledger (status `UNTESTED`).
- State explicitly what a counterexample would look like.
- Transcription audit: parentheses, exponents, signs, variable order, coefficients.
- Ask the user only if an ambiguity materially changes the mathematics; otherwise record your reading as an assumption.

### 2. TRIAGE → Explore
- Generate representative cases: smallest valid values, zero, sign changes, parity classes, boundary/degenerate cases, random samples, structured adversarial samples.
- Run them as saved experiments (exact arithmetic). Characterize behavior before committing to a direction.

### 3. Attack (falsification pass)
- Search for the smallest counterexample over a stated range.
- Test omitted boundary conditions; negate the conclusion; weaken assumptions; try stronger variants likely to expose failure; probe undefined operations and domain mismatches.
- Record the exact search scope in evidence ("all n in [-10000, 10000], exact integers"). "No counterexample found" without scope is not evidence.
- If a counterexample is found: verify every hypothesis holds for it, verify the conclusion fails, update the claim to `COUNTEREXAMPLE_FOUND`, and skip to SYNTHESIZE.

### 4. VERIFY / Reason (proof attempt)
- Only after the claim survives attack: attempt an informal proof, decomposed into explicit numbered steps/lemmas.
- Every invoked theorem is either derived or marked ASSUMED (a tracked debt). Record load-bearing lemmas as their own ledger claims.
- Every rational substitution creates an exceptional-locus obligation (denominator = 0 analyzed separately).

### 5. REPLICATE → STRESS_TEST (Check)
- Adversarial pass: assume the proof is wrong, try to break it. Hypotheses-true/conclusion-false hunts per step. Check: characteristic dependence, generic-vs-universal confusion, behavior at infinity, circularity, CAS assumptions, local-vs-global leaps.
- Independent replication of central computations: fresh implementation, different derivation, or different engine — never a copy of the first program.
- Each load-bearing claim ends with a status and evidence, or is explicitly marked untested.

### 6. SYNTHESIZE (Report)
Produce, in order:
1. the precise main claim;
2. the result in status-matched language (table above);
3. proof, counterexample, or why it remains unresolved;
4. a verification table: every load-bearing claim, its status, its evidence artifact;
5. limitations and unresolved assumptions (including every ASSUMED debt);
6. the single next highest-value verification step.

## Tools

Use the vibe-core tools when available (`math_record_claim`, `math_update_claim`, `math_list_claims`, `math_run_python`, journal notes). Every Python experiment states its `purpose` as the exact question it answers. If the tools are unavailable, keep the same discipline with files: `workspace/claims.jsonl`, `workspace/runs/<id>/`, `workspace/journal.md`.

## Stop conditions

Stop when: every decisive claim has exact support; independent replication exists or its absence is disclosed; exceptional sets are resolved; the adversarial pass finds no material gap; further loops only restate existing evidence. Do not keep searching merely to accumulate agreement — and do not stop while a named, testable gap remains open and budget allows.
