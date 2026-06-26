import path from "node:path";

import {
	initializeAgentDirState,
	resetAgentDirStateForTests,
	setProjectRoot,
} from "../../src/server/bobbit-dir.js";

export function pinAgentDirForTest(agentDir: string, options: { projectRoot?: string; stateDir?: string } = {}): void {
	const projectRoot = path.resolve(options.projectRoot ?? path.dirname(agentDir));
	const stateDir = path.resolve(options.stateDir ?? (process.env.BOBBIT_DIR ? path.join(process.env.BOBBIT_DIR, "state") : path.join(projectRoot, ".bobbit", "state")));
	resetAgentDirStateForTests();
	setProjectRoot(projectRoot);
	initializeAgentDirState({ env: { ...process.env, BOBBIT_AGENT_DIR: agentDir }, projectRoot, stateDir });
}

export function resetAgentDirForTest(): void {
	resetAgentDirStateForTests();
	setProjectRoot(process.cwd());
}
