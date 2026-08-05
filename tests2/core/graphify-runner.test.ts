import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	GraphifyCapabilityError,
	GraphifyDeltaAdapter,
	rebuildCodeCompatibility,
	type CompatibilitySpec,
	type GraphifyDeltaExecution,
	type GraphifyDeltaRequest,
} from "../../market-packs/code-intelligence/src/graphify-runner.ts";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "graphify-runner-"));
const componentRoot = path.join(fixtureRoot, "component");
const candidateRoot = path.join(fixtureRoot, "host-state", "candidate-a");
for (const relative of ["src/changed.ts", "src/a.ts", "src/z.ts", "tests2/covered.test.ts", "defaults/config.ts"]) {
	const file = path.join(componentRoot, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "export {};\n");
}
fs.mkdirSync(candidateRoot, { recursive: true });
afterAll(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

const request: GraphifyDeltaRequest = {
	cwd: componentRoot,
	candidateRoot,
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

function output(sourcePaths = ["src/z.ts", "src/a.ts", "src/a.ts"], graphPath = path.join(candidateRoot, "graph.json")) {
	fs.mkdirSync(path.dirname(graphPath), { recursive: true });
	fs.writeFileSync(graphPath, "{}\n");
	return { graphPath, nodes: 4, edges: 3, sourcePaths };
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
		await assert.rejects(() => adapter.invokeDelta({ ...request, candidateRoot: path.join(componentRoot, "graphify-out") }), /outside the component root/);
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

		const outsideGraph = path.join(componentRoot, "graphify-out", "graph.json");
		const outsideOutput = new GraphifyDeltaAdapter("1.2.3", fakeExecution({
			invokeCompatibility: async () => output(["src/a.ts"], outsideGraph),
		}), [compatibility]);
		await assert.rejects(() => outsideOutput.invokeDelta(request), /contained by the external candidate root/);
	});

	it("uses physical containment for aliases, symlinks, deleted paths, and executor artifacts", async () => {
		const adapter = new GraphifyDeltaAdapter("1.2.3", fakeExecution(), [compatibility]);
		const deletedResult = await adapter.invokeDelta({ ...request, changedPaths: ["src/deleted-before-delta.ts"] });
		assert.deepEqual(deletedResult.sourcePaths, ["src/a.ts", "src/z.ts"]);
		for (const equalCandidate of [componentRoot, `${componentRoot}${path.sep}`, path.join(componentRoot, "..", path.basename(componentRoot))]) {
			await assert.rejects(() => adapter.invokeDelta({ ...request, candidateRoot: equalCandidate }), /outside the component root/);
		}

		const candidateInCheckout = path.join(fixtureRoot, "candidate-in-checkout");
		fs.symlinkSync(componentRoot, candidateInCheckout, "dir");
		await assert.rejects(() => adapter.invokeDelta({ ...request, candidateRoot: candidateInCheckout }), /outside the component root/);

		const outside = path.join(fixtureRoot, "outside");
		fs.mkdirSync(outside);
		const outputLink = path.join(candidateRoot, "output-link");
		fs.symlinkSync(outside, outputLink, "dir");
		const escapedGraph = path.join(outputLink, "graph.json");
		const outputEscape = new GraphifyDeltaAdapter("1.2.3", fakeExecution({
			invokeCompatibility: async () => output(["src/a.ts"], escapedGraph),
		}), [compatibility]);
		await assert.rejects(() => outputEscape.invokeDelta(request), /contained by the external candidate root/);

		const escapedRoot = path.join(componentRoot, "escaped-root");
		fs.symlinkSync(outside, escapedRoot, "dir");
		await assert.rejects(() => adapter.invokeDelta({ ...request, scanRoots: ["escaped-root"], changedPaths: ["escaped-root/deleted.ts"] }), /scan root must be physically contained/);

		const sentinel = path.join(outside, "sentinel.ts");
		fs.writeFileSync(sentinel, "export const sentinel = true;\n");
		const sourceLink = path.join(componentRoot, "src", "sentinel.ts");
		fs.symlinkSync(sentinel, sourceLink, "file");
		const sourceEscape = new GraphifyDeltaAdapter("1.2.3", fakeExecution({
			invokeCompatibility: async () => output(["src/sentinel.ts"]),
		}), [compatibility]);
		await assert.rejects(() => sourceEscape.invokeDelta(request), /graph source path must be physically contained by the component root/);

		const cwdAlias = path.join(fixtureRoot, "component-alias");
		const candidateAlias = path.join(fixtureRoot, "candidate-alias");
		fs.symlinkSync(componentRoot, cwdAlias, "dir");
		fs.symlinkSync(candidateRoot, candidateAlias, "dir");
		const aliasResult = await adapter.invokeDelta({ ...request, cwd: cwdAlias, candidateRoot: candidateAlias });
		assert.equal(aliasResult.graphPath, path.join(candidateRoot, "graph.json"));
		assert.equal(aliasResult.sourcePaths[0], "src/a.ts");
	});

	it("creates no guessed private identity: the compatibility fallback requires its resolved version and observed signature", () => {
		assert.deepEqual(rebuildCodeCompatibility("1.2.3", ["root", "changed_paths"]), compatibility);
		assert.throws(() => rebuildCodeCompatibility("^1.2.3", ["root"]), /exact Graphify version/);
		assert.throws(() => rebuildCodeCompatibility("1.2.3", []), /probed _rebuild_code signature/);
		assert.throws(() => new GraphifyDeltaAdapter("^1.2.3", fakeExecution(), [compatibility]), /exact resolved version/);
		assert.throws(() => new GraphifyDeltaAdapter("1.2", fakeExecution(), [compatibility]), /exact resolved version/);
	});
});
