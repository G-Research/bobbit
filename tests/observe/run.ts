/**
 * Entry point for the observe harness.
 *
 *   npx tsx tests/observe/run.ts [--scenario basic|rapid-fire|interrupt]
 *                                [--hang-ms 30000]
 *                                [--tick-ms 1000]
 *                                [--headed]
 *                                [--no-spawn]    # attach to existing gateway
 *
 * Without --no-spawn, spawns a fresh gateway in a temp dir using the built
 * server CLI (npm run build first). With --no-spawn, reads GATEWAY_URL +
 * BOBBIT_TOKEN from env (or .bobbit/state/{gateway-url,token}).
 */

import { chromium, type Browser, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Observer, PROBE_SOURCE } from "./observer.ts";
import { SCENARIOS } from "./scenarios.ts";
import { detectHangs, detectOutOfOrder, detectVisibleToolErrors } from "./detectors.ts";
import { writeReport } from "./report.ts";
import type { RunMeta } from "./types.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");

interface Args {
	scenario: string;
	hangMs: number;
	tickMs: number;
	headed: boolean;
	spawn: boolean;
}

function parseArgs(): Args {
	const argv = process.argv.slice(2);
	const get = (flag: string, def?: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : def;
	};
	return {
		scenario: get("--scenario", "basic")!,
		hangMs: Number(get("--hang-ms", "30000")),
		tickMs: Number(get("--tick-ms", "1000")),
		headed: argv.includes("--headed"),
		spawn: !argv.includes("--no-spawn"),
	};
}

async function freePort(): Promise<number> {
	return new Promise((res, rej) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const p = (s.address() as any).port;
			s.close(() => res(p));
		});
		s.on("error", rej);
	});
}

interface GW {
	proc?: ChildProcess;
	dir: string;
	url: string;
	token: string;
}

async function spawnGateway(): Promise<GW> {
	const cli = join(PROJECT_ROOT, "dist", "server", "cli.js");
	if (!existsSync(cli)) {
		throw new Error(`${cli} not found — run \`npm run build\` first.`);
	}
	const tmp = process.platform === "win32" ? process.env.TEMP || "C:\\Temp" : "/tmp";
	const port = await freePort();
	const dir = join(tmp, `.bobbit-observe-${port}-${Date.now()}`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	// Init a tiny git repo so the gateway is happy registering it as a project.
	execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/master"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "obs@obs"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "obs"], { cwd: dir, stdio: "ignore" });
	writeFileSync(join(dir, "README.md"), "# observe scratch\n");
	execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });

	const proc = spawn(
		process.execPath,
		[cli, "--host", "127.0.0.1", "--port", String(port), "--no-tls", "--auth", "--cwd", dir],
		{
			env: { ...process.env, BOBBIT_DIR: join(dir, ".bobbit"), NODE_ENV: "test" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	proc.stderr!.on("data", (b) => process.stderr.write(`[gw] ${b}`));

	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) throw new Error(`gateway exited ${proc.exitCode}`);
		const tp = join(dir, ".bobbit", "state", "token");
		if (existsSync(tp)) {
			const t = readFileSync(tp, "utf-8").trim();
			try {
				const ok = await fetch(`http://127.0.0.1:${port}/api/health`, {
					headers: { Authorization: `Bearer ${t}` },
				});
				if (ok.ok) {
					// Register the cwd as a project so "New session" works.
					await fetch(`http://127.0.0.1:${port}/api/projects`, {
						method: "POST",
						headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
						body: JSON.stringify({ name: "default", rootPath: dir, upsert: true }),
					}).catch(() => undefined);
					return { proc, dir, url: `http://127.0.0.1:${port}`, token: t };
				}
			} catch {
				/* keep polling */
			}
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	proc.kill();
	throw new Error("gateway did not become healthy in 120s");
}

function attachGateway(): GW {
	const url = process.env.GATEWAY_URL?.trim();
	const token =
		process.env.BOBBIT_TOKEN ??
		(existsSync(".bobbit/state/token")
			? readFileSync(".bobbit/state/token", "utf-8").trim()
			: undefined);
	if (!url || !token) {
		throw new Error("--no-spawn requires GATEWAY_URL and BOBBIT_TOKEN (or .bobbit/state/token).");
	}
	return { dir: "", url, token };
}

async function stopGateway(gw: GW): Promise<void> {
	if (!gw.proc) return;
	if (gw.proc.exitCode === null) {
		if (process.platform === "win32") {
			try {
				execFileSync("taskkill", ["/PID", String(gw.proc.pid), "/T", "/F"], { stdio: "ignore" });
			} catch {
				/* ignore */
			}
		} else {
			gw.proc.kill();
		}
	}
	await new Promise<void>((r) => {
		if (gw.proc!.exitCode !== null) return r();
		gw.proc!.on("exit", () => r());
		setTimeout(() => r(), 5_000);
	});
}

async function main(): Promise<void> {
	const args = parseArgs();
	const scenario = SCENARIOS[args.scenario];
	if (!scenario) {
		console.error(`unknown scenario: ${args.scenario}`);
		console.error(`available: ${Object.keys(SCENARIOS).join(", ")}`);
		process.exit(2);
	}

	const gw = args.spawn ? await spawnGateway() : attachGateway();
	console.log(`[observe] gateway=${gw.url} (${args.spawn ? "spawned" : "attached"})`);

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outDir = join(PROJECT_ROOT, "tests", "observe", "runs", `${stamp}-${scenario.name}`);
	mkdirSync(outDir, { recursive: true });

	const meta: RunMeta = {
		startedAt: new Date().toISOString(),
		scenario: scenario.name,
		gatewayUrl: gw.url,
		thresholds: { hangMs: args.hangMs, tickMs: args.tickMs },
	};

	const browser: Browser = await chromium.launch({ headless: !args.headed });
	const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
	await ctx.addInitScript({ content: PROBE_SOURCE });
	const page: Page = await ctx.newPage();

	const observer = new Observer({ page, outDir, tickMs: args.tickMs, meta });
	await observer.init();

	const act = async (name: string, fn: () => Promise<void>): Promise<void> => {
		console.log(`[observe] · ${name}`);
		await observer.beforeAction(name);
		try {
			await fn();
		} catch (e) {
			observer.timeline.findings.push({
				kind: "hang",
				atMs: Date.now() - new Date(meta.startedAt).getTime(),
				tickIndex: observer.timeline.ticks.length,
				detail: `action "${name}" threw: ${(e as Error).message}`,
			});
			throw e;
		} finally {
			await observer.afterAction(name);
		}
	};

	observer.start();
	let exitReason = "ok";
	try {
		await scenario.run({ page, observer, act, gatewayUrl: gw.url, token: gw.token });
	} catch (e) {
		exitReason = `error: ${(e as Error).message}`;
		console.error(`[observe] scenario failed: ${exitReason}`);
	} finally {
		observer.stop();
		// One last capture after the scenario settles.
		await observer.afterAction("final").catch(() => undefined);
		observer.timeline.meta.finishedAt = new Date().toISOString();
		observer.timeline.meta.exitReason = exitReason;

		// Run detectors over the recorded timeline.
		detectHangs(observer.timeline, args.hangMs);
		detectOutOfOrder(observer.timeline);
		detectVisibleToolErrors(observer.timeline);

		writeFileSync(
			join(outDir, "timeline.json"),
			JSON.stringify(observer.timeline, null, 2),
		);

		const reportPath = await writeReport(outDir);
		console.log(`[observe] report: ${reportPath}`);
		console.log(`[observe] findings: ${observer.timeline.findings.length}`);
		for (const f of observer.timeline.findings) {
			console.log(`  · [${f.kind} @ ${f.atMs}ms] ${f.detail}`);
		}

		await ctx.close();
		await browser.close();
		await stopGateway(gw);
	}

	process.exit(observer.timeline.findings.length > 0 ? 1 : 0);
}

main().catch((e) => {
	console.error(e);
	process.exit(2);
});
