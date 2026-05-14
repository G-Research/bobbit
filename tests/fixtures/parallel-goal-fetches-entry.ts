// Test entry — bundles `goal-dashboard-fetches.ts` for file:// fixture use.
// The helper is self-contained / dependency-free, so bundling is trivial.
import { runDashboardFetchBundle } from "../../src/app/goal-dashboard-fetches.js";
(window as any).__runDashboardFetchBundle = runDashboardFetchBundle;
(window as any).__ready = true;
