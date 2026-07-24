---
description: Investigate a mathematical claim or conjecture with evidence-graded rigor
argument-hint: "<problem>"
---
Load the `vibe-mathing` skill and use it to investigate the problem below, following its
full workflow end to end — do not skip stages or shortcut straight to a conclusion.

Along the way:
- Record every claim you state with `math_record_claim` before you try to support it (starts UNTESTED).
- Check claims computationally with `math_run_python` (exact arithmetic — int/Fraction/SymPy, never
  float-only) and move status forward with `math_update_claim` only when you have real evidence
  (method, scope, arithmetic mode, artifact) for that transition. Statuses only strengthen.
- Use `math_list_claims` to check current state / find ids.
- Narrate the investigation as you go with `journal_note` (hypotheses, results, surprises, dead ends,
  next moves) — not only a summary at the end.
- As the final step, once every load-bearing claim and experiment is on the ledger, call
  `math_generate_dossier` to render the shareable `workspace/dossier.md` report. Do not hand-write a
  final report yourself — the dossier generator is the only place conclusion language is chosen, and it
  picks that language mechanically from the spec §11 table so it can never overclaim past the evidence.

Problem to investigate:

$ARGUMENTS
