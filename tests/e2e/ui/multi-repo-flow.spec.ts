/**
 * Multi-repo UI flow — register a 3-component project and assert the settings
 * surface lists components.
 *
 * TODO Phase 4 follow-up: most of the multi-repo UI surface (Components
 * section in Settings, per-repo git-status sections, worktree_root input,
 * goal-creation indicator, repo-scan checklist in Add Project) is deferred
 * to a follow-up. This spec is therefore a thin smoke-test scaffold marked
 * `.skip` until those land — see docs/design/multi-repo-components.md §8.
 */
import { test } from "@playwright/test";

test.skip("multi-repo: register 3-component project and verify settings displays them", async () => {
	// Acceptance criterion 20 (from goal spec): browser-side view of components
	// requires the Settings → Components section which is a follow-up. Until
	// then this skeleton documents the intended assertion shape:
	//   1. Navigate to settings.
	//   2. Open the project tab for the 3-component project.
	//   3. Assert all 3 component names appear in the components list.
	//   4. Reload — assertion still holds (persistence).
	//   5. Remove a component — disappears from the list (cleanup).
});
