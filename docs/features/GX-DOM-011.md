# GX-DOM-011 — client-side input discovery and evidence explorer

Status: proposed — not implemented  
Release target: not scheduled

## Operator intent

Find potentially user-controlled inputs that ordinary browsing, visible controls, and captured requests do not expose. Help researchers investigate undocumented, hidden, potentially forgotten, and potentially redundant inputs by showing the evidence behind each candidate.

GraphX should become an **input-evidence explorer**, with the domain graph providing navigation and scope context. The output is an explainable research lead, not a vulnerability verdict, a parameter wordlist, or a claim of exhaustive discovery.

## Current implementation boundary

[GX-DOM-010](GX-DOM-010.md) documents the implemented regex-based recon extractor. Its result model in `packages/shared/src/jsRecon.ts` includes endpoint literals, GraphQL operations, storage keys, messaging usage, DOM sink counts, and representative source evidence. It does not provide the structured input model, syntax-aware request-field analysis, comparisons, or browser observation described here.

JXSCOUT Pro V2 and its Caido companion can run alongside GraphX, but GraphX does not currently import JXSCOUT results or coordinate its fetches with JXSCOUT. Installing the companion does not implement this proposal. See the [setup guide](../jxscout-setup.md) for that distinction.

All behavior below is a proposed contract. Requirement IDs and acceptance scenarios are not claims of implemented or passing tests.

## Research objectives and classification

| Classification | Supporting evidence | What must not be concluded |
| --- | --- | --- |
| Undocumented relative to a baseline | A field appears in code or traffic but is absent from a supplied API/schema/documentation baseline for the applicable operation/version. | Absence from traffic alone does not establish undocumented behavior. An incomplete baseline cannot establish global absence. |
| Hidden or conditional | A field is bound to a hidden/disabled control, a conditional branch, feature state, or alternate workflow. | Hidden UI does not establish privileged behavior, user control, or backend acceptance. |
| Potentially forgotten | A field has legacy or historical references, a removed UI binding, or no recent observations in the available capture window. | Lack of observation does not prove that a feature is dead or that the server still supports it. |
| Potentially redundant | Evidence shows duplicate bindings, overwritten assignments, apparent aliases, or overlapping purposes within a specific operation. | Equal names across endpoints, repeated values, and legitimate arrays are not automatically redundant. |

These classifications can coexist. They are independent of extraction confidence and of whether user control has been established. Unknown or unavailable comparison evidence must remain unknown, not become a negative finding.

## Coverage

### Input surfaces

- Forms and framework bindings, including hidden, disabled, conditional, and dynamically rendered controls.
- File-upload field names and metadata supplied by application code.
- URL query parameters, path values, and fragment reads.
- JSON properties, nested paths, arrays, URL-encoded forms, multipart fields, and `FormData` construction.
- Application-defined request headers and cookie reads. A cookie read is not evidence that its value can be edited by page code.
- GraphQL variables and input objects; an operation name alone is not an input inventory.
- Storage values and browser messages that feed application behavior or request construction.
- Worker/service-worker communication and WebSocket message fields.

Keep client-only inputs separate from inputs bound to outbound requests. For example, a fragment used only for local navigation must not be reported as an HTTP query parameter.

### Complementary evidence sources

| Source | Contribution |
| --- | --- |
| Captured JavaScript and HTML | Request builders, inline scripts, form declarations, and code references already present in Caido. |
| Original sources and additional collected modules | Source-map recovery, lazy chunks, workers, and modules available from the existing collection. Original source is preferred for readability, without discarding bundle provenance. |
| Syntax-aware analysis | Local assignments, object construction/spreads, request wrappers, conditions, and serialization where statically resolvable. Arbitrary strings and object keys are not automatically inputs. |
| Rendered UI observations | Actual controls, visibility/enabled state, bindings, route, and observation time in an operator-recorded browser session. |
| Runtime observations | Computed names and payload construction that can be observed during the operator's normal interaction, including values before serialization where available. |
| Schemas and generated clients | Declared fields, types, defaults, validators, GraphQL input objects, and SDK contracts, with the baseline's origin and version retained. |
| Recorded application states | Differences between operator-recorded workflows or sessions. GraphX does not automatically sign into accounts, change roles, or activate hidden features. |
| Historical builds and captures | Added/removed/renamed references and changes across known asset versions and observation windows. |

Prefer already collected material. Optional JXSCOUT support should reuse saved files and available metadata rather than independently collecting the same assets. Its supported data-access contracts must be validated before implementing that adapter; do not assume a complete public REST API or stable internal database schema.

## Evidence model

An input candidate needs operation context and multiple independently attributable observations. The following are conceptual requirements, not an exported API/schema.

### Candidate identity and context

- Project and scope context.
- Field name and structured property path, with unresolved/computed segments represented explicitly.
- Input channel: UI, URL, query, body, header, cookie, storage, message, or other identified channel.
- Related origin, endpoint/route, method, request encoding, GraphQL operation, or message channel **when known**.
- Associated page, component, module, and request-builder context when attributable.
- Asset/build/content identity and observation times for version-specific evidence.

Do not collapse candidates merely because their names match. Keep different operations, methods, transports, origins, and relevant build contexts distinct. A normalized route template is a grouping aid, not proof that every concrete route accepts the same fields. Preserve transport-specific case, nesting, array, and repeated-field semantics; do not blindly lowercase JSON properties or flatten different encodings into one key.

### Evidence facts

Each candidate can have any combination of these facts; none implies the others:

| Fact | Meaning |
| --- | --- |
| Declared | A form, type, schema, or client contract defines the field. |
| Consumed | Code reads the input or a value associated with it. |
| Constructed | A request or message builder includes the field. |
| Serialized | Evidence connects the field to an encoded outbound representation. |
| Observed | An actual captured request/message or recorded runtime event contains it. |
| Documented | A supplied documentation/contract baseline describes it in the relevant context. |

Keep source-inferred facts distinct from runtime observations. An observed request containing a field proves that it was sent, not that the backend parsed, accepted, or acted on it.

### Provenance, control, and uncertainty

- Source provider, asset URL/path, original module path, and 1-based source location where available.
- Exact reference/snippet and the extraction or comparison reason.
- Applicable branch/feature/UI condition, distinguishing source inference from observed state.
- Inferred type, default, and validation constraints, each with its own evidence rather than a fabricated complete contract.
- Value origin: user-supplied, constant, configuration, server-provided, derived, mixed, or unresolved. A declared/request field alone does not establish user control.
- Extraction confidence with an explanation of what was resolved and what remains unknown. A numerical score must not substitute for provenance or a vulnerability claim.
- Matching Caido request IDs only when a reliable captured association exists. Preserve separate observations rather than replacing them with one representative occurrence.
- Comparison baseline/version and capture window. Distinguish absent-in-observed-data, not-collected, unresolved, and not-applicable states.

Reuse existing evidence and project-scoping conventions where appropriate, but the existing one-representative-evidence behavior is insufficient for comparisons that require multiple occurrences or versions. Never manufacture a Caido capture ID for a JXSCOUT-only file, recovered source, or independently fetched asset.

## Analysis and comparison semantics

1. Inventory available assets, versions, schemas, captures, and optional browser observations. Record missing, inaccessible, unsupported, failed-to-parse, and partially analyzed material.
2. Extract input candidates using syntax-aware analysis and attributable UI/runtime evidence. Resolve bounded local data flow where possible; retain uncertainty for dynamic construction, external state, unresolved wrappers, and unavailable code.
3. Associate candidates with request/message construction and serialization without inventing an endpoint or HTTP method.
4. Correlate with Caido captures using operation and source context, not field-name equality alone. Preserve conflicting observations and alternative bindings.
5. Compare with supplied documentation, recorded application states, and historical versions. Attach the particular discrepancy that supports each classification.
6. Present and prioritize candidates using transparent evidence and filters. A classification or candidate name must not be treated as a confirmed vulnerability or a reason to send a request automatically.

No target requests are generated by classification, graph rendering, filtering, source navigation, or comparison. Optional collection remains a separate, explicit operation; the existing source-map opt-in behavior is not implicitly enabled by this proposal. Runtime observation records the operator's interaction rather than generating synthetic traffic or triggering workflows.

## Researcher-facing behavior

- Navigate from a scoped host or route to a filterable input inventory; do not require rendering every field as a graph node.
- Filter by operation, transport, evidence fact, classification, inferred control, condition, version, confidence, and coverage gaps.
- Expand a candidate to inspect all relevant occurrences, source context, comparisons, and observed captures.
- Jump to the exact source location. Offer native Caido History/unsent Replay pivots only for genuine captured evidence, following the existing provenance rules.
- Show the documentation baseline, capture window, and relevant build beside discrepancy labels.
- Group related candidates without losing per-operation identity or hiding contradictions.
- Explain why an item is prioritized; allow researcher review/marking without turning that review into proof of server behavior.
- Keep large inventories browsable and make partial coverage visible instead of equating a small result list with a complete analysis.

## Example outcome

An `includeArchived` field is declared in a client schema and included by a conditional report-request builder. It is absent from the recorded UI state and captured requests, and absent from the supplied contract for that operation.

GraphX should show:

- The schema and request-builder source locations, including the condition.
- Declared/constructed facts, with observed and documented facts unresolved or absent relative to the identified data/baseline.
- A baseline-relative undocumented classification and conditional-input classification, each with its reason.
- Whether user control can be traced, rather than assuming it from the field name.
- Relevant build identities and the capture window.

The result is a specific research lead. It does not establish that the code executes in the deployed state, that the field reaches the server, or that the server accepts it.

## Limits and non-goals

- No guarantee of finding every input. Available material can omit dynamically loaded code, runtime-generated names, unavailable original sources, or logic that static analysis cannot resolve.
- No discovery guarantee for server-only inputs absent from all available client material and supplied contracts.
- No automatic proof of backend acceptance, vulnerability impact, dead code, or redundancy.
- No claim of arbitrary whole-program data-flow resolution or complete understanding of opaque/encrypted payload construction.
- No automatic parameter guessing, request mutation, server-side probing, account/role switching, or hidden-feature activation as part of discovery.
- No assumption that JXSCOUT collection is complete, that every source-map reference succeeds, or that its independent fetches appear in Caido.
- No cross-project evidence mixing, invented origins, fabricated capture pivots, or silent promotion of inferred facts to observations.

## Proposed architecture boundaries

Follow the [existing extension seams](../architecture.md#extension-seams):

- `shared`: pure candidate/evidence semantics, parsing and bounded analysis, identity, merging, and comparison logic.
- Backend adapters/services: Caido observations, optional validated JXSCOUT ingestion, supplied baselines, project persistence, and orchestration.
- Optional browser observation adapter: operator-recorded DOM/runtime context, explicitly associated with a project/session.
- Frontend: inventory, evidence inspection, filtering, review state, and graph presentation; no parsing or product classification rules in Vue components or renderer reducers.

Keep GraphX usable without JXSCOUT. An unavailable optional provider must be shown as unavailable coverage, not reported as an empty but complete analysis. Exact parser dependencies, provider interfaces, runtime-observation mechanism, and public API shapes require implementation-time investigation.

## Implementation order

1. Implement a complete source-backed inventory of request fields and associate those fields with operations where resolvable.
2. Compare that inventory with captured Caido requests and supplied contracts, preserving uncertainty and provenance.
3. Add the optional JXSCOUT adapter to reuse collected sources and attributable metadata.
4. Add operator-recorded UI/runtime observations and application-state comparisons.
5. Add historical comparisons and evidence-backed forgotten/redundant candidate analysis.

This is an ordering of work, not a reduction of the coverage contract. Completing the first item alone does not implement this proposal.

## Requirements ledger

All acceptance checks below are planned; none is recorded as passing here.

| ID | Requirement | Proposed acceptance scenario |
| --- | --- | --- |
| GX-DOM-1101 | Find attributable request fields rather than arbitrary keys/strings. | A fixture contains a real request body field, an unrelated configuration key, and a path-like string; only the attributable input is associated with the request operation. |
| GX-DOM-1102 | Resolve supported local construction while preserving uncertainty. | Local assignments, spreads, and a supported wrapper retain field provenance; unresolved computed keys/wrappers are marked unknown rather than omitted as if analyzed completely. |
| GX-DOM-1103 | Preserve operation identity and encoding semantics. | Equal field names on different methods/origins/operations remain distinct; legitimate arrays and repeated form fields are not mislabeled redundant. |
| GX-DOM-1104 | Separate evidence facts and user-control conclusions. | A schema-only field, a constant request field, a server-derived value, and an operator-supplied value receive different evidence/control states. |
| GX-DOM-1105 | Correlate real captures without fabricating acceptance or pivots. | A sent field gains observed evidence and a real request pivot; a source-only candidate has neither fabricated request evidence nor an accepted-by-server label. |
| GX-DOM-1106 | Make undocumented classifications baseline-relative. | No baseline yields unknown documentation status; an absent field in a supplied applicable contract carries that contract/version as its classification evidence. |
| GX-DOM-1107 | Preserve conditional UI/runtime evidence. | A recorded hidden/disabled control and a dynamically constructed field retain their observed state/session; no role switch or synthetic request is initiated. |
| GX-DOM-1108 | Compare history without asserting dead code. | A field removed from a later build remains attributable to the earlier build and can be flagged for review without being declared server-supported or definitively dead. |
| GX-DOM-1109 | Explain redundancy candidates. | A provably overwritten local assignment is distinguished from unrelated same-name fields and valid multi-value input construction. |
| GX-DOM-1110 | Reuse optional JXSCOUT data without false Caido provenance. | Imported saved sources and attributable relationships are usable without refetching those assets; JXSCOUT-only data has no invented Caido request ID. |
| GX-DOM-1111 | Keep provider absence and partial analysis visible. | Missing maps, unsupported syntax, unavailable runtime observations, and disconnected optional providers produce explicit coverage gaps rather than complete/empty results. |
| GX-DOM-1112 | Isolate project/scope/session context. | A project/scope switch prevents in-flight work and persisted observations from populating the wrong inventory; historical evidence retains its original context. |
| GX-DOM-1113 | Support evidence-driven review at scale. | A researcher can find an input, inspect multiple occurrences and conditions, follow valid source/capture pivots, and review it without loading the entire estate as graph nodes. |
| GX-DOM-1114 | Keep discovery and presentation passive. | Classification, comparisons, rendering, filtering, and evidence navigation produce no target requests; observation records only the operator's initiated session. |
