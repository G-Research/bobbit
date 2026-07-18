import { gatewayFetch } from "./gateway-fetch.js";

export interface SignoffReviewTarget {
	goalId: string;
	gateId: string;
	signalId: string;
	stepName: string;
	stepLabel?: string;
	goalTitle?: string;
	gateName?: string;
	/** Add the established short signal suffix when otherwise-identical tabs need disambiguation. */
	disambiguateWithSignal?: boolean;
}

export interface SignoffReviewEventDetail {
	title: string;
	markdown: string;
	source: {
		kind: "verification-signoff-markdown";
		goalId: string;
		gateId: string;
		signalId: string;
		stepName: string;
		goalTitle?: string;
		gateName?: string;
		stepLabel?: string;
	};
}

export interface SignoffReviewLaunchOptions {
	signal?: AbortSignal;
	/** Checked immediately before dispatch so callers can invalidate stale targets. */
	isCurrent?: () => boolean;
}

const EMPTY_SIGNOFF_CONTENT = "No content was attached to this sign-off signal.";

function assertLaunchCurrent(options: SignoffReviewLaunchOptions): void {
	if (!options.signal?.aborted && options.isCurrent?.() !== false) return;
	const error = new Error("Sign-off review launch was cancelled");
	error.name = "AbortError";
	throw error;
}

function signoffReviewTitle(target: SignoffReviewTarget): string {
	const goal = target.goalTitle || target.goalId || "Goal";
	const gate = target.gateName || target.gateId;
	const step = target.stepLabel || target.stepName;
	const base = `Sign-off: ${goal} / ${gate} / ${step}`;
	return target.disambiguateWithSignal ? `${base} (${target.signalId.slice(0, 8)})` : base;
}

/**
 * Fetch the exact submitted gate signal and hand it to the shared review pane.
 * Eligibility is intentionally the caller's responsibility: this helper only
 * performs the launch for an already-authoritative sign-off target.
 */
export async function launchSignoffReview(
	target: SignoffReviewTarget,
	options: SignoffReviewLaunchOptions = {},
): Promise<SignoffReviewEventDetail> {
	assertLaunchCurrent(options);
	let response: Response;
	try {
		response = await gatewayFetch(
			`/api/goals/${encodeURIComponent(target.goalId)}/gates/${encodeURIComponent(target.gateId)}/signals`,
			{ signal: options.signal },
		);
	} catch (error) {
		assertLaunchCurrent(options);
		throw new Error("Unable to load signal content (network)", { cause: error });
	}
	assertLaunchCurrent(options);
	if (!response.ok) throw new Error(`Unable to load signal content (${response.status})`);

	const data = await response.json().catch(() => null);
	assertLaunchCurrent(options);
	const signals = Array.isArray(data?.signals) ? data.signals : [];
	const signal = signals.find((candidate: unknown) => {
		return !!candidate
			&& typeof candidate === "object"
			&& (candidate as Record<string, unknown>).id === target.signalId;
	}) as Record<string, unknown> | undefined;
	if (!signal) throw new Error("Signal content is no longer available");

	// Gate-card targets carry only stable identifiers. Prefer any display names
	// explicitly supplied by richer launchers, then use the endpoint metadata.
	const goalTitle = target.goalTitle
		?? (typeof data?.goalTitle === "string" && data.goalTitle ? data.goalTitle : undefined);
	const gateName = target.gateName
		?? (typeof data?.gateName === "string" && data.gateName ? data.gateName : undefined);
	const resolvedTarget = { ...target, goalTitle, gateName };
	const detail: SignoffReviewEventDetail = {
		title: signoffReviewTitle(resolvedTarget),
		markdown: typeof signal.content === "string" && signal.content.trim()
			? signal.content
			: EMPTY_SIGNOFF_CONTENT,
		source: {
			kind: "verification-signoff-markdown",
			goalId: target.goalId,
			gateId: target.gateId,
			signalId: target.signalId,
			stepName: target.stepName,
			...(goalTitle ? { goalTitle } : {}),
			...(gateName ? { gateName } : {}),
			...(target.stepLabel ? { stepLabel: target.stepLabel } : {}),
		},
	};
	assertLaunchCurrent(options);
	window.dispatchEvent(new CustomEvent("bobbit-open-review-document", { detail }));
	return detail;
}
