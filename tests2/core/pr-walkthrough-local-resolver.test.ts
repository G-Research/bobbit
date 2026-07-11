import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";

import { resolveLocalChangeset } from "../../src/server/pr-walkthrough/git-changeset.ts";
import type { CommandRunner, ExecFileResult } from "../../src/server/gateway-deps.ts";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

function fakeGitRunner(options: {
	diff?: string;
	nameStatus?: string;
	shortstat?: string;
	failBase?: boolean;
	failHead?: boolean;
} = {}): CommandRunner {
	return {
		async execFile(file, args): Promise<ExecFileResult> {
			expect(file).toBe("git");
			if (args[0] === "rev-parse") {
				const ref = String(args[2] ?? "");
				if (ref.includes("not-a-sha") || (options.failBase && ref.startsWith("base")) || (options.failHead && ref.startsWith("head"))) {
					throw new Error(`bad ref: ${ref}`);
				}
				return { stdout: ref.startsWith("head") || ref.startsWith(HEAD_SHA) ? `${HEAD_SHA}\n` : `${BASE_SHA}\n`, stderr: "" };
			}
			if (args.includes("--shortstat")) return { stdout: options.shortstat ?? "", stderr: "" };
			if (args.includes("--name-status")) return { stdout: options.nameStatus ?? "", stderr: "" };
			throw new Error(`unexpected git execFile args: ${args.join(" ")}`);
		},
		spawn(file, args) {
			expect(file).toBe("git");
			expect(args).toContain("diff");
			const child = new EventEmitter() as ChildProcess;
			const stdout = new PassThrough();
			const stderr = new PassThrough();
			let closed = false;
			const close = () => {
				if (closed) return;
				closed = true;
				child.emit("close", 0, null);
			};
			Object.assign(child, {
				stdout,
				stderr,
				killed: false,
				kill: () => {
					(child as any).killed = true;
					stdout.end();
					stderr.end();
					queueMicrotask(close);
					return true;
				},
			});
			queueMicrotask(() => {
				if (closed) return;
				stdout.write(options.diff ?? "");
				if ((child as any).killed) return;
				stdout.end();
				stderr.end();
				close();
			});
			return child;
		},
	};
}

describe("PR walkthrough local resolver", () => {
	it("rejects invalid base refs before parsing diffs", async () => {
		await expect(resolveLocalChangeset({
			cwd: "/repo",
			baseSha: "not-a-sha",
			headSha: "head",
			commandRunner: fakeGitRunner(),
		})).rejects.toThrow(/Invalid baseSha ref "not-a-sha"/);
	});

	it("resolves empty local diffs without review cards", async () => {
		const result = await resolveLocalChangeset({
			cwd: "/repo",
			baseSha: "base",
			headSha: "head",
			commandRunner: fakeGitRunner(),
		});

		expect(result.changeset.filesChanged).toBe(0);
		expect(result.files).toHaveLength(0);
		expect(result.warnings).toHaveLength(0);
	});

	it("returns truncation warnings for oversized local diffs without relying on real git", async () => {
		const largeDiff = [
			"diff --git a/large.txt b/large.txt",
			"index 1111111..2222222 100644",
			"--- a/large.txt",
			"+++ b/large.txt",
			"@@ -1 +1,200 @@",
			...Array.from({ length: 200 }, (_, index) => `+line ${index} ${"x".repeat(24)}`),
			"",
		].join("\n");

		const result = await resolveLocalChangeset({
			cwd: "/repo",
			baseSha: "base",
			headSha: "head",
			limits: { maxDiffBytes: 512 },
			commandRunner: fakeGitRunner({
				diff: largeDiff,
				nameStatus: "M\tlarge.txt\n",
				shortstat: "1 file changed, 200 insertions(+)\n",
			}),
		});

		expect(result.warnings.some(warning => warning.code === "diff-truncated")).toBe(true);
		expect(result.changeset.filesChanged).toBe(1);
	});
});
