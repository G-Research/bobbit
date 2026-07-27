import { createHash } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CommandRunner } from "../gateway-deps.js";
import type { Component } from "./project-config-store.js";
import {
	SYSTEMS_REVIEW_COVERAGE_VERSION,
	SYSTEMS_REVIEW_READER_VERSION,
	type SystemsReviewChange,
	type SystemsReviewChangeKind,
	type SystemsReviewCoverageItem,
	type SystemsReviewEvidenceChunk,
	type SystemsReviewPathClass,
	type SystemsReviewRepoBinding,
	type SystemsReviewRiskSignal,
	type SystemsReviewSnapshot,
} from "./systems-review-types.js";

const ZERO_OID_RE = /^0+$/;
const OID_RE = /^[0-9a-f]{40,64}$/;
const SNAPSHOT_GIT_TIMEOUT_MS = 30_000;
export const SYSTEMS_REVIEW_CHUNK_PATCH_BYTES = 256 * 1024;
export const SYSTEMS_REVIEW_CHUNK_MAX_CHANGES = 100;

const PASSIVE_BINARY_EXTENSIONS = new Set([
	".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".webp",
	".eot", ".otf", ".ttf", ".woff", ".woff2",
	".mp3", ".mp4", ".ogg", ".wav", ".webm", ".pdf",
]);
const EXECUTABLE_BINARY_EXTENSIONS = new Set([
	".app", ".bin", ".class", ".com", ".dll", ".dylib", ".elf", ".exe", ".jar",
	".node", ".o", ".obj", ".pdb", ".so", ".wasm",
]);
const DEPENDENCY_LOCKFILE_NAMES = new Set([
	"bun.lock", "bun.lockb", "cargo.lock", "composer.lock", "deno.lock", "flake.lock",
	"gemfile.lock", "go.sum", "package-lock.json", "packages.lock.json", "pnpm-lock.yaml",
	"poetry.lock", "pubspec.lock", "uv.lock", "yarn.lock",
]);
const SECRET_BASENAMES = new Set([
	".env", ".npmrc", ".pypirc", ".netrc", "credentials", "credentials.json",
	"id_dsa", "id_ecdsa", "id_ed25519", "id_rsa", "secrets.json",
]);
const SECRET_SUFFIXES = [".key", ".pem", ".p12", ".pfx", ".jks", ".keystore"];

const RISK_PATTERNS: ReadonlyArray<readonly [SystemsReviewRiskSignal, RegExp]> = [
	["control", /\b(button|checkbox|control|menu|click|submit|onchange|onclick|widget|visible|disabled)\b/i],
	["route", /\b(route|router|handler|controller|endpoint|pathname|request)\b/i],
	["mutation", /\b(delete|remove|write|save|update|insert|commit|push|merge|archive|mutat|destroy|unlink|rename)\w*\b/i],
	["target", /\b(target|cwd|root|repo|repository|worktree|scope|path|branch)\b/i],
	["aggregation", /\b(aggregate|all|every|some|reduce|summary|merged|clean|complete|healthy|authorized|combined|overall)\b/i],
	["transport", /\b(api|http|websocket|transport|payload|request|response|json|rpc|event)\b/i],
	["persistence", /\b(database|persist|store|cache|file|queue|serialize|sessionstorage|localstorage)\b/i],
	["state", /\b(state|status|stale|partial|failed|success|boolean|flag|loading|error)\b/i],
];

export class SystemsReviewSnapshotError extends Error {
	readonly code: string;
	readonly details?: Record<string, unknown>;

	constructor(code: string, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = "SystemsReviewSnapshotError";
		this.code = code;
		this.details = details;
	}
}

export interface CreateSystemsReviewSnapshotOptions {
	sessionId: string;
	signalId: string;
	projectRoot: string;
	branchContainer: string;
	components: readonly Component[];
	baseBranch: string;
	metadataBaseRefs?: Readonly<Record<string, string>>;
	commandRunner?: CommandRunner;
	now?: () => number;
}

interface RawChange {
	oldMode: string;
	newMode: string;
	oldOid?: string;
	newOid?: string;
	status: string;
	oldPath?: string;
	newPath?: string;
}

interface PatchInspection {
	sha256: string;
	bytes: number;
	binary: boolean;
	riskSignals: SystemsReviewRiskSignal[];
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function nativeRealpath(target: string): string {
	try {
		return fs.realpathSync.native(target);
	} catch (error) {
		throw new SystemsReviewSnapshotError("REPO_PATH_UNAVAILABLE", `Cannot resolve repository path "${target}".`, {
			target,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function pathIdentity(target: string): string {
	const normalized = path.resolve(target).replace(/\\/g, "/").replace(/\/+$/, "");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isContained(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertSafeRelativePath(candidate: string): string {
	if (!candidate || candidate.includes("\0") || path.isAbsolute(candidate) || /^[a-zA-Z]:[\\/]/.test(candidate)) {
		throw new SystemsReviewSnapshotError("UNSAFE_PATH", `Unsafe repository path "${candidate}".`);
	}
	const posix = candidate.replace(/\\/g, "/");
	if (posix.startsWith("/") || posix.split("/").some(segment => segment === ".." || segment === "")) {
		throw new SystemsReviewSnapshotError("UNSAFE_PATH", `Unsafe repository path "${candidate}".`);
	}
	return posix;
}

export function assertSystemsReviewReadablePath(candidate: string): string {
	const normalized = assertSafeRelativePath(candidate);
	const segments = normalized.toLowerCase().split("/");
	const base = segments.at(-1) ?? "";
	const bobbitIndex = segments.indexOf(".bobbit");
	const protectedBobbitPath = bobbitIndex >= 0 && ["state", "secrets", "headquarters"].includes(segments[bobbitIndex + 1] ?? "");
	if (segments.includes(".git") || segments.includes("node_modules") || protectedBobbitPath) {
		throw new SystemsReviewSnapshotError("PROTECTED_PATH", `Protected path "${candidate}" is not readable by Systems review.`);
	}
	if (SECRET_BASENAMES.has(base) || base.startsWith(".env.") || SECRET_SUFFIXES.some(suffix => base.endsWith(suffix))) {
		throw new SystemsReviewSnapshotError("SECRET_PATH", `Secret-bearing path "${candidate}" is not readable by Systems review.`);
	}
	return normalized;
}

export async function runSystemsReviewGit(
	cwd: string,
	args: readonly string[],
	commandRunner?: CommandRunner,
	onStdout?: (chunk: Buffer) => void,
	timeoutMs = SNAPSHOT_GIT_TIMEOUT_MS,
): Promise<Buffer> {
	if (commandRunner && !commandRunner.spawn) {
		const result = await commandRunner.execFile("git", args, {
			cwd,
			encoding: "buffer",
			timeout: timeoutMs,
			maxBuffer: Number.MAX_SAFE_INTEGER,
		});
		const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
		onStdout?.(stdout);
		return stdout;
	}

	return new Promise<Buffer>((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = commandRunner?.spawn
				? commandRunner.spawn("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
				: nodeSpawn("git", [...args], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			reject(error);
			return;
		}
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer | string) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			if (!onStdout) stdout.push(buffer);
			onStdout?.(buffer);
		});
		child.stderr?.on("data", (chunk: Buffer | string) => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		child.on("error", error => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", code => {
			clearTimeout(timer);
			if (timedOut) {
				reject(new SystemsReviewSnapshotError("GIT_TIMEOUT", `git ${args[0] ?? "command"} exceeded ${timeoutMs}ms.`, { cwd }));
				return;
			}
			if (code !== 0) {
				reject(new SystemsReviewSnapshotError("GIT_FAILED", `git ${args.join(" ")} failed in ${cwd}: ${Buffer.concat(stderr).toString("utf8").trim()}`, { cwd, code }));
				return;
			}
			resolve(Buffer.concat(stdout));
		});
	});
}

async function gitText(cwd: string, args: readonly string[], commandRunner?: CommandRunner): Promise<string> {
	return (await runSystemsReviewGit(cwd, args, commandRunner)).toString("utf8").trim();
}

async function revParse(cwd: string, ref: string, commandRunner?: CommandRunner): Promise<string | undefined> {
	try {
		const oid = await gitText(cwd, ["rev-parse", "--verify", `${ref}^{commit}`], commandRunner);
		return OID_RE.test(oid) ? oid : undefined;
	} catch {
		return undefined;
	}
}

function baseCandidates(baseBranch: string, metadataRef?: string): string[] {
	const clean = baseBranch.trim().replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/origin\//, "").replace(/^origin\//, "");
	const candidates = [metadataRef, `refs/heads/${clean}`, clean, `refs/remotes/origin/${clean}`, `origin/${clean}`]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
	return [...new Set(candidates)];
}

async function resolveBase(cwd: string, headOid: string, candidates: readonly string[], commandRunner?: CommandRunner): Promise<{ ref: string; oid: string; mergeBaseOid: string }> {
	for (const ref of candidates) {
		const oid = await revParse(cwd, ref, commandRunner);
		if (!oid) continue;
		try {
			const mergeBaseOid = await gitText(cwd, ["merge-base", oid, headOid], commandRunner);
			if (OID_RE.test(mergeBaseOid)) return { ref, oid, mergeBaseOid };
		} catch {
			// Try the next compatible local/remote-tracking candidate.
		}
	}
	throw new SystemsReviewSnapshotError("BASE_UNRESOLVED", `No compatible base ref could be resolved in ${cwd}.`, { candidates });
}

async function cleanStatus(cwd: string, commandRunner?: CommandRunner): Promise<string> {
	return (await runSystemsReviewGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], commandRunner)).toString("utf8");
}

async function assertObjectIsolation(cwd: string, commandRunner?: CommandRunner): Promise<void> {
	if (process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES) {
		throw new SystemsReviewSnapshotError("ALTERNATE_OBJECTS", "Systems review does not permit alternate Git object directories.", { cwd });
	}
	const alternatePath = await gitText(cwd, ["rev-parse", "--git-path", "objects/info/alternates"], commandRunner);
	if (alternatePath) {
		const absolute = path.isAbsolute(alternatePath) ? alternatePath : path.resolve(cwd, alternatePath);
		try {
			if (fs.readFileSync(absolute, "utf8").trim()) {
				throw new SystemsReviewSnapshotError("ALTERNATE_OBJECTS", "Systems review does not permit repositories backed by alternate object directories.", { cwd });
			}
		} catch (error) {
			if (error instanceof SystemsReviewSnapshotError) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const replacements = await gitText(cwd, ["replace", "-l"], commandRunner);
	if (replacements) throw new SystemsReviewSnapshotError("REPLACED_OBJECTS", "Systems review does not permit Git replacement objects.", { cwd });
	const graftsPath = await gitText(cwd, ["rev-parse", "--git-path", "info/grafts"], commandRunner);
	if (graftsPath) {
		const absolute = path.isAbsolute(graftsPath) ? graftsPath : path.resolve(cwd, graftsPath);
		try {
			if (fs.readFileSync(absolute, "utf8").trim()) throw new SystemsReviewSnapshotError("GRAFTED_HISTORY", "Systems review does not permit grafted Git history.", { cwd });
		} catch (error) {
			if (error instanceof SystemsReviewSnapshotError) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

function parseRawChanges(raw: Buffer): RawChange[] {
	const tokens = raw.toString("utf8").split("\0");
	const changes: RawChange[] = [];
	let index = 0;
	while (index < tokens.length) {
		const header = tokens[index++];
		if (!header) continue;
		const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(header);
		if (!match) throw new SystemsReviewSnapshotError("MALFORMED_GIT_DIFF", `Unexpected raw diff record: ${header.slice(0, 200)}`);
		const [, oldMode, newMode, rawOldOid, rawNewOid, status] = match;
		const firstPath = tokens[index++];
		if (!firstPath) throw new SystemsReviewSnapshotError("MALFORMED_GIT_DIFF", "Raw diff record omitted its path.");
		const secondPath = status === "R" || status === "C" ? tokens[index++] : undefined;
		if ((status === "R" || status === "C") && !secondPath) throw new SystemsReviewSnapshotError("MALFORMED_GIT_DIFF", "Rename/copy record omitted its destination path.");
		changes.push({
			oldMode,
			newMode,
			oldOid: ZERO_OID_RE.test(rawOldOid) ? undefined : rawOldOid,
			newOid: ZERO_OID_RE.test(rawNewOid) ? undefined : rawNewOid,
			status,
			oldPath: status === "A" ? undefined : firstPath,
			newPath: status === "D" ? undefined : (secondPath ?? firstPath),
		});
	}
	return changes;
}

function changeKind(status: string): SystemsReviewChangeKind {
	switch (status) {
		case "A": return "add";
		case "D": return "delete";
		case "R": return "rename";
		case "C": return "copy";
		case "T": return "type-change";
		case "M": return "modify";
		default: throw new SystemsReviewSnapshotError("UNSUPPORTED_CHANGE", `Unsupported Git change status "${status}".`);
	}
}

function patchArgs(repo: SystemsReviewRepoBinding, change: Pick<SystemsReviewChange, "oldPath" | "newPath">): string[] {
	const paths = [...new Set([change.oldPath, change.newPath].filter((value): value is string => !!value))]
		.map(candidate => `:(literal)${candidate}`);
	return [
		"-c", "core.quotepath=false", "diff", "--no-ext-diff", "--no-textconv", "--full-index", "--find-renames", "--find-copies",
		"--unified=80", repo.mergeBaseOid, repo.headOid, "--", ...paths,
	];
}

export function systemsReviewPatchArgs(repo: SystemsReviewRepoBinding, change: Pick<SystemsReviewChange, "oldPath" | "newPath">): string[] {
	return patchArgs(repo, change);
}

async function inspectPatch(repo: SystemsReviewRepoBinding, raw: RawChange, commandRunner?: CommandRunner): Promise<PatchInspection> {
	const hash = createHash("sha256");
	let bytes = 0;
	let scanTail = "";
	let binary = false;
	const signals = new Set<SystemsReviewRiskSignal>();
	const change = { oldPath: raw.oldPath, newPath: raw.newPath };
	await runSystemsReviewGit(repo.root, patchArgs(repo, change), commandRunner, chunk => {
		hash.update(chunk);
		bytes += chunk.byteLength;
		const scan = scanTail + chunk.toString("utf8");
		if (/Binary files .* differ|GIT binary patch/i.test(scan)) binary = true;
		for (const [signal, pattern] of RISK_PATTERNS) if (pattern.test(scan)) signals.add(signal);
		scanTail = scan.slice(-1024);
	});
	return { sha256: hash.digest("hex"), bytes, binary, riskSignals: [...signals].sort() };
}

function classifyPath(candidate: string, binary: boolean): SystemsReviewPathClass {
	const normalized = candidate.toLowerCase().replace(/\\/g, "/");
	const base = path.posix.basename(normalized);
	const extension = path.posix.extname(normalized);
	if (binary && PASSIVE_BINARY_EXTENSIONS.has(extension)) return "asset";
	if (/(^|\/)(test|tests|__tests__|spec|specs|fixtures)(\/|$)/.test(normalized) || /\.(test|spec)\.[^.]+$/.test(normalized)) return "test";
	if (/(^|\/)(docs?|documentation)(\/|$)/.test(normalized) || /(^|\/)readme(?:\.[^/]*)?$/.test(normalized) || /\.mdx?$/.test(normalized)) return "docs";
	if (DEPENDENCY_LOCKFILE_NAMES.has(base) || /(^|\/)(config|configs|schemas?)(\/|$)/.test(normalized) || /\.(json|ya?ml|toml|ini|config)$/.test(normalized)) return "config-schema";
	if (PASSIVE_BINARY_EXTENSIONS.has(extension)) return "asset";
	if (/(^|\/)(src|app|server|client|lib|packages|bin)(\/|$)/.test(normalized) || /\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|kts|cs|cpp|cxx|cc|c|h|hpp|swift|sh|bash|zsh|fish|ps1|cmd|bat|sql|vue|svelte)$/.test(normalized)) return "production-executable";
	return "unknown";
}

function binaryExempt(pathClass: SystemsReviewPathClass, candidate: string): boolean {
	const normalized = candidate.toLowerCase().replace(/\\/g, "/");
	const extension = path.posix.extname(normalized);
	if (EXECUTABLE_BINARY_EXTENSIONS.has(extension)) return false;
	return pathClass === "asset" && PASSIVE_BINARY_EXTENSIONS.has(extension);
}

export function isSystemsReviewDependencyLockfile(candidate: string): boolean {
	const normalized = candidate.toLowerCase().replace(/\\/g, "/");
	return DEPENDENCY_LOCKFILE_NAMES.has(path.posix.basename(normalized));
}

export function isSystemsReviewBodyExemptPath(candidate: string): boolean {
	const normalized = candidate.toLowerCase().replace(/\\/g, "/");
	return isSystemsReviewDependencyLockfile(normalized) || PASSIVE_BINARY_EXTENSIONS.has(path.posix.extname(normalized));
}

function coverageFor(change: SystemsReviewChange): SystemsReviewCoverageItem {
	const risks = new Set(change.riskSignals);
	const requiresActionTrace = risks.has("mutation") && (risks.has("control") || risks.has("route") || risks.has("target") || risks.has("aggregation"));
	const requiresStateTrace = risks.has("aggregation") || risks.has("state") || risks.has("transport") || risks.has("persistence") || (change.pathClass === "config-schema" && (risks.has("transport") || risks.has("state")));
	const requiresExactTargetEvidence = requiresActionTrace && risks.has("aggregation") && (risks.has("target") || risks.has("control") || risks.has("route"));
	const candidate = change.newPath ?? change.oldPath ?? "unknown";
	return {
		id: `coverage:${sha256(`${SYSTEMS_REVIEW_COVERAGE_VERSION}\0${change.id}`).slice(0, 32)}`,
		version: SYSTEMS_REVIEW_COVERAGE_VERSION,
		changeId: change.id,
		repoId: change.repoId,
		path: candidate,
		pathClass: change.pathClass,
		riskSignals: [...change.riskSignals],
		requiresStateTrace,
		requiresActionTrace,
		requiresExactTargetEvidence,
	};
}

export function buildSystemsReviewEvidenceChunks(changes: readonly SystemsReviewChange[]): SystemsReviewEvidenceChunk[] {
	const chunks: SystemsReviewEvidenceChunk[] = [];
	let parts: SystemsReviewEvidenceChunk["parts"] = [];
	let bytes = 0;
	let changeIds: string[] = [];
	const flush = () => {
		if (parts.length === 0) return;
		const index = chunks.length;
		const identity = stableJson({ index, parts });
		chunks.push({ id: `chunk:${sha256(identity).slice(0, 32)}`, index, parts, semanticPatchBytes: bytes, changeIds });
		parts = [];
		bytes = 0;
		changeIds = [];
	};

	for (const change of changes) {
		const semanticBytes = change.bodyExempt ? 0 : change.patchBytes;
		if (semanticBytes === 0) {
			if (changeIds.length >= SYSTEMS_REVIEW_CHUNK_MAX_CHANGES) flush();
			parts.push({ changeId: change.id, patchStart: 0, patchEnd: 0 });
			changeIds.push(change.id);
			continue;
		}
		let offset = 0;
		while (offset < semanticBytes) {
			const isNewChange = !changeIds.includes(change.id);
			if ((isNewChange && changeIds.length >= SYSTEMS_REVIEW_CHUNK_MAX_CHANGES) || bytes >= SYSTEMS_REVIEW_CHUNK_PATCH_BYTES) flush();
			const remaining = SYSTEMS_REVIEW_CHUNK_PATCH_BYTES - bytes;
			const length = Math.min(remaining, semanticBytes - offset);
			parts.push({ changeId: change.id, patchStart: offset, patchEnd: offset + length });
			if (!changeIds.includes(change.id)) changeIds.push(change.id);
			bytes += length;
			offset += length;
			if (bytes >= SYSTEMS_REVIEW_CHUNK_PATCH_BYTES) flush();
		}
	}
	flush();
	if (chunks.length === 0) {
		const identity = stableJson({ index: 0, parts: [] });
		chunks.push({ id: `chunk:${sha256(identity).slice(0, 32)}`, index: 0, parts: [], semanticPatchBytes: 0, changeIds: [] });
	}
	return chunks;
}

async function bindRepositories(options: CreateSystemsReviewSnapshotOptions): Promise<SystemsReviewRepoBinding[]> {
	const branchContainer = nativeRealpath(options.branchContainer);
	const componentList = options.components.length > 0 ? options.components : [{ name: "project", repo: "." }];
	const byLexicalCandidate = new Map<string, { candidate: string; components: string[]; metadataKeys: string[] }>();
	for (const component of componentList) {
		const repoRelative = component.repo && component.repo !== "." ? assertSafeRelativePath(component.repo) : ".";
		const candidate = path.resolve(branchContainer, repoRelative);
		if (!isContained(branchContainer, candidate)) throw new SystemsReviewSnapshotError("REPO_ESCAPE", `Component "${component.name}" escapes the branch container.`, { repo: component.repo });
		if (component.relativePath) {
			const relativePath = assertSafeRelativePath(component.relativePath);
			const componentPath = path.resolve(candidate, relativePath);
			if (!isContained(candidate, componentPath)) throw new SystemsReviewSnapshotError("COMPONENT_ESCAPE", `Component "${component.name}" has an unsafe relativePath.`, { relativePath });
		}
		const key = pathIdentity(candidate);
		const found = byLexicalCandidate.get(key);
		if (found) {
			found.components.push(component.name);
			found.metadataKeys.push(component.name, component.repo);
		} else {
			byLexicalCandidate.set(key, { candidate, components: [component.name], metadataKeys: [component.name, component.repo] });
		}
	}

	const byRoot = new Map<string, { root: string; components: string[]; lexicalKeys: Set<string>; metadataKeys: string[] }>();
	for (const [lexicalKey, candidate] of byLexicalCandidate) {
		const candidateReal = nativeRealpath(candidate.candidate);
		if (!isContained(branchContainer, candidateReal)) throw new SystemsReviewSnapshotError("REPO_REALPATH_ESCAPE", `Component repository escapes the branch container after realpath resolution.`, { candidate: candidate.candidate, candidateReal });
		const gitRootRaw = await gitText(candidateReal, ["rev-parse", "--show-toplevel"], options.commandRunner);
		const root = nativeRealpath(gitRootRaw);
		if (!isContained(branchContainer, root)) throw new SystemsReviewSnapshotError("GIT_ROOT_ESCAPE", `Git repository root escapes the branch container.`, { root });
		const key = pathIdentity(root);
		const found = byRoot.get(key);
		if (found) {
			if (!found.lexicalKeys.has(lexicalKey)) {
				throw new SystemsReviewSnapshotError("REPO_ALIAS", `Multiple component repository paths alias the same canonical Git root.`, { root, candidates: [found.root, candidate.candidate] });
			}
			found.components.push(...candidate.components);
			found.metadataKeys.push(...candidate.metadataKeys);
		} else {
			byRoot.set(key, { root, components: candidate.components, lexicalKeys: new Set([lexicalKey]), metadataKeys: candidate.metadataKeys });
		}
	}

	const repos: SystemsReviewRepoBinding[] = [];
	for (const entry of [...byRoot.values()].sort((a, b) => pathIdentity(a.root).localeCompare(pathIdentity(b.root)))) {
		await assertObjectIsolation(entry.root, options.commandRunner);
		const statusBefore = await cleanStatus(entry.root, options.commandRunner);
		if (statusBefore) throw new SystemsReviewSnapshotError("DIRTY_WORKTREE", `Systems review requires a clean worktree: ${entry.root}`, { root: entry.root });
		const headOid = await revParse(entry.root, "HEAD", options.commandRunner);
		if (!headOid) throw new SystemsReviewSnapshotError("UNBORN_HEAD", `Repository has no valid HEAD: ${entry.root}`, { root: entry.root });
		const metadataRef = entry.metadataKeys.map(key => options.metadataBaseRefs?.[key]).find((value): value is string => !!value);
		const base = await resolveBase(entry.root, headOid, baseCandidates(options.baseBranch, metadataRef), options.commandRunner);
		const [headTreeOid, mergeBaseTreeOid] = await Promise.all([
			gitText(entry.root, ["rev-parse", `${headOid}^{tree}`], options.commandRunner),
			gitText(entry.root, ["rev-parse", `${base.mergeBaseOid}^{tree}`], options.commandRunner),
		]);
		if (!OID_RE.test(headTreeOid) || !OID_RE.test(mergeBaseTreeOid)) throw new SystemsReviewSnapshotError("INVALID_TREE", `Could not pin repository trees for ${entry.root}.`);
		const statusAfter = await cleanStatus(entry.root, options.commandRunner);
		const headAfter = await revParse(entry.root, "HEAD", options.commandRunner);
		if (statusAfter || statusAfter !== statusBefore || headAfter !== headOid) {
			throw new SystemsReviewSnapshotError("REPO_MOVED", `Repository changed while the Systems review snapshot was being bound: ${entry.root}`, { headOid, headAfter });
		}
		const id = `repo:${sha256(pathIdentity(entry.root)).slice(0, 24)}`;
		repos.push({
			id,
			root: entry.root,
			components: [...new Set(entry.components)].sort(),
			baseRef: base.ref,
			baseOid: base.oid,
			mergeBaseOid: base.mergeBaseOid,
			mergeBaseTreeOid,
			headOid,
			headTreeOid,
		});
	}
	return repos;
}

export async function createSystemsReviewSnapshot(options: CreateSystemsReviewSnapshotOptions): Promise<SystemsReviewSnapshot> {
	if (!options.sessionId || !options.signalId) throw new SystemsReviewSnapshotError("INVALID_BINDING", "Systems review snapshot requires sessionId and signalId.");
	const projectRoot = nativeRealpath(options.projectRoot);
	const branchContainer = nativeRealpath(options.branchContainer);
	const repos = await bindRepositories(options);
	const changes: SystemsReviewChange[] = [];
	for (const repo of repos) {
		const raw = await runSystemsReviewGit(repo.root, ["-c", "core.quotepath=false", "diff", "--raw", "-z", "--no-abbrev", "--find-renames", "--find-copies", repo.mergeBaseOid, repo.headOid], options.commandRunner);
		for (const rawChange of parseRawChanges(raw)) {
			const candidatePath = assertSystemsReviewReadablePath(rawChange.newPath ?? rawChange.oldPath ?? "");
			if (rawChange.oldMode === "160000" || rawChange.newMode === "160000") throw new SystemsReviewSnapshotError("SUBMODULE_CHANGE", `Submodule changes cannot be inspected safely: ${candidatePath}`);
			if (rawChange.oldMode === "120000" || rawChange.newMode === "120000") throw new SystemsReviewSnapshotError("SYMLINK_CHANGE", `Symlink changes cannot be inspected safely: ${candidatePath}`);
			const patch = await inspectPatch(repo, rawChange, options.commandRunner);
			const pathClass = classifyPath(candidatePath, patch.binary);
			const exemptBinary = patch.binary && binaryExempt(pathClass, candidatePath);
			const exemptBody = exemptBinary || isSystemsReviewDependencyLockfile(candidatePath);
			if (patch.binary && !exemptBinary) throw new SystemsReviewSnapshotError("UNREADABLE_BINARY", `Executable, production, or unknown binary change cannot be reviewed safely: ${candidatePath}`, { pathClass });
			const kind = changeKind(rawChange.status);
			const id = `change:${sha256(stableJson({ repoId: repo.id, kind, oldPath: rawChange.oldPath, newPath: rawChange.newPath, oldOid: rawChange.oldOid, newOid: rawChange.newOid })).slice(0, 32)}`;
			changes.push({
				id,
				repoId: repo.id,
				kind,
				oldPath: rawChange.oldPath,
				newPath: rawChange.newPath,
				oldMode: rawChange.oldMode,
				newMode: rawChange.newMode,
				oldBlobOid: rawChange.oldOid,
				newBlobOid: rawChange.newOid,
				patchSha256: patch.sha256,
				patchBytes: patch.bytes,
				binary: patch.binary,
				binaryExempt: exemptBinary,
				bodyExempt: exemptBody,
				components: repo.components,
				pathClass,
				riskSignals: patch.riskSignals,
			});
		}
	}
	changes.sort((a, b) => `${a.repoId}\0${a.newPath ?? a.oldPath ?? ""}\0${a.id}`.localeCompare(`${b.repoId}\0${b.newPath ?? b.oldPath ?? ""}\0${b.id}`));
	const coverage = changes.map(coverageFor);
	const chunks = buildSystemsReviewEvidenceChunks(changes);
	const derivation = {
		version: SYSTEMS_REVIEW_READER_VERSION,
		projectRoot: pathIdentity(projectRoot),
		branchContainer: pathIdentity(branchContainer),
		repos: repos.map(repo => ({ id: repo.id, root: pathIdentity(repo.root), components: repo.components, baseRef: repo.baseRef, baseOid: repo.baseOid, mergeBaseOid: repo.mergeBaseOid, mergeBaseTreeOid: repo.mergeBaseTreeOid, headOid: repo.headOid, headTreeOid: repo.headTreeOid })),
	};
	const derivationSha256 = sha256(stableJson(derivation));
	const digest = sha256(stableJson({ derivationSha256, changes, coverage, chunks }));
	return Object.freeze({
		version: SYSTEMS_REVIEW_READER_VERSION,
		sessionId: options.sessionId,
		signalId: options.signalId,
		createdAt: options.now?.() ?? Date.now(),
		projectRoot,
		branchContainer,
		digest,
		derivationSha256,
		repos: repos.map(repo => Object.freeze({ ...repo, components: Object.freeze([...repo.components]) }) as SystemsReviewRepoBinding),
		changes: changes.map(change => Object.freeze({ ...change, components: Object.freeze([...change.components]), riskSignals: Object.freeze([...change.riskSignals]) }) as SystemsReviewChange),
		coverage: coverage.map(item => Object.freeze({ ...item, riskSignals: Object.freeze([...item.riskSignals]) }) as SystemsReviewCoverageItem),
		chunks: chunks.map(chunk => Object.freeze({ ...chunk, parts: Object.freeze(chunk.parts.map(part => Object.freeze({ ...part }))), changeIds: Object.freeze([...chunk.changeIds]) }) as SystemsReviewEvidenceChunk),
	});
}

export async function assertSystemsReviewSnapshotCurrent(snapshot: SystemsReviewSnapshot, commandRunner?: CommandRunner): Promise<void> {
	for (const repo of snapshot.repos) {
		const root = nativeRealpath(repo.root);
		if (pathIdentity(root) !== pathIdentity(repo.root)) throw new SystemsReviewSnapshotError("STALE_REPO_ROOT", `Repository realpath changed after snapshot: ${repo.root}`);
		const [headOid, headTreeOid, mergeBaseTreeOid, status] = await Promise.all([
			revParse(root, "HEAD", commandRunner),
			gitText(root, ["rev-parse", `${repo.headOid}^{tree}`], commandRunner),
			gitText(root, ["rev-parse", `${repo.mergeBaseOid}^{tree}`], commandRunner),
			cleanStatus(root, commandRunner),
		]);
		if (headOid !== repo.headOid || headTreeOid !== repo.headTreeOid || mergeBaseTreeOid !== repo.mergeBaseTreeOid || status) {
			throw new SystemsReviewSnapshotError("STALE_SNAPSHOT", `Repository moved or became dirty after the Systems review snapshot: ${repo.root}`, { expectedHead: repo.headOid, actualHead: headOid, dirty: !!status });
		}
	}
}

export async function readSystemsReviewPatchRange(
	snapshot: SystemsReviewSnapshot,
	change: SystemsReviewChange,
	start: number,
	maxBytes: number,
	commandRunner?: CommandRunner,
	timeoutMs = 10_000,
): Promise<{ content: Buffer; end: number; complete: boolean; digest: string; totalBytes: number }> {
	const repo = snapshot.repos.find(candidate => candidate.id === change.repoId);
	if (!repo) throw new SystemsReviewSnapshotError("UNKNOWN_REPO", `Unknown repository binding for change ${change.id}.`);
	if (start < 0 || start > change.patchBytes || !Number.isSafeInteger(start)) throw new SystemsReviewSnapshotError("INVALID_RANGE", `Invalid patch offset ${start}.`);
	const hash = createHash("sha256");
	const page: Buffer[] = [];
	let totalBytes = 0;
	let pageBytes = 0;
	await runSystemsReviewGit(repo.root, patchArgs(repo, change), commandRunner, chunk => {
		hash.update(chunk);
		const chunkStart = totalBytes;
		totalBytes += chunk.byteLength;
		if (pageBytes >= maxBytes || chunkStart + chunk.byteLength <= start) return;
		const localStart = Math.max(0, start - chunkStart);
		const available = Math.min(chunk.byteLength - localStart, maxBytes - pageBytes);
		if (available > 0) {
			page.push(chunk.subarray(localStart, localStart + available));
			pageBytes += available;
		}
	}, timeoutMs);
	const digest = hash.digest("hex");
	if (digest !== change.patchSha256 || totalBytes !== change.patchBytes) {
		throw new SystemsReviewSnapshotError("STALE_PATCH", `Patch bytes no longer match the immutable manifest for ${change.id}.`, { expectedDigest: change.patchSha256, actualDigest: digest, expectedBytes: change.patchBytes, actualBytes: totalBytes });
	}
	const content = Buffer.concat(page);
	const end = start + content.byteLength;
	return { content, end, complete: end >= totalBytes, digest, totalBytes };
}

export const systemsReviewSnapshotInternals = Object.freeze({
	passiveBinaryExtensions: Object.freeze([...PASSIVE_BINARY_EXTENSIONS]),
	executableBinaryExtensions: Object.freeze([...EXECUTABLE_BINARY_EXTENSIONS]),
	dependencyLockfileNames: Object.freeze([...DEPENDENCY_LOCKFILE_NAMES]),
});
