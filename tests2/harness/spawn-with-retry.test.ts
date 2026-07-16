import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FixtureCommandError, runFixtureCommand } from "./spawn-with-retry.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runFixtureCommand", () => {
	it("passes literal argv without a shell and captures output", async () => {
		const marker = "value with spaces & shell characters";
		const result = await runFixtureCommand(process.execPath, ["-e", "process.stdout.write(process.argv[1])", marker], {
			attempts: 1,
			timeoutMs: 5_000,
		});
		expect(result).toMatchObject({ stdout: marker, stderr: "", attempts: 1, exitCode: 0 });
	});

	it("retries failures with bounded attempts", async () => {
		const root = mkdtempSync(join(tmpdir(), "bb-fixture-retry-"));
		roots.push(root);
		const counter = join(root, "attempts.txt");
		const script = [
			"const fs=require('node:fs')",
			"const p=process.argv[1]",
			"let n=0;try{n=Number(fs.readFileSync(p,'utf8'))}catch{}",
			"fs.writeFileSync(p,String(++n))",
			"if(n<2){process.stderr.write('transient');process.exit(23)}",
			"process.stdout.write('ready')",
		].join(";");
		const result = await runFixtureCommand(process.execPath, ["-e", script, counter], {
			attempts: 3,
			retryDelayMs: 1,
			maxRetryDelayMs: 1,
		});
		expect(result.stdout).toBe("ready");
		expect(result.attempts).toBe(2);
		expect(readFileSync(counter, "utf8")).toBe("2");
	});

	it("bounds time and redacts argv, environment secrets, and stderr", async () => {
		const secret = "fixture-super-secret";
		await expect(runFixtureCommand(process.execPath, ["-e", "process.stderr.write(process.env.TEST_TOKEN);setInterval(()=>{},1000)", secret], {
			attempts: 1,
			timeoutMs: 100,
			env: { ...process.env, TEST_TOKEN: secret },
			redact: [secret],
		})).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(FixtureCommandError);
			const commandError = error as FixtureCommandError;
			expect(commandError.timedOut).toBe(true);
			expect(commandError.attempts).toBe(1);
			expect(commandError.message).toContain("[REDACTED]");
			expect(commandError.message).not.toContain(secret);
			expect(commandError.stderr).toBe("[REDACTED]");
			return true;
		});
	});

	it("rejects retry counts above the hard maximum", async () => {
		await expect(runFixtureCommand(process.execPath, [], { attempts: 4 })).rejects.toThrow(/attempts must be an integer between 1 and 3/);
	});
});
