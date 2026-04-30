// Test entry — bundles the New Goal dialog so we can drive it from a
// file:// fixture. We expose `showNewGoalDialog` plus a tiny shim around
// `localStorage` so the test can assert dismiss persistence.
import { showNewGoalDialog } from "../../src/app/dialogs.js";

(window as any).__showNewGoalDialog = showNewGoalDialog;
(window as any).__readLocalStorage = (key: string) => {
	try { return localStorage.getItem(key); } catch { return null; }
};
(window as any).__clearLocalStorage = (key: string) => {
	try { localStorage.removeItem(key); } catch { /* ignore */ }
};
(window as any).__ready = true;
