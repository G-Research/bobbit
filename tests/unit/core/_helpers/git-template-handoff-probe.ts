import { expect, it } from "vitest";
import { GIT_TEMPLATE_HANDOFF_PROOF_ENV } from "../../../support/harnesses/git-template-handoff-proof.js";
import { isTier1SpawnGuardInstalled } from "../../../support/harnesses/tier1-spawn-guard.js";

const LABELS = ["a", "b", "c"] as const;
type ProbeLabel = (typeof LABELS)[number];

/**
 * Keeps explicit markers in the canonical inventory whose complete execution
 * activates coordinator certification. A focused marker remains independently
 * runnable because subsets never certify incomplete suite evidence.
 */
export function registerGitTemplateHandoffProbe(label: ProbeLabel): void {
	it(`probe ${label} belongs to the coordinator-certified one-init inventory`, () => {
		expect(process.env[GIT_TEMPLATE_HANDOFF_PROOF_ENV]).toBe("v2-core");
		expect(isTier1SpawnGuardInstalled()).toBe(true);
	});
}
