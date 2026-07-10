import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";

const RUNTIME_PACKAGE = "@earendil-works/pi-coding-agent";
const RUNTIME_PACKAGE_MANIFEST = path.join("@earendil-works", "pi-coding-agent", "package.json");
const RUNTIME_DIR = "runtime";
const CURRENT_POINTER = "node_modules.current";
const CURRENT_STABLE_DIR = "node_modules";
const FINGERPRINT_FILE = ".fingerprint";
const SNAPSHOT_SCHEMA = "runtime-ringfence-v1";

export interface ResolveAgentRuntimeModulesDirOptions {
	workingModulesDir: string;
	snapshotModulesDir?: string;
	exists?: (p: string) => boolean;
}

export interface EnsureRuntimeSnapshotOptions {
	workingModulesDir: string;
	stateDir?: string;
	log?: (msg: string) => void;
}

function packageManifest(modulesDir: string): string {
	return path.join(modulesDir, RUNTIME_PACKAGE_MANIFEST);
}

function hasRuntimePackage(modulesDir: string | undefined, exists: (p: string) => boolean = fs.existsSync): modulesDir is string {
	return !!modulesDir && exists(packageManifest(modulesDir));
}

/**
 * Pure resolver seam: prefer an intact ring-fenced snapshot, then fall back to
 * the mutable working tree. The caller supplies any snapshot path it trusts
 * (normally from ensureRuntimeSnapshot()/currentRuntimeSnapshotModulesDir()).
 */
export function resolveAgentRuntimeModulesDir(opts: ResolveAgentRuntimeModulesDirOptions): string {
	const { workingModulesDir, snapshotModulesDir, exists = fs.existsSync } = opts;
	if (hasRuntimePackage(snapshotModulesDir, exists)) return snapshotModulesDir;
	return workingModulesDir;
}

function runtimeRoot(stateDir: string): string {
	return path.join(stateDir, RUNTIME_DIR);
}

function readCurrentPointer(root: string): string | undefined {
	try {
		const name = fs.readFileSync(path.join(root, CURRENT_POINTER), "utf-8").trim();
		if (!name || name.includes("/") || name.includes("\\") || path.isAbsolute(name)) return undefined;
		return path.join(root, name);
	} catch {
		return undefined;
	}
}

export function currentRuntimeSnapshotModulesDir(stateDir = bobbitStateDir()): string | undefined {
	const root = runtimeRoot(stateDir);
	const pointed = readCurrentPointer(root);
	if (hasRuntimePackage(pointed)) return pointed;

	// Back-compat / optional stable symlink-junction path. This is not mutated in
	// place; ensureRuntimeSnapshot switches it only after a versioned snapshot is
	// complete, and falls back to the pointer file if the host disallows links.
	const stable = path.join(root, CURRENT_STABLE_DIR);
	if (hasRuntimePackage(stable)) return stable;
	return undefined;
}

function readIfPresent(file: string): Buffer | undefined {
	try {
		return fs.readFileSync(file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

export function fingerprintRuntimeInputs(projectRoot: string): string {
	const h = crypto.createHash("sha256");
	h.update(SNAPSHOT_SCHEMA);
	for (const name of ["package.json", "package-lock.json"]) {
		const content = readIfPresent(path.join(projectRoot, name));
		h.update("\0");
		h.update(name);
		h.update("\0");
		if (content) h.update(content);
	}
	return h.digest("hex").slice(0, 32);
}

function sameFingerprint(root: string, fingerprint: string): boolean {
	try {
		return fs.readFileSync(path.join(root, FINGERPRINT_FILE), "utf-8").trim() === fingerprint;
	} catch {
		return false;
	}
}

function writeAtomic(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, content, "utf-8");
	try {
		fs.renameSync(tmp, file);
	} catch (err) {
		try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
		try {
			fs.renameSync(tmp, file);
		} catch {
			try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
			throw err;
		}
	}
}

function copyOrLinkFile(src: string, dst: string): void {
	try {
		fs.linkSync(src, dst);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EXDEV" || code === "EPERM" || code === "EACCES" || code === "EINVAL" || code === "ENOTSUP") {
			fs.copyFileSync(src, dst);
			return;
		}
		throw err;
	}
}

function cloneSymlink(src: string, dst: string): void {
	const target = fs.readlinkSync(src);
	try {
		fs.symlinkSync(target, dst);
	} catch (err) {
		// Windows may reject relative file symlinks without developer mode. Copy the
		// resolved target when it is a file; skip broken links so snapshot creation
		// can still fall back cleanly instead of bricking agent spawns.
		const code = (err as NodeJS.ErrnoException).code;
		if (process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EINVAL")) {
			const resolved = path.resolve(path.dirname(src), target);
			const st = fs.statSync(resolved);
			if (st.isFile()) {
				copyOrLinkFile(resolved, dst);
				return;
			}
		}
		throw err;
	}
}

function hardlinkFarm(src: string, dst: string): void {
	const st = fs.lstatSync(src);
	if (st.isSymbolicLink()) {
		cloneSymlink(src, dst);
		return;
	}
	if (st.isDirectory()) {
		fs.mkdirSync(dst, { recursive: true });
		for (const entry of fs.readdirSync(src)) {
			hardlinkFarm(path.join(src, entry), path.join(dst, entry));
		}
		return;
	}
	if (st.isFile()) {
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		copyOrLinkFile(src, dst);
		try { fs.chmodSync(dst, st.mode); } catch { /* best-effort */ }
	}
}

function switchStableLink(root: string, target: string): void {
	const stable = path.join(root, CURRENT_STABLE_DIR);
	try {
		fs.rmSync(stable, { recursive: true, force: true });
		fs.symlinkSync(target, stable, process.platform === "win32" ? "junction" : "dir");
	} catch {
		// The pointer file is authoritative; the stable link is best-effort only.
	}
}

/**
 * Build (or reuse) a complete hardlink-farm snapshot of the working
 * node_modules under <state>/runtime. Any failure returns undefined so direct
 * spawns fall back to import.meta.resolve's working-tree behavior.
 */
export function ensureRuntimeSnapshot(opts: EnsureRuntimeSnapshotOptions): string | undefined {
	try {
		if (!hasRuntimePackage(opts.workingModulesDir)) return currentRuntimeSnapshotModulesDir(opts.stateDir ?? bobbitStateDir());

		const projectRoot = path.dirname(opts.workingModulesDir);
		const fingerprint = fingerprintRuntimeInputs(projectRoot);
		const stateDir = opts.stateDir ?? bobbitStateDir();
		const root = runtimeRoot(stateDir);
		const versionName = `node_modules-${fingerprint}`;
		const versionDir = path.join(root, versionName);

		const current = currentRuntimeSnapshotModulesDir(stateDir);
		if (current && sameFingerprint(root, fingerprint) && hasRuntimePackage(current)) return current;
		if (hasRuntimePackage(versionDir)) {
			writeAtomic(path.join(root, CURRENT_POINTER), `${versionName}\n`);
			writeAtomic(path.join(root, FINGERPRINT_FILE), `${fingerprint}\n`);
			switchStableLink(root, versionDir);
			return versionDir;
		}

		fs.mkdirSync(root, { recursive: true });
		const tmpDir = path.join(root, `${versionName}.tmp-${process.pid}-${Date.now()}`);
		try {
			hardlinkFarm(opts.workingModulesDir, tmpDir);
			if (!hasRuntimePackage(tmpDir)) throw new Error(`${RUNTIME_PACKAGE} missing from built runtime snapshot`);
			writeAtomic(path.join(tmpDir, FINGERPRINT_FILE), `${fingerprint}\n`);
			try {
				fs.renameSync(tmpDir, versionDir);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST" || !hasRuntimePackage(versionDir)) throw err;
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		} catch (err) {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
			throw err;
		}

		writeAtomic(path.join(root, CURRENT_POINTER), `${versionName}\n`);
		writeAtomic(path.join(root, FINGERPRINT_FILE), `${fingerprint}\n`);
		switchStableLink(root, versionDir);
		opts.log?.(`[runtime-ringfence] prepared agent runtime snapshot ${versionName}`);
		return versionDir;
	} catch (err) {
		opts.log?.(`[runtime-ringfence] snapshot unavailable; falling back to working node_modules: ${err instanceof Error ? err.message : String(err)}`);
		return undefined;
	}
}
