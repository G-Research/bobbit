// A deliberately-hanging provider: beforePrompt never resolves within its
// budget, so the LifecycleHub must enforce the per-provider timeout and the
// before-prompt endpoint must still respond within budget with an empty tail
// and a timeout trace row. Declares ONLY beforePrompt so it is inert for the
// sessionSetup-driven sibling fixture specs.
export default {
	beforePrompt() {
		// Sleep far beyond the provider's configured timeoutMs. The module host
		// aborts the worker on timeout; this promise intentionally never settles
		// on its own.
		return new Promise((resolve) => setTimeout(resolve, 30_000));
	},
};
