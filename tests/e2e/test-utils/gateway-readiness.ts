const CONNECTION_REFUSED_CODE = "ECONNREFUSED";

/**
 * Return true only when every coded transport failure in the wrapper tree is
 * an exact connection refusal. Node's fetch can wrap startup refusals in a
 * TypeError cause and, on some hosts, an AggregateError containing one error
 * per attempted address.
 */
export function isConnectionRefusal(error: unknown): boolean {
	return classifyConnectionRefusal(error, new Set<object>());
}

function classifyConnectionRefusal(error: unknown, ancestors: Set<object>): boolean {
	if (!error || typeof error !== "object") return false;
	if (ancestors.has(error)) return false;
	ancestors.add(error);

	try {
		const candidate = error as { code?: unknown; cause?: unknown; errors?: unknown };
		let foundTransportFailure = false;

		if (candidate.code !== undefined) {
			foundTransportFailure = true;
			if (candidate.code !== CONNECTION_REFUSED_CODE) return false;
		}

		if (candidate.cause !== undefined) {
			foundTransportFailure = true;
			if (!classifyConnectionRefusal(candidate.cause, ancestors)) return false;
		}

		// Fetch failures can cross a worker/VM boundary, where instanceof no
		// longer identifies the native AggregateError. Its errors array is the
		// stable transport shape across those realms.
		if (Array.isArray(candidate.errors)) {
			if (candidate.errors.length === 0) return false;
			foundTransportFailure = true;
			for (const nestedError of candidate.errors) {
				if (!classifyConnectionRefusal(nestedError, ancestors)) return false;
			}
		}

		return foundTransportFailure;
	} finally {
		ancestors.delete(error);
	}
}
