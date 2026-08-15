// src/server/extension-host/service-extension-tool-rpc.ts
//
// Closed, core-owned service-tool RPC contract. Pack code can only name a
// registered operation through a ServerHostApi that binds its session and pack.
// This module deliberately contains no paths, endpoints, processes, or transport.

import { isSafeExtensionGrantIdentifier } from "../agent/project-config-store.js";
import type { ServiceState } from "./service-extension-contract.js";

const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_DISCRIMINATOR = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 4_096;
const MAX_ADAPTERS = 64;
const MAX_OPERATIONS_PER_ADAPTER = 32;
const SERVICE_STATES = new Set<ServiceState>(["stopped", "starting", "ready", "unhealthy", "failed"]);

export interface ServiceToolRequest {
	component: string;
	serviceId: string;
	/** Omitted means the server-derived default instance. */
	discriminator?: string;
	/** Closed consumer-owned operation name; never a URL, command, or path. */
	operation: string;
	payload?: unknown;
}

export interface ServiceToolResponse {
	state: ServiceState;
	/** JSON-cloneable, bounded, consumer-validated operation result. */
	value?: unknown;
}

/** The only broker surface injected into a server host. */
export interface ServiceExtensionToolRpc {
	request(input: {
		sessionId: string;
		packId: string;
		request: ServiceToolRequest;
	}): Promise<ServiceToolResponse>;
}

export type ServiceToolRpcErrorCode =
	| "invalid_request"
	| "operation_unavailable"
	| "invalid_payload"
	| "invalid_result"
	| "service_unavailable"
	| "service_not_ready"
	| "overloaded"
	| "cancelled";

const ERROR_MESSAGES: Readonly<Record<ServiceToolRpcErrorCode, string>> = {
	invalid_request: "managed service request is invalid",
	operation_unavailable: "managed service operation is unavailable",
	invalid_payload: "managed service payload is invalid",
	invalid_result: "managed service result is invalid",
	service_unavailable: "managed service is unavailable",
	service_not_ready: "managed service is not ready",
	overloaded: "managed service is busy",
	cancelled: "managed service operation was cancelled",
};

/** Fixed public errors: no service diagnostic, path, process, or transport text. */
export class ServiceToolRpcError extends Error {
	constructor(readonly code: ServiceToolRpcErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.name = "ServiceToolRpcError";
	}
}

export type ServiceToolValueValidator = (value: unknown) => boolean;

/**
 * A core-owned, closed operation vocabulary. Validators are required on both
 * sides so an adapter cannot accidentally turn this into an ambient JSON pipe.
 * The registry intentionally has no consumer registrations in this slice.
 */
export interface ServiceToolOperation {
	validatePayload: ServiceToolValueValidator;
	validateResult: ServiceToolValueValidator;
}

export interface ServiceToolAdapter {
	packId: string;
	serviceId: string;
	discriminator?: string;
	operations: Readonly<Record<string, ServiceToolOperation>>;
}

export interface ResolvedServiceToolOperation {
	adapter: Readonly<ServiceToolAdapter>;
	operation: Readonly<ServiceToolOperation>;
	request: Readonly<ServiceToolRequest>;
}

/**
 * Core-only registry keyed by exact pack/service/discriminator. It registers
 * schemas, not service handles or transports; the coordinator owns execution.
 */
export class ServiceToolAdapterRegistry {
	private readonly adapters = new Map<string, Readonly<ServiceToolAdapter>>();

	register(adapter: ServiceToolAdapter): () => void {
		const normalized = normalizeAdapter(adapter);
		const key = adapterKey(normalized.packId, normalized.serviceId, normalized.discriminator ?? "default");
		if (this.adapters.has(key)) throw new Error("service tool adapter is already registered");
		if (this.adapters.size >= MAX_ADAPTERS) throw new Error("service tool adapter limit reached");
		this.adapters.set(key, normalized);
		return () => {
			if (this.adapters.get(key) === normalized) this.adapters.delete(key);
		};
	}

	resolve(packId: string, request: unknown): ResolvedServiceToolOperation {
		const normalizedRequest = validateServiceToolRequest(request);
		if (!isPlatformIdentifier(packId)) throw new ServiceToolRpcError("operation_unavailable");
		const adapter = this.adapters.get(adapterKey(packId, normalizedRequest.serviceId, normalizedRequest.discriminator ?? "default"));
		const operation = adapter?.operations[normalizedRequest.operation];
		if (!adapter || !operation) throw new ServiceToolRpcError("operation_unavailable");
		return { adapter, operation, request: normalizedRequest };
	}
}

/** Validate and JSON-clone the public request before it reaches a coordinator. */
export function validateServiceToolRequest(input: unknown): ServiceToolRequest {
	if (!isPlainRecord(input) || !hasOnlyKeys(input, new Set(["component", "serviceId", "discriminator", "operation", "payload"]))) {
		throw new ServiceToolRpcError("invalid_request");
	}
	if (!isComponent(input.component) || !isSafeId(input.serviceId) || !isSafeId(input.operation)
		|| (input.discriminator !== undefined && !isDiscriminator(input.discriminator))) {
		throw new ServiceToolRpcError("invalid_request");
	}
	const payload = input.payload === undefined ? undefined : cloneJson(input.payload, "invalid_payload");
	return {
		component: input.component,
		serviceId: input.serviceId,
		discriminator: input.discriminator ?? "default",
		operation: input.operation,
		...(payload === undefined ? {} : { payload }),
	};
}

/** Validate and JSON-clone a coordinator response before it returns to a pack. */
export function validateServiceToolResponse(input: unknown): ServiceToolResponse {
	if (!isPlainRecord(input) || !hasOnlyKeys(input, new Set(["state", "value"]))
		|| typeof input.state !== "string" || !SERVICE_STATES.has(input.state as ServiceState)) {
		throw new ServiceToolRpcError("invalid_result");
	}
	const value = input.value === undefined ? undefined : cloneJson(input.value, "invalid_result");
	return { state: input.state as ServiceState, ...(value === undefined ? {} : { value }) };
}

/** Apply an operation's closed payload schema after exact adapter resolution. */
export function validateServiceToolPayload(operation: ServiceToolOperation, payload: unknown): unknown {
	if (!safeValidate(operation.validatePayload, payload)) throw new ServiceToolRpcError("invalid_payload");
	return payload === undefined ? undefined : cloneJson(payload, "invalid_payload");
}

/** Apply an operation's closed result schema and clone it for the caller. */
export function validateServiceToolResult(operation: ServiceToolOperation, value: unknown): unknown {
	const cloned = value === undefined ? undefined : cloneJson(value, "invalid_result");
	if (!safeValidate(operation.validateResult, cloned)) throw new ServiceToolRpcError("invalid_result");
	return cloned;
}

export interface ServiceToolSchedulerOptions {
	/** Bounded global operation count. Defaults to 4, maximum 16. */
	maxConcurrent?: number;
	/** Bounded pending FIFO depth for one exact service instance. Defaults to 32. */
	maxQueuedPerInstance?: number;
	/** Bounded pending depth across all service instances. Defaults to 256. */
	maxQueuedTotal?: number;
}

interface ScheduledOperation<T> {
	fence: number;
	run: (signal: AbortSignal) => Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
}

/**
 * Coordinator-facing bounded scheduler. Keys are server-derived full instance
 * keys; callers cannot use it through the host API. `invalidate()` fences both
 * pending work and the AbortSignal supplied to active core adapters.
 */
export class ServiceToolOperationScheduler {
	private readonly queues = new Map<string, ScheduledOperation<unknown>[]>();
	private readonly fences = new Map<string, number>();
	private readonly active = new Map<string, Set<AbortController>>();
	private readonly maxConcurrent: number;
	private readonly maxQueuedPerInstance: number;
	private readonly maxQueuedTotal: number;
	private running = 0;
	private queued = 0;
	private closed = false;

	constructor(options: ServiceToolSchedulerOptions = {}) {
		this.maxConcurrent = boundedOption(options.maxConcurrent, 4, 1, 16);
		this.maxQueuedPerInstance = boundedOption(options.maxQueuedPerInstance, 32, 1, 64);
		this.maxQueuedTotal = boundedOption(options.maxQueuedTotal, 256, 1, 512);
	}

	run<T>(instanceKey: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject(new ServiceToolRpcError("service_unavailable"));
		if (!isSchedulerKey(instanceKey) || typeof task !== "function") return Promise.reject(new ServiceToolRpcError("invalid_request"));
		const queue = this.queues.get(instanceKey) ?? [];
		if (queue.length >= this.maxQueuedPerInstance || this.queued >= this.maxQueuedTotal) {
			return Promise.reject(new ServiceToolRpcError("overloaded"));
		}
		return new Promise<T>((resolve, reject) => {
			queue.push({ fence: this.fence(instanceKey), run: task, resolve, reject } as ScheduledOperation<unknown>);
			this.queues.set(instanceKey, queue);
			this.queued++;
			this.drain();
		});
	}

	/** Fence one exact instance after its lifecycle changes or service is removed. */
	invalidate(instanceKey: string): void {
		if (!isSchedulerKey(instanceKey)) return;
		this.fences.set(instanceKey, this.fence(instanceKey) + 1);
		const queued = this.queues.get(instanceKey);
		if (queued) {
			this.queues.delete(instanceKey);
			this.queued -= queued.length;
			for (const job of queued) job.reject(new ServiceToolRpcError("cancelled"));
		}
		for (const controller of this.active.get(instanceKey) ?? []) controller.abort();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const key of [...this.queues.keys(), ...this.active.keys()]) this.invalidate(key);
	}

	private drain(): void {
		while (!this.closed && this.running < this.maxConcurrent) {
			const next = this.next();
			if (!next) return;
			this.start(next.key, next.job);
		}
	}

	private next(): { key: string; job: ScheduledOperation<unknown> } | undefined {
		for (const [key, queue] of this.queues) {
			const job = queue.shift();
			if (!job) continue;
			this.queued--;
			if (queue.length === 0) this.queues.delete(key);
			else {
				// Rotate this queue behind its peers so one hot instance cannot monopolise slots.
				this.queues.delete(key);
				this.queues.set(key, queue);
			}
			return { key, job };
		}
		return undefined;
	}

	private start(key: string, job: ScheduledOperation<unknown>): void {
		if (job.fence !== this.fence(key)) {
			job.reject(new ServiceToolRpcError("cancelled"));
			this.drain();
			return;
		}
		this.running++;
		const controller = new AbortController();
		const active = this.active.get(key) ?? new Set<AbortController>();
		active.add(controller);
		this.active.set(key, active);
		void Promise.resolve().then(() => job.run(controller.signal)).then(
			value => {
				if (controller.signal.aborted || job.fence !== this.fence(key)) job.reject(new ServiceToolRpcError("cancelled"));
				else job.resolve(value);
			},
			error => job.reject(controller.signal.aborted || job.fence !== this.fence(key) ? new ServiceToolRpcError("cancelled") : error),
		).finally(() => {
			this.running--;
			active.delete(controller);
			if (active.size === 0) this.active.delete(key);
			this.drain();
		});
	}

	private fence(key: string): number {
		return this.fences.get(key) ?? 0;
	}
}

function normalizeAdapter(adapter: ServiceToolAdapter): Readonly<ServiceToolAdapter> {
	if (!isPlainRecord(adapter) || !isPlatformIdentifier(adapter.packId) || !isSafeId(adapter.serviceId)
		|| (adapter.discriminator !== undefined && !isDiscriminator(adapter.discriminator))
		|| !isPlainRecord(adapter.operations)) {
		throw new Error("invalid service tool adapter");
	}
	const operations = Object.entries(adapter.operations);
	if (operations.length === 0 || operations.length > MAX_OPERATIONS_PER_ADAPTER) throw new Error("invalid service tool adapter operations");
	const out: Record<string, ServiceToolOperation> = {};
	for (const [name, operation] of operations) {
		if (!isSafeId(name) || !isPlainRecord(operation) || typeof operation.validatePayload !== "function" || typeof operation.validateResult !== "function") {
			throw new Error("invalid service tool operation");
		}
		out[name] = Object.freeze({ validatePayload: operation.validatePayload, validateResult: operation.validateResult });
	}
	return Object.freeze({
		packId: adapter.packId,
		serviceId: adapter.serviceId,
		discriminator: adapter.discriminator ?? "default",
		operations: Object.freeze(out),
	});
}

function adapterKey(packId: string, serviceId: string, discriminator: string): string {
	return `${packId}\0${serviceId}\0${discriminator}`;
}

function cloneJson(value: unknown, errorCode: "invalid_payload" | "invalid_result"): unknown {
	assertJson(value, 0, { nodes: 0 }, errorCode);
	let json: string;
	try { json = JSON.stringify(value); } catch { throw new ServiceToolRpcError(errorCode); }
	if (json === undefined || Buffer.byteLength(json, "utf8") > MAX_JSON_BYTES) throw new ServiceToolRpcError(errorCode);
	try { return JSON.parse(json) as unknown; } catch { throw new ServiceToolRpcError(errorCode); }
}

function assertJson(value: unknown, depth: number, state: { nodes: number }, errorCode: "invalid_payload" | "invalid_result"): void {
	if (++state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new ServiceToolRpcError(errorCode);
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (Number.isFinite(value)) return;
		throw new ServiceToolRpcError(errorCode);
	}
	if (typeof value !== "object") throw new ServiceToolRpcError(errorCode);
	if (Array.isArray(value)) {
		for (const item of value) assertJson(item, depth + 1, state, errorCode);
		return;
	}
	if (!isPlainRecord(value)) throw new ServiceToolRpcError(errorCode);
	for (const [key, child] of Object.entries(value)) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") throw new ServiceToolRpcError(errorCode);
		assertJson(child, depth + 1, state, errorCode);
	}
}

function safeValidate(validator: ServiceToolValueValidator, value: unknown): boolean {
	try { return validator(value) === true; } catch { return false; }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every(key => allowed.has(key));
}

function isSafeId(value: unknown): value is string {
	return typeof value === "string" && SAFE_ID.test(value);
}

function isPlatformIdentifier(value: unknown): value is string {
	return isSafeExtensionGrantIdentifier(value);
}

function isComponent(value: unknown): value is string {
	return value === "." || isPlatformIdentifier(value);
}

function isDiscriminator(value: unknown): value is string {
	return typeof value === "string" && SAFE_DISCRIMINATOR.test(value);
}

function boundedOption(value: number | undefined, fallback: number, min: number, max: number): number {
	return value === undefined ? fallback : Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function isSchedulerKey(value: string): boolean {
	return value.length > 0 && value.length <= 2_048 && !value.includes("\n") && !value.includes("\r");
}
