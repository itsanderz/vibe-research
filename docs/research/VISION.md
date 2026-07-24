# vibe-research — North Star

*What this system is ultimately for. Milestones live in PLAN.md; this document is why they exist and where they point. (Drew, 2026-07-24.)*

## The one-sentence version

Make rigorous discovery feel like conversation — so that anyone, expert or not, can ask any question about reality, run real experiments on it, and get answers whose certainty is honestly graded.

## Principles

1. **Anyone can ask.** ChatGPT made talking to models easy; we make *researching* with them easy. A curious teenager and a working physicist use the same engine — only vocabulary, defaults, and depth change. Plain language in; plain language out; the rigor machinery underneath is never dumbed down, only translated.
2. **Crazy questions welcome, evidence mandatory.** "Can we train a family of local differentiable physical laws such that persistent structures emerge that model and control their own futures?" is a legitimate input. So are the questions people are afraid to ask. The ledger doesn't judge questions — it grades answers. Respect the established science; remember it has been wrong before; the way out is proof, not vibes.
3. **First principles + stolen fire.** Derive from scratch AND mine what worked elsewhere (distill.pub's growing neural CA, old forgotten papers, other fields' methods). "Someone just had to notice" is a research strategy: the librarian role exists to find what's already sitting there.
4. **Every discipline is a lens.** The same seed question refracted through a physicist, mathematician, biologist, psychologist, anthropologist, musician — unconventional lenses included — yields different experiments. The explore engine generates through personas, not just prompts.
5. **Two kinds of truth-seeking, one ledger.**
   - *Deductive investigations* (math): claims → counterexamples → proofs → formal verification.
   - *Empirical investigations* (simulation/training experiments, growing-CA style): hypotheses → metrics defined in advance → reproducible runs → keep/discard against the metric. Both live in the same claim ledger with the same honesty grades; an emergent-structure claim is TESTED against pre-registered metrics exactly as a conjecture is tested against integers.
6. **Steer any model, any field.** The harness is a conductor: frontier LLMs for reasoning, cheap models for fan-out, and *domain* foundation models as instruments — BioNeMo-class models for drug discovery, quantum toolchains, physics simulators. Model-agnosticism isn't a convenience feature; it's how one harness serves every science.
7. **Discovery should be thrilling to watch.** Dense, dark, instrument-grade visualization — signal glowing out of darkness, the agent working on the canvas, not in a chat margin (visual language: Chronicle reference doc). Excitement is not decoration; it is how you recruit a species into collective research.
8. **Solve the universe, honestly.** The ambition is unbounded; the claims never are. Wording never exceeds evidence. That discipline is the product.

## How the staged plan serves this (mapping, not new scope)

| Vision element | Where it lands |
|---|---|
| Non-expert conversational research | M4 ingest (plain-language → confirmed reading) + explore mode defaults; expert mode exposes every knob |
| Growing-CA-style open-ended experiments | M2 loop already is a metric-driven keep/discard engine (autoresearch pattern); empirical-experiment claim type + pre-registered metrics formalized in M2 |
| "Get what worked out of that paper" | Librarian role (M2) + alphaXiv/arXiv mining skill (M4) |
| Discipline persona lenses | M4 explore fan-out: same seed, many lenses; Daedalus corpus as seed material |
| BioNeMo / quantum / any-domain steering | Domain adapters after the math gauntlet proves the engine (post-M5); provider layer + modelbook already model-agnostic |
| Mind-blowing visualization | Dossiers get tokenized plots (Chronicle palette) as soon as runs produce data worth seeing; live instrument canvas belongs to the wxrlds layer |
| Drug discovery et al. | A domain pack like any other: adapter + evaluators + domain models + its own gauntlet before open problems |

## The line we never cross

New domains, wild questions, and beautiful dashboards all enter through the same door: pre-registered success criteria, reproducible artifacts, independent checking, status-bound language. If a feature would make the system more exciting but less honest, it doesn't ship.
