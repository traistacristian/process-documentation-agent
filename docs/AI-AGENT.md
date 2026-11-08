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

- Model `claude-haiku-5-5` (lowest cost; `ANTHROPIC_MODEL` changes it), adaptive thinking, effort `low` (`ANTHROPIC_EFFORT`), streaming, **structured output** (JSON schema generated from the Zod document schema).
- Provider: Claude API (`ANTHROPIC_API_KEY`; server-side refusal fallback `fallbacks: "default"` is used with Opus models only, Haiku has none) or **Claude in Microsoft Foundry** (`ANTHROPIC_FOUNDRY_RESOURCE`, authenticated with the App Service managed identity; a refusal there goes straight to the rule-based engine).
- Input: process metadata, existing approved document (updates), all redacted events, deterministic candidate steps, up to 20 screenshots as images.

## Server-side guardrails (applied to every model answer)

- Steps whose cited evidence does not exist get a “Not supported by captured evidence” warning and a clarification; approval is blocked until a person confirms or deletes them.
- Screenshot ids not produced by this recording are dropped.
- Empty purpose and permissions always produce a clarification.
- Process ID, version, dates, author and change history are set by the server, never by the model.
- The comparison with the previous version is computed deterministically, not by the model.
- Live step descriptions: while recording, each finished step is sent once (its screenshot and the recognised actions) to the same model, which drafts a 1-3 sentence instruction. The recorder sees it marked "written by AI - check it" and corrects it only if it is wrong; the correction always wins in the document. Disable with `PDA_AI_DESCRIBE_STEPS=false`.
- Personal data in screenshots: each screenshot is sent (downscaled to 1280 px) with a structured-output request for the rectangles that show personal data; the server pixelates them with `sharp` and overwrites the file. Viewing, describing and generating wait for this check.
- Languages: the recorder chooses English or German; the draft and step descriptions are written in that language. On publishing, the approved document is translated into the other language (`ai.languages`) string by string with structured output, so ids, screenshots and evidence are unchanged, and published next to the original (`<id> - <title> (DE).docx`). A failed translation never blocks publishing.
- Guided mode: each step stores the elements clicked in the recording (`targets`: role, accessible name, page). The browser add-in shows the published steps on top of the real pages, highlights the next element and moves on when it is clicked. No AI is involved at that point.
- If the model call fails, is refused, or returns invalid JSON, the rule-based engine produces the draft and the reviewer is told.
