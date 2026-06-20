const STORE_SCHEMA_VERSION = 1;
const PROVIDER_BLOCK_ID = "pr-walkthrough:durable-progress";
const CHECKPOINT_CHAR_LIMIT = 8000;
const MAX_LISTED_CHUNKS = 50;
const MAX_CHUNK_ID_CHARS = 120;

const bindingKey = (sessionId) => `binding/${sessionId}`;
const submittedKey = (jobId) => `submitted/${jobId}`;
const jobKey = (jobId) => `job/${jobId}`;
const reviewerIndexKey = (sessionId) => `reviewers/${sessionId}`;
const reviewPrefix = (jobId) => `reviews/${jobId}/`;
const reviewBindingKey = (jobId, sessionId) => `${reviewPrefix(jobId)}binding/${sessionId}`;
const draftPrefix = (jobId) => `${reviewPrefix(jobId)}draft/`;
const chunkPrefix = (jobId) => `${draftPrefix(jobId)}chunks/`;
const draftStatusKey = (jobId) => `${draftPrefix(jobId)}status`;
const draftCheckpointKey = (jobId) => `${draftPrefix(jobId)}checkpoint`;
const finalPayloadKey = (jobId) => `${reviewPrefix(jobId)}final/payload`;
const cardsKey = (changesetId) => `cards/${b64url(changesetId)}`;
const DRAFT_QUOTA = (jobId) => ({ quotaScope: { prefix: draftPrefix(jobId), profile: "review-draft" } });

function b64url(value) {
	return Buffer.from(String(value), "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function isObject(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function strOf(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uniqueStrings(values) {
	return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function safeChunkIdFromKey(key, prefix) {
	if (!key.startsWith(prefix)) return undefined;
	const id = key.slice(prefix.length);
	if (!id || id.includes("/")) return undefined;
	return id.length > MAX_CHUNK_ID_CHARS ? `${id.slice(0, MAX_CHUNK_ID_CHARS)}…` : id;
}

async function resolveReview(ctx) {
	const store = ctx?.host?.store;
	const sessionId = strOf(ctx?.sessionId);
	if (!store || !sessionId) return undefined;

	const reviewerIndex = await store.get(reviewerIndexKey(sessionId)).catch(() => null);
	const indexedJobId = isObject(reviewerIndex) ? strOf(reviewerIndex.jobId) : undefined;
	if (!indexedJobId && ctx?.roleName !== "pr-reviewer") return undefined;

	let jobId = indexedJobId;
	let scopedBinding;
	if (jobId) {
		scopedBinding = await store.get(reviewBindingKey(jobId, sessionId)).catch(() => null);
	}
	let legacyBinding = await store.get(bindingKey(sessionId)).catch(() => null);
	if (!isObject(legacyBinding)) legacyBinding = undefined;
	if (!isObject(scopedBinding)) scopedBinding = undefined;
	if (!jobId) jobId = strOf(scopedBinding?.jobId) || strOf(legacyBinding?.jobId);
	if (!jobId) return undefined;
	if (!scopedBinding) {
		scopedBinding = await store.get(reviewBindingKey(jobId, sessionId)).catch(() => null);
		if (!isObject(scopedBinding)) scopedBinding = undefined;
	}
	const binding = isObject(scopedBinding) ? scopedBinding : legacyBinding;
	return { store, sessionId, jobId, reviewerIndex: isObject(reviewerIndex) ? reviewerIndex : undefined, binding: isObject(binding) ? binding : undefined };
}

async function listChunkIds(store, jobId) {
	const prefix = chunkPrefix(jobId);
	const keys = await store.list(prefix).catch(() => []);
	if (!Array.isArray(keys)) return [];
	return uniqueStrings(keys.map((key) => safeChunkIdFromKey(key, prefix)).filter(Boolean)).sort();
}

function chunkSummaryLine(ids) {
	if (ids.length === 0) return "Saved chunks: none";
	const shown = ids.slice(0, MAX_LISTED_CHUNKS);
	const suffix = ids.length > shown.length ? ` (+${ids.length - shown.length} more)` : "";
	return `Saved chunks (${ids.length}): ${shown.join(", ")}${suffix}`;
}

function nextStepFor(ids, hasFinal) {
	if (hasFinal) return "Next required step: review is finalized; do not resubmit chunks unless explicitly asked to revise.";
	if (ids.includes("document")) {
		const others = ids.filter((id) => id !== "document");
		if (others.length > 0) return "Next required step: resolve chunk conflict before finalizing; document cannot be mixed with section chunks.";
		return "Next required step: call finalize_pr_walkthrough_submission to validate and publish the saved document chunk.";
	}
	const required = ["metadata", "context", "merge_assessment", "audit"];
	const missing = required.filter((id) => !ids.includes(id));
	if (missing.length > 0) return `Next required step: save missing required chunk(s): ${missing.join(", ")}.`;
	const hasReviewChunk = ids.some((id) => id.startsWith("chunk:"));
	if (!hasReviewChunk) return "Next required step: save at least one chunk:<id> review section, or ensure audit carries a reviewer checklist, then finalize.";
	return "Next required step: call finalize_pr_walkthrough_submission after any remaining optional decision/display/follow-up chunks are saved.";
}

function summarizeDraftStatus(status) {
	if (!isObject(status)) return undefined;
	const parts = [];
	const updatedAt = typeof status.updatedAt === "number" ? new Date(status.updatedAt).toISOString() : strOf(status.updatedAt);
	if (updatedAt) parts.push(`statusUpdatedAt=${updatedAt}`);
	const checkpointAt = typeof status.checkpointAt === "number" ? new Date(status.checkpointAt).toISOString() : strOf(status.checkpointAt);
	if (checkpointAt) parts.push(`checkpointAt=${checkpointAt}`);
	const phase = strOf(status.phase) || strOf(status.status);
	if (phase) parts.push(`phase=${phase}`);
	return parts.length > 0 ? parts.join(", ") : undefined;
}

function contentForProgress({ jobId, binding, ids, status, hasFinal, finalPayload }) {
	const lines = [
		"PR Walkthrough durable progress is available for this reviewer session.",
		`Job: ${jobId}`,
	];
	const changesetId = strOf(finalPayload?.changesetId) || strOf(binding?.changesetId);
	if (changesetId) lines.push(`Changeset: ${changesetId}`);
	lines.push(`Finalized: ${hasFinal ? "yes" : "no"}`);
	lines.push(chunkSummaryLine(ids));
	const statusLine = summarizeDraftStatus(status);
	if (statusLine) lines.push(`Draft status: ${statusLine}`);
	lines.push(nextStepFor(ids, hasFinal));
	lines.push("Use read_pr_walkthrough_submission_status for bounded readback before resuming work.");
	return lines.join("\n");
}

function checkpointText(ctx) {
	const summary = strOf(ctx?.summary);
	if (summary) return { source: "summary", text: summary.slice(0, CHECKPOINT_CHAR_LIMIT), originalLength: summary.length };
	const span = strOf(ctx?.span);
	if (span) return { source: "span", text: span.slice(0, CHECKPOINT_CHAR_LIMIT), originalLength: span.length };
	return undefined;
}

async function bestEffortDelete(store, key) {
	try {
		if (typeof store.delete === "function") await store.delete(key);
	} catch { /* best-effort cleanup */ }
}

async function bestEffortDeletePrefix(store, prefix) {
	try {
		if (typeof store.deletePrefix === "function") await store.deletePrefix(prefix);
	} catch { /* best-effort cleanup */ }
}

async function collectChangesetIds(store, jobId, binding) {
	const ids = [];
	if (isObject(binding)) ids.push(strOf(binding.changesetId));
	const finalPayload = await store.get(finalPayloadKey(jobId)).catch(() => null);
	if (isObject(finalPayload)) ids.push(strOf(finalPayload.changesetId));
	const legacyJob = await store.get(jobKey(jobId)).catch(() => null);
	if (isObject(legacyJob)) ids.push(strOf(legacyJob.changesetId));
	return uniqueStrings(ids);
}

export default {
	async beforePrompt(ctx) {
		const review = await resolveReview(ctx);
		if (!review) return { blocks: [] };
		const { store, jobId, binding } = review;
		const [ids, status, finalPayload] = await Promise.all([
			listChunkIds(store, jobId),
			store.get(draftStatusKey(jobId)).catch(() => null),
			store.get(finalPayloadKey(jobId)).catch(() => null),
		]);
		const hasFinal = isObject(finalPayload);
		return {
			blocks: [{
				id: PROVIDER_BLOCK_ID,
				title: "PR Walkthrough durable progress",
				authority: "tool",
				priority: 30,
				reason: "saved PR Walkthrough chunk/finalization status for this reviewer session",
				content: contentForProgress({ jobId, binding, ids, status, hasFinal, finalPayload }),
			}],
		};
	},

	async beforeCompact(ctx) {
		const review = await resolveReview(ctx);
		if (!review) return { blocks: [] };
		const { store, sessionId, jobId } = review;
		const finalPayload = await store.get(finalPayloadKey(jobId)).catch(() => null);
		if (isObject(finalPayload)) return { blocks: [] };
		const checkpoint = checkpointText(ctx);
		if (!checkpoint) return { blocks: [] };
		await store.put(draftCheckpointKey(jobId), {
			schemaVersion: STORE_SCHEMA_VERSION,
			jobId,
			sessionId,
			source: checkpoint.source,
			text: checkpoint.text,
			truncated: checkpoint.originalLength > CHECKPOINT_CHAR_LIMIT,
			updatedAt: Date.now(),
		}, DRAFT_QUOTA(jobId));
		return { blocks: [] };
	},

	async sessionShutdown(ctx) {
		const review = await resolveReview(ctx);
		if (!review) return { blocks: [] };
		const { store, sessionId, jobId, binding } = review;
		const changesetIds = await collectChangesetIds(store, jobId, binding);
		await bestEffortDeletePrefix(store, reviewPrefix(jobId));
		await bestEffortDelete(store, reviewerIndexKey(sessionId));
		await bestEffortDelete(store, bindingKey(sessionId));
		await bestEffortDelete(store, submittedKey(jobId));
		await bestEffortDelete(store, jobKey(jobId));
		for (const changesetId of changesetIds) {
			await bestEffortDelete(store, cardsKey(changesetId));
		}
		return { blocks: [] };
	},
};
