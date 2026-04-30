// Test entry — bundles diffProjectYaml so we can call it from a file:// fixture.
import { diffProjectYaml, renderProjectProposalDiff } from "../../src/ui/components/ProjectProposalPanel.js";
(window as any).diffProjectYaml = diffProjectYaml;
(window as any).renderProjectProposalDiff = renderProjectProposalDiff;
(window as any).__ready = true;
