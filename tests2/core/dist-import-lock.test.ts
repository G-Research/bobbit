// v2-native — regression coverage for dist/server import lock ownership and recovery.
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	distServerImportLockPath,
	withDistServerImportLock,
} from "../harness/dist-import-lock.js";
import { withDistServerImportLock as withLegacyDistServerImportLock } from "../../tests/e2e/test-utils/dist-import-lock.js";
import { withEnv } from "../harness/with-env.js";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "bobbit-dist-import-lock-"));
	temporaryRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("dist/server import lock", () => {
	it("creates a missing explicit coordinator root and releases only its lock child", async () => {
		const root = join(temporaryRoot(), "coordinator", "tmp", "bobbit-e2e");
		const lock = distServerImportLockPath(root);

		expect(withLegacyDistServerImportLock).toBe(withDistServerImportLock);
		await withEnv({ BOBBIT_E2E_TMP_ROOT: root }, async () => {
			await withLegacyDistServerImportLock(async () => {
				expect(existsSync(root)).toBe(true);
				expect(existsSync(lock)).toBe(true);
			});
		});

		expect(existsSync(root)).toBe(true);
		expect(existsSync(lock)).toBe(false);
	});

	it("keeps simultaneous callers mutually exclusive after creating an explicit root", async () => {
		const root = join(temporaryRoot(), "missing", "bobbit-e2e");
		let active = 0;
		let peakActive = 0;

		await withEnv({ BOBBIT_E2E_TMP_ROOT: root }, async () => {
			await Promise.all(Array.from({ length: 8 }, () => withDistServerImportLock(async () => {
				active += 1;
				peakActive = Math.max(peakActive, active);
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
				active -= 1;
			})));
		});

		expect(peakActive).toBe(1);
	});

	it("reclaims a stale lock beneath an explicit root", async () => {
		const root = join(temporaryRoot(), "coordinator", "tmp", "bobbit-e2e");
		const lock = distServerImportLockPath(root);
		mkdirSync(lock, { recursive: true });
		writeFileSync(join(lock, "owner.txt"), "stale\n");
		const stale = new Date(Date.now() - 61_000);
		utimesSync(lock, stale, stale);

		await withEnv({ BOBBIT_E2E_TMP_ROOT: root }, async () => {
			await withDistServerImportLock(async () => {
				expect(existsSync(lock)).toBe(true);
				expect(existsSync(join(lock, "owner.txt"))).toBe(true);
			});
		});

		expect(existsSync(lock)).toBe(false);
	});

	it("rejects an explicit lock root that is not a directory", async () => {
		const root = join(temporaryRoot(), "not-a-directory");
		writeFileSync(root, "file\n");

		await withEnv({ BOBBIT_E2E_TMP_ROOT: root }, async () => {
			await expect(withDistServerImportLock(async () => undefined))
				.rejects.toThrow(`dist/server import lock root must be a directory: ${root}`);
		});
	});
});
