import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Reporter } from "vitest/reporters";
import {
	copyGitTemplate,
	type GitTemplateDescriptor,
	prepareGitTemplate,
	readGitTemplateBootstrapAudit,
} from "./git-template.js";
import {
	cleanupOwnedRunRoot,
	getRunRoot,
	isOwnedRunChild,
	isRunRootOwner,
	RUN_ROOT_OWNER_ENV,
} from "./run-isolation.js";

export const GIT_TEMPLATE_HANDOFF_PROOF_ENV = "BOBBIT_V2_GIT_TEMPLATE_HANDOFF_PROOF";
const PROOF_DIRECTORY = "git-template-handoff-proof";
const STATE_KEY = Symbol.for("bobbit.tests2.git-template-handoff-proof-state");

type ProcessWithProofState = NodeJS.Process & { [STATE_KEY]?: boolean };
type TestModule = Parameters<NonNullable<Reporter["onTestModuleStart"]>>[0];
export type GitTemplateHandoffCertifier = (
	descriptor: GitTemplateDescriptor,
	expectedWorkers: number,
) => Promise<void> | void;

interface WorkerRegistration {
	schema: 1;
	pid: number;
	project: string;
	poolId: string;
	workerId: string;
	path: string;
	digest: string;
	ownerPid: number;
	bootstrapCommandCount: number;
	guardInstalled: boolean;
	runRootOwner: boolean;
	cleanupAttempt: boolean;
	copy: string;
}

function proofRoot(): string {
	return join(getRunRoot(), PROOF_DIRECTORY);
}

function proofError(message: string): Error {
	return new Error(`GIT_TEMPLATE_ONE_INIT_PROOF_FAILED: ${message}`);
}

function parseRegistration(path: string): WorkerRegistration {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw proofError(`registration is not valid JSON: ${basename(path)}`);
	}
	if (!value || typeof value !== "object") throw proofError(`registration is not an object: ${basename(path)}`);
	const item = value as Partial<WorkerRegistration>;
	if (item.schema !== 1
		|| !Number.isSafeInteger(item.pid) || (item.pid ?? 0) <= 0
		|| typeof item.project !== "string" || item.project.length === 0
		|| typeof item.poolId !== "string" || item.poolId.length === 0
		|| typeof item.workerId !== "string" || item.workerId.length === 0
		|| typeof item.path !== "string" || typeof item.digest !== "string"
		|| !Number.isSafeInteger(item.ownerPid) || (item.ownerPid ?? 0) <= 0
		|| !Number.isSafeInteger(item.bootstrapCommandCount)
		|| typeof item.guardInstalled !== "boolean"
		|| typeof item.runRootOwner !== "boolean"
		|| typeof item.cleanupAttempt !== "boolean"
		|| typeof item.copy !== "string" || item.copy.length === 0) {
		throw proofError(`registration is missing or malformed: ${basename(path)}`);
	}
	return item as WorkerRegistration;
}

/**
 * Publish one immutable record per guarded fork. Setup files call this after
 * handoff adoption and spawn-fence installation; no test-file scheduling is
 * involved. The coordinator certifies the completed set after every module has
 * finished, when synchronous atomic writes from all workers are authoritative.
 */
export function registerGitTemplateHandoffWorker(
	descriptor: GitTemplateDescriptor,
	guardInstalled: boolean,
): void {
	const project = process.env[GIT_TEMPLATE_HANDOFF_PROOF_ENV]?.trim() ?? "";
	if (!project) return;
	if (!/^[a-z0-9-]+$/.test(project)) throw proofError(`invalid project identity: ${project}`);
	const owner = process as ProcessWithProofState;
	if (owner[STATE_KEY]) return;

	// The proof is enabled only for the shared fork projects. A thread or the
	// coordinator registering here would make distinct-process evidence invalid.
	if (typeof process.send !== "function") throw proofError("registration did not run in a Vitest fork");
	const poolId = process.env.VITEST_POOL_ID?.trim() ?? "";
	const workerId = process.env.VITEST_WORKER_ID?.trim() ?? "";
	if (!poolId || !workerId) throw proofError("worker identity is missing");
	if (!guardInstalled) throw proofError(`spawn guard is not installed in worker ${workerId}`);

	const root = proofRoot();
	const registrations = join(root, "registrations");
	const copies = join(root, "copies");
	mkdirSync(registrations, { recursive: true });
	mkdirSync(copies, { recursive: true });
	const identity = `${project}-${poolId}`;
	const copy = copyGitTemplate(join(copies, `worker-${identity}-${process.pid}`));
	writeFileSync(join(copy, `worker-${identity}.txt`), `${process.pid}\n`, "utf8");
	const audit = readGitTemplateBootstrapAudit(descriptor);
	const registration: WorkerRegistration = {
		schema: 1,
		pid: process.pid,
		project,
		poolId,
		workerId,
		path: descriptor.path,
		digest: descriptor.digest,
		ownerPid: audit.ownerPid,
		bootstrapCommandCount: audit.commands.length,
		guardInstalled: true,
		runRootOwner: isRunRootOwner(),
		cleanupAttempt: cleanupOwnedRunRoot(),
		copy,
	};
	const finalPath = join(registrations, `worker-${identity}-${process.pid}.json`);
	const temporaryPath = `${finalPath}.tmp`;
	if (existsSync(finalPath) || existsSync(temporaryPath)) {
		throw proofError(`duplicate registration path for pool=${poolId} pid=${process.pid}`);
	}
	writeFileSync(temporaryPath, JSON.stringify(registration), { encoding: "utf8", flag: "wx" });
	try {
		renameSync(temporaryPath, finalPath);
	} catch (error) {
		throw proofError(`could not publish unique registration for pool=${poolId} pid=${process.pid}: ${String(error)}`);
	}
	owner[STATE_KEY] = true;
}

function canonicalTestPath(path: string): string | undefined {
	const normalized = path.replace(/[?#].*$/, "").replace(/\\/g, "/");
	const markerIndex = Math.max(normalized.lastIndexOf("/tests/"), normalized.lastIndexOf("/tests2/"));
	const relativePath = markerIndex >= 0
		? normalized.slice(markerIndex + 1)
		: normalized.startsWith("tests/") || normalized.startsWith("tests2/") ? normalized : undefined;
	return relativePath?.endsWith(".test.ts") ? relativePath : undefined;
}

/**
 * Certification is meaningful only for the exact registered Tier-1 inventory.
 * Focused or otherwise partial invocations are valid subsets and must neither
 * certify incomplete evidence nor require unrelated companion modules.
 */
export function isCompleteCanonicalUnitInvocation(
	startedModules: Iterable<string>,
	canonicalInventory: readonly string[],
): boolean {
	const expected = new Set(canonicalInventory.map(path => canonicalTestPath(path)));
	if (expected.has(undefined) || expected.size === 0 || expected.size !== canonicalInventory.length) return false;
	const started = new Set([...startedModules].map(path => canonicalTestPath(path)));
	if (started.has(undefined) || started.size !== expected.size) return false;
	return [...expected].every(path => started.has(path));
}

/** Coordinator-owned, scheduler-independent complete-suite certification. */
export class GitTemplateHandoffReporter implements Reporter {
	private readonly startedModules = new Set<string>();

	constructor(
		private readonly descriptor: GitTemplateDescriptor,
		public readonly expectedWorkers: number,
		public readonly canonicalInventory: readonly string[],
		private readonly certifier: GitTemplateHandoffCertifier = certifyGitTemplateHandoff,
	) {
		if (!Number.isSafeInteger(expectedWorkers) || expectedWorkers < 1) {
			throw new Error(`invalid expected Git-template worker count: ${expectedWorkers}`);
		}
	}

	onTestRunStart(): void {
		this.startedModules.clear();
	}

	onTestModuleStart(testModule: TestModule): void {
		this.startedModules.add(testModule.moduleId);
	}

	async onTestRunEnd(): Promise<void> {
		if (!isCompleteCanonicalUnitInvocation(this.startedModules, this.canonicalInventory)) return;
		await this.certifier(this.descriptor, this.expectedWorkers);
	}
}

export async function certifyGitTemplateHandoff(
	descriptor: GitTemplateDescriptor,
	expectedWorkers: number,
): Promise<void> {
	await prepareGitTemplate({
		mode: "adopt",
		path: descriptor.path,
		expectedDigest: descriptor.digest,
	});
	const registrationsDirectory = join(proofRoot(), "registrations");
	if (!existsSync(registrationsDirectory)) throw proofError("worker registrations are missing");
	const entries = readdirSync(registrationsDirectory).sort();
	if (entries.some(entry => !/^worker-.+-.+\.json$/.test(entry))) {
		throw proofError(`unexpected or incomplete registration data: ${entries.join(", ")}`);
	}
	if (entries.length < expectedWorkers) {
		throw proofError(`expected at least ${expectedWorkers} worker registrations, found ${entries.length}`);
	}
	const reports = entries.map(entry => parseRegistration(join(registrationsDirectory, entry)));
	if (new Set(reports.map(report => report.pid)).size !== reports.length) {
		throw proofError("worker registrations do not identify distinct processes");
	}
	if (new Set(reports.map(report => `${report.project}\0${report.poolId}`)).size !== reports.length) {
		throw proofError("worker registrations contain duplicate project/pool identities");
	}
	if (new Set(reports.map(report => `${report.project}\0${report.workerId}`)).size !== reports.length) {
		throw proofError("worker registrations contain duplicate project/worker identities");
	}

	const expectedOwnerPid = Number(process.env[RUN_ROOT_OWNER_ENV]);
	const audit = readGitTemplateBootstrapAudit(descriptor);
	if (audit.ownerPid !== expectedOwnerPid || audit.commands.length !== 10) {
		throw proofError("coordinator bootstrap audit is contradictory");
	}
	for (const report of reports) {
		if (resolve(report.path) !== resolve(descriptor.path) || report.digest !== descriptor.digest) {
			throw proofError(`worker ${report.workerId} adopted contradictory template identity`);
		}
		if (report.ownerPid !== expectedOwnerPid || report.pid === expectedOwnerPid
			|| report.bootstrapCommandCount !== 10 || !report.guardInstalled
			|| report.runRootOwner || report.cleanupAttempt) {
			throw proofError(`worker ${report.workerId} reported contradictory lifecycle data`);
		}
		const copy = realpathSync(report.copy);
		if (!isOwnedRunChild(getRunRoot(), copy) || resolve(copy) === resolve(descriptor.path)) {
			throw proofError(`worker ${report.workerId} copy is outside the run or aliases the source`);
		}
		const identity = `${report.project}-${report.poolId}`;
		if (readFileSync(join(copy, `worker-${identity}.txt`), "utf8") !== `${report.pid}\n`) {
			throw proofError(`worker ${report.workerId} private copy is not writable or has the wrong marker`);
		}
		for (const other of reports) {
			const otherIdentity = `${other.project}-${other.poolId}`;
			if (otherIdentity !== identity && existsSync(join(copy, `worker-${otherIdentity}.txt`))) {
				throw proofError(`worker ${report.workerId} copy is not independent`);
			}
		}
		if (existsSync(join(descriptor.path, `worker-${identity}.txt`))) {
			throw proofError(`worker ${report.workerId} mutated the immutable source`);
		}
	}
	// Re-reading the audit after all copies proves adoption/copying never added
	// worker-side Git initialization commands.
	if (readGitTemplateBootstrapAudit(descriptor).commands.length !== 10) {
		throw proofError("worker adoption changed the coordinator bootstrap audit");
	}
}

export default GitTemplateHandoffReporter;
