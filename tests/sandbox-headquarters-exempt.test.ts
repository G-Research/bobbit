/**
 * Regression test: Headquarters and the hidden `system` compatibility anchor
 * must NEVER participate in the per-project Docker sandbox lifecycle.
 *
 * HQ is data-only / no-worktree / no-git and its cwd is the Headquarters
 * directory (`<serverRunDir>/.bobbit/headquarters`), not a git checkout. If HQ
 * were allowed into the sandbox path, `_createContainer()` would walk up into
 * the server-run-dir git checkout and clone/mount it, and would create a
 * one-off `<hqDir>/.bobbit/{state,config}` layout — breaking HQ isolation.
 *
 * Invariants pinned here:
 *   (a) `SandboxManager.ensureForProject(HEADQUARTERS_PROJECT_ID / SYSTEM_PROJECT_ID)`
 *       never invokes the bootstrap and registers no sandbox;
 *   (b) `initForProject` refuses to construct a ProjectSandbox for those ids;
 *   (c) `ProjectSandbox.init()` refuses to run (no Docker, no git clone, no
 *       one-off state layout) for those ids as a defensive backstop.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SandboxManager, isSandboxExemptProject, type SandboxBootstrap } from "../src/server/agent/sandbox-manager.ts";
import { ProjectSandbox } from "../src/server/agent/project-sandbox.ts";
import { HEADQUARTERS_PROJECT_ID, SYSTEM_PROJECT_ID } from "../src/server/agent/project-registry.ts";

describe("Headquarters/system sandbox exemption", () => {
	it("isSandboxExemptProject flags only HQ and system", () => {
		assert.equal(isSandboxExemptProject(HEADQUARTERS_PROJECT_ID), true);
		assert.equal(isSandboxExemptProject(SYSTEM_PROJECT_ID), true);
		assert.equal(isSandboxExemptProject("normal-project"), false);
	});

	it("ensureForProject skips HQ/system without invoking bootstrap or registering a sandbox", async () => {
		let bootstrapCalls = 0;
		const bootstrap: SandboxBootstrap = async () => {
			bootstrapCalls++;
			throw new Error("bootstrap must not run for exempt projects");
		};
		const manager = new SandboxManager({ bootstrap });

		for (const id of [HEADQUARTERS_PROJECT_ID, SYSTEM_PROJECT_ID]) {
			await assert.doesNotReject(() => manager.ensureForProject(id));
			assert.equal(manager.has(id), false, `${id} must not register a sandbox`);
			assert.equal(manager.get(id), undefined, `${id} must have no ProjectSandbox`);
		}
		assert.equal(bootstrapCalls, 0, "bootstrap must never run for exempt projects");
	});

	it("initForProject refuses to construct a ProjectSandbox for HQ/system", async () => {
		const manager = new SandboxManager({ bootstrap: async () => null });
		const opts = {
			projectId: HEADQUARTERS_PROJECT_ID,
			projectDir: "/tmp/does-not-matter",
			repoUrl: "https://example.invalid/repo.git",
			image: "bobbit-sandbox:test",
		} as unknown as Parameters<SandboxManager["initForProject"]>[1];

		await assert.rejects(
			() => manager.initForProject(HEADQUARTERS_PROJECT_ID, opts),
			/never sandboxed|exempt/i,
		);
		assert.equal(manager.has(HEADQUARTERS_PROJECT_ID), false);
	});

	it("ProjectSandbox.init() refuses to run for HQ/system (no Docker, no clone)", async () => {
		for (const id of [HEADQUARTERS_PROJECT_ID, SYSTEM_PROJECT_ID]) {
			const sandbox = new ProjectSandbox({
				projectId: id,
				projectDir: "/tmp/does-not-matter",
				repoUrl: "https://example.invalid/repo.git",
				image: "bobbit-sandbox:test",
			} as unknown as ConstructorParameters<typeof ProjectSandbox>[0]);

			await assert.rejects(() => sandbox.init(), /never sandboxed|exempt/i);
			// Refused before ever touching Docker — no container was created.
			assert.equal(sandbox.getStatus().containerId, "");
		}
	});
});
