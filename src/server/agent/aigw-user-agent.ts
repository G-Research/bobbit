import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function loadBobbitPackageVersion(): string {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [
		path.resolve(moduleDir, "../../../package.json"),
	];

	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		try {
			const parsed = JSON.parse(fs.readFileSync(candidate, "utf-8")) as { version?: unknown };
			if (typeof parsed.version === "string" && parsed.version.trim()) {
				return parsed.version;
			}
			throw new Error(`missing string version field in ${candidate}`);
		} catch (err) {
			throw new Error(`Failed to read Bobbit package version from ${candidate}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	throw new Error(`Failed to locate Bobbit package.json for AI Gateway User-Agent. Tried: ${candidates.join(", ")}`);
}

const bobbitPackageVersion = loadBobbitPackageVersion();

export const BOBBIT_AIGW_USER_AGENT = `Bobbit/${bobbitPackageVersion}`;

export function aigwUserAgentHeaders(extra?: Record<string, string>): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(extra || {})) {
		if (key.toLowerCase() === "user-agent") continue;
		headers[key] = value;
	}
	headers["User-Agent"] = BOBBIT_AIGW_USER_AGENT;
	return headers;
}
