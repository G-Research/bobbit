import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import { parse as parseYaml } from "yaml";

type Step = {
	name?: string;
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
};
type Job = {
	permissions?: Record<string, string>;
	steps?: Step[];
};
type Workflow = { jobs?: Record<string, Job> };

const source = parseYaml(
	readFileSync(resolve(".github/workflows/release-publish.yml"), "utf8"),
) as Workflow;

function job(workflow: Workflow, name: string): Job {
	const value = workflow.jobs?.[name];
	assert.ok(value, `missing ${name} job`);
	return value;
}

function step(workflow: Workflow, jobName: string, name: string): Step {
	const value = job(workflow, jobName).steps?.find(candidate => candidate.name === name);
	assert.ok(value, `missing ${jobName}/${name} step`);
	return value;
}

function assertPublishBoundary(workflow: Workflow): void {
	assert.equal(job(workflow, "verify").permissions?.["id-token"], undefined);
	assert.deepEqual(job(workflow, "publish").permissions, {
		contents: "read",
		"id-token": "write",
	});

	const steps = job(workflow, "publish").steps ?? [];
	assert.ok(
		!steps.some(candidate => (candidate.uses ?? "").startsWith("actions/checkout@")),
		"publish must not check out repository code",
	);
	assert.ok(
		!steps.some(candidate => /\bnpm (?:ci|install|run)\b|\bnode\s+scripts\//.test(candidate.run ?? "")),
		"publish must not install dependencies or run repository scripts",
	);

	const stateCheck = step(workflow, "publish", "Confirm dist-tag state is unchanged");
	const download = step(workflow, "publish", "Download verified release artifacts");
	assert.ok(
		steps.indexOf(stateCheck) < steps.indexOf(download),
		"registry state must be checked before the artifact enters the privileged job",
	);
	assert.match(download.uses ?? "", /^actions\/download-artifact@[0-9a-f]{40}$/);
	assert.match(String(download.with?.name ?? ""), /needs\.verify\.outputs\.artifact_name/);

	const publish = step(workflow, "publish", "Publish verified artifact (OIDC trusted publishing)");
	assert.match(
		publish.run ?? "",
		/npm publish \.\/release-artifact\/bobbit\.tgz --ignore-scripts --provenance/,
		"publish must use an explicit local path for the verified artifact and disable lifecycle scripts",
	);
}

function mutated(change: (workflow: Workflow) => void): Workflow {
	const workflow = structuredClone(source);
	change(workflow);
	return workflow;
}

describe("release publish privilege boundary mutations", () => {
	it("accepts the reviewed workflow", () => {
		assertPublishBoundary(source);
	});

	it("rejects checkout, install, and repository-script mutations", () => {
		for (const mutation of [
			mutated(workflow => {
				job(workflow, "publish").steps?.push({ uses: "actions/checkout@" + "0".repeat(40) });
			}),
			mutated(workflow => {
				job(workflow, "publish").steps?.push({ run: "npm ci" });
			}),
			mutated(workflow => {
				job(workflow, "publish").steps?.push({ run: "node scripts/release/prepare.mjs" });
			}),
		]) {
			assert.throws(() => assertPublishBoundary(mutation));
		}
	});

	it("rejects publishing the workspace or enabling lifecycle scripts", () => {
		for (const replacement of [
			"npm publish --provenance",
			"npm publish release-artifact/bobbit.tgz --ignore-scripts --provenance",
			"npm publish ./release-artifact/bobbit.tgz --provenance",
		]) {
			const mutation = mutated(workflow => {
				step(workflow, "publish", "Publish verified artifact (OIDC trusted publishing)").run = replacement;
			});
			assert.throws(() => assertPublishBoundary(mutation));
		}
	});

	it("rejects moving the artifact ahead of the serialized state check", () => {
		const mutation = mutated(workflow => {
			const steps = job(workflow, "publish").steps ?? [];
			const checkIndex = steps.indexOf(step(workflow, "publish", "Confirm dist-tag state is unchanged"));
			const downloadIndex = steps.indexOf(step(workflow, "publish", "Download verified release artifacts"));
			[steps[checkIndex], steps[downloadIndex]] = [steps[downloadIndex], steps[checkIndex]];
		});
		assert.throws(() => assertPublishBoundary(mutation));
	});

	it("rejects granting OIDC authority to repository verification", () => {
		const mutation = mutated(workflow => {
			job(workflow, "verify").permissions = { "id-token": "write" };
		});
		assert.throws(() => assertPublishBoundary(mutation));
	});
});
