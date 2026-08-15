import { describe, expect, it } from "vitest";
import {
	isServiceInstanceDiscriminator,
	isServiceInstancePublicRef,
	isServiceStateTransitionAllowed,
	normalizeServiceStatus,
	redactServiceDiagnostic,
	validateServiceExtensionSpec,
} from "../../src/server/extension-host/service-extension-contract.ts";

const valid = {
	id: "hindsight",
	runMode: "local",
	readiness: { url: "http://127.0.0.1:8080/health", timeoutMs: 500 },
	stopGraceMs: 500,
	restart: "on-failure",
	ports: [8080],
	dataDir: "hindsight/data",
};

const ref = {
	projectId: "project-a",
	component: ".",
	worktreeKey: "1234567890123456789012",
	packId: "pack",
	serviceId: "hindsight",
	discriminator: "default",
};

describe("service extension contract", () => {
	it("accepts a closed, bounded local declaration and copies it", () => {
		const result = validateServiceExtensionSpec(valid);
		expect(result).toMatchObject({ ok: true, value: valid });
		if (result.ok) {
			expect(result.value).not.toBe(valid);
			expect(result.value.ports).not.toBe(valid.ports);
		}
	});

	it("rejects unknown keys, unsafe paths/ports, and shell-shaped probes", () => {
		for (const declaration of [
			{ ...valid, extra: true },
			{ ...valid, id: "../escape" },
			{ ...valid, ports: [8080, 8080] },
			{ ...valid, ports: [0] },
			{ ...valid, dataDir: "../escape" },
			{ ...valid, readiness: { url: "https://example.test/health", timeoutMs: 500 } },
			{ ...valid, readiness: { command: "curl x; rm -rf /", timeoutMs: 500 } },
			{ ...valid, readiness: { url: "http://127.0.0.1:8080", command: "check", timeoutMs: 500 } },
			{ ...valid, stopGraceMs: 60_001 },
		]) expect(validateServiceExtensionSpec(declaration).ok).toBe(false);
	});

	it("validates bounded path-free public identities", () => {
		expect(isServiceInstanceDiscriminator("typescript")).toBe(true);
		expect(isServiceInstanceDiscriminator("A".repeat(33))).toBe(false);
		expect(isServiceInstanceDiscriminator("../escape")).toBe(false);
		expect(isServiceInstancePublicRef(ref)).toBe(true);
		expect(isServiceInstancePublicRef({ ...ref, canonicalWorktreeRoot: "/host/repo" })).toBe(false);
		expect(isServiceInstancePublicRef({ ...ref, worktreeKey: "/host/repo" })).toBe(false);
	});

	it("normalizes a path-free public status enum and never preserves arbitrary detail", () => {
		const status = normalizeServiceStatus({ ref, state: "ready", updatedAt: "2026-01-01T00:00:00.000Z" });
		expect(status).toEqual({ ref, state: "ready", updatedAt: "2026-01-01T00:00:00.000Z" });
		expect(JSON.stringify(status)).not.toContain("canonicalWorktreeRoot");
		expect(normalizeServiceStatus({ ref, state: "ready", updatedAt: "2026-01-01T00:00:00.000Z", detail: "api-key=secret" })).toBeUndefined();
		expect(isServiceStateTransitionAllowed("ready", "failed")).toBe(true);
		expect(isServiceStateTransitionAllowed("stopped", "ready")).toBe(false);
	});

	it("redacts known secret values and bounds diagnostic text", () => {
		const result = redactServiceDiagnostic(new Error(`failed with token-${"x".repeat(600)}`), [`token-${"x".repeat(600)}`]);
		expect(result).not.toContain("token-");
		expect(result).toContain("[REDACTED]");
		expect(result.length).toBeLessThanOrEqual(512);
	});
});
