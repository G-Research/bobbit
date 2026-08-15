import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxManager } from "./sandbox-manager.js";

export const MAX_SESSION_MARKDOWN_IMAGE_BYTES = 6 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

export type SessionMarkdownImageErrorCode = "invalid" | "forbidden" | "not_found" | "too_large" | "unavailable";

export class SessionMarkdownImageError extends Error {
	constructor(
		readonly code: SessionMarkdownImageErrorCode,
		message: string,
	) {
		super(message);
		this.name = "SessionMarkdownImageError";
	}
}

export interface SessionMarkdownImageContext {
	cwd: string;
	sandboxed?: boolean;
	projectId?: string;
}

export interface SessionMarkdownImage {
	data: Buffer;
	mimeType: string;
}

function isInside(root: string, candidate: string, pathApi: typeof path | typeof path.posix): boolean {
	const relative = pathApi.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));
}

function decodePath(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		throw new SessionMarkdownImageError("invalid", "Image path is not valid URL encoding");
	}
}

/** Convert the Markdown destination back into the agent's filesystem coordinates. */
export function localMarkdownImagePath(rawPath: string, sandboxed = false): string {
	if (!rawPath || rawPath.length > 8_192 || /[\0\r\n]/.test(rawPath)) {
		throw new SessionMarkdownImageError("invalid", "Image path is invalid");
	}
	if (/^file:/i.test(rawPath)) {
		let url: URL;
		try {
			url = new URL(rawPath);
		} catch {
			throw new SessionMarkdownImageError("invalid", "Image file URL is invalid");
		}
		if (url.protocol !== "file:" || url.username || url.password || url.port || url.search || url.hash) {
			throw new SessionMarkdownImageError("invalid", "Image file URL is invalid");
		}
		if (url.hostname && url.hostname !== "localhost") {
			throw new SessionMarkdownImageError("invalid", "Image file URL host is invalid");
		}
		if (sandboxed) {
			return decodePath(url.pathname);
		}
		try {
			return fileURLToPath(url);
		} catch {
			throw new SessionMarkdownImageError("invalid", "Image file URL is invalid");
		}
	}
	if (/^[a-z][a-z\d+.-]*:/i.test(rawPath) && !/^[a-z]:[\\/]/i.test(rawPath)) {
		throw new SessionMarkdownImageError("invalid", "Only local image paths are supported");
	}
	return decodePath(rawPath);
}

function mimeTypeForExtension(extension: string): string {
	const mimeType = MIME_BY_EXTENSION[extension.toLowerCase()];
	if (!mimeType) throw new SessionMarkdownImageError("invalid", "Unsupported image type");
	return mimeType;
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
	// dev+ino are stable on POSIX and populated by current Node builds on NTFS.
	// Size and timestamps are defense-in-depth for filesystems with weak inode ids.
	return left.dev === right.dev
		&& left.ino === right.ino
		&& left.size === right.size
		&& left.mtimeMs === right.mtimeMs
		&& left.birthtimeMs === right.birthtimeMs;
}

function readHostImage(cwd: string, rawPath: string): SessionMarkdownImage {
	const requestedPath = localMarkdownImagePath(rawPath, false);
	let root: string;
	let target: string;
	try {
		const rootEntry = fs.lstatSync(cwd);
		if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
			throw new SessionMarkdownImageError("forbidden", "Session workspace identity is invalid");
		}
		root = fs.realpathSync.native(cwd);
		const unresolved = path.isAbsolute(requestedPath)
			? path.resolve(requestedPath)
			: path.resolve(cwd, requestedPath);
		target = fs.realpathSync.native(unresolved);
	} catch (error) {
		if (error instanceof SessionMarkdownImageError) throw error;
		throw new SessionMarkdownImageError("not_found", "Image not found");
	}
	if (!isInside(root, target, path)) {
		throw new SessionMarkdownImageError("forbidden", "Image is outside the session workspace");
	}
	const mimeType = mimeTypeForExtension(path.extname(target));
	let fd: number | undefined;
	try {
		const noFollow = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;
		fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
		const openedStat = fs.fstatSync(fd);
		if (!openedStat.isFile()) throw new SessionMarkdownImageError("not_found", "Image not found");
		if (openedStat.size > MAX_SESSION_MARKDOWN_IMAGE_BYTES) {
			throw new SessionMarkdownImageError("too_large", "Image exceeds the size limit");
		}
		const data = Buffer.allocUnsafe(openedStat.size);
		let offset = 0;
		while (offset < data.length) {
			const count = fs.readSync(fd, data, offset, data.length - offset, offset);
			if (count === 0) break;
			offset += count;
		}
		const rootAfter = fs.realpathSync.native(cwd);
		const targetAfter = fs.realpathSync.native(target);
		const pathStat = fs.statSync(targetAfter);
		if (rootAfter !== root || targetAfter !== target || !sameFile(openedStat, pathStat)) {
			throw new SessionMarkdownImageError("forbidden", "Image changed during validation");
		}
		return { data: offset === data.length ? data : data.subarray(0, offset), mimeType };
	} catch (error) {
		if (error instanceof SessionMarkdownImageError) throw error;
		throw new SessionMarkdownImageError("not_found", "Image not found");
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* retain the primary result */ }
		}
	}
}

const SANDBOX_READ_IMAGE_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const [cwd, requested, maxText] = process.argv.slice(1);
const finish = value => process.stdout.write(JSON.stringify(value));
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.birthtimeMs === b.birthtimeMs;
(() => {
  let fd;
  try {
    const rootEntry = fs.lstatSync(cwd);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) return finish({ error: "forbidden" });
    const root = fs.realpathSync(cwd);
    const unresolved = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(cwd, requested);
    const target = fs.realpathSync(unresolved);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return finish({ error: "forbidden" });
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    const openedStat = fs.fstatSync(fd);
    if (!openedStat.isFile()) return finish({ error: "not_found" });
    if (openedStat.size > Number(maxText)) return finish({ error: "too_large" });
    const data = Buffer.allocUnsafe(openedStat.size);
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const rootAfter = fs.realpathSync(cwd);
    const targetAfter = fs.realpathSync(target);
    const pathStat = fs.statSync(targetAfter);
    if (rootAfter !== root || targetAfter !== target || !sameFile(openedStat, pathStat)) return finish({ error: "forbidden" });
    finish({ data: data.subarray(0, offset).toString("base64"), extension: path.extname(target).toLowerCase(), size: offset });
  } catch { finish({ error: "not_found" }); }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
})();
`;

async function readSandboxImage(
	ctx: SessionMarkdownImageContext,
	rawPath: string,
	sandboxManager: SandboxManager | null,
): Promise<SessionMarkdownImage> {
	const requestedPath = localMarkdownImagePath(rawPath, true);
	const root = path.posix.resolve(ctx.cwd);
	const unresolved = path.posix.isAbsolute(requestedPath)
		? path.posix.resolve(requestedPath)
		: path.posix.resolve(root, requestedPath);
	// Reject lexical escapes before invoking the container. The in-container
	// realpath check below independently rejects symlink escapes.
	if (!isInside(root, unresolved, path.posix)) {
		throw new SessionMarkdownImageError("forbidden", "Image is outside the session workspace");
	}
	const sandbox = ctx.projectId ? sandboxManager?.get(ctx.projectId) : undefined;
	if (!sandbox) throw new SessionMarkdownImageError("unavailable", "Session sandbox is unavailable");

	let parsed: { error?: SessionMarkdownImageErrorCode; data?: string; extension?: string; size?: number };
	try {
		const output = await sandbox.exec([
			"node", "-e", SANDBOX_READ_IMAGE_SCRIPT, "--",
			root, unresolved, String(MAX_SESSION_MARKDOWN_IMAGE_BYTES),
		], { timeout: 15_000 });
		parsed = JSON.parse(output);
	} catch {
		throw new SessionMarkdownImageError("unavailable", "Session image could not be read");
	}
	if (parsed.error) {
		throw new SessionMarkdownImageError(parsed.error, parsed.error === "forbidden"
			? "Image is outside the session workspace"
			: parsed.error === "too_large" ? "Image exceeds the size limit" : "Image not found");
	}
	if (typeof parsed.data !== "string" || typeof parsed.extension !== "string" || typeof parsed.size !== "number") {
		throw new SessionMarkdownImageError("unavailable", "Session image response is invalid");
	}
	const data = Buffer.from(parsed.data, "base64");
	if (data.length !== parsed.size || data.length > MAX_SESSION_MARKDOWN_IMAGE_BYTES) {
		throw new SessionMarkdownImageError("unavailable", "Session image response is invalid");
	}
	return { data, mimeType: mimeTypeForExtension(parsed.extension) };
}

/** Read one image while enforcing session-cwd containment in the owning filesystem realm. */
export async function readSessionMarkdownImage(
	ctx: SessionMarkdownImageContext,
	rawPath: string,
	sandboxManager: SandboxManager | null,
): Promise<SessionMarkdownImage> {
	return ctx.sandboxed
		? readSandboxImage(ctx, rawPath, sandboxManager)
		: readHostImage(ctx.cwd, rawPath);
}
