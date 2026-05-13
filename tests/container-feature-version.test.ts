/**
 * Pinning tests for the container feature-version label.
 *
 * Bumping CONTAINER_FEATURE_VERSION causes pre-existing containers (lacking
 * the matching `<labelPrefix>-version` label) to be treated as not-found
 * by the project-sandbox discovery flow, so they get recreated with the
 * new bind-mount surface (e.g. /bobbit-preload).
 *
 * See: docs/design "Idle-stream timeout for remote LLM calls" — the
 * preload mount requires container recreation on upgrade.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildDockerRunArgs,
	CONTAINER_FEATURE_VERSION,
	type DockerRunConfig,
} from "../src/server/agent/docker-args.ts";

function baseConfig(overrides: Partial<DockerRunConfig> = {}): DockerRunConfig {
	return {
		image: "test-image:latest",
		workspaceDir: "/tmp/test-workspace",
		...overrides,
	};
}

describe("buildDockerRunArgs feature-version label", () => {
	it("emits bobbit-project-version=preload-1 when labelVersion provided for project containers", () => {
		const args = buildDockerRunArgs(baseConfig({
			label: "proj-abc",
			labelPrefix: "bobbit-project",
			labelVersion: CONTAINER_FEATURE_VERSION,
			projectId: "proj-abc",
		}));

		// Both the base label and the version label must be emitted as
		// separate --label args (docker accepts repeated --label flags).
		const labelArgs: string[] = [];
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--label" && i + 1 < args.length) labelArgs.push(args[i + 1]);
		}

		assert.ok(
			labelArgs.includes("bobbit-project=proj-abc"),
			`expected primary label, got: ${labelArgs.join(", ")}`,
		);
		assert.ok(
			labelArgs.includes(`bobbit-project-version=${CONTAINER_FEATURE_VERSION}`),
			`expected version label, got: ${labelArgs.join(", ")}`,
		);
	});

	it("emits bobbit-sandbox-version=<v> when labelVersion provided for sandbox-pool containers", () => {
		const args = buildDockerRunArgs(baseConfig({
			label: "sandbox-xyz",
			labelPrefix: "bobbit-sandbox",
			labelVersion: CONTAINER_FEATURE_VERSION,
		}));

		const labelArgs: string[] = [];
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--label" && i + 1 < args.length) labelArgs.push(args[i + 1]);
		}

		assert.ok(labelArgs.includes("bobbit-sandbox=sandbox-xyz"));
		assert.ok(labelArgs.includes(`bobbit-sandbox-version=${CONTAINER_FEATURE_VERSION}`));
	});

	it("omits version label when labelVersion is not provided", () => {
		const args = buildDockerRunArgs(baseConfig({
			label: "proj-abc",
			labelPrefix: "bobbit-project",
			projectId: "proj-abc",
		}));

		const labelArgs: string[] = [];
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--label" && i + 1 < args.length) labelArgs.push(args[i + 1]);
		}

		assert.ok(labelArgs.includes("bobbit-project=proj-abc"));
		assert.ok(
			!labelArgs.some(l => l.startsWith("bobbit-project-version=")),
			`expected no version label, got: ${labelArgs.join(", ")}`,
		);
	});

	it("CONTAINER_FEATURE_VERSION is a non-empty string constant", () => {
		assert.equal(typeof CONTAINER_FEATURE_VERSION, "string");
		assert.ok(CONTAINER_FEATURE_VERSION.length > 0);
	});
});
