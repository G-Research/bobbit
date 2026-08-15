import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
	parseSandboxBaseImageReference,
	resolveSandboxImagePlan,
	sandboxImageBuildArgs,
	MAX_SANDBOX_IMAGE_PLAN_REQUIREMENT_ROWS,
	SandboxImageRequirementFailureStore,
	UnsupportedSandboxImagePlanError,
} from "../../src/server/agent/sandbox-image-requirements.js";

const requirement = (profiles: readonly "python"[] = ["python"]) => ({
	packId: "example-pack",
	requirementId: "python-analysis",
	profiles,
});

function resolve(overrides: Partial<Parameters<typeof resolveSandboxImagePlan>[0]> = {}) {
	return resolveSandboxImagePlan({
		baseImageName: "registry.example:5000/team/bobbit-agent:base",
		requirements: [requirement()],
		piAgentVersion: "1.2.3",
		...overrides,
	});
}

describe("sandbox image requirement plans", () => {
	it("uses a core-derived tag and identical plan for equivalent authorized profiles", () => {
		const first = resolve({ requirements: [requirement(), { packId: "other", requirementId: "also-python", profiles: ["python"] }] });
		const second = resolve({ requirements: [{ packId: "other", requirementId: "also-python", profiles: ["python"] }, requirement()] });
		assert.deepEqual(first.profiles, ["python"]);
		assert.equal(first.fingerprint, second.fingerprint);
		assert.equal(first.imageName, second.imageName);
		assert.match(first.imageName, /^registry\.example:5000\/team\/bobbit-agent:bobbit-req-[a-f0-9]{16}$/);
		assert.deepEqual(sandboxImageBuildArgs(first), [
			"--build-arg", "BOBBIT_SANDBOX_TOOLCHAINS=python",
			"--build-arg", `BOBBIT_SANDBOX_REQUIREMENTS_FINGERPRINT=${first.fingerprint}`,
		]);
	});

	it("keeps the project-configured baseline image unchanged without profiles", () => {
		const plan = resolve({ requirements: [] });
		assert.equal(plan.imageName, "registry.example:5000/team/bobbit-agent:base");
		assert.equal(plan.buildable, true);
		assert.deepEqual(plan.profiles, []);
	});

	it("accepts Docker-legal repeated separators and marks a digest baseline build-not-applicable", () => {
		const legal = resolve({ baseImageName: "registry.example/team/bobbit--agent__stable:base", requirements: [] });
		assert.equal(legal.imageName, "registry.example/team/bobbit--agent__stable:base");
		assert.equal(legal.buildable, true);

		const digest = `registry.example/team/bobbit--agent@sha256:${"a".repeat(64)}`;
		const pinned = resolve({ baseImageName: digest, requirements: [] });
		assert.equal(pinned.imageName, digest);
		assert.equal(pinned.buildable, false);
	});

	it("changes the fingerprint only for core build inputs", () => {
		const baseline = resolve();
		assert.notEqual(baseline.fingerprint, resolve({ baseImageName: "bobbit-agent" }).fingerprint);
		assert.notEqual(baseline.fingerprint, resolve({ piAgentVersion: "1.2.4" }).fingerprint);
		assert.equal(
			baseline.fingerprint,
			resolve({ requirements: [{ packId: "renamed", requirementId: "renamed", profiles: ["python"] }] }).fingerprint,
		);
	});

	it("rejects invalid image references and unknown or duplicate profile values before a Docker argument exists", () => {
		for (const value of ["", "bobbit-agent; touch /tmp/pwn", "https://registry/bobbit", "bobbit-agent:tag with spaces", "repo@sha256:abc"]) {
			assert.equal(parseSandboxBaseImageReference(value), null, value);
		}
		const digested = `registry.example:5000/team/bobbit-agent:base@sha256:${"a".repeat(64)}`;
		assert.deepEqual(parseSandboxBaseImageReference(digested), {
			repository: "registry.example:5000/team/bobbit-agent",
			normalized: digested,
		});
		for (const profiles of [["python --build-arg X=Y"], ["python", "python"]] as const) {
			assert.throws(
				() => resolve({ requirements: [{ packId: "attacker", requirementId: "anything", profiles: profiles as any }] }),
				UnsupportedSandboxImagePlanError,
			);
		}
	});

	it("rejects aggregate requirement rows rather than truncating status metadata", () => {
		const requirements = Array.from(
			{ length: MAX_SANDBOX_IMAGE_PLAN_REQUIREMENT_ROWS + 1 },
			(_, index) => ({ packId: `pack-${index}`, requirementId: `requirement-${index}`, profiles: ["python"] as const }),
		);
		assert.throws(() => resolve({ requirements }), UnsupportedSandboxImagePlanError);
	});

	it("keeps failed build state bounded, project-local, and free of Docker output", () => {
		const failures = new SandboxImageRequirementFailureStore(1);
		failures.recordFailure("project-a", "a".repeat(64));
		assert.deepEqual(failures.getFailure("project-a", "a".repeat(64)), { code: "build-failed", message: "Sandbox image build failed" });
		assert.equal(failures.getFailure("project-b", "a".repeat(64)), undefined);
		failures.recordFailure("project-a", "b".repeat(64));
		assert.equal(failures.getFailure("project-a", "a".repeat(64)), undefined);
		failures.recordSuccess("project-a", "b".repeat(64));
		assert.equal(failures.getFailure("project-a", "b".repeat(64)), undefined);
	});
});
