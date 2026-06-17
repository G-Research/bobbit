import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gateDiagnosticsRootDir, safeGateDiagnosticsSegment } from "./agent/gate-diagnostics-cleanup.js";

const DEFAULT_MAX_RETAINED_LOG_BYTES = 20 * 1024 * 1024;
const TEST_MAX_RETAINED_LOG_BYTES = 5 * 1024 * 1024;

function resolveMaxRetainedLogBytes(): number {
	const raw = process.env.BOBBIT_RETAINED_LOG_MAX_BYTES;
	if (raw !== undefined && raw.trim() !== "") {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
	}
	return process.env.NODE_ENV === "test" ? TEST_MAX_RETAINED_LOG_BYTES : DEFAULT_MAX_RETAINED_LOG_BYTES;
}

export const MAX_RETAINED_LOG_BYTES = resolveMaxRetainedLogBytes();
const LOG_COUNT_CHUNK_BYTES = 64 * 1024;

export interface GateStepDiagnosticLogMetadata {
	path: string;
	bytes: number;
	lines: number;
	truncated?: boolean;
	truncationReason?: string;
}

export interface GateStepDiagnosticArtifactMetadata {
	path: string;
	relativePath: string;
	sourcePath: string;
	bytes: number;
	kind: "test-results" | "playwright-report";
	content?: string;
	contentType?: string;
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
const MAX_INLINE_ARTIFACT_CONTENT_BYTES = 64 * 1024;
const PLAYWRIGHT_ARTIFACT_DIRS: Array<{ name: string; kind: GateStepDiagnosticArtifactMetadata["kind"] }> = [
	{ name: "test-results", kind: "test-results" },
	{ name: "playwright-report", kind: "playwright-report" },
];

export function prepareGateStepDiagnosticsPaths(input: {
	stateDir: string;
	goalId: string;
	gateId: string;
	signalId: string;
	stepIndex: number;
	stepName: string;
}): GateStepDiagnosticsPaths {
	const baseDir = path.join(
		gateDiagnosticsRootDir(input.stateDir),
		safeGateDiagnosticsSegment(input.goalId),
		safeGateDiagnosticsSegment(input.gateId),
		safeGateDiagnosticsSegment(input.signalId),
		`${String(input.stepIndex).padStart(2, "0")}-${safeGateDiagnosticsSegment(input.stepName)}`,
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

export function appendRetainedLogChunk(filePath: string | undefined, text: string): void {
	if (!filePath || !text) return;
	try {
		let currentBytes = 0;
		try {
			const stat = fs.statSync(filePath);
			if (stat.isFile()) currentBytes = stat.size;
		} catch { /* file may not exist yet */ }
		const remaining = MAX_RETAINED_LOG_BYTES - currentBytes;
		if (remaining <= 0) return;
		const chunk = Buffer.from(text, "utf8");
		fs.appendFileSync(filePath, chunk.subarray(0, Math.min(chunk.length, remaining)));
	} catch {
		// Best-effort diagnostics must never affect verification execution.
	}
}

function capRetainedLogFile(filePath: string): { truncated: boolean; bytes: number } {
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) return { truncated: false, bytes: 0 };
		if (stat.size < MAX_RETAINED_LOG_BYTES) return { truncated: false, bytes: stat.size };
		if (stat.size === MAX_RETAINED_LOG_BYTES) return { truncated: true, bytes: stat.size };
		const fd = fs.openSync(filePath, "r+");
		try {
			fs.ftruncateSync(fd, MAX_RETAINED_LOG_BYTES);
		} finally {
			try { fs.closeSync(fd); } catch { /* ignore */ }
		}
		return { truncated: true, bytes: MAX_RETAINED_LOG_BYTES };
	} catch {
		return { truncated: false, bytes: 0 };
	}
}

function countLinesInFile(filePath: string): number {
	let fd: number | undefined;
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile() || stat.size <= 0) return 0;
		fd = fs.openSync(filePath, "r");
		const buffer = Buffer.allocUnsafe(LOG_COUNT_CHUNK_BYTES);
		let position = 0;
		let lineFeeds = 0;
		while (position < stat.size) {
			const bytesRead = fs.readSync(fd, buffer, 0, Math.min(LOG_COUNT_CHUNK_BYTES, stat.size - position), position);
			if (bytesRead <= 0) break;
			for (let i = 0; i < bytesRead; i++) if (buffer[i] === 10) lineFeeds++;
			position += bytesRead;
		}
		return lineFeeds + 1;
	} catch {
		return 0;
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* ignore */ }
		}
	}
}

function logMetadata(filePath: string): GateStepDiagnosticLogMetadata | undefined {
	try {
		const capped = capRetainedLogFile(filePath);
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) return undefined;
		const metadata: GateStepDiagnosticLogMetadata = { path: filePath, bytes: stat.size, lines: countLinesInFile(filePath) };
		if (capped.truncated) {
			metadata.truncated = true;
			metadata.truncationReason = `retained log capped at ${MAX_RETAINED_LOG_BYTES} bytes`;
		}
		return metadata;
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

function copyArtifactTree(
	rootSourceDir: string,
	currentSourceDir: string,
	destRoot: string,
	kind: GateStepDiagnosticArtifactMetadata["kind"],
	state: { files: number; bytes: number; artifacts: GateStepDiagnosticArtifactMetadata[] },
	sourcePathForArtifact?: (sourceRelativePath: string, sourcePath: string) => string,
): void {
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
			copyArtifactTree(rootSourceDir, sourcePath, destRoot, kind, state, sourcePathForArtifact);
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
			if (fs.existsSync(retainedPath)) continue;
			fs.mkdirSync(path.dirname(retainedPath), { recursive: true });
			fs.copyFileSync(sourcePath, retainedPath);
			state.files += 1;
			state.bytes += stat.size;
			const artifact: GateStepDiagnosticArtifactMetadata = {
				path: retainedPath,
				relativePath: `${kind}/${sourceRelativePath}`.replace(/\\/g, "/"),
				sourcePath: sourcePathForArtifact ? sourcePathForArtifact(sourceRelativePath, sourcePath) : sourcePath,
				bytes: stat.size,
				kind,
			};
			if (sourceRelativePath.toLowerCase().endsWith("error-context.md") && stat.size <= MAX_INLINE_ARTIFACT_CONTENT_BYTES) {
				artifact.content = fs.readFileSync(retainedPath, "utf8");
				artifact.contentType = "text/markdown";
			}
			state.artifacts.push(artifact);
		} catch {
			// Best-effort diagnostics must never fail verification finalization.
		}
	}
}

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function copyContainerArtifactDir(input: {
	containerId: string;
	containerCwd: string;
	candidate: { name: string; kind: GateStepDiagnosticArtifactMetadata["kind"] };
	paths: GateStepDiagnosticsPaths;
	state: { files: number; bytes: number; artifacts: GateStepDiagnosticArtifactMetadata[] };
}): void {
	const containerDir = path.posix.join(input.containerCwd.replace(/\\/g, "/"), input.candidate.name);
	const test = spawnSync("docker", ["exec", input.containerId, "sh", "-c", `test -d ${shellSingleQuote(containerDir)}`], {
		stdio: "ignore",
		env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
	});
	if (test.status !== 0) return;

	const tmpParent = path.join(input.paths.baseDir, ".container-artifact-tmp", safeGateDiagnosticsSegment(input.candidate.name));
	try {
		fs.rmSync(tmpParent, { recursive: true, force: true });
		fs.mkdirSync(tmpParent, { recursive: true });
		const copied = spawnSync("docker", ["cp", `${input.containerId}:${containerDir}`, tmpParent], {
			stdio: "ignore",
			env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
		});
		if (copied.status !== 0) return;
		const sourceDir = path.join(tmpParent, input.candidate.name);
		if (!fs.existsSync(sourceDir)) return;
		const destRoot = path.join(input.paths.artifactsDir, input.candidate.name);
		copyArtifactTree(
			sourceDir,
			sourceDir,
			destRoot,
			input.candidate.kind,
			input.state,
			(relativePath) => `${input.containerId}:${path.posix.join(containerDir, relativePath.replace(/\\/g, "/"))}`,
		);
	} catch {
		// Best-effort only.
	} finally {
		try { fs.rmSync(path.join(input.paths.baseDir, ".container-artifact-tmp"), { recursive: true, force: true }); } catch { /* ignore */ }
	}
}

export function finalizeGateStepDiagnostics(input: {
	paths: GateStepDiagnosticsPaths;
	commandCwd: string;
	containerId?: string;
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
	if (input.containerId) {
		for (const candidate of PLAYWRIGHT_ARTIFACT_DIRS) {
			if (artifactsState.files >= MAX_ARTIFACT_FILES || artifactsState.bytes >= MAX_ARTIFACT_BYTES) break;
			copyContainerArtifactDir({
				containerId: input.containerId,
				containerCwd: input.commandCwd,
				candidate,
				paths: input.paths,
				state: artifactsState,
			});
		}
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
