import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];
const workers: Worker[] = [];

function waitForMessage(worker: Worker, type: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
	return new Promise((resolveMessage, rejectMessage) => {
		const timer = setTimeout(() => {
			cleanup();
			rejectMessage(new Error(`Timed out waiting for worker message ${type}`));
		}, timeoutMs);
		const onMessage = (message: unknown): void => {
			if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== type) return;
			cleanup();
			resolveMessage(message as Record<string, unknown>);
		};
		const onError = (error: Error): void => {
			cleanup();
			rejectMessage(error);
		};
		const onExit = (code: number): void => {
			cleanup();
			rejectMessage(new Error(`Worker exited with code ${code} before message ${type}`));
		};
		function cleanup(): void {
			clearTimeout(timer);
			worker.off("message", onMessage);
			worker.off("error", onError);
			worker.off("exit", onExit);
		}
		worker.on("message", onMessage);
		worker.on("error", onError);
		worker.on("exit", onExit);
	});
}

afterEach(async () => {
	await Promise.all(workers.splice(0).map(worker => worker.terminate()));
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
import { parentPort } from "node:worker_threads";
import { buildBundle } from ${JSON.stringify(helperUrl)};
parentPort.on("message", (message) => {
  if (message !== "go") return;
  parentPort.postMessage({ type: "calling" });
  try {
    buildBundle(${JSON.stringify({ entry, outfile })});
    parentPort.postMessage({ type: "returned" });
  } catch (error) {
    parentPort.postMessage({ type: "failed", error: String(error?.stack ?? error) });
  } finally {
    parentPort.close();
  }
});
parentPort.postMessage({ type: "ready" });
`, "utf8");

		const worker = new Worker(runner, { execArgv: ["--import", "tsx"] });
		workers.push(worker);
		await waitForMessage(worker, "ready");
		const returned = waitForMessage(worker, "returned");
		const failed = waitForMessage(worker, "failed");
		worker.postMessage("go");
		await waitForMessage(worker, "calling");

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
