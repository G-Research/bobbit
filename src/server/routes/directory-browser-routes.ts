// src/server/routes/directory-browser-routes.ts
//
// STR-01 cohort 14: Add Project directory browser/create routes migrated out
// of handleApiRoute's legacy if/else chain into the core route registry. See
// docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. Both legacy
// blocks gated on path and method in the same `if` condition. A method
// mismatch skipped the block and fell through to the terminal 404; RouteTable's
// method-scoped matching preserves that by leaving other methods unregistered.

import fs from "node:fs";
import path from "node:path";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

// POST /api/create-directory — create the typed Add Project directory path.
async function handleCreateDirectory(ctx: CoreRouteCtx): Promise<void> {
	const { json, readBody, req } = ctx;
	const body = await readBody(req).catch(() => null);
	const rawPath = typeof body?.path === "string" ? body.path.trim() : "";
	if (!rawPath || !path.isAbsolute(rawPath)) {
		json({ error: "Enter an absolute directory path.", code: "invalid_path" }, 400);
		return;
	}

	const targetPath = path.resolve(rawPath);
	try {
		const targetStat = fs.statSync(targetPath);
		if (targetStat.isDirectory()) {
			json({ error: "Directory already exists", code: "already_exists" }, 409);
		} else {
			json({ error: "A file already exists at that path", code: "exists_as_file" }, 409);
		}
		return;
	} catch (err: any) {
		if (err?.code && err.code !== "ENOENT") {
			if (err.code === "EACCES" || err.code === "EPERM") {
				json({ error: "Permission denied creating this directory", code: "permission_denied" }, 403);
				return;
			}
			json({ error: err?.message || "Could not check directory", code: "create_failed" }, 500);
			return;
		}
	}

	const parentPath = path.dirname(targetPath);
	try {
		const parentStat = fs.statSync(parentPath);
		if (!parentStat.isDirectory()) {
			json({ error: "The parent directory does not exist", code: "parent_not_found" }, 404);
			return;
		}
	} catch (err: any) {
		if (err?.code === "EACCES" || err?.code === "EPERM") {
			json({ error: "Permission denied creating this directory", code: "permission_denied" }, 403);
		} else {
			json({ error: "The parent directory does not exist", code: "parent_not_found" }, 404);
		}
		return;
	}

	try {
		fs.mkdirSync(targetPath, { recursive: false });
		json({ path: targetPath });
	} catch (err: any) {
		if (err?.code === "EEXIST") {
			json({ error: "Directory already exists", code: "already_exists" }, 409);
		} else if (err?.code === "EACCES" || err?.code === "EPERM") {
			json({ error: "Permission denied creating this directory", code: "permission_denied" }, 403);
		} else if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
			json({ error: "The parent directory does not exist", code: "parent_not_found" }, 404);
		} else {
			json({ error: err?.message || "Could not create directory", code: "create_failed" }, 500);
		}
	}
	return;
}

// GET /api/browse-directory — list child directories for Add Project browsing/typeahead.
async function handleBrowseDirectory(ctx: CoreRouteCtx): Promise<void> {
	const { defaultCwd, json, url } = ctx;
	const rawPath = url.searchParams.get("path");
	const rawPrefix = url.searchParams.get("prefix") ?? "";
	const prefix = rawPrefix.toLowerCase();
	const rawLimit = url.searchParams.get("limit");
	const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : 0;
	const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 0;
	const dirPath = rawPath ? path.resolve(rawPath) : defaultCwd;

	if (!fs.existsSync(dirPath)) {
		json({ error: "Directory not found" }, 404);
		return;
	}

	try {
		const stat = fs.statSync(dirPath);
		if (!stat.isDirectory()) {
			json({ error: "Path is not a directory" }, 400);
			return;
		}
	} catch {
		json({ error: "Cannot access path" }, 400);
		return;
	}

	const entries: Array<{ name: string; path: string }> = [];
	let truncated = false;
	try {
		const items = fs.readdirSync(dirPath)
			.filter((item) => {
				// Skip hidden directories and node_modules
				if (item.startsWith(".") || item === "node_modules") return false;
				return !prefix || item.toLowerCase().startsWith(prefix);
			})
			.sort((a, b) => a.localeCompare(b));
		for (const item of items) {
			const fullPath = path.join(dirPath, item);
			try {
				const stat = fs.lstatSync(fullPath);
				if (stat.isDirectory() && !stat.isSymbolicLink()) {
					entries.push({ name: item, path: fullPath });
					if (limit > 0 && entries.length >= limit) {
						truncated = true;
						break;
					}
				}
			} catch {
				// Skip entries we can't stat
			}
		}
	} catch {
		json({ error: "Cannot read directory" }, 500);
		return;
	}

	const parsed = path.parse(dirPath);
	const parent = parsed.root === dirPath ? null : path.dirname(dirPath);

	json({ current: dirPath, parent, entries, truncated });
	return;
}

export function registerDirectoryBrowserRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("POST", "/api/create-directory", handleCreateDirectory);
	table.register("GET", "/api/browse-directory", handleBrowseDirectory);
}
