import { afterEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
	TOOL_EXTENSION_ADAPTER_ENTRY,
	TOOL_EXTENSION_ADAPTER_MANIFEST,
	captureToolExtensionTarget,
	materializeToolExtensionAdapter,
	planToolExtensionTarget,
	toolExtensionTargetIdentity,
	type MaterializedToolExtensionAdapter,
	type ToolExtensionAdapterManifest,
	type ToolExtensionTargetPlan,
} from "../../../src/server/agent/tool-extension-activation.ts";

const roots: string[] = [];
const originalBobbitDir = process.env.BOBBIT_DIR;

afterEach(() => {
	vi.restoreAllMocks();
	if (originalBobbitDir === undefined) delete process.env.BOBBIT_DIR;
	else process.env.BOBBIT_DIR = originalBobbitDir;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tool-extension-adapter-"));
	roots.push(root);
	process.env.BOBBIT_DIR = path.join(root, "headquarters");
	return root;
}

function writeTarget(directory: string, marker: string): string {
	const target = path.join(directory, "extension.mjs");
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(target, `export default function extension() { return ${JSON.stringify(marker)}; }\n`, "utf-8");
	return target;
}

function tryDirectorySymlink(target: string, link: string): boolean {
	try {
		fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return false;
		throw error;
	}
}

function planFor(targetPath: string, names = ["session_prompt"]): ToolExtensionTargetPlan {
	const plans = new Map<string, ToolExtensionTargetPlan>();
	for (const name of names) planToolExtensionTarget(plans, targetPath, name);
	assert.equal(plans.size, 1);
	return [...plans.values()][0];
}

function readManifest(adapter: MaterializedToolExtensionAdapter): ToolExtensionAdapterManifest {
	return JSON.parse(fs.readFileSync(path.join(path.dirname(adapter.adapterPath), TOOL_EXTENSION_ADAPTER_MANIFEST), "utf-8")) as ToolExtensionAdapterManifest;
}

function assertValidArtifact(adapter: MaterializedToolExtensionAdapter): void {
	const source = fs.readFileSync(path.join(path.dirname(adapter.adapterPath), TOOL_EXTENSION_ADAPTER_ENTRY), "utf-8");
	const manifest = readManifest(adapter);
	assert.equal(manifest.adapterId, adapter.adapterId);
	assert.equal(createHash("sha256").update(source).digest("hex"), manifest.generatedSourceSha256);
}

describe("tool extension adapter publication", () => {
	it("pins one physical target across a concurrent symlink replacement", (t) => {
		const root = fixtureRoot();
		const targetA = writeTarget(path.join(root, "target-a"), "A");
		const targetB = writeTarget(path.join(root, "target-b"), "B");
		const active = path.join(root, "active");
		if (!tryDirectorySymlink(path.dirname(targetA), active)) {
			t.skip("directory symlinks are unavailable on this platform");
			return;
		}

		const lexicalTarget = path.join(active, path.basename(targetA));
		const plan = planFor(lexicalTarget);
		const captured = plan.capturedTarget;
		assert.ok(captured);
		assert.equal(captured.physicalPath, fs.realpathSync.native(targetA));

		fs.rmSync(active, { recursive: true, force: true });
		assert.equal(tryDirectorySymlink(path.dirname(targetB), active), true);
		const adapter = materializeToolExtensionAdapter(plan);

		assert.equal(adapter.manifest.targetIdentity, toolExtensionTargetIdentity(captured));
		assert.equal(adapter.targetUrl, pathToFileURL(captured.physicalPath).href);
		assert.notEqual(adapter.targetUrl, pathToFileURL(fs.realpathSync.native(lexicalTarget)).href);
	});

	it("accepts one exact immutable artifact when identical publishers race", () => {
		const root = fixtureRoot();
		const plan = planFor(writeTarget(path.join(root, "target"), "winner"));
		const rename = fs.renameSync;
		let competing: MaterializedToolExtensionAdapter | undefined;
		let injected = false;
		const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
			if (!injected) {
				injected = true;
				renameSpy.mockImplementation(rename);
				competing = materializeToolExtensionAdapter(plan);
			}
			return rename(source, destination);
		});

		const winner = materializeToolExtensionAdapter(plan);
		assert.ok(competing);
		assert.equal(winner.adapterPath, competing.adapterPath);
		assert.equal(winner.adapterId, competing.adapterId);
		assertValidArtifact(winner);
		const published = fs.readdirSync(path.dirname(path.dirname(winner.adapterPath)));
		assert.deepEqual(published, [path.basename(path.dirname(winner.adapterPath))]);
	});

	for (const corruptFile of [TOOL_EXTENSION_ADAPTER_ENTRY, TOOL_EXTENSION_ADAPTER_MANIFEST]) {
		it(`fails closed on a corrupted cached ${corruptFile} and republishes after removal`, () => {
			const root = fixtureRoot();
			const plan = planFor(writeTarget(path.join(root, "target"), corruptFile));
			const initial = materializeToolExtensionAdapter(plan);
			const directory = path.dirname(initial.adapterPath);
			fs.writeFileSync(path.join(directory, corruptFile), "corrupt\n", "utf-8");

			assert.throws(
				() => materializeToolExtensionAdapter(plan),
				(error: unknown) => {
					assert.ok(error instanceof Error);
					return true;
				},
				"a corrupt immutable address must never be returned",
			);
			fs.rmSync(directory, { recursive: true, force: true });
			const repaired = materializeToolExtensionAdapter(plan);
			assert.equal(repaired.adapterPath, initial.adapterPath);
			assertValidArtifact(repaired);
		});
	}

	it("coalesces lexical and physical aliases with case-insensitive unioned names", (t) => {
		const root = fixtureRoot();
		const physicalTarget = writeTarget(path.join(root, "physical"), "aliases");
		const aliasDirectory = path.join(root, "alias");
		if (!tryDirectorySymlink(path.dirname(physicalTarget), aliasDirectory)) {
			t.skip("directory symlinks are unavailable on this platform");
			return;
		}
		const lexicalTarget = path.join(aliasDirectory, path.basename(physicalTarget));
		const plans = new Map<string, ToolExtensionTargetPlan>();

		planToolExtensionTarget(plans, lexicalTarget, "Session_Prompt");
		planToolExtensionTarget(plans, physicalTarget, "read_session");
		planToolExtensionTarget(plans, lexicalTarget, "session_prompt");

		assert.equal(plans.size, 1);
		const plan = [...plans.values()][0];
		assert.deepEqual(plan.allowedToolNames, ["Session_Prompt", "read_session"]);
		assert.deepEqual(plan.targetAliases, [path.resolve(lexicalTarget), path.resolve(physicalTarget)]);
		assert.equal(plan.capturedTarget?.physicalPath, fs.realpathSync.native(physicalTarget));
		const adapter = materializeToolExtensionAdapter(plan);
		assert.deepEqual(adapter.manifest.allowedToolNames, plan.allowedToolNames);
		assert.deepEqual(adapter.manifest.targetAliases, plan.targetAliases);
		assert.equal(adapter.manifest.targetIdentity, toolExtensionTargetIdentity(plan.capturedTarget!));
	});

	it("rejects a forged capture whose identity and executable path disagree", () => {
		const root = fixtureRoot();
		const targetA = writeTarget(path.join(root, "target-a"), "A");
		const targetB = writeTarget(path.join(root, "target-b"), "B");
		const captured = captureToolExtensionTarget(targetA);
		const plan: ToolExtensionTargetPlan = {
			targetPath: targetA,
			capturedTarget: { ...captured, physicalPath: targetB },
			allowedToolNames: ["session_prompt"],
		};

		assert.throws(() => materializeToolExtensionAdapter(plan), /identity does not match physical path/);
	});
});
