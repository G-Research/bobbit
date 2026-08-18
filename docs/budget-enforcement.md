# Budget enforcement

Budget enforcement is a small server-core reducer for future budget-sensitive operation
consumers. It gives those consumers one consistent place to validate extension advice, recheck
EP-6 authority, select the restrictive result, and produce safe audit metadata. It intentionally
does not define a spending policy, calculate costs or limits, shape requests, or execute an
extension hook. There is currently no live budget consumer.

This surface complements, rather than replaces, [extension capability grants](extension-capability-grants.md).
Grants determine whether an active declared hook has `decide` authority; the reducer determines
what a future core-owned consumer does with a returned proposal. Usage telemetry for lifecycle
providers is documented in [Lifecycle Hub](lifecycle-hub.md#afterturn-usage-telemetry).

## Core interface

The server module exports these types and reducer from `src/server/agent/budget-enforcement.ts`:

```ts
export const BUDGET_ENFORCEMENT_DISPOSITIONS = [
  "allow", "warn", "pause", "halt",
] as const;
export type BudgetEnforcementDisposition =
  typeof BUDGET_ENFORCEMENT_DISPOSITIONS[number];

export interface BudgetEnforcementProposal {
  disposition: BudgetEnforcementDisposition;
  ruleId: string;
  reasonId?: string;
}

export interface BudgetEnforcementCandidate {
  source: ExtensionHookRef;
  proposal: unknown;
}

export interface BudgetEnforcementRequest {
  sessionId: string;
  projectId?: string;
  goalId?: string;
  consumerId: string;
  operationId: string;
  fallback: BudgetEnforcementDisposition;
  hardCapOverride?: "core-hard-cap";
}

export interface BudgetEnforcementAudit {
  hookId?: string;
  disposition: BudgetEnforcementDisposition;
  ruleId?: string;
  reasonId?: string;
  grantDenied: number;
  malformed: number;
}

export interface BudgetEnforcementResult {
  disposition: BudgetEnforcementDisposition;
  permitsOperation: boolean;
  consent: "not-required" | "hard-cap-override";
  audit: BudgetEnforcementAudit;
}

export function resolveBudgetEnforcement(
  request: BudgetEnforcementRequest,
  activeHooks: readonly ResolvedHook[],
  grants: readonly ExtensionGrant[],
  candidates: readonly BudgetEnforcementCandidate[],
): BudgetEnforcementResult;
```

`BudgetEnforcementCandidate.source` is server-derived hook identity paired with a worker result;
it is not an identity supplied by an extension. `request` is trusted core operation context.
`consumerId`, `operationId`, hook identifiers, `ruleId`, and `reasonId` must use the shared
safe-identifier format. The resolver accepts no free-form explanation, token count, cost, cap,
prompt, request payload, credential, or consent answer.

## Fail-closed resolution

`fallback` is mandatory. The reducer never treats silence, no candidates, a malformed candidate,
an inactive hook, a missing/revoked `decide` grant, or an invalid request as an implicit allow.
For no accepted candidate it returns the caller's explicit fallback; an invalid request always
returns `halt`. A caller that already has a safe continuation may deliberately choose `allow`.
A hard-cap override path can explicitly choose `halt` until a later consent flow authorizes a new
attempt.

For each candidate, the reducer validates the core-paired source and proposal, then checks the
exact active EP-6 `decide` grant through the current active hooks and grants. A future consumer
must obtain fresh active hooks and grants immediately before applying the result. Consequently,
a grant revoked while a worker runs cannot authorize its late result.

Accepted proposals resolve by restrictiveness:

```text
halt > pause > warn > allow
```

Equal dispositions use active-hook priority, then lexical `packId`, `hookId`, `ruleId`, and
`reasonId` (with an absent reason last) to choose a stable audit identity. Priority never lets a
less restrictive proposal defeat a more restrictive one.

`allow` and `warn` set `permitsOperation` to `true`; `pause` and `halt` set it to `false`.
`pause` is not a permissive intermediate result: a consumer must stop the protected operation
until its separate, core-owned pause handling decides what happens next. `halt` denies the
current protected operation. Neither result grants any broader tool, role, session, or extension
authority.

## Audit and future consent composition

The returned `audit` object is bounded metadata only: the selected safe hook/rule/reason labels,
the result disposition, and counts of grant-denied or malformed candidates. It is designed for
the existing `ContextTraceStore` sanitizer, whose core-owned reason catalog includes `Budget
enforcement`; it is not a new budget ledger or raw-proposal store. A concrete consumer is
responsible for appending an appropriate core-owned trace outcome. No live consumer currently
invokes the reducer or writes such an outcome.

`hardCapOverride: "core-hard-cap"` is a classification tag, not a cap calculation or consent
mechanism. It causes `consent: "hard-cap-override"` independently of the selected disposition;
it does not override normal resolution or itself authorize an operation. This lets EP-11 later
classify a hard-cap override without introducing an EP-11 dependency today. There is no live
hard-cap consumer: a future consumer must require its own consent result and recheck the core
application boundary rather than treating this tag, extension silence, or an ungranted proposal
as consent.

## Integration boundary

A future consumer invokes only its applicable active decision hooks, pairs each result with the
server-derived source, and passes the collected candidates to this reducer at its core application
choke point. It must not expose a `host.budget` or prompt-cache API, give extensions an `apply()`
callback, or treat this reducer as a generic hook dispatcher. This preserves the distinction
between extension advice, project authority, and the core operation that ultimately permits or
denies work.
