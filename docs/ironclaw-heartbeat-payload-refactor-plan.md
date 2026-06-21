# Ironclaw Heartbeat Payload Refactor Plan

## Objective

Improve heartbeat reliability and answer quality for Paperclip agents using the Ironclaw Responses API by separating:

- durable behavior/policy instructions
- task-specific user input
- runtime skill metadata

Current symptom to eliminate:

- heartbeat runs can succeed with low-value outputs like "Based"
- direct Ironclaw calls can time out with continuation context

## Scope

Primary implementation scope:

- paperclip server Ironclaw adapter payload construction
- paperclip heartbeat run quality classification and logging
- light compatibility updates to adapter tests

Secondary validation scope:

- end-to-end run verification through Paperclip -> Ironclaw -> Ollama

Out of scope for this phase:

- changing model family
- replacing Ironclaw Responses API
- large redesign of workspace/session management

## Current Behavior Summary

File:

- paperclip/server/src/adapters/ironclaw-http/execute.ts

Observed behavior:

- managed instructions are already sent in body.instructions
- runtime skill markdown is appended into body.input prompt text
- body.stream is forced to false
- previous_response_id is chained from session state
- response quality gating is weak; short outputs can still produce successful runs

## Target Payload Contract

For each heartbeat invocation:

1. body.instructions
- Contains compact, high-priority behavior guidance only.
- Includes managed AGENTS content and short execution contract summary.
- Must be size-capped with explicit truncation markers.

2. body.input
- Contains only task-turn content.
- Should include wake delta, issue context, and immediate requested action.
- Must not include full runtime skill markdown blocks.

3. body.x_context.paperclip
- Contains structured runtime metadata only.
- Include skill keys, selection rationale, and optional short skill summary snippets.
- Keep concise and machine-readable.

4. body.tools (optional phase-2 extension)
- Move eligible skill capabilities to structured tool declarations where possible.
- Do not block phase-1 on tools migration.

## Refactor Design

### A. Split prompt assembly into explicit layers

Replace current buildPromptInput return shape with an explicit payload model:

- instructionsText
- taskInputText
- runtimeSkillMeta

Suggested new helper names in execute.ts:

- buildInstructionLayer
- buildTaskInputLayer
- buildRuntimeSkillContext

### B. Move skills out of main input

Current behavior:

- full skill markdown concatenated into input

New behavior:

- input includes no full skill markdown
- x_context.paperclip.runtimeSkills keeps selected skill keys
- optional x_context.paperclip.runtimeSkillSummaries keeps very short summaries (for audit/debug only)

### C. Add quality classification

Create a lightweight result classifier:

- low_signal_short_text
- empty_text
- normal_text

Heuristic v1:

- trim length <= 16 and token count <= 3 => low signal
- known low-signal tokens list includes Based

Classification output:

- emit stderr warning line for low-signal responses
- include classification in result metadata
- do not silently treat low-signal as fully healthy in operational dashboards

### D. Add continuation fallback policy for adapter-side retry trigger

Adapter should introduce retry policy envelope metadata (even if actual retry remains gateway-side):

- continuation_mode: chained or fresh
- low_signal_detected: true or false
- retry_recommendation: fresh_session

If policy allows immediate retry in adapter:

- on low-signal output, retry once with forceFreshSession semantics
- preserve run trace fields to avoid ambiguity

If retry remains disabled:

- still emit structured warning and recommendation

### E. Preserve workspace/session semantics

Do not alter heartbeat workspace resolver behavior in this phase.

Important interpretation for operators:

- fallback workspace log line is informational about cwd selection
- it is not itself an LLM output-quality root cause

## Implementation Steps

1. Update payload builder in execute.ts
- isolate instructions, input, and skill context builders
- remove runtime skill markdown concatenation from main input
- keep managed instructions in instructions field

2. Update x_context schema emitted by adapter
- add compact runtime skill metadata
- add response quality classification fields after response parse

3. Add result quality classifier
- classify output text
- emit warning logs on low-signal output

4. Keep existing status failed handling
- preserve current behavior when Ironclaw returns status failed

5. Update tests
- execute.test.ts assertions should validate:
  - input no longer includes large runtime skill body
  - instructions still present when configured
  - x_context includes runtime skill metadata
  - low-signal output triggers warning path

6. Add integration validation script notes
- capture prompt hash, payload sizes, response length, classification

## Test Plan

### Unit tests (paperclip)

File:

- paperclip/server/src/adapters/ironclaw-http/execute.test.ts

Add or adjust tests:

1. instructions and input separation
- assert body.instructions contains managed guidance
- assert body.input excludes full skill markdown blob

2. runtime skill context preserved
- assert x_context.paperclip.runtimeSkills contains selected keys

3. low-signal classifier
- mock output Based and assert warning path and classification

4. normal response path
- assert no low-signal warning

### Direct API reproducibility tests

Use exact captured adapter.invoke prompt from a real run.

Run matrix:

1. Ollama direct generate
2. Ironclaw direct responses with previous_response_id
3. Ironclaw direct responses without previous_response_id
4. Paperclip run with same logical context

Compare:

- response status
- output length
- quality classification
- latency

### End-to-end acceptance tests

A run is acceptable when:

- adapter.invoke dispatches to Ironclaw successfully
- run does not end with low-signal one-token output
- onboarding blocked task receives actionable response text

## Rollout Plan

1. Implement and test locally in Paperclip.
2. Build server package.
3. Deploy CT202 Paperclip.
4. Re-run targeted CEO run and record:
- adapter.invoke payload shape
- log content
- issue update behavior
5. If stable, keep as baseline before further Ironclaw-side changes.

## Risk Assessment

1. Behavior drift from removing skill markdown in input
- mitigation: keep compact skill summaries in context and monitor task completion quality

2. Overly aggressive low-signal detection
- mitigation: keep threshold conservative and warning-first in phase-1

3. Regression in instruction precedence
- mitigation: explicit tests for instructions placement and content caps

## Suggested Follow-up Phase

After payload split stabilizes:

- migrate selected capabilities from markdown skill text to structured Responses tools
- tune continuation retry policy with gateway and adapter cooperation
- add dashboard metric for low-signal successful runs

## New Session Handoff Prompt Template

Use this in a new implementation session:

Implement the Ironclaw heartbeat payload refactor described in paperclip/docs/ironclaw-heartbeat-payload-refactor-plan.md. Keep managed instructions in instructions, remove full runtime skill markdown from input, keep task content in input, add compact skill metadata in x_context, add low-signal response classification and warning behavior, and update execute.test.ts accordingly. Run focused adapter tests and a server build, then summarize payload before/after and test outcomes.
