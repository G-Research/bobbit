import { VitestTestRunner } from "vitest/runners";
import type { File } from "@vitest/runner";
import { setProjectRoot } from "../../src/server/bobbit-dir.js";
import { resetAgentDirStateForTests } from "../../src/server/agent-dir-config.js";

const BASELINE_CWD = process.cwd();

// isolate:false files share a fork's module graph, so the project-root and
// agent-dir singletons leak between files. onCollectStart is the only hook that
// runs per file before its module loads; env is left to the fork-scoped gateway.
export default class FileBoundaryRunner extends VitestTestRunner {
	onCollectStart(file: File): void {
		setProjectRoot(BASELINE_CWD);
		resetAgentDirStateForTests();
		return super.onCollectStart(file);
	}
}
