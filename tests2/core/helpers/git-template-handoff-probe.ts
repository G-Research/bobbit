import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	copyGitTemplate,
	GIT_TEMPLATE_DIGEST_ENV,
	GIT_TEMPLATE_PATH_ENV,
	prepareGitTemplate,
	readGitTemplateBootstrapAudit,
} from "../../harness/git-template.js";
import {
	cleanupOwnedRunRoot,
	getRunRoot,
	isRunRootOwner,
	RUN_ROOT_OWNER_ENV,
} from "../../harness/run-isolation.js";
import { isTier1SpawnGuardInstalled } from "../../harness/tier1-spawn-guard.js";

const LABELS = ["a", "b", "c"] as const;
type ProbeLabel = (typeof LABELS)[number];

interface AdopterReport {
	label: ProbeLabel;
	pid: number;
	poolId: string;
	path: string;
	digest: string;
	ownerPid: number;
	bootstrapCommandCount: number;
	guardInstalled: boolean;
	runRootOwner: boolean;
	cleanupAttempt: boolean;
	copy: string;
}

function reportPath(probeRoot: string, label: ProbeLabel): string {
	return join(probeRoot, `adopter-${label}.json`);
}

function readAllReports(probeRoot: string): Promise<AdopterReport[]> {
	const paths = LABELS.map(label => reportPath(probeRoot, label));
	return new Promise((resolve, reject) => {
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		const finish = (error?: Error, reports?: AdopterReport[]) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			watcher.close();
			if (error) reject(error);
			else resolve(reports ?? []);
		};
		const inspectReports = () => {
			if (!paths.every(existsSync)) return;
			try {
				finish(undefined, paths.map(path => JSON.parse(readFileSync(path, "utf8")) as AdopterReport));
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		};

		// Arm the signal before scanning. A report published before watch setup is
		// found by the scan; one published during or after it causes another scan.
		// Reports use atomic rename, so an observed final path is complete.
		const watcher = watch(probeRoot, { persistent: false }, inspectReports);
		watcher.once("error", error => finish(error));
		timeout = setTimeout(() => {
			const found = existsSync(probeRoot) ? readdirSync(probeRoot).sort() : [];
			finish(new Error(`GIT_TEMPLATE_ONE_INIT_PROBE_TIMEOUT: expected three guarded adopter reports, found ${found.join(", ")}`));
		}, 15_000);
		timeout.unref();
		inspectReports();
	});
}

/**
 * Register one of three files that Vitest dispatches across its fixed fork pool.
 * The short barrier makes a single fork unable to satisfy the proof by running
 * the files serially: all three guarded adopters must be alive concurrently.
 */
export function registerGitTemplateHandoffProbe(label: ProbeLabel): void {
	it(`adopter ${label} shares the one-init template and receives a writable private copy`, async () => {
		const descriptor = await prepareGitTemplate({
			mode: "adopt",
			path: process.env[GIT_TEMPLATE_PATH_ENV],
			expectedDigest: process.env[GIT_TEMPLATE_DIGEST_ENV],
		});
		const audit = readGitTemplateBootstrapAudit(descriptor);
		const probeRoot = join(getRunRoot(), "git-template-handoff-probe");
		const copiesRoot = join(probeRoot, "copies");
		mkdirSync(copiesRoot, { recursive: true });
		const destination = join(copiesRoot, label);
		rmSync(destination, { recursive: true, force: true });
		const copy = copyGitTemplate(destination);
		const marker = `adopter-${label}.txt`;
		writeFileSync(join(copy, marker), `${process.pid}\n`, "utf8");

		const report: AdopterReport = {
			label,
			pid: process.pid,
			poolId: process.env.VITEST_POOL_ID ?? "",
			path: descriptor.path,
			digest: descriptor.digest,
			ownerPid: audit.ownerPid,
			bootstrapCommandCount: audit.commands.length,
			guardInstalled: isTier1SpawnGuardInstalled(),
			runRootOwner: isRunRootOwner(),
			cleanupAttempt: cleanupOwnedRunRoot(),
			copy,
		};
		const temporaryReport = `${reportPath(probeRoot, label)}.${process.pid}.tmp`;
		writeFileSync(temporaryReport, JSON.stringify(report), "utf8");
		renameSync(temporaryReport, reportPath(probeRoot, label));

		const reports = await readAllReports(probeRoot);
		const auditAfterAdoption = readGitTemplateBootstrapAudit(descriptor);
		expect(reports.map(item => item.label).sort()).toEqual([...LABELS]);
		expect(new Set(reports.map(item => item.pid)).size).toBe(3);
		expect(new Set(reports.map(item => item.poolId)).size).toBe(3);
		expect(reports.every(item => item.poolId.length > 0)).toBe(true);
		expect(new Set(reports.map(item => item.path))).toEqual(new Set([descriptor.path]));
		expect(new Set(reports.map(item => item.digest))).toEqual(new Set([descriptor.digest]));
		expect(new Set(reports.map(item => item.ownerPid))).toEqual(new Set([Number(process.env[RUN_ROOT_OWNER_ENV])]));
		expect(reports.some(item => item.pid === audit.ownerPid)).toBe(false);
		expect(reports.every(item => item.bootstrapCommandCount === 10)).toBe(true);
		expect(auditAfterAdoption.commands).toHaveLength(10);
		expect(reports.every(item => item.guardInstalled)).toBe(true);
		expect(reports.every(item => !item.runRootOwner && !item.cleanupAttempt)).toBe(true);
		expect(existsSync(descriptor.path)).toBe(true);
		expect(readFileSync(join(descriptor.path, "README.md"), "utf8")).toBe("# Bobbit test repository\n");

		for (const adopter of reports) {
			expect(readFileSync(join(adopter.copy, `adopter-${adopter.label}.txt`), "utf8")).toBe(`${adopter.pid}\n`);
			for (const other of reports) {
				if (other.label !== adopter.label) {
					expect(existsSync(join(adopter.copy, `adopter-${other.label}.txt`))).toBe(false);
				}
			}
			expect(existsSync(join(descriptor.path, `adopter-${adopter.label}.txt`))).toBe(false);
		}
	});
}
