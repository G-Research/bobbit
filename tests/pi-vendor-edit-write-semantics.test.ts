import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Vendor-behavior compatibility pins for pi's `edit`/`write` tool semantics
 * that Bobbit's code assumes without wrapping pi's file-tool factories.
 *
 * WORKAROUND PROTECTED: none of these are compensated from Bobbit's side --
 * `defaults/tools/_builtins/extension.ts:26-32,36-41,58` re-registers pi's
 * `createEditToolDefinition`/`createWriteToolDefinition` unmodified. There is
 * no hook between "read the file" and "write the file" inside pi's own
 * `execute()` for Bobbit to intercept. Design doc: `docs/design/pi-fork-edit-safety.md`
 * §2 ("Edit-safety assessment") -- this file exists per that doc's
 * recommendation #1 to turn a silent pi-upgrade behavior change here into a
 * loud CI failure instead of a field-discovered corruption bug.
 *
 * Four claims are pinned, each independently load-bearing:
 *  1. Same-file mutation serialization EXISTS (`withFileMutationQueue`) --
 *     Bobbit relies on this to avoid racing concurrent edit/write calls
 *     against the same file within one pi process.
 *  2. Writes are NON-ATOMIC -- a single `fs.promises.writeFile(path, content,
 *     "utf-8")` with no temp-file-then-rename and no fsync. Bobbit's
 *     worktree-per-session model contains most of this blast radius (see the
 *     design doc §2), but that containment argument is void if pi silently
 *     switches to a temp+rename scheme with different partial-failure
 *     semantics Bobbit hasn't accounted for.
 *  3. No conflict/staleness check exists between the read and the write --
 *     `edit.js` reads once, diffs in memory, writes once, with no re-check
 *     of mtime/hash against a concurrent external modification.
 *  4. File content is decoded/encoded as hardcoded UTF-8 -- a binary or
 *     non-UTF-8 file routed through `edit`/`write` is silently
 *     mis-decoded/re-encoded.
 */

function packageRootFromResolved(specifier: string): string {
	const resolved = fileURLToPath(import.meta.resolve(specifier));
	let dir = path.dirname(resolved);
	while (true) {
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`Could not find package root for ${specifier} from ${resolved}`);
}

function codingAgentDistFile(...segments: string[]): string {
	const root = packageRootFromResolved("@earendil-works/pi-coding-agent");
	return path.join(root, "dist", "core", "tools", ...segments);
}

describe("Pi edit/write tool vendor-behavior pins", () => {
	it("withFileMutationQueue still serializes operations against the same resolved path", async () => {
		const queueFile = codingAgentDistFile("file-mutation-queue.js");
		assert.ok(
			fs.existsSync(queueFile),
			`installed pi-coding-agent file-mutation-queue.js missing: ${queueFile} -- ` +
				"defaults/tools/_builtins/extension.ts re-registers pi's edit/write factories " +
				"unmodified and relies on this module existing to serialize same-file mutations.",
		);
		const { withFileMutationQueue } = (await import(pathToFileURL(queueFile).href)) as {
			withFileMutationQueue: <T>(filePath: string, fn: () => Promise<T>) => Promise<T>;
		};
		assert.equal(
			typeof withFileMutationQueue,
			"function",
			"pi-coding-agent file-mutation-queue.js no longer exports withFileMutationQueue as a function -- " +
				"edit.js/write.js's same-file serialization guarantee depends on this export shape.",
		);

		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-vendor-mutation-queue-"));
		try {
			const target = path.join(dir, "same-file.txt");
			fs.writeFileSync(target, "");

			const events: string[] = [];
			let releaseFirst: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});

			const first = withFileMutationQueue(target, async () => {
				events.push("first-start");
				await gate;
				events.push("first-end");
			});
			const second = withFileMutationQueue(target, async () => {
				events.push("second-start");
			});

			// Give the event loop several turns without releasing the gate. If pi's
			// queue stopped serializing same-path operations, "second-start" would
			// already be present here.
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.deepEqual(
				events,
				["first-start"],
				"withFileMutationQueue let a second operation on the SAME resolved path start before the " +
					"first finished -- pi no longer serializes same-file edit/write mutations within one " +
					"process. Bobbit's edit/write registration (defaults/tools/_builtins/extension.ts) has no " +
					"workaround for a race here.",
			);

			releaseFirst();
			await Promise.all([first, second]);
			assert.deepEqual(events, ["first-start", "first-end", "second-start"]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("withFileMutationQueue does not serialize operations across different resolved paths", async () => {
		const queueFile = codingAgentDistFile("file-mutation-queue.js");
		const { withFileMutationQueue } = (await import(pathToFileURL(queueFile).href)) as {
			withFileMutationQueue: <T>(filePath: string, fn: () => Promise<T>) => Promise<T>;
		};

		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-vendor-mutation-queue-cross-"));
		try {
			const pathA = path.join(dir, "a.txt");
			const pathB = path.join(dir, "b.txt");
			fs.writeFileSync(pathA, "");
			fs.writeFileSync(pathB, "");

			const events: string[] = [];
			let releaseA: () => void = () => {};
			const gateA = new Promise<void>((resolve) => {
				releaseA = resolve;
			});

			const a = withFileMutationQueue(pathA, async () => {
				events.push("a-start");
				await gateA;
				events.push("a-end");
			});
			const b = withFileMutationQueue(pathB, async () => {
				events.push("b-start");
			});

			await b;
			assert.ok(
				events.includes("b-start") && !events.includes("a-end"),
				"withFileMutationQueue blocked an operation on a DIFFERENT resolved path behind an in-flight " +
					"mutation on another path -- pi's mutation queue became a single global lock instead of " +
					"per-file. This would change concurrency characteristics Bobbit's worktree-per-session " +
					"model (docs/dev-workflow.md) does not currently account for.",
			);

			releaseA();
			await a;
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("edit.js still writes non-atomically with hardcoded UTF-8 and no re-read staleness check", () => {
		const editFile = codingAgentDistFile("edit.js");
		assert.ok(fs.existsSync(editFile), `installed pi-coding-agent edit.js missing: ${editFile}`);
		const source = fs.readFileSync(editFile, "utf-8");

		assert.ok(
			source.includes('writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),'),
			"pi-coding-agent edit.js: default writeFile operation changed shape. Bobbit assumes edit() performs " +
				'a single non-atomic fs.promises.writeFile(path, content, "utf-8") call with no temp-file/rename ' +
				"step -- if pi added atomic-write semantics here, the design doc's edit-safety risk assessment " +
				"(docs/design/pi-fork-edit-safety.md §2, 'non-atomic write' gap) needs re-evaluation, not silent " +
				"carry-forward.",
		);
		assert.ok(
			source.includes('const rawContent = buffer.toString("utf-8");'),
			"pi-coding-agent edit.js: no longer decodes file content as hardcoded UTF-8 via " +
				'buffer.toString("utf-8"). Bobbit does not guard binary/non-UTF-8 files routed through edit -- ' +
				"a change here changes what 'silently mis-decoded' means for those files.",
		);

		const readIndex = source.indexOf('const rawContent = buffer.toString("utf-8");');
		const writeIndex = source.indexOf("await ops.writeFile(absolutePath, finalContent);");
		assert.ok(readIndex >= 0 && writeIndex > readIndex, "edit.js read/write anchors not found in expected order");
		const betweenReadAndWrite = source.slice(readIndex, writeIndex);
		for (const staleCheckKeyword of ["mtime", "birthtime", "\\bstat\\(", "createHash", "\\bino\\b"]) {
			const re = new RegExp(staleCheckKeyword);
			assert.ok(
				!re.test(betweenReadAndWrite),
				`pi-coding-agent edit.js now contains "${staleCheckKeyword}"-looking logic between its file read ` +
					"and write -- this suggests pi added a conflict/staleness check that did not exist before. " +
					"Re-verify docs/design/pi-fork-edit-safety.md §2's 'no conflict/staleness detection' finding " +
					"before assuming it's still accurate.",
			);
		}
	});

	it("write.js still writes non-atomically with hardcoded UTF-8", () => {
		const writeFile = codingAgentDistFile("write.js");
		assert.ok(fs.existsSync(writeFile), `installed pi-coding-agent write.js missing: ${writeFile}`);
		const source = fs.readFileSync(writeFile, "utf-8");

		assert.ok(
			source.includes('writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),'),
			"pi-coding-agent write.js: default writeFile operation changed shape. Bobbit assumes write() performs " +
				'a single non-atomic fs.promises.writeFile(path, content, "utf-8") call -- see ' +
				"docs/design/pi-fork-edit-safety.md §2's non-atomic-write finding, which this pin protects.",
		);
		assert.ok(
			source.includes("return withFileMutationQueue(absolutePath, async () => {"),
			"pi-coding-agent write.js no longer routes its execute() body through withFileMutationQueue. " +
				"Bobbit's assumption that same-file write()/edit() calls are serialized within one pi process " +
				"depends on both tools using this queue.",
		);
	});
});
