import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const PI_AI_BEDROCK_HEADERS_PATCH_LABEL = "1";

const PATCH_MARKER = "bobbit-pi-ai-bedrock-headers-patch-v1";

const PATCH_HELPER = `
const BOBBIT_PI_AI_BEDROCK_HEADERS_PATCH = "${PATCH_MARKER}";
function applyBobbitBedrockRequestHeaders(client, model, options) {
    if (model?.provider !== "aigw") return;
    const headerSource = options?.headers;
    if (!headerSource || typeof headerSource !== "object") return;
    const headerEntries = Object.entries(headerSource).filter((entry) => typeof entry[1] === "string" && entry[1].length > 0);
    if (headerEntries.length === 0) return;
    const middleware = (next) => async (args) => {
        const request = args?.request;
        const requestHeaders = request?.headers;
        if (requestHeaders && typeof requestHeaders === "object") {
            for (const [key, value] of headerEntries) {
                const lowerKey = key.toLowerCase();
                for (const existingKey of Object.keys(requestHeaders)) {
                    if (existingKey.toLowerCase() === lowerKey) delete requestHeaders[existingKey];
                }
                requestHeaders[key] = value;
            }
        }
        return next(args);
    };
    try {
        client.middlewareStack.addRelativeTo(middleware, {
            relation: "after",
            toMiddleware: "getUserAgentMiddleware",
            name: "bobbitBedrockRequestHeadersMiddleware",
            override: true,
        });
    }
    catch {
        client.middlewareStack.add(middleware, {
            step: "build",
            priority: "low",
            name: "bobbitBedrockRequestHeadersMiddleware",
            override: true,
        });
    }
}
`;

function uniqueExisting(paths: string[]): string[] {
	return Array.from(new Set(paths.filter((candidate) => {
		try { return fs.statSync(candidate).isFile(); }
		catch { return false; }
	})));
}

function packageSegments(specifier: string): string[] {
	return specifier.startsWith("@") ? specifier.split("/").slice(0, 2) : [specifier.split("/")[0]];
}

function findPackageRoot(specifier: string): string | undefined {
	const segments = packageSegments(specifier);
	const starts = [path.dirname(fileURLToPath(import.meta.url)), process.cwd()];
	for (const start of starts) {
		let dir = path.resolve(start);
		while (true) {
			const candidate = path.join(dir, "node_modules", ...segments);
			try {
				if (fs.statSync(path.join(candidate, "package.json")).isFile()) return candidate;
			} catch { /* keep walking */ }
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return undefined;
}

function packageRootFromMain(specifier: string): string | undefined {
	try {
		const resolve = import.meta.resolve?.bind(import.meta);
		if (resolve) {
			const mainPath = fileURLToPath(resolve(specifier));
			return path.resolve(path.dirname(mainPath), "..");
		}
	} catch { /* fall back below */ }
	try {
		const mainPath = require.resolve(specifier);
		return path.resolve(path.dirname(mainPath), "..");
	} catch {
		return findPackageRoot(specifier);
	}
}

/**
 * One installed copy of @earendil-works/pi-ai to patch (top-level, or the
 * copy nested under pi-coding-agent's own node_modules). `candidates` is
 * ordered by preference: pi-ai 0.80 moved the Bedrock stream implementation
 * from `dist/providers/amazon-bedrock.js` to `dist/api/bedrock-converse-stream.js`
 * — the old path is now a ~40-line provider-factory wrapper that no longer
 * contains either patch anchor. The old path is kept as a trailing fallback
 * candidate so an older installed pi-ai (pre-0.80) still gets patched, NOT
 * as an independent target to warn about when its anchors don't match — a
 * target only warns if EVERY one of its candidates fails to patch (see
 * ensurePiAiBedrockHeadersPatch below).
 */
interface BedrockPatchTarget {
	copyLabel: string;
	candidates: string[];
}

function piAiBedrockCandidates(): BedrockPatchTarget[] {
	const targets: BedrockPatchTarget[] = [];

	const piAiRoot = packageRootFromMain("@earendil-works/pi-ai");
	if (piAiRoot) {
		targets.push({
			copyLabel: "top-level @earendil-works/pi-ai",
			candidates: uniqueExisting([
				path.join(piAiRoot, "dist", "api", "bedrock-converse-stream.js"),
				path.join(piAiRoot, "dist", "providers", "amazon-bedrock.js"),
			]),
		});
	}

	const piCodingAgentRoot = packageRootFromMain("@earendil-works/pi-coding-agent");
	if (piCodingAgentRoot) {
		const nestedPiAiRoot = path.join(piCodingAgentRoot, "node_modules", "@earendil-works", "pi-ai");
		targets.push({
			copyLabel: "pi-coding-agent's nested @earendil-works/pi-ai",
			candidates: uniqueExisting([
				path.join(nestedPiAiRoot, "dist", "api", "bedrock-converse-stream.js"),
				path.join(nestedPiAiRoot, "dist", "providers", "amazon-bedrock.js"),
			]),
		});
	}

	return targets.filter((target) => target.candidates.length > 0);
}

function patchPiAiBedrockFile(filePath: string): "patched" | "already" | "skipped" {
	const source = fs.readFileSync(filePath, "utf-8");
	if (source.includes(PATCH_MARKER)) return "already";

	const importAnchor = `import { transformMessages } from "./transform-messages.js";\n`;
	const clientAnchor = `            const client = new BedrockRuntimeClient(config);\n`;
	if (!source.includes(importAnchor) || !source.includes(clientAnchor)) return "skipped";

	const patched = source
		.replace(importAnchor, `${importAnchor}${PATCH_HELPER}`)
		.replace(clientAnchor, `${clientAnchor}            applyBobbitBedrockRequestHeaders(client, model, options);\n`);
	fs.writeFileSync(filePath, patched, "utf-8");
	return "patched";
}

let didEnsure = false;

export function ensurePiAiBedrockHeadersPatch(): void {
	if (didEnsure) return;
	didEnsure = true;

	for (const target of piAiBedrockCandidates()) {
		let succeeded = false;
		let lastError: unknown;
		for (const candidate of target.candidates) {
			try {
				const result = patchPiAiBedrockFile(candidate);
				if (result === "patched" || result === "already") {
					succeeded = true;
					break;
				}
			} catch (err) {
				lastError = err;
			}
		}
		if (!succeeded) {
			if (lastError !== undefined) {
				const err = lastError as any;
				console.warn(`[aigw] Failed to patch pi-ai Bedrock headers hook for ${target.copyLabel}: ${err?.message || err}`);
			} else {
				console.warn(`[aigw] Could not patch pi-ai Bedrock headers hook for ${target.copyLabel}; unsupported file shape in all candidates: ${target.candidates.join(", ")}`);
			}
		}
	}
}
