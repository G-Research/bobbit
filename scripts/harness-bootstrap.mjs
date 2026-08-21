#!/usr/bin/env node

/**
 * Stable development-harness bootstrap.
 *
 * This entry point deliberately lives outside dist so it remains runnable when
 * a host exits between the two directory renames used to promote a staged dist.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const JOURNAL_FILE = ".bobbit-dist-promotion.json";
const STAGING_PREFIX = ".bobbit-dist-stage-";
const BACKUP_PREFIX = ".bobbit-dist-previous-";
const REQUIRED_SERVER_ENTRYPOINTS = ["cli.js", "harness.js", "watchdog.js"];
const UNSUPPORTED_DIRECTORY_SYNC = new Set(["EACCES", "EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EPERM"]);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function syncDirectory(directory) {
	if (process.platform === "win32") return;
	let fd;
	try {
		fd = fs.openSync(directory, fs.constants.O_RDONLY);
		fs.fsyncSync(fd);
	} catch (error) {
		if (!UNSUPPORTED_DIRECTORY_SYNC.has(error?.code ?? "")) throw error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function managedSibling(projectRoot, basename, prefix, label) {
	if (typeof basename !== "string" || !basename.startsWith(prefix) || path.basename(basename) !== basename) {
		throw new Error(`Invalid ${label} in ${JOURNAL_FILE}`);
	}
	return path.join(projectRoot, basename);
}

function validDist(dist) {
	try {
		return fs.statSync(dist).isDirectory()
			&& REQUIRED_SERVER_ENTRYPOINTS.every(entry => fs.statSync(path.join(dist, "server", entry)).isFile());
	} catch {
		return false;
	}
}

function removeManagedDirectory(directory, projectRoot, prefix) {
	managedSibling(projectRoot, path.basename(directory), prefix, "managed directory");
	fs.rmSync(directory, { recursive: true, force: true });
	syncDirectory(projectRoot);
}

function removeJournal(journalPath, projectRoot) {
	fs.rmSync(journalPath, { force: true });
	syncDirectory(projectRoot);
}

export function recoverInterruptedDistPromotion(projectRootValue = repositoryRoot) {
	const projectRoot = path.resolve(projectRootValue);
	const journalPath = path.join(projectRoot, JOURNAL_FILE);
	if (!fs.existsSync(journalPath)) return { action: "none" };

	let journal;
	try {
		journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read ${journalPath}; refusing to guess dist recovery state`, { cause: error });
	}
	if (journal?.version !== 1 || journal?.phase !== "live-moved" || typeof journal?.hadLive !== "boolean") {
		throw new Error(`Unsupported or corrupt dist promotion journal: ${journalPath}`);
	}

	const liveDist = path.join(projectRoot, "dist");
	const stagingDir = managedSibling(projectRoot, journal.stagingDir, STAGING_PREFIX, "stagingDir");
	const backupDir = journal.hadLive
		? managedSibling(projectRoot, journal.backupDir, BACKUP_PREFIX, "backupDir")
		: undefined;
	const liveExists = fs.existsSync(liveDist);
	const backupExists = backupDir !== undefined && fs.existsSync(backupDir);

	if (!liveExists && backupExists) {
		fs.renameSync(backupDir, liveDist);
		syncDirectory(projectRoot);
		if (!validDist(liveDist)) throw new Error(`Restored dist backup is invalid: ${liveDist}`);
		if (fs.existsSync(stagingDir)) removeManagedDirectory(stagingDir, projectRoot, STAGING_PREFIX);
		removeJournal(journalPath, projectRoot);
		return { action: "restored-backup" };
	}

	if (!liveExists && !journal.hadLive && fs.existsSync(stagingDir)) {
		fs.renameSync(stagingDir, liveDist);
		syncDirectory(projectRoot);
		if (!validDist(liveDist)) throw new Error(`Recovered staged dist is invalid: ${liveDist}`);
		removeJournal(journalPath, projectRoot);
		return { action: "promoted-candidate" };
	}

	if (!liveExists) {
		throw new Error(`Dist promotion is incomplete and has no recovery authority: ${journalPath}`);
	}

	if (!validDist(liveDist)) {
		if (!backupExists) throw new Error(`Live dist is invalid and no valid backup is available: ${liveDist}`);
		removeManagedDirectory(liveDist, projectRoot, "dist");
		fs.renameSync(backupDir, liveDist);
		syncDirectory(projectRoot);
		if (!validDist(liveDist)) throw new Error(`Restored dist backup is invalid: ${liveDist}`);
		if (fs.existsSync(stagingDir)) removeManagedDirectory(stagingDir, projectRoot, STAGING_PREFIX);
		removeJournal(journalPath, projectRoot);
		return { action: "restored-backup" };
	}

	// Both trees means the candidate rename completed. A live tree without a
	// backup means either the first rename never happened or cleanup already did;
	// in either case the validated live tree is the only safe selection.
	if (backupExists) removeManagedDirectory(backupDir, projectRoot, BACKUP_PREFIX);
	if (fs.existsSync(stagingDir)) removeManagedDirectory(stagingDir, projectRoot, STAGING_PREFIX);
	removeJournal(journalPath, projectRoot);
	return { action: backupExists ? "retained-candidate" : "retained-live" };
}

function parseInvocation(argv) {
	const args = [...argv];
	const mode = args.shift() ?? "recover";
	let projectRoot = repositoryRoot;
	const rootFlag = args.indexOf("--project-root");
	if (rootFlag >= 0) {
		if (!args[rootFlag + 1]) throw new Error("--project-root requires a path");
		projectRoot = path.resolve(args[rootFlag + 1]);
		args.splice(rootFlag, 2);
	}
	return { mode, projectRoot, args };
}

async function main() {
	const { mode, projectRoot, args } = parseInvocation(process.argv.slice(2));
	const recovery = recoverInterruptedDistPromotion(projectRoot);
	if (recovery.action !== "none") console.log(`[bootstrap] Dist promotion recovery: ${recovery.action}`);
	if (mode === "recover") return;

	const entries = {
		harness: "harness.js",
		watchdog: "watchdog.js",
	};
	const entryName = entries[mode];
	if (!entryName) throw new Error(`Unknown harness bootstrap mode: ${mode}`);
	const entry = path.join(projectRoot, "dist", "server", entryName);
	if (!fs.existsSync(entry)) throw new Error(`Harness entry point is missing after dist recovery: ${entry}`);

	process.argv = [process.execPath, entry, ...args];
	await import(pathToFileURL(entry).href);
}

const invokedPath = process.argv[1];
if (invokedPath && path.resolve(invokedPath) === path.resolve(fileURLToPath(import.meta.url))) {
	await main();
}
