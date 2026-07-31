import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { CookieStore } from "../../src/server/auth/cookie.ts";
import { COOKIE_SIGNING_KEY_FILE } from "../../src/server/auth/cookie-signing-key.ts";

const BASE_NOW = 1_800_000_000;
let stateDir: string;

beforeAll(() => {
	stateDir = fs.mkdtempSync(path.join(tmpdir(), "bobbit-cookie-concurrency-"));
});

afterAll(() => {
	fs.rmSync(stateDir, { recursive: true, force: true });
});

interface IndependentContenderResult {
	pid: number;
	key: string;
	cookie: string;
	crossVerified: number;
}

async function runIndependentKeyContenders(
	workDir: string,
	secretsDir: string,
	contenderCount: number,
): Promise<IndependentContenderResult[]> {
	const coordinationDir = path.join(workDir, "coordination");
	fs.mkdirSync(coordinationDir);
	const contenderPath = path.join(workDir, "cookie-key-contender.mjs");
	const launcherPath = path.join(workDir, "cookie-key-launcher.cjs");
	const signingKeyModule = fileURLToPath(new URL("../../src/server/auth/cookie-signing-key.ts", import.meta.url));
	const cookieModule = fileURLToPath(new URL("../../src/server/auth/cookie.ts", import.meta.url));

	fs.writeFileSync(contenderPath, String.raw`
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [secretsDir, coordinationDir, countRaw, id, signingKeyModule, cookieModule, nowRaw] = process.argv.slice(2);
const contenderCount = Number(countRaw);
const nowSeconds = Number(nowRaw);
const clock = { now: () => nowSeconds * 1_000 };
const [{ loadOrCreateCookieSigningKey }, { CookieStore }] = await Promise.all([
	import(pathToFileURL(signingKeyModule).href),
	import(pathToFileURL(cookieModule).href),
]);

async function waitFor(predicate, label) {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for " + label);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

fs.writeFileSync(path.join(coordinationDir, "ready-" + id), String(process.pid), { flag: "wx" });
await waitFor(() => fs.existsSync(path.join(coordinationDir, "release")), "release barrier");

const key = loadOrCreateCookieSigningKey(secretsDir);
const cookie = new CookieStore(key, { clock }).mint();
const result = { id: Number(id), pid: process.pid, key: key.toString("base64url"), cookie };
const tempResult = path.join(coordinationDir, "result-" + id + ".tmp");
const finalResult = path.join(coordinationDir, "result-" + id + ".json");
fs.writeFileSync(tempResult, JSON.stringify(result), { flag: "wx" });
fs.renameSync(tempResult, finalResult);

await waitFor(
	() => fs.readdirSync(coordinationDir).filter((name) => /^result-\d+\.json$/.test(name)).length === contenderCount,
	"all contender results",
);
const results = fs.readdirSync(coordinationDir)
	.filter((name) => /^result-\d+\.json$/.test(name))
	.map((name) => JSON.parse(fs.readFileSync(path.join(coordinationDir, name), "utf8")))
	.sort((left, right) => left.id - right.id);
for (const other of results) {
	const otherKey = Buffer.from(other.key, "base64url");
	if (otherKey.length !== 32) throw new Error("contender observed an incomplete signing key");
	if (!new CookieStore(key, { clock }).verify(other.cookie)) {
		throw new Error("contender could not verify a peer cookie");
	}
	if (!new CookieStore(otherKey, { clock }).verify(cookie)) {
		throw new Error("peer key could not verify contender cookie");
	}
}
process.stdout.write(JSON.stringify({ pid: process.pid, key: result.key, cookie, crossVerified: results.length }));
`);

	fs.writeFileSync(launcherPath, String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { parentPort, workerData } = require("node:worker_threads");

const children = [];
function waitFor(predicate, label) {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 5_000;
		const poll = () => {
			if (predicate()) return resolve();
			if (Date.now() >= deadline) return reject(new Error("timed out waiting for " + label));
			setTimeout(poll, 10);
		};
		poll();
	});
}
function launch(index) {
	const child = spawn(process.execPath, [
		"--import", "tsx", workerData.contenderPath,
		workerData.secretsDir, workerData.coordinationDir, String(workerData.contenderCount), String(index),
		workerData.signingKeyModule, workerData.cookieModule, String(workerData.nowSeconds),
	], { cwd: workerData.cwd, env: process.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	children.push(child);
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", (error) => resolve({ index, code: null, stdout, stderr, error: error.stack || error.message }));
		child.on("close", (code) => resolve({ index, code, stdout, stderr }));
	});
}

(async () => {
	try {
		const completions = Array.from({ length: workerData.contenderCount }, (_, index) => launch(index));
		await waitFor(
			() => fs.readdirSync(workerData.coordinationDir).filter((name) => name.startsWith("ready-")).length === workerData.contenderCount,
			"all contenders at release barrier",
		);
		fs.writeFileSync(path.join(workerData.coordinationDir, "release"), "go", { flag: "wx" });
		const outcomes = await Promise.all(completions);
		for (const outcome of outcomes) {
			if (outcome.code !== 0) {
				throw new Error("contender " + outcome.index + " failed (exit " + outcome.code + "): " + (outcome.error || outcome.stderr || outcome.stdout));
			}
		}
		parentPort.postMessage({ ok: true, results: outcomes.map((outcome) => JSON.parse(outcome.stdout)) });
	} catch (error) {
		for (const child of children) child.kill();
		parentPort.postMessage({ ok: false, error: error && (error.stack || error.message) || String(error) });
	}
})();
`);

	return await new Promise<IndependentContenderResult[]>((resolve, reject) => {
		const worker = new Worker(launcherPath, {
			workerData: {
				contenderPath,
				secretsDir,
				coordinationDir,
				contenderCount,
				signingKeyModule,
				cookieModule,
				nowSeconds: BASE_NOW,
				cwd: process.cwd(),
			},
		});
		const timeout = setTimeout(() => {
			void worker.terminate();
			reject(new Error("independent cookie signing-key contenders timed out"));
		}, 8_000);
		worker.once("message", (message: { ok: boolean; results?: IndependentContenderResult[]; error?: string }) => {
			clearTimeout(timeout);
			void worker.terminate();
			if (message.ok && message.results) resolve(message.results);
			else reject(new Error(message.error ?? "independent cookie signing-key contenders failed"));
		});
		worker.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
}

describe("cookie signing-key concurrency", () => {
	it("atomically initializes one complete key across released independent processes", async () => {
		const workDir = fs.mkdtempSync(path.join(stateDir, "process-race-"));
		const secretsDir = path.join(workDir, "secrets");
		const contenderCount = 3;
		const results = await runIndependentKeyContenders(workDir, secretsDir, contenderCount);

		assert.equal(results.length, contenderCount);
		assert.equal(new Set(results.map((result) => result.pid)).size, contenderCount);
		assert.equal(new Set(results.map((result) => result.key)).size, 1);
		assert.ok(results.every((result) => Buffer.from(result.key, "base64url").length === 32));
		assert.ok(results.every((result) => result.crossVerified === contenderCount));

		const persisted = fs.readFileSync(path.join(secretsDir, COOKIE_SIGNING_KEY_FILE));
		assert.equal(persisted.length, 32);
		assert.deepEqual(persisted, Buffer.from(results[0].key, "base64url"));
		assert.deepEqual(fs.readdirSync(secretsDir), [COOKIE_SIGNING_KEY_FILE]);

		const clock = { now: () => BASE_NOW * 1_000 };
		for (const verifier of results) {
			const store = new CookieStore(Buffer.from(verifier.key, "base64url"), { clock });
			for (const signer of results) assert.ok(store.verify(signer.cookie));
		}
	});
});
