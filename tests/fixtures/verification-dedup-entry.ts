// Entry that bundles VerificationOutputModal and GateVerificationLive so we
// can drive them in a file:// fixture for the dedup reproducing test.
import "../../src/ui/components/VerificationOutputModal.js";
import "../../src/ui/tools/renderers/GateVerificationLive.js";

(window as any).__ready = true;
