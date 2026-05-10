// Test entry — bundles the components under listener-leak regression so
// they can be mounted in a file:// fixture. Add components here as they
// migrate to BobbitElement and gain a leak-regression test case.
import "../../src/ui/components/GitStatusWidget.js";
import "../../src/ui/components/SandboxedIframe.js";

(window as any).__ready = true;
