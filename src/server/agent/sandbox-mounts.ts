/**
 * Shared sandbox mount validation — used by both session-manager (per-session)
 * and server.ts (pool init) to enforce the same blocklist.
 */

import path from "node:path";

const BLOCKED_PATHS = [
	"/var/run/docker.sock", "/run/docker.sock",
	"/var/run/containerd", "/run/containerd",
	"/proc", "/sys", "/dev",
	"/etc", "/boot", "/sbin", "/bin", "/lib", "/lib64",
	"/usr/sbin", "/usr/bin", "/usr/lib",
	"/root", "/home",
];

const SENSITIVE_SUBSTRINGS = [
	"/.ssh", "/.aws", "/.gnupg", "/.config",
	"/.kube", "/.docker", "/.npmrc", "/.netrc",
	"/.git-credentials", "/.env",
	"/docker.sock",
];

/**
 * Validate and filter sandbox mounts against the blocklist.
 * Returns only the mounts that pass validation. Logs warnings for rejected mounts.
 */
export function validateSandboxMounts(mounts: string[], logPrefix = "[sandbox]"): string[] {
	return mounts.filter((m: string) => {
		const parts = m.split(":");
		if (parts.length < 2) { console.warn(`${logPrefix} Rejecting invalid sandbox mount format: ${m}`); return false; }
		const src = parts[0];
		if (!path.isAbsolute(src)) { console.warn(`${logPrefix} Rejecting non-absolute sandbox mount: ${m}`); return false; }
		if (src.includes("..")) { console.warn(`${logPrefix} Rejecting sandbox mount with "..": ${m}`); return false; }
		if (src.startsWith("~") || src.startsWith("$")) { console.warn(`${logPrefix} Rejecting sandbox mount with variable/home dir: ${m}`); return false; }
		const normalizedSrc = src.replace(/\\/g, "/").toLowerCase();
		for (const blocked of BLOCKED_PATHS) {
			if (normalizedSrc === blocked || normalizedSrc.startsWith(blocked + "/")) {
				console.warn(`${logPrefix} Rejecting sandbox mount to system path: ${m}`);
				return false;
			}
		}
		for (const pat of SENSITIVE_SUBSTRINGS) {
			if (normalizedSrc.includes(pat)) { console.warn(`${logPrefix} Rejecting sandbox mount with sensitive path: ${m}`); return false; }
		}
		if (/^[a-z]:\/?$/i.test(src.replace(/\\/g, "/"))) {
			console.warn(`${logPrefix} Rejecting sandbox mount of drive root: ${m}`);
			return false;
		}
		return true;
	});
}
