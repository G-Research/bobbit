import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type ValidationResult = {
	ok: boolean;
	resolvedPath?: string;
	error?: { code?: string; message?: string; resolvedPath?: string };
};

async function loadValidationFn(): Promise<(input: string, projectRoot: string) => Promise<ValidationResult> | ValidationResult> {
	for (const specifier of ["../src/server/agent-dir-config.ts", "../src/server/bobbit-dir.ts"]) {
		try {
			const mod = await import(specifier) as Record<string, any>;
			if (typeof mod.validateAgentDirTarget === "function") {
				return (input, projectRoot) => mod.validateAgentDirTarget(input, projectRoot);
			}
		} catch (err: any) {
			if (err?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find module/.test(String(err?.message))) continue;
			throw err;
		}
	}
	throw new Error("validateAgentDirTarget must be exported");
}

function makeGitProject(prefix: string): string {
	const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	execFileSync("git", ["init"], { cwd: projectRoot, stdio: "ignore" });
	return projectRoot;
}

function cleanup(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function assertSamePath(actual: string | undefined, expected: string): void {
	assert.ok(actual, "expected resolvedPath to be present");
	assert.equal(path.normalize(actual), path.normalize(expected));
}

describe("validateAgentDirTarget", () => {
	it("accepts and creates the default <projectRoot>/.bobbit/agent path inside the worktree", async (t) => {
		const validate = await loadValidationFn();
		const projectRoot = makeGitProject("bobbit-agent-dir-validation-default-");
		t.after(() => cleanup(projectRoot));

		const defaultDir = path.join(projectRoot, ".bobbit", "agent");
		const result = await validate(defaultDir, projectRoot);

		assert.equal(result.ok, true, JSON.stringify(result.error));
		assertSamePath(result.resolvedPath, defaultDir);
		assert.equal(fs.statSync(defaultDir).isDirectory(), true);
	});

	it("accepts nested paths under the default agent directory", async (t) => {
		const validate = await loadValidationFn();
		const projectRoot = makeGitProject("bobbit-agent-dir-validation-default-nested-");
		t.after(() => cleanup(projectRoot));

		const nested = path.join(projectRoot, ".bobbit", "agent", "nested");
		const result = await validate(nested, projectRoot);

		assert.equal(result.ok, true, JSON.stringify(result.error));
		assertSamePath(result.resolvedPath, nested);
		assert.equal(fs.statSync(nested).isDirectory(), true);
	});

	it("rejects non-default paths inside the git worktree", async (t) => {
		const validate = await loadValidationFn();
		const projectRoot = makeGitProject("bobbit-agent-dir-validation-inside-");
		t.after(() => cleanup(projectRoot));

		const result = await validate(path.join(projectRoot, "credentials", "agent"), projectRoot);

		assert.equal(result.ok, false);
		assert.equal(result.error?.code, "INSIDE_WORKTREE");
	});

	it("resolves relative inputs against project root before applying worktree checks", async (t) => {
		const validate = await loadValidationFn();
		const projectRoot = makeGitProject("bobbit-agent-dir-validation-relative-");
		t.after(() => cleanup(projectRoot));

		const result = await validate("relative-agent-dir", projectRoot);

		assert.equal(result.ok, false);
		assert.equal(result.error?.code, "INSIDE_WORKTREE");
		assertSamePath(result.error?.resolvedPath ?? result.resolvedPath, path.join(projectRoot, "relative-agent-dir"));
	});

	it("creates outside-worktree targets and verifies read/write access", async (t) => {
		const validate = await loadValidationFn();
		const projectRoot = makeGitProject("bobbit-agent-dir-validation-project-");
		const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-agent-dir-validation-outside-"));
		t.after(() => {
			cleanup(projectRoot);
			cleanup(outsideRoot);
		});

		const target = path.join(outsideRoot, "agent");
		const result = await validate(target, projectRoot);

		assert.equal(result.ok, true, JSON.stringify(result.error));
		assertSamePath(result.resolvedPath, target);
		assert.equal(fs.statSync(target).isDirectory(), true);
		const probes = fs.readdirSync(target).filter((entry) => /probe/i.test(entry));
		assert.deepEqual(probes, [], "validation probe files must be cleaned up");
	});

	it("returns structured errors for empty paths and file targets", async (t) => {
		const validate = await loadValidationFn();
		const projectRoot = makeGitProject("bobbit-agent-dir-validation-errors-");
		const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-agent-dir-validation-file-"));
		t.after(() => {
			cleanup(projectRoot);
			cleanup(outsideRoot);
		});

		const empty = await validate("   ", projectRoot);
		assert.equal(empty.ok, false);
		assert.equal(empty.error?.code, "EMPTY_PATH");

		const fileTarget = path.join(outsideRoot, "agent-file");
		fs.writeFileSync(fileTarget, "not a directory");
		const fileResult = await validate(fileTarget, projectRoot);
		assert.equal(fileResult.ok, false);
		assert.equal(fileResult.error?.code, "NOT_DIRECTORY");
		assertSamePath(fileResult.error?.resolvedPath ?? fileResult.resolvedPath, fileTarget);
	});
});
