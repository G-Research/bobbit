import { expect, it } from "vitest";
import { GIT_TEMPLATE_HANDOFF_PROOF_ENV } from "../../harness/git-template-handoff-proof.js";
import { isTier1SpawnGuardInstalled } from "../../harness/tier1-spawn-guard.js";

const LABELS = ["a", "b", "c"] as const;
type ProbeLabel = (typeof LABELS)[number];

/**
 * Marks the modules that activate coordinator end-of-run certification. Worker
 * lifecycle evidence is published by guarded setup, not by these scheduled
 * tests, so serial or reused-file dispatch cannot deadlock or forge the proof.
 */
export function registerGitTemplateHandoffProbe(label: ProbeLabel): void {
	it(`probe ${label} participates in coordinator-certified one-init handoff`, () => {
		expect(process.env[GIT_TEMPLATE_HANDOFF_PROOF_ENV]).toBe("v2-core");
		expect(isTier1SpawnGuardInstalled()).toBe(true);
	});
}
