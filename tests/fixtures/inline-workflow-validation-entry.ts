// Test entry — bundles `showNewGoalDialog` so the inline workflow / roles
// YAML validation behaviour can be driven from a file:// fixture without a
// live gateway. See `tests/inline-workflow-validation.spec.ts`.
import { showNewGoalDialog } from "../../src/app/dialogs.js";

(window as any).__showNewGoalDialog = showNewGoalDialog;
(window as any).__lastResult = undefined;
(window as any).__readLastResult = () => (window as any).__lastResult;
(window as any).__ready = true;
