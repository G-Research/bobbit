// Test entry — bundles the components under listener-leak regression so
// they can be mounted in a file:// fixture. Add components here as they
// migrate to BobbitElement and gain a leak-regression test case.
import "../../src/ui/components/GitStatusWidget.js";
import "../../src/ui/components/MessageEditor.js";
import "../../src/ui/components/SandboxedIframe.js";
import "../../src/ui/components/AgentInterface.js";

(window as any).__ready = true;
