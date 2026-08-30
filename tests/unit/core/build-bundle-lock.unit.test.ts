import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];
const children: ChildProcess[] = [];

function waitForMessage(child: ChildProcess, type: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
	return new Promise((resolveMessage, rejectMessage) => {
		const timer = setTimeout(() => {
			cleanup();
			rejectMessage(new Error(`Timed out waiting for child message ${type}`));
		}, timeoutMs);
		const onMessage = (message: unknown): void => {
			if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== type) return;
			cleanup();
			resolveMessage(message as Record<string, unknown>);
		};
		const onExit = (code: number | null): void => {
			cleanup();
			rejectMessage(new Error(`Child exited with code ${code} before message ${type}`));
		};
		function cleanup(): void {
			clearTimeout(timer);
			child.off("message", onMessage);
			child.off("exit", onExit);
		}
		child.on("message", onMessage);
		child.on("exit", onExit);
	});
}

afterEach(async () => {
	await Promise.all(children.splice(0).map(async child => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		await new Promise<void>(resolveExit => {
			const timeout = setTimeout(resolveExit, 1_000);
			child.once("exit", () => {
				clearTimeout(timeout);
				resolveExit();
			});
			child.kill();
		});
	}));
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("buildBundle lock ownership", () => {
	it("does not accept a fresh partial outfile while another caller owns the lock", async () => {
		const root = mkdtempSync(join(tmpdir(), "bobbit-build-bundle-lock-"));
		temporaryRoots.push(root);
		const entry = join(root, "entry.ts");
		const outfile = join(root, "fixture-bundle.js");
		const lockDir = `${outfile}.lock`;
		const runner = join(root, "waiter.mjs");
		writeFileSync(entry, "globalThis.fixture = 'source';\n", "utf8");
		mkdirSync(lockDir);
		writeFileSync(outfile, "partial", "utf8");
		const future = new Date(Date.now() + 5_000);
		utimesSync(outfile, future, future);

		const helperUrl = pathToFileURL(resolve(import.meta.dirname, "../../fixtures/build-bundle.ts")).href;
		writeFileSync(runner, `
import { buildBundle } from ${JSON.stringify(helperUrl)};
process.on("message", (message) => {
  if (message !== "go") return;
  process.send({ type: "calling" }, () => {
    try {
      buildBundle(${JSON.stringify({ entry, outfile })});
      process.send({ type: "returned" }, () => process.disconnect());
    } catch (error) {
      process.send({ type: "failed", error: String(error?.stack ?? error) }, () => process.disconnect());
    }
  });
});
process.send({ type: "ready" });
`, "utf8");

		const child = spawn(process.execPath, ["--import", "tsx", runner], {
			cwd: resolve(import.meta.dirname, "../../.."),
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		children.push(child);
		await waitForMessage(child, "ready");
		const returned = waitForMessage(child, "returned");
		const failed = waitForMessage(child, "failed");
		child.send("go");
		await waitForMessage(child, "calling");

		const premature = await Promise.race([
			returned.then(() => "returned"),
			failed.then(message => `failed: ${String(message.error)}`),
			new Promise<string>(resolveBlocked => setTimeout(() => resolveBlocked("blocked"), 300)),
		]);
		expect(premature).toBe("blocked");

		writeFileSync(outfile, "complete publication", "utf8");
		utimesSync(outfile, future, future);
		rmSync(lockDir);
		await returned;
		expect(readFileSync(outfile, "utf8")).toBe("complete publication");
	}, 10_000);
});
