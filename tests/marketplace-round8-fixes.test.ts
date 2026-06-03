/**
 * Round-8 security fixes:
 *  1. HIGH — token-as-username URLs (`https://ghp_xxx@host/repo.git`) are now
 *     scrubbed: `gitUrlSecrets()` returns `parsed.username`, so
 *     `redactGitUrlInText` removes the token even when git reformats the url in
 *     its stderr (trailing slash, decoded, scheme-less).
 *  2. MED — `sources.json` is written with mode 0o600 (it stores original git
 *     URLs WITH embedded credentials), with a guarded chmod that does not throw
 *     on platforms/filesystems that ignore POSIX modes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { gitUrlSecrets, redactGitUrl, redactGitUrlInText } =
	await import("../src/server/marketplace/git-url-redact.ts");
const { SourceRegistry, redactSourceUrl } = await import("../src/server/marketplace/source-registry.ts");

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-market-r8-"));
}

// ── Fix 1: token-as-username redaction ───────────────────────────────────────

describe("marketplace fix: token-as-username is redacted", () => {
	const url = "https://ghp_SECRET@github.com/acme/packs.git";

	it("gitUrlSecrets() includes the username token", () => {
		assert.ok(gitUrlSecrets(url).includes("ghp_SECRET"));
	});

	it("redactGitUrl() strips the userinfo (no token in the displayed url)", () => {
		const out = redactGitUrl(url);
		assert.equal(out, "https://github.com/acme/packs.git");
		assert.ok(!out.includes("ghp_SECRET"));
	});

	it("redactGitUrlInText() scrubs the token even when git reformats the url", () => {
		// git rewrites the url in stderr: decoded, trailing slash, no scheme, etc.
		const stderr =
			"fatal: unable to access 'https://ghp_SECRET@github.com/acme/packs.git/': " +
			"The requested URL returned error: 403 for ghp_SECRET@github.com";
		const out = redactGitUrlInText(stderr, url);
		assert.ok(!out.includes("ghp_SECRET"), `token leaked: ${out}`);
	});

	it("redactSourceUrl() returns a DTO without the token", () => {
		const reg = new SourceRegistry(tmp());
		const rec = reg.add({ kind: "git", url });
		assert.ok(!String(redactSourceUrl(rec).url).includes("ghp_SECRET"));
	});
});

// ── Fix 2: sources.json written 0o600 ────────────────────────────────────────

describe("marketplace fix: sources.json is owner-only (0o600)", () => {
	it("applies 0o600 where supported and does not throw on platforms that ignore it", () => {
		const stateDir = tmp();
		const reg = new SourceRegistry(stateDir);
		// add() persists — must not throw on any platform.
		reg.add({ kind: "git", url: "https://ghp_SECRET@github.com/acme/packs.git" });

		const file = path.join(stateDir, "marketplace", "sources.json");
		assert.ok(fs.existsSync(file));

		// On POSIX filesystems the mode must be exactly owner read/write. Windows
		// and some filesystems ignore POSIX modes, so only assert there.
		if (process.platform !== "win32") {
			const mode = fs.statSync(file).mode & 0o777;
			assert.equal(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
		}
	});

	it("preserves the credential-bearing url on disk (git needs it to auth)", () => {
		const stateDir = tmp();
		const reg = new SourceRegistry(stateDir);
		reg.add({ kind: "git", url: "https://ghp_SECRET@github.com/acme/packs.git" });
		const file = path.join(stateDir, "marketplace", "sources.json");
		const onDisk = fs.readFileSync(file, "utf-8");
		assert.ok(onDisk.includes("ghp_SECRET"), "stored url must keep its credentials for git auth");
	});
});
