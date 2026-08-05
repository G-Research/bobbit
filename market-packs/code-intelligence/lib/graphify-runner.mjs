/* Generated from src/graphify-runner.ts by scripts/build-market-packs.mjs.
 * Kept committed because marketplace packs ship built assets. */
import { isAbsolute } from "node:path";
export class GraphifyCapabilityError extends Error {
  constructor(version, capability, detail) {
    super(`Graphify ${version} cannot provide ${capability}: ${detail}`);
    this.version = version;
    this.capability = capability;
    this.name = "GraphifyCapabilityError";
  }
}
export class GraphifyDeltaAdapter {
  constructor(version, execution, compatibility) {
    if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error("GraphifyDeltaAdapter requires an exact resolved version");
    this.version = version;
    this.execution = execution;
    this.compatibility = compatibility;
  }
  async invokeDelta(request) {
    validateRequest(request);
    const publicCapability = await this.execution.probePublicDelta(this.version);
    if (publicCapability) {
      const output = await this.execution.invokePublicDelta(publicCapability, request);
      return { ...normaliseOutput(output), compatibility: { kind: "public", id: publicCapability.id, resolvedVersion: this.version } };
    }
    const spec = this.compatibility.find((candidate) => candidate.version === this.version);
    if (!spec) throw new GraphifyCapabilityError(this.version, "incremental-delta", "no supported public delta capability and no pinned compatibility adapter");
    const observed = await this.execution.probeCompatibility(spec);
    if (observed.modulePath !== spec.modulePath || observed.callable !== spec.callable || !containsAll(observed.signature, spec.requiredSignature)) {
      throw new GraphifyCapabilityError(this.version, "incremental-delta", `compatibility probe expected ${spec.modulePath}.${spec.callable}(${spec.requiredSignature.join(", ")})`);
    }
    const output = await this.execution.invokeCompatibility(spec, request);
    return { ...normaliseOutput(output), compatibility: { kind: "compatibility", id: `${spec.modulePath}.${spec.callable}`, resolvedVersion: this.version, modulePath: observed.modulePath, signature: [...observed.signature].sort() } };
  }
}
function validateRequest(request) {
  if (!request.noCluster) throw new Error("Graphify deltas must set noCluster=true");
  if (!request.cwd || !isAbsolute(request.cwd)) throw new Error("Graphify delta cwd must be an absolute component root");
  for (const root of request.scanRoots) validateRelative(root, "scan root");
  for (const changed of request.changedPaths) validateRelative(changed, "changed path");
}
function validateRelative(value, kind) {
  if (!value || value.startsWith("/") || value.split(/[\\/]/).some((part) => part === ".." || part === "")) throw new Error(`${kind} must be a non-empty component-relative path: ${value}`);
}
function normaliseOutput(result) { return { ...result, sourcePaths: [...new Set(result.sourcePaths)].sort() }; }
function containsAll(observed, required) { return required.every((name) => observed.includes(name)); }
export function rebuildCodeCompatibility(version, requiredSignature) {
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error("compatibility adapter requires an exact Graphify version");
  if (requiredSignature.length === 0) throw new Error("compatibility adapter requires a probed _rebuild_code signature");
  return { version, modulePath: "graphify.watch", callable: "_rebuild_code", requiredSignature: [...requiredSignature] };
}
