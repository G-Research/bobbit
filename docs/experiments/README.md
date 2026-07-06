# Experiments Index

This directory records experiments that follow the same discipline: pre-register the question, arms, metrics, and success criteria; measure against that registration; then record the outcome honestly even when it is inconclusive. The Experiment Runner framework and storage model are described in [../experiment-runner.md](../experiment-runner.md); panel/backend design details live in [../design/experiment-runner-panel-ux.md](../design/experiment-runner-panel-ux.md) and [../design/experiment-runner-pack-backend.md](../design/experiment-runner-pack-backend.md).

| Experiment | Status | Outcome |
|---|---|---|
| [EXP-001: Gate Cache Keying A/B](EXP-001-gate-cache-keying.md) | measured | Recommended content-keyed cache behavior for the next lane; default change remains a separate operational decision. |
| [EXP-002: Unit Compile Cache A/B](EXP-002-unit-compile-cache.md) | measured | Inconclusive; keep `BOBBIT_TEST_COMPILE_CACHE=1` opt-in. |
| EXP-003 | in flight | No experiment file is present in this worktree yet; add the pre-registration/results document here when it lands. |
