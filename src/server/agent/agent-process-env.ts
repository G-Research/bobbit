import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { caCertPath } from "../auth/tls.js";
import { globalAgentDir, serverSecretsDir } from "../bobbit-dir.js";

const PRIVATE_ROOT_ENV = "BOBBIT_SECRETS_DIR";
const NODE_CA_ENV = "NODE_EXTRA_CA_CERTS";

function resolvedPathWithExistingAncestor(value: string): string {
	let candidate = path.resolve(value);
	const suffix: string[] = [];
	while (!fs.existsSync(candidate)) {
		const parent = path.dirname(candidate);
		if (parent === candidate) return path.resolve(value);
		suffix.unshift(path.basename(candidate));
		candidate = parent;
	}
	try {
		return path.join(fs.realpathSync.native(candidate), ...suffix);
	} catch {
		return path.resolve(value);
	}
}

/** True when a path names the private server root or one of its descendants. */
export function isPrivateServerPath(candidate: string, privateRoot = serverSecretsDir()): boolean {
	if (!candidate.trim()) return false;
	let root = resolvedPathWithExistingAncestor(privateRoot);
	let child = resolvedPathWithExistingAncestor(candidate);
	if (process.platform === "win32") {
		root = root.toLocaleLowerCase("en-US");
		child = child.toLocaleLowerCase("en-US");
	}
	const relative = path.relative(root, child);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Agent-readable copy of the public Bobbit CA. The private TLS directory also
 * contains the CA key, so agents must receive this isolated certificate copy
 * rather than a pathname that reveals the server-secrets root.
 */
export function publicAgentCaCertPath(): string {
	return path.join(globalAgentDir(), "trust", "bobbit-ca.crt");
}

/**
 * Refresh the public CA copy before an agent starts. Returns undefined when no
 * CA exists or the configured public destination is itself beneath the private
 * server root, allowing the established TLS compatibility fallback to apply.
 */
export function publishPublicAgentCaCert(privateRoot = serverSecretsDir()): string | undefined {
	const source = caCertPath();
	const target = publicAgentCaCertPath();
	if (!fs.existsSync(source) || isPrivateServerPath(target, privateRoot)) return undefined;

	const targetDir = path.dirname(target);
	fs.mkdirSync(targetDir, { recursive: true });
	const temporary = path.join(targetDir, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		fs.writeFileSync(temporary, fs.readFileSync(source), { flag: "wx", mode: 0o644 });
		fs.renameSync(temporary, target);
		if (process.platform !== "win32") fs.chmodSync(target, 0o644);
		return target;
	} catch {
		try { fs.unlinkSync(temporary); } catch { /* best-effort temporary cleanup */ }
		return undefined;
	}
}

/**
 * Final agent-process environment boundary. Apply only after inherited and
 * caller-provided env have been merged so neither source can reintroduce the
 * private root locator or a CA pathname beneath it.
 */
export function sanitizeAgentProcessEnv(
	environment: Readonly<NodeJS.ProcessEnv>,
	options: { privateRoot?: string; trustedCaPath?: string } = {},
): NodeJS.ProcessEnv {
	const privateRoot = options.privateRoot ?? serverSecretsDir();
	const sanitized: NodeJS.ProcessEnv = { ...environment };
	let safeCaPath: string | undefined;
	for (const key of Object.keys(sanitized)) {
		const normalized = key.toLocaleUpperCase("en-US");
		if (normalized === PRIVATE_ROOT_ENV) {
			delete sanitized[key];
			continue;
		}
		if (normalized === NODE_CA_ENV) {
			const value = sanitized[key];
			delete sanitized[key];
			if (typeof value === "string" && value.trim() && !isPrivateServerPath(value, privateRoot)) safeCaPath = value;
		}
	}

	const trustedCaPath = options.trustedCaPath;
	if (!safeCaPath && trustedCaPath && !isPrivateServerPath(trustedCaPath, privateRoot)) safeCaPath = trustedCaPath;
	if (safeCaPath) sanitized[NODE_CA_ENV] = safeCaPath;
	return sanitized;
}
