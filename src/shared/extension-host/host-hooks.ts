import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Runtime and type-level source of truth for Extension Host lifecycle hooks. */

export const HOST_HOOK_LIMITS = Object.freeze({
	identifierLength: 256,
	nameLength: 128,
	shortTextLength: 512,
	textLength: 16_384,
	jsonStringLength: 8_192,
	arrayItems: 64,
	contextContributions: 16,
	changedIdentifiers: 16,
	objectProperties: 64,
	jsonDepth: 8,
	jsonNodes: 1_024,
	payloadBytes: 32 * 1_024,
	interceptorBytes: 128 * 1_024,
	filterFields: 8,
	filterBytes: 2 * 1_024,
} as const);

export type HostHookScope = "session" | "project";
export type HostConsumerKind = "browser" | "module" | "staff" | "diagnostic";
export type HostNotificationPrivacy = "public-metadata" | "project-metadata";
export type HostInterceptorFailurePolicy = "failOpen" | "failClosed" | "nonFatal";

const IDENTIFIER_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:/@+\\-]*$";
const SAFE_KEY_PATTERN = "^[A-Za-z][A-Za-z0-9._-]*$";
const RELATIVE_COORDINATE_PATTERN = "^(?![A-Za-z]:[\\\\/])(?![\\\\/])(?!.*(?:^|[\\\\/])\\.\\.(?:[\\\\/]|$))[^\\u0000]+$";

const IdentifierSchema = Type.String({
	minLength: 1,
	maxLength: HOST_HOOK_LIMITS.identifierLength,
	pattern: IDENTIFIER_PATTERN,
});
const NameSchema = Type.String({
	minLength: 1,
	maxLength: HOST_HOOK_LIMITS.nameLength,
	pattern: SAFE_KEY_PATTERN,
});
const ShortTextSchema = Type.String({ maxLength: HOST_HOOK_LIMITS.shortTextLength });
const TextSchema = Type.String({ maxLength: HOST_HOOK_LIMITS.textLength });
const NonNegativeIntegerSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const NonNegativeNumberSchema = Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const RevisionSchema = Type.Union([
	Type.String({ minLength: 1, maxLength: HOST_HOOK_LIMITS.identifierLength }),
	NonNegativeNumberSchema,
]);

function literals<const V extends readonly [string, ...string[]]>(values: V) {
	return Type.Union(values.map((value) => Type.Literal(value)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]]);
}

const SessionStatusSchema = literals(["starting", "preparing", "idle", "streaming", "aborting", "terminated"] as const);
const PromptSourceSchema = literals([
	"user",
	"auto-nudge",
	"task-notification",
	"verification",
	"system",
	"agent",
	"child-complete",
	"extension",
] as const);
const GoalStateSchema = literals(["todo", "in-progress", "complete", "shelved", "blocked"] as const);
const TaskStateSchema = literals(["todo", "in-progress", "blocked", "complete", "skipped"] as const);
const GateStatusSchema = literals(["pending", "passed", "failed", "bypassed"] as const);
const StaffStateSchema = literals(["active", "paused", "retired"] as const);
const MessageRoleSchema = literals(["user", "assistant", "system"] as const);
const ContentBlockKindSchema = literals(["text", "tool_use", "tool_result"] as const);
const ToolCallStatusSchema = literals(["succeeded", "errored"] as const);
const ToolErrorStatusSchema = literals(["timeout", "denied", "handler_error", "invalid_result", "cancelled"] as const);
const TurnOutcomeSchema = literals(["succeeded", "errored", "aborted"] as const);
const SessionKindSchema = literals(["general", "assistant", "goal", "team", "delegate", "staff", "child"] as const);
const SessionArchiveReasonSchema = literals(["user", "goal_archived", "project_deleted", "retired", "cleanup"] as const);
const ForkModeSchema = literals(["whole", "history"] as const);
const PullRequestStateSchema = literals(["OPEN", "CLOSED", "MERGED"] as const);
const ReviewDecisionSchema = literals(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"] as const);
const MergeabilitySchema = literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"] as const);
const SettingsTargetSchema = literals(["project", "component", "workflow", "pack", "sandbox", "provider"] as const);

function strictObject<P extends Record<string, TSchema>>(properties: P) {
	return Type.Object(properties, { additionalProperties: false });
}

function sortedUniqueArray<T extends TSchema>(items: T, maxItems: number = HOST_HOOK_LIMITS.changedIdentifiers) {
	return Type.Array(items, { maxItems, uniqueItems: true });
}

const StaffChangedFieldSchema = literals([
	"name", "description", "systemPrompt", "state", "triggers", "roleId", "accessory", "contextPolicy",
] as const);
const GoalChangedFieldSchema = literals([
	"title", "spec", "state", "workflow", "metadata", "team", "paused", "divergencePolicy", "maxConcurrentChildren",
] as const);
const TaskChangedFieldSchema = literals([
	"title", "type", "assignedSessionId", "spec", "parentTaskId", "dependsOn", "workflowGateId", "inputGateIds", "resultSummary", "headSha",
] as const);
const SettingsChangedKeySchema = literals([
	"components", "workflows", "configDirectories", "sandbox", "sandboxTokens", "packOrder", "packActivation", "commands", "providers", "models",
] as const);

const StatusChangedPayloadSchema = strictObject({
	previousStatus: SessionStatusSchema,
	status: SessionStatusSchema,
	statusVersion: NonNegativeIntegerSchema,
});
const TurnStartedPayloadSchema = strictObject({
	turnIndex: NonNegativeIntegerSchema,
	source: PromptSourceSchema,
});
const TurnCompletedPayloadSchema = strictObject({
	turnIndex: NonNegativeIntegerSchema,
	outcome: TurnOutcomeSchema,
	durationMs: NonNegativeNumberSchema,
	hadToolCalls: Type.Boolean(),
});
const MessageAppendedPayloadSchema = strictObject({
	messageId: IdentifierSchema,
	cursor: RevisionSchema,
	role: MessageRoleSchema,
	blockKinds: sortedUniqueArray(ContentBlockKindSchema, 8),
});
const ToolCallStartedPayloadSchema = strictObject({
	toolCallId: IdentifierSchema,
	toolName: NameSchema,
	turnIndex: NonNegativeIntegerSchema,
});
const ToolCallCompletedPayloadSchema = strictObject({
	toolCallId: IdentifierSchema,
	toolName: NameSchema,
	status: ToolCallStatusSchema,
	durationMs: NonNegativeNumberSchema,
	errorStatus: Type.Optional(ToolErrorStatusSchema),
});
const SessionCreatedPayloadSchema = strictObject({
	sessionId: IdentifierSchema,
	kind: SessionKindSchema,
	goalId: Type.Optional(IdentifierSchema),
});
const SessionArchivedPayloadSchema = strictObject({
	sessionId: IdentifierSchema,
	reason: SessionArchiveReasonSchema,
});
const SessionForkedPayloadSchema = strictObject({
	sourceSessionId: IdentifierSchema,
	sessionId: IdentifierSchema,
	cutEntryId: Type.Optional(IdentifierSchema),
	forkMode: ForkModeSchema,
});
const SessionStatusChangedPayloadSchema = strictObject({
	sessionId: IdentifierSchema,
	previousStatus: SessionStatusSchema,
	status: SessionStatusSchema,
	statusVersion: NonNegativeIntegerSchema,
});
const StaffCreatedPayloadSchema = strictObject({
	staffId: IdentifierSchema,
	state: StaffStateSchema,
	sessionId: Type.Optional(IdentifierSchema),
});
const StaffConfigChangedPayloadSchema = strictObject({
	staffId: IdentifierSchema,
	changedFields: sortedUniqueArray(StaffChangedFieldSchema),
});
const StaffRetiredPayloadSchema = strictObject({ staffId: IdentifierSchema });
const StaffSessionChangedPayloadSchema = strictObject({
	staffId: IdentifierSchema,
	previousSessionId: Type.Optional(IdentifierSchema),
	sessionId: Type.Optional(IdentifierSchema),
});
const GoalCreatedPayloadSchema = strictObject({
	goalId: IdentifierSchema,
	parentGoalId: Type.Optional(IdentifierSchema),
	state: GoalStateSchema,
});
const GoalUpdatedPayloadSchema = strictObject({
	goalId: IdentifierSchema,
	state: GoalStateSchema,
	changedFields: sortedUniqueArray(GoalChangedFieldSchema),
});
const GoalCompletedPayloadSchema = strictObject({
	goalId: IdentifierSchema,
	parentGoalId: Type.Optional(IdentifierSchema),
});
const GoalArchivedPayloadSchema = strictObject({ goalId: IdentifierSchema });
const TaskCreatedPayloadSchema = strictObject({
	taskId: IdentifierSchema,
	goalId: IdentifierSchema,
	type: NameSchema,
	state: TaskStateSchema,
	parentTaskId: Type.Optional(IdentifierSchema),
});
const TaskUpdatedPayloadSchema = strictObject({
	taskId: IdentifierSchema,
	goalId: IdentifierSchema,
	state: TaskStateSchema,
	changedFields: sortedUniqueArray(TaskChangedFieldSchema),
});
const TaskStateChangedPayloadSchema = strictObject({
	taskId: IdentifierSchema,
	goalId: IdentifierSchema,
	previousState: TaskStateSchema,
	state: TaskStateSchema,
});
const GateStatusChangedPayloadSchema = strictObject({
	gateId: IdentifierSchema,
	goalId: IdentifierSchema,
	previousStatus: GateStatusSchema,
	status: GateStatusSchema,
});
const PullRequestStatusChangedPayloadSchema = strictObject({
	goalId: IdentifierSchema,
	number: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
	state: PullRequestStateSchema,
	reviewDecision: Type.Optional(ReviewDecisionSchema),
	mergeability: Type.Optional(MergeabilitySchema),
});
const SettingsChangedPayloadSchema = strictObject({
	target: SettingsTargetSchema,
	changedKeys: sortedUniqueArray(SettingsChangedKeySchema),
});

export interface HostNotificationDefinition<
	N extends string,
	S extends HostHookScope,
	P extends TSchema,
	K extends string = string,
> {
	readonly name: N;
	readonly scope: S;
	readonly payloadVersion: 1;
	readonly payloadSchema: P;
	readonly boundary: string;
	readonly aggregateKind: K;
	readonly revisionSource: string;
	readonly filterFields: Readonly<Record<string, TSchema>>;
	readonly consumers: ReadonlySet<HostConsumerKind>;
	readonly privacy: HostNotificationPrivacy;
	readonly delivery: Readonly<{
		browser: "live" | "none";
		module: "live" | "none";
		staff: "durable-intent" | "none";
	}>;
}

const ALL_CONSUMERS: ReadonlySet<HostConsumerKind> = new Set(["browser", "module", "staff", "diagnostic"]);
const STANDARD_DELIVERY = Object.freeze({ browser: "live", module: "live", staff: "durable-intent" } as const);

function notificationDefinition<
	const N extends string,
	const S extends HostHookScope,
	const P extends TSchema,
	const K extends string,
>(definition: HostNotificationDefinition<N, S, P, K>): HostNotificationDefinition<N, S, P, K> {
	return Object.freeze(definition);
}

function notification<
	const N extends string,
	const S extends HostHookScope,
	const P extends TSchema,
	const K extends string,
>(options: {
	name: N;
	scope: S;
	payloadSchema: P;
	boundary: string;
	aggregateKind: K;
	revisionSource: string;
	filterFields?: Readonly<Record<string, TSchema>>;
	privacy?: HostNotificationPrivacy;
}): HostNotificationDefinition<N, S, P, K> {
	return notificationDefinition({
		...options,
		payloadVersion: 1,
		filterFields: Object.freeze({ ...(options.filterFields ?? {}) }),
		consumers: ALL_CONSUMERS,
		privacy: options.privacy ?? "project-metadata",
		delivery: STANDARD_DELIVERY,
	});
}

export const HOST_NOTIFICATION_CATALOGUE = Object.freeze({
	statusChanged: notification({ name: "statusChanged", scope: "session", payloadSchema: StatusChangedPayloadSchema, boundary: "session-status.broadcastStatus.afterLegacyFrameQueued", aggregateKind: "session", revisionSource: "statusVersion", filterFields: { status: SessionStatusSchema } }),
	turnStarted: notification({ name: "turnStarted", scope: "session", payloadSchema: TurnStartedPayloadSchema, boundary: "session-manager.handleAgentLifecycle.canonicalAgentStart", aggregateKind: "turn", revisionSource: "turnIndex", filterFields: { source: PromptSourceSchema } }),
	turnCompleted: notification({ name: "turnCompleted", scope: "session", payloadSchema: TurnCompletedPayloadSchema, boundary: "session-manager.handleAgentLifecycle.finalAgentEnd", aggregateKind: "turn", revisionSource: "completedTurnIndex", filterFields: { outcome: TurnOutcomeSchema, hadToolCalls: Type.Boolean() } }),
	messageAppended: notification({ name: "messageAppended", scope: "session", payloadSchema: MessageAppendedPayloadSchema, boundary: "session-manager.emitSessionEvent.acceptedMessageEnd", aggregateKind: "message", revisionSource: "eventBufferCursor", filterFields: { role: MessageRoleSchema } }),
	toolCallStarted: notification({ name: "toolCallStarted", scope: "session", payloadSchema: ToolCallStartedPayloadSchema, boundary: "session-manager.toolExecutionStart.afterAdmission", aggregateKind: "toolCall", revisionSource: "toolCallStartCursor", filterFields: { toolName: NameSchema } }),
	toolCallCompleted: notification({ name: "toolCallCompleted", scope: "session", payloadSchema: ToolCallCompletedPayloadSchema, boundary: "session-manager.acceptedToolResultMessageEnd", aggregateKind: "toolCall", revisionSource: "resultMessageCursor", filterFields: { toolName: NameSchema, status: ToolCallStatusSchema, errorStatus: ToolErrorStatusSchema } }),
	sessionCreated: notification({ name: "sessionCreated", scope: "project", payloadSchema: SessionCreatedPayloadSchema, boundary: "session-manager.notifySessionCreated.afterStrictPersistence", aggregateKind: "session", revisionSource: "session.updatedAt", filterFields: { kind: SessionKindSchema } }),
	sessionArchived: notification({ name: "sessionArchived", scope: "project", payloadSchema: SessionArchivedPayloadSchema, boundary: "session-store.archiveAsync.afterCommit", aggregateKind: "session", revisionSource: "session.archivedAt", filterFields: { reason: SessionArchiveReasonSchema } }),
	sessionForked: notification({ name: "sessionForked", scope: "project", payloadSchema: SessionForkedPayloadSchema, boundary: "server.historyFork.afterMaterialisation", aggregateKind: "session", revisionSource: "destinationSession.updatedAt", filterFields: { forkMode: ForkModeSchema } }),
	sessionStatusChanged: notification({ name: "sessionStatusChanged", scope: "project", payloadSchema: SessionStatusChangedPayloadSchema, boundary: "session-status.broadcastStatus.afterLegacyFrameQueued", aggregateKind: "session", revisionSource: "statusVersion", filterFields: { status: SessionStatusSchema } }),
	staffCreated: notification({ name: "staffCreated", scope: "project", payloadSchema: StaffCreatedPayloadSchema, boundary: "staff-manager.createStaff.afterDurableAcceptance", aggregateKind: "staff", revisionSource: "staff.updatedAt", filterFields: { state: StaffStateSchema } }),
	staffConfigChanged: notification({ name: "staffConfigChanged", scope: "project", payloadSchema: StaffConfigChangedPayloadSchema, boundary: "staff-manager.updateStaff.afterStrictCommit", aggregateKind: "staff", revisionSource: "staff.updatedAt" }),
	staffRetired: notification({ name: "staffRetired", scope: "project", payloadSchema: StaffRetiredPayloadSchema, boundary: "staff-manager.retire.afterStrictCommit", aggregateKind: "staff", revisionSource: "staff.updatedAt" }),
	staffSessionChanged: notification({ name: "staffSessionChanged", scope: "project", payloadSchema: StaffSessionChangedPayloadSchema, boundary: "staff-manager.commitCurrentSession.afterStrictCommit", aggregateKind: "staff", revisionSource: "staff.updatedAt" }),
	goalCreated: notification({ name: "goalCreated", scope: "project", payloadSchema: GoalCreatedPayloadSchema, boundary: "goal-store.create.afterStrictPublication", aggregateKind: "goal", revisionSource: "goal.updatedAt", filterFields: { state: GoalStateSchema } }),
	goalUpdated: notification({ name: "goalUpdated", scope: "project", payloadSchema: GoalUpdatedPayloadSchema, boundary: "goal-store.updateStrict.afterPublication", aggregateKind: "goal", revisionSource: "goal.updatedAt", filterFields: { state: GoalStateSchema } }),
	goalCompleted: notification({ name: "goalCompleted", scope: "project", payloadSchema: GoalCompletedPayloadSchema, boundary: "goal-manager.complete.afterStrictPublication", aggregateKind: "goal", revisionSource: "goal.updatedAt" }),
	goalArchived: notification({ name: "goalArchived", scope: "project", payloadSchema: GoalArchivedPayloadSchema, boundary: "goal-store.archiveStrict.afterPublication", aggregateKind: "goal", revisionSource: "goal.archivedAt" }),
	taskCreated: notification({ name: "taskCreated", scope: "project", payloadSchema: TaskCreatedPayloadSchema, boundary: "task-manager.createTask.afterStrictPublication", aggregateKind: "task", revisionSource: "task.updatedAt", filterFields: { type: NameSchema, state: TaskStateSchema } }),
	taskUpdated: notification({ name: "taskUpdated", scope: "project", payloadSchema: TaskUpdatedPayloadSchema, boundary: "task-manager.updateTask.afterStrictPublication", aggregateKind: "task", revisionSource: "task.updatedAt", filterFields: { state: TaskStateSchema } }),
	taskStateChanged: notification({ name: "taskStateChanged", scope: "project", payloadSchema: TaskStateChangedPayloadSchema, boundary: "task-manager.stateTransition.afterStrictPublication", aggregateKind: "task", revisionSource: "task.updatedAt", filterFields: { previousState: TaskStateSchema, state: TaskStateSchema } }),
	gateStatusChanged: notification({ name: "gateStatusChanged", scope: "project", payloadSchema: GateStatusChangedPayloadSchema, boundary: "gate-store.statusSummary.afterStrictPersistence", aggregateKind: "gate", revisionSource: "gate.statusRevision", filterFields: { status: GateStatusSchema } }),
	pullRequestStatusChanged: notification({ name: "pullRequestStatusChanged", scope: "project", payloadSchema: PullRequestStatusChangedPayloadSchema, boundary: "pr-status-store.set.afterAtomicPersistence", aggregateKind: "pullRequest", revisionSource: "provider.updatedAt|safeProjectionSha256", filterFields: { state: PullRequestStateSchema, reviewDecision: ReviewDecisionSchema, mergeability: MergeabilitySchema } }),
	settingsChanged: notification({ name: "settingsChanged", scope: "project", payloadSchema: SettingsChangedPayloadSchema, boundary: "project-config-store.mutate.afterAtomicRename", aggregateKind: "settings", revisionSource: "committedConfigSha256", filterFields: { target: SettingsTargetSchema } }),
} as const);

export type HostNotificationName = keyof typeof HOST_NOTIFICATION_CATALOGUE;
export type HostNotificationScope<N extends HostNotificationName> = (typeof HOST_NOTIFICATION_CATALOGUE)[N]["scope"];
export type HostNotificationAggregateKind<N extends HostNotificationName> = (typeof HOST_NOTIFICATION_CATALOGUE)[N]["aggregateKind"];
export type HostNotificationPayload<N extends HostNotificationName> = Static<(typeof HOST_NOTIFICATION_CATALOGUE)[N]["payloadSchema"]>;
export type SessionNotificationName = {
	[N in HostNotificationName]: HostNotificationScope<N> extends "session" ? N : never;
}[HostNotificationName];
export type ProjectNotificationName = {
	[N in HostNotificationName]: HostNotificationScope<N> extends "project" ? N : never;
}[HostNotificationName];

export interface HostNotification<N extends HostNotificationName = HostNotificationName> {
	readonly id: string;
	readonly scope: HostNotificationScope<N>;
	readonly name: N;
	readonly payloadVersion: number;
	readonly occurredAt: number;
	readonly projectId: string;
	readonly sessionId?: string;
	readonly aggregate: Readonly<{
		kind: HostNotificationAggregateKind<N>;
		id: string;
		revision?: string | number;
	}>;
	readonly correlationId?: string;
	readonly causationId?: string;
	readonly payload: Readonly<HostNotificationPayload<N>>;
}

export interface HostNotificationBuildInput<N extends HostNotificationName> {
	readonly id: string;
	readonly occurredAt: number;
	readonly projectId: string;
	readonly sessionId?: string;
	readonly aggregateId: string;
	readonly aggregateRevision: string | number;
	readonly correlationId?: string;
	readonly causationId?: string;
	readonly payload: HostNotificationPayload<N>;
}

export type HostNotificationFilter = Readonly<Record<string, string | number | boolean>>;
export type HostNotificationFilterValidation =
	| { ok: true; filter: HostNotificationFilter }
	| { ok: false; code: "UNKNOWN_NOTIFICATION" | "INELIGIBLE_CONSUMER" | "UNKNOWN_FILTER_FIELD" | "INVALID_FILTER_VALUE" | "FILTER_TOO_LARGE" };

export function isHostNotificationName(value: unknown): value is HostNotificationName {
	return typeof value === "string" && Object.prototype.hasOwnProperty.call(HOST_NOTIFICATION_CATALOGUE, value);
}

export function getHostNotificationDefinition(name: string): (typeof HOST_NOTIFICATION_CATALOGUE)[HostNotificationName] | undefined {
	return isHostNotificationName(name) ? HOST_NOTIFICATION_CATALOGUE[name] : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function jsonByteLength(value: unknown): number {
	try {
		return new TextEncoder().encode(JSON.stringify(value)).byteLength;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function isStructurallyBounded(value: unknown, maxBytes: number): boolean {
	if (jsonByteLength(value) > maxBytes) return false;
	let nodes = 0;
	const ancestors = new Set<object>();
	const visit = (current: unknown, depth: number): boolean => {
		nodes += 1;
		if (nodes > HOST_HOOK_LIMITS.jsonNodes || depth > HOST_HOOK_LIMITS.jsonDepth) return false;
		if (current === null || typeof current === "boolean") return true;
		if (typeof current === "number") return Number.isFinite(current);
		if (typeof current === "string") return current.length <= HOST_HOOK_LIMITS.textLength;
		if (typeof current !== "object") return false;
		if (ancestors.has(current)) return false;
		ancestors.add(current);
		let valid = true;
		if (Array.isArray(current)) {
			valid = current.length <= HOST_HOOK_LIMITS.arrayItems && current.every((item) => visit(item, depth + 1));
		} else if (isPlainObject(current)) {
			const entries = Object.entries(current);
			valid = entries.length <= HOST_HOOK_LIMITS.objectProperties
				&& entries.every(([key, item]) => key.length <= HOST_HOOK_LIMITS.nameLength && visit(item, depth + 1));
		} else {
			valid = false;
		}
		ancestors.delete(current);
		return valid;
	};
	return visit(value, 0);
}

function isSortedUniqueStrings(value: unknown): boolean {
	if (!Array.isArray(value)) return false;
	for (let index = 0; index < value.length; index += 1) {
		if (typeof value[index] !== "string") return false;
		if (index > 0 && value[index - 1] >= value[index]) return false;
	}
	return true;
}

function hasPayloadInvariants(name: HostNotificationName, payload: Record<string, unknown>): boolean {
	if ("changedFields" in payload && !isSortedUniqueStrings(payload.changedFields)) return false;
	if ("changedKeys" in payload && !isSortedUniqueStrings(payload.changedKeys)) return false;
	if (name === "toolCallCompleted") {
		if (payload.status === "succeeded" && payload.errorStatus !== undefined) return false;
		if (payload.status === "errored" && payload.errorStatus === undefined) return false;
	}
	if (name === "staffSessionChanged" && payload.previousSessionId === undefined && payload.sessionId === undefined) return false;
	return true;
}

export function validateNotificationPayload<N extends HostNotificationName>(
	name: N,
	value: unknown,
): value is HostNotificationPayload<N> {
	return isStructurallyBounded(value, HOST_HOOK_LIMITS.payloadBytes)
		&& Value.Check(HOST_NOTIFICATION_CATALOGUE[name].payloadSchema, value)
		&& isPlainObject(value)
		&& hasPayloadInvariants(name, value);
}

export function validateNotificationFilter(
	scope: HostHookScope,
	name: string,
	value: unknown,
): HostNotificationFilterValidation {
	const definition = getHostNotificationDefinition(name);
	if (!definition || definition.scope !== scope) return { ok: false, code: "UNKNOWN_NOTIFICATION" };
	if (!definition.consumers.has("staff")) return { ok: false, code: "INELIGIBLE_CONSUMER" };
	if (!isPlainObject(value)) return { ok: false, code: "INVALID_FILTER_VALUE" };
	const entries = Object.entries(value);
	if (entries.length > HOST_HOOK_LIMITS.filterFields || jsonByteLength(value) > HOST_HOOK_LIMITS.filterBytes) {
		return { ok: false, code: "FILTER_TOO_LARGE" };
	}
	for (const [field, fieldValue] of entries) {
		const schema = definition.filterFields[field];
		if (!schema) return { ok: false, code: "UNKNOWN_FILTER_FIELD" };
		if ((typeof fieldValue !== "string" && typeof fieldValue !== "number" && typeof fieldValue !== "boolean")
			|| !Value.Check(schema, fieldValue)) {
			return { ok: false, code: "INVALID_FILTER_VALUE" };
		}
	}
	return { ok: true, filter: Object.freeze(Object.fromEntries(entries)) as HostNotificationFilter };
}

export function notificationMatchesFilter<N extends HostNotificationName>(
	notification: HostNotification<N>,
	filter: HostNotificationFilter,
): boolean {
	const validated = validateNotificationFilter(notification.scope, notification.name, filter);
	if (!validated.ok || !validateHostNotification(notification)) return false;
	const payload = notification.payload as Record<string, unknown>;
	return Object.entries(validated.filter).every(([field, expected]) => payload[field] === expected);
}

function notificationEnvelopeSchema<N extends HostNotificationName>(name: N): TSchema {
	const definition = HOST_NOTIFICATION_CATALOGUE[name];
	return strictObject({
		id: IdentifierSchema,
		scope: Type.Literal(definition.scope),
		name: Type.Literal(name),
		payloadVersion: Type.Literal(definition.payloadVersion),
		occurredAt: NonNegativeIntegerSchema,
		projectId: IdentifierSchema,
		...(definition.scope === "session" ? { sessionId: IdentifierSchema } : {}),
		aggregate: strictObject({
			kind: Type.Literal(definition.aggregateKind),
			id: IdentifierSchema,
			revision: RevisionSchema,
		}),
		correlationId: Type.Optional(IdentifierSchema),
		causationId: Type.Optional(IdentifierSchema),
		payload: definition.payloadSchema,
	});
}

export const HOST_NOTIFICATION_ENVELOPE_SCHEMAS: Readonly<Record<HostNotificationName, TSchema>> = Object.freeze(
	Object.fromEntries((Object.keys(HOST_NOTIFICATION_CATALOGUE) as HostNotificationName[]).map((name) => [name, notificationEnvelopeSchema(name)])) as Record<HostNotificationName, TSchema>,
);

export function validateHostNotification(value: unknown): value is HostNotification {
	if (!isPlainObject(value) || !isHostNotificationName(value.name)) return false;
	if (!isStructurallyBounded(value, HOST_HOOK_LIMITS.payloadBytes)) return false;
	if (!Value.Check(HOST_NOTIFICATION_ENVELOPE_SCHEMAS[value.name], value)) return false;
	return validateNotificationPayload(value.name, value.payload);
}

function cloneHostValue<T>(value: T): T {
	if (Array.isArray(value)) return value.map((item) => cloneHostValue(item)) as T;
	if (isPlainObject(value)) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneHostValue(item)])) as T;
	}
	return value;
}

export function deepFreezeHostValue<T>(value: T): Readonly<T> {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value as Record<string, unknown>)) deepFreezeHostValue(child);
		Object.freeze(value);
	}
	return value as Readonly<T>;
}

/** Host-only constructor. It copies, validates, and deeply freezes the canonical projection. */
export function buildHostNotification<N extends HostNotificationName>(
	name: N,
	input: HostNotificationBuildInput<N>,
): HostNotification<N> {
	const definition = HOST_NOTIFICATION_CATALOGUE[name];
	const candidate = cloneHostValue({
		id: input.id,
		scope: definition.scope,
		name,
		payloadVersion: definition.payloadVersion,
		occurredAt: input.occurredAt,
		projectId: input.projectId,
		...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
		aggregate: {
			kind: definition.aggregateKind,
			id: input.aggregateId,
			revision: input.aggregateRevision,
		},
		...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
		...(input.causationId === undefined ? {} : { causationId: input.causationId }),
		payload: input.payload,
	});
	if (!validateHostNotification(candidate)) throw new TypeError("Invalid host notification projection");
	return deepFreezeHostValue(candidate) as HostNotification<N>;
}

// Interceptor contracts -----------------------------------------------------

const BoundedJsonValueSchema = Type.Recursive((This) => Type.Union([
	Type.Null(),
	Type.Boolean(),
	Type.Number(),
	Type.String({ maxLength: HOST_HOOK_LIMITS.jsonStringLength }),
	Type.Array(This, { maxItems: HOST_HOOK_LIMITS.arrayItems }),
	Type.Record(
		Type.String({ minLength: 1, maxLength: HOST_HOOK_LIMITS.nameLength, pattern: SAFE_KEY_PATTERN }),
		This,
		{ maxProperties: HOST_HOOK_LIMITS.objectProperties },
	),
]));
const BoundedJsonObjectSchema = Type.Record(
	Type.String({ minLength: 1, maxLength: HOST_HOOK_LIMITS.nameLength, pattern: SAFE_KEY_PATTERN }),
	BoundedJsonValueSchema,
	{ maxProperties: HOST_HOOK_LIMITS.objectProperties },
);
const ContextContributionSchema = strictObject({
	id: IdentifierSchema,
	title: Type.String({ minLength: 1, maxLength: HOST_HOOK_LIMITS.shortTextLength }),
	authority: literals(["memory", "skill", "tool", "workflow", "role", "generic"] as const),
	content: TextSchema,
	reason: ShortTextSchema,
	priority: Type.Number({ minimum: -1_000, maximum: 1_000 }),
});
const ContextResultSchema = strictObject({
	context: Type.Array(ContextContributionSchema, { maxItems: HOST_HOOK_LIMITS.contextContributions }),
});
const SessionSetupRequestSchema = strictObject({
	sessionId: IdentifierSchema,
	projectId: Type.Optional(IdentifierSchema),
	goalId: Type.Optional(IdentifierSchema),
	scope: literals(["project", "global"] as const),
	roleName: Type.Optional(NameSchema),
	component: Type.Optional(strictObject({ name: NameSchema })),
});
const BeforePromptRequestSchema = strictObject({
	sessionId: IdentifierSchema,
	turnIndex: NonNegativeIntegerSchema,
	source: PromptSourceSchema,
	userText: TextSchema,
});
const BeforeToolCallRequestSchema = strictObject({
	toolCallId: IdentifierSchema,
	toolName: NameSchema,
	args: BoundedJsonObjectSchema,
});
const BeforeToolCallResultSchema = Type.Union([
	strictObject({ action: Type.Literal("allow") }),
	strictObject({ action: Type.Literal("block"), reasonCode: literals(["denied", "invalid_request", "not_permitted"] as const) }),
	strictObject({ action: Type.Literal("replaceArgs"), args: BoundedJsonObjectSchema }),
]);
const AfterToolResultRequestSchema = strictObject({
	toolCallId: IdentifierSchema,
	toolName: NameSchema,
	result: BoundedJsonValueSchema,
});
const AfterToolResultResultSchema = Type.Union([
	strictObject({ action: Type.Literal("allow") }),
	strictObject({ action: Type.Literal("replaceResult"), result: BoundedJsonValueSchema }),
	strictObject({ action: Type.Literal("syntheticError"), code: literals(["policy_denied", "invalid_result", "handler_error"] as const) }),
]);
const BeforeCompactRequestSchema = strictObject({
	sessionId: IdentifierSchema,
	turnIndex: NonNegativeIntegerSchema,
	span: TextSchema,
	summary: Type.Optional(TextSchema),
});
const BeforeCompactResultSchema = strictObject({
	context: Type.Optional(Type.Array(ContextContributionSchema, { maxItems: HOST_HOOK_LIMITS.contextContributions })),
	flush: Type.Optional(Type.Literal("complete")),
});
const SessionShutdownRequestSchema = strictObject({
	sessionId: IdentifierSchema,
	projectId: Type.Optional(IdentifierSchema),
	reason: literals(["completed", "archived", "terminated", "restarted", "failed"] as const),
});
const FlushResultSchema = strictObject({ flush: Type.Optional(Type.Literal("complete")) });
const ProjectImportedRequestSchema = strictObject({
	projectId: IdentifierSchema,
	components: Type.Array(strictObject({
		name: NameSchema,
		repo: Type.String({ minLength: 1, maxLength: HOST_HOOK_LIMITS.identifierLength, pattern: RELATIVE_COORDINATE_PATTERN }),
		relativePath: Type.Optional(Type.String({ minLength: 1, maxLength: HOST_HOOK_LIMITS.identifierLength, pattern: RELATIVE_COORDINATE_PATTERN })),
	}), { maxItems: HOST_HOOK_LIMITS.arrayItems }),
});
const ProjectImportedResultSchema = strictObject({ initialised: Type.Optional(Type.Literal(true)) });

export interface HostInterceptorAuditProjection {
	readonly proposal: "none" | "received";
}

export interface HostInterceptorDefinition<N extends string, RQ extends TSchema, RS extends TSchema> {
	readonly name: N;
	readonly requestSchema: RQ;
	readonly resultSchema: RS;
	readonly defaultTimeoutMs: number;
	readonly maxTimeoutMs: number;
	readonly dispatchDeadlineMs: number;
	readonly defaultFailurePolicy: HostInterceptorFailurePolicy;
	readonly allowedFailurePolicies: ReadonlySet<HostInterceptorFailurePolicy>;
	readonly requiredGrants: readonly string[];
	readonly cancellation: Readonly<{
		abortWorker: true;
		discardLateResult: true;
		operationAtDeadline: "continue" | "apply-failure-policy";
	}>;
	readonly auditProjector: (request: unknown, result: unknown) => HostInterceptorAuditProjection;
}

const FAIL_OPEN = new Set<HostInterceptorFailurePolicy>(["failOpen"]);
const FAIL_CLOSED_OR_OPEN = new Set<HostInterceptorFailurePolicy>(["failOpen", "failClosed"]);
const NON_FATAL = new Set<HostInterceptorFailurePolicy>(["nonFatal"]);
const NO_GRANTS = Object.freeze([]) as readonly string[];
const AUDIT_NONE = Object.freeze({ proposal: "none" } as const);
const AUDIT_RECEIVED = Object.freeze({ proposal: "received" } as const);

function interceptor<const N extends string, const RQ extends TSchema, const RS extends TSchema>(options: {
	name: N;
	requestSchema: RQ;
	resultSchema: RS;
	defaultTimeoutMs: number;
	maxTimeoutMs: number;
	dispatchDeadlineMs: number;
	defaultFailurePolicy: HostInterceptorFailurePolicy;
	allowedFailurePolicies: ReadonlySet<HostInterceptorFailurePolicy>;
	operationAtDeadline: "continue" | "apply-failure-policy";
}): HostInterceptorDefinition<N, RQ, RS> {
	return Object.freeze({
		...options,
		requiredGrants: NO_GRANTS,
		cancellation: Object.freeze({ abortWorker: true, discardLateResult: true, operationAtDeadline: options.operationAtDeadline }),
		auditProjector: (_request: unknown, result: unknown) => result === undefined ? AUDIT_NONE : AUDIT_RECEIVED,
	});
}

export const HOST_INTERCEPTOR_CATALOGUE = Object.freeze({
	sessionSetup: interceptor({ name: "sessionSetup", requestSchema: SessionSetupRequestSchema, resultSchema: ContextResultSchema, defaultTimeoutMs: 1_500, maxTimeoutMs: 3_000, dispatchDeadlineMs: 5_000, defaultFailurePolicy: "failOpen", allowedFailurePolicies: FAIL_OPEN, operationAtDeadline: "continue" }),
	beforePrompt: interceptor({ name: "beforePrompt", requestSchema: BeforePromptRequestSchema, resultSchema: ContextResultSchema, defaultTimeoutMs: 500, maxTimeoutMs: 1_000, dispatchDeadlineMs: 1_500, defaultFailurePolicy: "failOpen", allowedFailurePolicies: FAIL_OPEN, operationAtDeadline: "continue" }),
	beforeToolCall: interceptor({ name: "beforeToolCall", requestSchema: BeforeToolCallRequestSchema, resultSchema: BeforeToolCallResultSchema, defaultTimeoutMs: 750, maxTimeoutMs: 1_500, dispatchDeadlineMs: 2_000, defaultFailurePolicy: "failOpen", allowedFailurePolicies: FAIL_CLOSED_OR_OPEN, operationAtDeadline: "apply-failure-policy" }),
	afterToolResult: interceptor({ name: "afterToolResult", requestSchema: AfterToolResultRequestSchema, resultSchema: AfterToolResultResultSchema, defaultTimeoutMs: 750, maxTimeoutMs: 1_500, dispatchDeadlineMs: 2_000, defaultFailurePolicy: "failClosed", allowedFailurePolicies: FAIL_CLOSED_OR_OPEN, operationAtDeadline: "apply-failure-policy" }),
	beforeCompact: interceptor({ name: "beforeCompact", requestSchema: BeforeCompactRequestSchema, resultSchema: BeforeCompactResultSchema, defaultTimeoutMs: 1_500, maxTimeoutMs: 3_000, dispatchDeadlineMs: 5_000, defaultFailurePolicy: "failOpen", allowedFailurePolicies: FAIL_OPEN, operationAtDeadline: "continue" }),
	sessionShutdown: interceptor({ name: "sessionShutdown", requestSchema: SessionShutdownRequestSchema, resultSchema: FlushResultSchema, defaultTimeoutMs: 1_000, maxTimeoutMs: 2_000, dispatchDeadlineMs: 3_000, defaultFailurePolicy: "nonFatal", allowedFailurePolicies: NON_FATAL, operationAtDeadline: "continue" }),
	projectImported: interceptor({ name: "projectImported", requestSchema: ProjectImportedRequestSchema, resultSchema: ProjectImportedResultSchema, defaultTimeoutMs: 2_000, maxTimeoutMs: 5_000, dispatchDeadlineMs: 8_000, defaultFailurePolicy: "nonFatal", allowedFailurePolicies: NON_FATAL, operationAtDeadline: "continue" }),
} as const);

export type HostInterceptorName = keyof typeof HOST_INTERCEPTOR_CATALOGUE;
export type HostInterceptorRequest<N extends HostInterceptorName> = Static<(typeof HOST_INTERCEPTOR_CATALOGUE)[N]["requestSchema"]>;
export type HostInterceptorResult<N extends HostInterceptorName> = Static<(typeof HOST_INTERCEPTOR_CATALOGUE)[N]["resultSchema"]>;

export function isHostInterceptorName(value: unknown): value is HostInterceptorName {
	return typeof value === "string" && Object.prototype.hasOwnProperty.call(HOST_INTERCEPTOR_CATALOGUE, value);
}

export function validateInterceptorRequest<N extends HostInterceptorName>(
	name: N,
	value: unknown,
): value is HostInterceptorRequest<N> {
	return isStructurallyBounded(value, HOST_HOOK_LIMITS.interceptorBytes)
		&& Value.Check(HOST_INTERCEPTOR_CATALOGUE[name].requestSchema, value);
}

export function validateInterceptorResult<N extends HostInterceptorName>(
	name: N,
	value: unknown,
): value is HostInterceptorResult<N> {
	return isStructurallyBounded(value, HOST_HOOK_LIMITS.interceptorBytes)
		&& Value.Check(HOST_INTERCEPTOR_CATALOGUE[name].resultSchema, value);
}
