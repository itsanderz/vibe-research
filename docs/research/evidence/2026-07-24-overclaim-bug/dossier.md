# Investigation Dossier

Generated: 2026-07-25T00:00:01.706Z

**The bounded/finite claim was exhaustively verified.**

## What we found

No journal entries were recorded for this investigation.

## Claims & evidence

| ID | Status | Statement |
|---|---|---|
| `X87FiumIw1b1` | COMPUTATIONALLY_VERIFIED | For every integer n, 30 divides n^5 - n. |

**Evidence**

- `X87FiumIw1b1`
  - method=exhaustive check; scope=n in [-100, 100]; arithmetic=exact integer; artifact=workspace/runs/20260724T235950974-6c4528; result=no counterexample

## Experiments

| Run ID | Purpose | Exit code | Timed out | Duration (ms) | Artifact |
|---|---|---|---|---|---|
| `20260724T235950974-6c4528` | Verify 30 divides n^5 -n for all integers n in range [-100, 100] | 0 | false | 2021 | `runs/20260724T235950974-6c4528` |

## Limitations & open items

No open items identified: no claim is stuck at UNTESTED or TESTED_SMALL_CASES, and every experiment completed without a timeout or a nonzero exit code.

## Reproduce

Run these commands from the workspace directory:

```
wsl.exe -d Ubuntu -- python3 runs/20260724T235950974-6c4528/experiment.py
```

Full claim history: `claims.jsonl`
Full narrative: `journal.md` / `journal.jsonl`
