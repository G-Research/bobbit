// Test entry — bundles `src/app/perf-trace.ts` only. The cold-load observer
// function is extracted from `src/app/main.ts` at test-time by transpiling
// the source file in isolation (no bundle) and capturing the function
// definition (see perf-trace-cold-spans.spec.ts beforeAll). This avoids
// pulling in main.ts's full UI dependency graph (which is owned by parallel
// coders) into a unit-test bundle.
import * as perfTrace from "../../src/app/perf-trace.js";
(window as any).__perfTrace = perfTrace;
(window as any).__ready = true;
