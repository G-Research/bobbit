import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface OperatorConfirmationBinding {
	purpose: string;
	binding: string;
}

export interface OperatorConfirmationPermit extends OperatorConfirmationBinding {
	expiresAt: number;
}

const DEFAULT_TTL_MS = 2 * 60 * 1000;
const permits = new Map<string, OperatorConfirmationPermit>();

function pruneExpired(now: number): void {
	for (const [token, permit] of permits) {
		if (now > permit.expiresAt) permits.delete(token);
	}
}

export function mintOperatorConfirmation(
	input: OperatorConfirmationBinding,
	opts?: { ttlMs?: number; now?: () => number },
): { token: string; expiresAt: number } {
	const clock = opts?.now ?? Date.now;
	const now = clock();
	pruneExpired(now);
	const ttl = opts?.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
	const token = randomBytes(32).toString("base64url");
	const expiresAt = now + ttl;
	permits.set(token, { purpose: input.purpose, binding: input.binding, expiresAt });
	return { token, expiresAt };
}

export function consumeOperatorConfirmation(
	token: unknown,
	input: OperatorConfirmationBinding,
	opts?: { now?: () => number },
): boolean {
	if (typeof token !== "string" || token.length === 0) return false;
	const clock = opts?.now ?? Date.now;
	const now = clock();
	pruneExpired(now);
	const permit = permits.get(token);
	if (!permit) return false;
	permits.delete(token);
	if (now > permit.expiresAt) return false;
	return safeEqual(permit.purpose, input.purpose) && safeEqual(permit.binding, input.binding);
}

export function stableConfirmationBinding(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function __resetOperatorConfirmationsForTests(): void {
	permits.clear();
}
