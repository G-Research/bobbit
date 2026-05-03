// Test entry point — bundles follow-tail.ts for file:// use.
import { reconcileFollowTail } from "../../src/app/follow-tail.js";
(window as any).__followTail = { reconcileFollowTail };
