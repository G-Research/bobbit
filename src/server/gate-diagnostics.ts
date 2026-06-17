import fs from "node:fs";
import path from "node:path";

export interface GateStepDiagnosticLogMetadata {
	path: string;
	bytes: number;
	lines: number;
}

export interface GateStepDiagnosticArtifactMetadata {
	path: string;
	relativePath: string;
	sourcePath: string;
	bytes: number;
	kind: "test-results" | "playwright-report";
}

export interface GateStepDiagnostics {
	type: "retained-command-diagnostics";
	baseDir: string;
	stdout?: GateStepDiagnosticLogMetadata;
	stderr?: GateStepDiagnosticLogMetadata;
	artifacts?: GateStepDiagnosticArtifactMetadata[];
	createdAt: number;
	truncated?: boolean;
	truncationReason?: string;
}

export interface GateStepDiagnosticsPaths {
	baseDir: string;
	stdoutPath: string;
	stderrPath: string;
	artifactsDir: string;
}

const MAX_ARTIFACT_FILES = 250;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const PLAYWRIGHT_ARTIFACT_DIRS: Array<{ name: string; kind: GateStepDiagnosticArtifactMetadata["kind"] }> = [
	{ name: "test-results", kind: "test-results" },
	{ name: "playwright-report", kind: "playwright-report" },
];

function safeSegment(value: string): string {
	const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
	return cleaned.slice(0, 80) || "unnamed";
}

export function gateDiagnosticsRoot(stateDir: string): string {
	return path.join(stateDir, "gate-diagnostics");
}

export function cleanupGateDiagnosticsForGoal(stateDir: string, goalId: string): void {
	fs.rmSync(path.join(gateDiagnosticsRoot(stateDir), safeSegment(goalId)), { recursive: true, force: true });
}

export function prepareGateStepDiagnosticsPaths(input: {
	stateDir: string;
	goalId: string;
	gateId: string;
	signalId: string;
	stepIndex: number;
	stepName: string;
}): GateStepDiagnosticsPaths {
	const baseDir = path.join(
		gateDiagnosticsRoot(input.stateDir),
		safeSegment(input.goalId),
		safeSegment(input.gateId),
		safeSegment(input.signalId),
		`${String(input.stepIndex).padStart(2, "0")}-${safeSegment(input.stepName)}`,
	);
	fs.rmSync(baseDir, { recursive: true, force: true });
	fs.mkdirSync(baseDir, { recursive: true });
	const artifactsDir = path.join(baseDir, "artifacts");
	return {
		baseDir,
		stdoutPath: path.join(baseDir, "stdout.log"),
		stderrPath: path.join(baseDir, "stderr.log"),
		artifactsDir,
	};
}

function countLines(text: string): number {
	if (!text.length) return 0;
	return text.split(/\r?\n/).length;
}

function logMetadata(filePath: string): GateStepDiagnosticLogMetadata | undefined {
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) return undefined;
		const text = fs.readFileSync(filePath, "utf8");
		return { path: filePath, bytes: stat.size, lines: countLines(text) };
	} catch {
		return undefined;
	}
}

function isProbablyPlaywrightFile(relativePath: string): boolean {
	const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
	return normalized.endsWith("error-context.md")
		|| normalized.endsWith("trace.zip")
		|| normalized.endsWith(".png")
		|| normalized.endsWith(".webm")
		|| normalized.endsWith(".zip")
		|| normalized.endsWith(".html")
		|| normalized.includes("/data/")
		|| normalized.includes("/trace/");
}

function copyArtifactTree(rootSourceDir: string, currentSourceDir: string, destRoot: string, kind: GateStepDiagnosticArtifactMetadata["kind"], state: { files: number; bytes: number; artifacts: GateStepDiagnosticArtifactMetadata[] }): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(currentSourceDir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (state.files >= MAX_ARTIFACT_FILES || state.bytes >= MAX_ARTIFACT_BYTES) return;
		const sourcePath = path.join(currentSourceDir, entry.name);
		const sourceRelativePath = path.relative(rootSourceDir, sourcePath).replace(/\\/g, "/");
		if (entry.isDirectory()) {
			copyArtifactTree(rootSourceDir, sourcePath, destRoot, kind, state);
			continue;
		}
		if (!entry.isFile()) continue;
		if (kind === "test-results" && !isProbablyPlaywrightFile(sourceRelativePath)) continue;
		let stat: fs.Stats;
		try { stat = fs.statSync(sourcePath); } catch { continue; }
		if (!stat.isFile()) continue;
		if (state.bytes + stat.size > MAX_ARTIFACT_BYTES) return;
		const retainedPath = path.join(destRoot, sourceRelativePath);
		try {
			fs.mkdirSync(path.dirname(retainedPath), { recursive: true });
			fs.copyFileSync(sourcePath, retainedPath);
			state.files += 1;
			state.bytes += stat.size;
			state.artifacts.push({
				path: retainedPath,
				relativePath: `${kind}/${sourceRelativePath}`.replace(/\\/g, "/"),
				sourcePath,
				bytes: stat.size,
				kind,
			});
		} catch {
			// Best-effort diagnostics must never fail verification finalization.
		}
	}
}

export function finalizeGateStepDiagnostics(input: {
	paths: GateStepDiagnosticsPaths;
	commandCwd: string;
}): GateStepDiagnostics {
	const artifactsState: { files: number; bytes: number; artifacts: GateStepDiagnosticArtifactMetadata[] } = {
		files: 0,
		bytes: 0,
		artifacts: [],
	};
	try {
		const cwd = path.resolve(input.commandCwd);
		if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) {
			for (const candidate of PLAYWRIGHT_ARTIFACT_DIRS) {
				const sourceDir = path.join(cwd, candidate.name);
				if (!fs.existsSync(sourceDir)) continue;
				const destRoot = path.join(input.paths.artifactsDir, candidate.name);
				copyArtifactTree(sourceDir, sourceDir, destRoot, candidate.kind, artifactsState);
			}
		}
	} catch {
		// Best-effort only.
	}

	const diagnostics: GateStepDiagnostics = {
		type: "retained-command-diagnostics",
		baseDir: input.paths.baseDir,
		createdAt: Date.now(),
	};
	const stdout = logMetadata(input.paths.stdoutPath);
	const stderr = logMetadata(input.paths.stderrPath);
	if (stdout) diagnostics.stdout = stdout;
	if (stderr) diagnostics.stderr = stderr;
	if (artifactsState.artifacts.length > 0) diagnostics.artifacts = artifactsState.artifacts;
	if (artifactsState.files >= MAX_ARTIFACT_FILES || artifactsState.bytes >= MAX_ARTIFACT_BYTES) {
		diagnostics.truncated = true;
		diagnostics.truncationReason = `artifact capture capped at ${MAX_ARTIFACT_FILES} files/${MAX_ARTIFACT_BYTES} bytes`;
	}
	return diagnostics;
}
