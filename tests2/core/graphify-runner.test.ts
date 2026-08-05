import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
	GraphifyCapabilityError,
	GraphifyDeltaAdapter,
	rebuildCodeCompatibility,
	type CompatibilitySpec,
	type GraphifyDeltaExecution,
	type GraphifyDeltaRequest,
} from "../../market-packs/code-intelligence/src/graphify-runner.ts";

const request: GraphifyDeltaRequest = {
	cwd: "/workspace-wt/goal-a/component",
	candidateRoot: "/host-state/graphs/component/staging/candidate-a",
	scanRoots: ["defaults", "src", "tests2"],
	changedPaths: ["src/changed.ts", "src/changed.ts", "tests2/covered.test.ts"],
	noCluster: true,
};

const compatibility: CompatibilitySpec = {
	version: "1.2.3",
	modulePath: "graphify.watch",
	callable: "_rebuild_code",
	requiredSignature: ["root", "changed_paths"],
};

function output(sourcePaths = ["src/z.ts", "src/a.ts", "src/a.ts"]) {
	return { graphPath: "/host-state/graphs/component/staging/candidate-a/graph.json", nodes: 4, edges: 3, sourcePaths };
}

function fakeExecution(overrides: Partial<GraphifyDeltaExecution> = {}): GraphifyDeltaExecution {
	return {
		probePublicDelta: async () => null,
		invokePublicDelta: async () => output(),
		probeCompatibility: async () => ({ modulePath: "graphify.watch", callable: "_rebuild_code", signature: ["root", "changed_paths", "no_cluster"] }),
		invokeCompatibility: async () => output(),
		...overrides,
	};
}

describe("GraphifyDeltaAdapter — public capability and pinned compatibility contract", () => {
	it("prefers a supported public incremental-delta capability without probing private Graphify APIs", async () => {
		let compatibilityProbeCalls = 0;
		let publicCalls = 0;
		const adapter = new GraphifyDeltaAdapter("1.2.3", fakeExecution({
			probePublicDelta: async version => ({ id: "graphify-delta-v1", version }),
			invokePublicDelta: async capability => {
				publicCalls += 1;
				assert.equal(capability.id, "graphify-delta-v1");
				return output();
			},
			probeCompatibility: async () => {
				compatibilityProbeCalls += 1;
				return { modulePath: "graphify.watch", callable: "_rebuild_code", signature: ["root", "changed_paths"] };
			},
		}), [compatibility]);

		const result = await adapter.invokeDelta(request);

		assert.equal(publicCalls, 1);
		assert.equal(compatibilityProbeCalls, 0, "a private fallback must not be touched when a public capability exists");
		assert.deepEqual(result.compatibility, { kind: "public", id: "graphify-delta-v1", resolvedVersion: "1.2.3" });
		assert.deepEqual(result.sourcePaths, ["src/a.ts", "src/z.ts"]);
	});

	it("uses only an exact version-pinned _rebuild_code fallback and records its feature-probed identity", async () => {
		let invoked: CompatibilitySpec | undefined;
		const adapter = new GraphifyDeltaAdapter("1.2.3", fakeExecution({
			invokeCompatibility: async spec => {
				invoked = spec;
				return output();
			},
		}), [compatibility]);

		const result = await adapter.invokeDelta(request);

		assert.equal(invoked, compatibility);
		assert.deepEqual(result.compatibility, {
			kind: "compatibility",
			id: "graphify.watch._rebuild_code",
			resolvedVersion: "1.2.3",
			modulePath: "graphify.watch",
			signature: ["changed_paths", "no_cluster", "root"],
		});
	});

	it("fails loudly when neither a public capability nor an exact pinned fallback exists", async () => {
		const adapter = new GraphifyDeltaAdapter("1.2.4", fakeExecution(), [compatibility]);
		await assert.rejects(
			() => adapter.invokeDelta(request),
			(error: unknown) => error instanceof GraphifyCapabilityError
				&& error.version === "1.2.4"
				&& error.capability === "incremental-delta"
				&& /no supported public delta capability and no pinned compatibility adapter/.test(error.message),
		);
	});

	it("rejects a changed private module path or signature before invoking the compatibility fallback", async () => {
		let compatibilityInvocations = 0;
		const adapter = new GraphifyDeltaAdapter("1.2.3", fakeExecution({
			probeCompatibility: async () => ({ modulePath: "graphify.private_watch", callable: "_rebuild_code", signature: ["root"] }),
			invokeCompatibility: async () => {
				compatibilityInvocations += 1;
				return output();
			},
		}), [compatibility]);

		await assert.rejects(
			() => adapter.invokeDelta(request),
			(error: unknown) => error instanceof GraphifyCapabilityError
				&& /expected graphify\.watch\._rebuild_code\(root, changed_paths\)/.test(error.message),
		);
		assert.equal(compatibilityInvocations, 0, "an unproven private API must never be invoked");
	});

	it("requires an external candidate root, canonical component-relative inputs, and no-cluster delta execution", async () => {
		const adapter = new GraphifyDeltaAdapter("1.2.3", fakeExecution(), [compatibility]);
		await assert.rejects(() => adapter.invokeDelta({ ...request, noCluster: false }), /noCluster=true/);
		await assert.rejects(() => adapter.invokeDelta({ ...request, cwd: "relative-component" }), /absolute component root/);
		await assert.rejects(() => adapter.invokeDelta({ ...request, candidateRoot: "relative-candidate" }), /absolute external directory/);
		await assert.rejects(() => adapter.invokeDelta({ ...request, candidateRoot: "/workspace-wt/goal-a/component/graphify-out" }), /outside the component root/);
		for (const invalid of [".", "../outside", "/outside", "C:/Windows", "C:\\Windows", "C:secret", "\\\\host\\share", "src/\u0000secret.ts"]) {
			await assert.rejects(() => adapter.invokeDelta({ ...request, scanRoots: [invalid] }), /scan root must be a non-empty component-relative path/);
		}
		await assert.rejects(() => adapter.invokeDelta({ ...request, changedPaths: ["private/secret.env"] }), /under a pinned scan root/);
	});

	it("contains executor artifacts and source identities within the server-derived candidate and roots", async () => {
		const adapter = new GraphifyDeltaAdapter("1.2.3", fakeExecution({
			invokeCompatibility: async () => output(["src/allowed.ts", "private/secret.env"]),
		}), [compatibility]);
		await assert.rejects(() => adapter.invokeDelta(request), /graph source path must be under a pinned scan root/);

		const outsideOutput = new GraphifyDeltaAdapter("1.2.3", fakeExecution({
			invokeCompatibility: async () => ({ ...output(), graphPath: "/workspace-wt/goal-a/component/graphify-out/graph.json" }),
		}), [compatibility]);
		await assert.rejects(() => outsideOutput.invokeDelta(request), /contained by the external candidate root/);
	});

	it("creates no guessed private identity: the compatibility fallback requires its resolved version and observed signature", () => {
		assert.deepEqual(rebuildCodeCompatibility("1.2.3", ["root", "changed_paths"]), compatibility);
		assert.throws(() => rebuildCodeCompatibility("^1.2.3", ["root"]), /exact Graphify version/);
		assert.throws(() => rebuildCodeCompatibility("1.2.3", []), /probed _rebuild_code signature/);
		assert.throws(() => new GraphifyDeltaAdapter("^1.2.3", fakeExecution(), [compatibility]), /exact resolved version/);
		assert.throws(() => new GraphifyDeltaAdapter("1.2", fakeExecution(), [compatibility]), /exact resolved version/);
	});
});
