import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type BobbitBuildType = "installed" | "source";

export interface BobbitAppInfo {
	version: string;
	buildType: BobbitBuildType;
	commitSha?: string;
}

const BOBBIT_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readPackageVersion(packageRoot: string): string {
	const packagePath = path.join(packageRoot, "package.json");
	try {
		const parsed = JSON.parse(fs.readFileSync(packagePath, "utf-8")) as { version?: unknown };
		if (typeof parsed.version === "string" && parsed.version.trim()) return parsed.version.trim();
		throw new Error("missing string version field");
	} catch (err) {
		throw new Error(`Failed to read Bobbit version from ${packagePath}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function readLooseGitCommitSha(packageRoot: string): string | undefined {
	const markerPath = path.join(packageRoot, ".git");
	try {
		const marker = fs.statSync(markerPath).isDirectory()
			? undefined
			: fs.readFileSync(markerPath, "utf-8").trim();
		const gitDir = marker?.startsWith("gitdir:")
			? path.resolve(packageRoot, marker.slice("gitdir:".length).trim())
			: markerPath;
		const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf-8").trim();
		if (/^[0-9a-f]{40}$/i.test(head)) return head;
		if (!head.startsWith("ref:")) return undefined;

		const ref = head.slice("ref:".length).trim();
		const commonDirPath = path.join(gitDir, "commondir");
		const commonDir = fs.existsSync(commonDirPath)
			? path.resolve(gitDir, fs.readFileSync(commonDirPath, "utf-8").trim())
			: gitDir;
		for (const root of new Set([gitDir, commonDir])) {
			const looseRefPath = path.join(root, ...ref.split("/"));
			if (fs.existsSync(looseRefPath)) return fs.readFileSync(looseRefPath, "utf-8").trim();
			const packedRefsPath = path.join(root, "packed-refs");
			if (!fs.existsSync(packedRefsPath)) continue;
			const packedRef = fs.readFileSync(packedRefsPath, "utf-8")
				.split(/\r?\n/)
				.find(line => line.endsWith(` ${ref}`));
			if (packedRef) return packedRef.split(" ", 1)[0];
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function readGitCommitSha(packageRoot: string): string | undefined {
	const looseSha = readLooseGitCommitSha(packageRoot);
	if (looseSha) return looseSha;
	try {
		return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
			cwd: packageRoot,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return undefined;
	}
}

/**
 * Resolve the running Bobbit package's version and provenance. A `.git` marker
 * at the package root distinguishes a source checkout (including worktrees)
 * from an npm-installed package without accidentally reading the host
 * project's commit from a parent repository.
 */
export function resolveBobbitAppInfo(
	packageRoot = BOBBIT_PACKAGE_ROOT,
	resolveCommitSha: (root: string) => string | undefined = readGitCommitSha,
): BobbitAppInfo {
	const version = readPackageVersion(packageRoot);
	if (!fs.existsSync(path.join(packageRoot, ".git"))) {
		return { version, buildType: "installed" };
	}

	const rawCommitSha = resolveCommitSha(packageRoot)?.trim();
	const commitSha = rawCommitSha && /^[0-9a-f]{7,40}$/i.test(rawCommitSha)
		? rawCommitSha.slice(0, 7).toLowerCase()
		: undefined;
	return {
		version,
		buildType: "source",
		...(commitSha ? { commitSha } : {}),
	};
}

export const BOBBIT_APP_INFO: Readonly<BobbitAppInfo> = Object.freeze(resolveBobbitAppInfo());
