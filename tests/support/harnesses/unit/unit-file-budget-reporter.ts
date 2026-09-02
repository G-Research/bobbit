import { fileURLToPath } from "node:url";
import type { Reporter } from "vitest/reporters";

type TestModule = Parameters<NonNullable<Reporter["onTestModuleStart"]>>[0];

export const UNIT_FILE_WALL_BUDGET_MS = 25_000;
export const UNIT_CONCURRENT_PROOF_ENV = "BOBBIT_UNIT_CONCURRENT_PROOF";
export const UNIT_CONCURRENT_PROOF_BANNER =
	"[unit-file-budget] CONCURRENT PROOF MODE — wall-budget overruns are report-only and do not qualify as solo unit-stage evidence.";

const CONDITIONAL_E2E_PROJECT = "v2-e2e-vitest";

type FileTiming = {
	path: string;
	project: string;
	durationMs: number;
};

function physicalPath(moduleId: string): string {
	const withoutQuery = moduleId.replace(/[?#].*$/, "");
	const path = withoutQuery.startsWith("file:") ? fileURLToPath(withoutQuery) : withoutQuery;
	return path.replace(/\\/g, "/").replace(/^\/([A-Za-z]:\/)/, "$1");
}

function timingKey(path: string, project: string): string {
	return `${project}\0${path}`;
}

/** Enforces the tier-1 wall budget from module start through all hooks and retries. */
export class UnitFileBudgetReporter implements Reporter {
	private readonly starts = new Map<TestModule, number>();
	private readonly timings = new Map<string, FileTiming>();
	private readonly concurrentProof: boolean;

	constructor(
		private readonly now: () => number = () => performance.now(),
		env: NodeJS.ProcessEnv = process.env,
		private readonly output: (message: string) => void = message => console.warn(message),
	) {
		this.concurrentProof = env[UNIT_CONCURRENT_PROOF_ENV] === "1";
	}

	onTestRunStart(): void {
		this.starts.clear();
		this.timings.clear();
		if (this.concurrentProof) this.output(UNIT_CONCURRENT_PROOF_BANNER);
	}

	onTestModuleStart(testModule: TestModule): void {
		if (testModule.project.name === CONDITIONAL_E2E_PROJECT) return;
		this.starts.set(testModule, this.now());
	}

	onTestModuleEnd(testModule: TestModule): void {
		if (testModule.project.name === CONDITIONAL_E2E_PROJECT) return;
		const startedAt = this.starts.get(testModule);
		if (startedAt === undefined) return;
		this.starts.delete(testModule);

		const path = physicalPath(testModule.moduleId);
		const project = testModule.project.name;
		const key = timingKey(path, project);
		const previous = this.timings.get(key);
		const durationMs = Math.max(0, this.now() - startedAt);
		this.timings.set(key, {
			path,
			project,
			durationMs: (previous?.durationMs ?? 0) + durationMs,
		});
	}

	onTestRunEnd(): void {
		const violations = [...this.timings.values()]
			.filter(({ durationMs }) => durationMs > UNIT_FILE_WALL_BUDGET_MS)
			.sort((a, b) => b.durationMs - a.durationMs || a.path.localeCompare(b.path));
		if (violations.length === 0) return;

		const details = violations.map(({ path, project, durationMs }) =>
			`- path=${path} project=${project} duration=${Math.ceil(durationMs)}ms`
		);
		const report = [
			`Tier-1 unit file wall budget exceeded (budget=${UNIT_FILE_WALL_BUDGET_MS}ms):`,
			...details,
		].join("\n");
		if (this.concurrentProof) {
			this.output([
				UNIT_CONCURRENT_PROOF_BANNER,
				report,
				"[unit-file-budget] Proof-mode wall-budget overruns did not fail this run; suite and test failures remain authoritative.",
			].join("\n"));
			// Only this reporter's budget exception is suppressed; Vitest still owns
			// the process exit status for failed suites and tests.
			return;
		}
		throw new Error(report);
	}
}

export default UnitFileBudgetReporter;
