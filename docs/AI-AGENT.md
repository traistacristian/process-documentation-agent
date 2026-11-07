# AI agent instructions, prompts and guardrails

The full system prompt is in [`server/engine/prompts.js`](../server/engine/prompts.js) so it is versioned with the code. Summary of the behaviour it enforces:

1. Understand the process before writing; group low-level actions into meaningful steps with clear titles.
2. Document what was actually done; every step cites the event sequence numbers it is based on.
3. Imperative, one action per instruction, exact UI names, consistent terminology.
4. Preserve relevant technical details; never guess redacted values.
5. Never invent purpose, scope, permissions, roles, decisions, escalation or troubleshooting — leave empty and ask.
6. Errors seen during recording become exceptions with handling left open unless recovery was recorded.
7. Attach only provided screenshot ids.
8. Suggestions are separate from the documented steps.
9. For updates, reuse existing wording for unchanged steps so the comparison only shows real changes.

## Model call

- Model `claude-opus-5-5`, adaptive thinking, effort `high`, streaming, **structured output** (JSON schema generated from the Zod document schema), server-side refusal fallback (`fallbacks: "default"`).
- Input: process metadata, existing approved document (updates), all redacted events, deterministic candidate steps, up to 20 screenshots as images.

## Server-side guardrails (applied to every model answer)

- Steps whose cited evidence does not exist get a “Not supported by captured evidence” warning and a clarification; approval is blocked until a person confirms or deletes them.
- Screenshot ids not produced by this recording are dropped.
- Empty purpose and permissions always produce a clarification.
- Process ID, version, dates, author and change history are set by the server, never by the model.
- The comparison with the previous version is computed deterministically, not by the model.
- If the model call fails, is refused, or returns invalid JSON, the rule-based engine produces the draft and the reviewer is told.
