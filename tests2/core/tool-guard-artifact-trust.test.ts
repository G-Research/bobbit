import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TOOL_GUARD_ARTIFACT_INTEGRITY_ERROR, writeToolGuardExtension } from "../../src/server/agent/tool-activation.ts";

function toolManager() {
	const tools = [{ name: "bash", group: "Shell", grantPolicy: "ask" }];
	return {
		getAvailableTools: () => tools,
		getToolByName: (name: string) => tools.find((tool) => tool.name === name),
		getToolProviders: () => new Map(),
	} as any;
}

function writeGuard(): string {
	const guard = writeToolGuardExtension("trusted-guard-session", toolManager(), undefined, undefined, undefined, []);
	if (!guard) throw new Error("expected tool guard");
	return guard;
}

function withPlatform<T>(platform: NodeJS.Platform, callback: () => T): T {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	if (!descriptor?.configurable) throw new Error("process.platform must be configurable for this platform test");
	Object.defineProperty(process, "platform", { ...descriptor, value: platform });
	try {
		return callback();
	} finally {
		Object.defineProperty(process, "platform", descriptor);
	}
}

describe.sequential("trusted tool-guard artifact", () => {
	let stateRoot = "";
	let previousBobbitDir: string | undefined;

	beforeEach(() => {
		previousBobbitDir = process.env.BOBBIT_DIR;
		stateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tool-guard-trust-")));
		process.env.BOBBIT_DIR = stateRoot;
	});

	afterEach(() => {
		if (previousBobbitDir === undefined) delete process.env.BOBBIT_DIR;
		else process.env.BOBBIT_DIR = previousBobbitDir;
		fs.rmSync(stateRoot, { recursive: true, force: true });
	});

	it("publishes a readable regular guard through a temporary atomic artifact", () => {
		const guard = writeGuard();
		const directory = path.dirname(guard);
		const source = fs.readFileSync(guard, "utf8");
		const guardStat = fs.lstatSync(guard);

		expect(guardStat.isFile()).toBe(true);
		expect(guardStat.isSymbolicLink()).toBe(false);
		expect(source.length).toBeGreaterThan(0);
		expect(fs.readdirSync(directory).filter((entry) => entry.includes(".tmp"))).toEqual([]);
		// Exact content remains safely reusable on every platform.
		expect(writeGuard()).toBe(guard);
		expect(fs.readFileSync(guard, "utf8")).toBe(source);

		if (process.platform !== "win32") {
			expect(guardStat.mode & 0o777).toBe(0o444);
			expect(fs.lstatSync(path.dirname(directory)).mode & 0o111).toBe(0o111);
			expect(fs.lstatSync(directory).mode & 0o111).toBe(0o111);

			// A permissive inherited mode is repaired only where POSIX modes apply.
			fs.chmodSync(guard, 0o644);
			expect(writeGuard()).toBe(guard);
			expect(fs.lstatSync(guard).mode & 0o777).toBe(0o444);
		}
	});

	it("fails closed when a cached guard's bytes are tampered", () => {
		const guard = writeGuard();
		if (process.platform !== "win32") fs.chmodSync(guard, 0o644);
		fs.writeFileSync(guard, "export default { tampered: true };", "utf8");

		expect(() => writeGuard()).toThrow(TOOL_GUARD_ARTIFACT_INTEGRITY_ERROR);
	});

	it("keeps exact-content validation without POSIX mode operations on Windows", () => {
		const chmod = vi.spyOn(fs, "chmodSync");
		try {
			withPlatform("win32", () => {
				const guard = writeGuard();
				expect(chmod).not.toHaveBeenCalled();
				expect(fs.lstatSync(guard).isFile()).toBe(true);
				expect(fs.lstatSync(guard).isSymbolicLink()).toBe(false);
				expect(fs.readFileSync(guard, "utf8").length).toBeGreaterThan(0);

				fs.writeFileSync(guard, "export default { tampered: true };", "utf8");
				expect(() => writeGuard()).toThrow(TOOL_GUARD_ARTIFACT_INTEGRITY_ERROR);
			});
		} finally {
			chmod.mockRestore();
		}
	});

	it.skipIf(process.platform === "win32")("fails closed for symlinked guard roots, hash directories, or files", () => {
		const guard = writeGuard();
		const hashDir = path.dirname(guard);
		const root = path.dirname(hashDir);
		const target = path.join(stateRoot, "attacker-target");
		fs.mkdirSync(target);

		fs.rmSync(guard);
		fs.symlinkSync(path.join(target, "guard.ts"), guard, "file");
		expect(() => writeGuard()).toThrow(TOOL_GUARD_ARTIFACT_INTEGRITY_ERROR);

		fs.rmSync(guard);
		fs.rmSync(hashDir, { recursive: true, force: true });
		fs.symlinkSync(target, hashDir, "dir");
		expect(() => writeGuard()).toThrow(TOOL_GUARD_ARTIFACT_INTEGRITY_ERROR);

		fs.rmSync(hashDir);
		fs.rmSync(root, { recursive: true, force: true });
		fs.symlinkSync(target, root, "dir");
		expect(() => writeGuard()).toThrow(TOOL_GUARD_ARTIFACT_INTEGRITY_ERROR);
	});

	it("never accepts a matching filename without exact expected content", () => {
		const guard = writeGuard();
		const original = fs.readFileSync(guard, "utf8");
		const expectedHash = createHash("sha256").update(original).digest("hex").slice(0, 12);
		expect(path.basename(path.dirname(guard))).toBe(expectedHash);

		if (process.platform !== "win32") fs.chmodSync(guard, 0o644);
		fs.writeFileSync(guard, original + "\n// attacker append", "utf8");
		expect(() => writeGuard()).toThrow(TOOL_GUARD_ARTIFACT_INTEGRITY_ERROR);
	});
});
