// Test entry — bundles perf-trace.ts for file:// fixture use.
import * as perfTrace from "../../src/app/perf-trace.js";
(window as any).__perfTrace = perfTrace;
