# Functional requirements, acceptance criteria and test scenarios

Status legend: ✅ automated test passes · 🟡 implemented, needs a real environment to verify · ⬜ not yet implemented

## Functional requirements

| ID | Requirement | Status |
|---|---|---|
| F1 | Landing page with the two primary options and dashboard (totals, recently created/updated, drafts awaiting approval, recording history, unfinished recordings) | ✅ |
| F2 | New recording: title mandatory; description, department, owner, category optional; duplicate-title warning with “update instead” | ✅ |
| F3 | Explicit consent before recording; visible recording state; pause/resume/stop; add note; mark important step | ✅ |
| F4 | Capture navigation, clicked elements (name + role), field labels, selected values, submits, confirmations and errors, application/URL, screenshots | ✅ browser · 🟡 desktop |
| F5 | Reconstruct steps from events; generate documentation in the 11-section standard template | ✅ |
| F6 | Never invent: steps must cite captured evidence; missing information becomes clarification requests; approval blocked while open | ✅ |
| F7 | Review: edit every section and step, reorder/add/delete steps, remove screenshots, answer clarifications, see suggestions, preview final document, download Word | ✅ |
| F8 | Update: search repository, show current version and history, record, compare, classify unchanged/modified/added/removed/moved + section changes, inconsistencies | ✅ |
| F9 | Approve or reject individual changes or all; rejected changes keep the approved content | ✅ |
| F10 | Approve / reject / save as draft / publish; version numbering and change history | ✅ |
| F11 | Publish to SharePoint with folders, metadata, version history, screenshots, link to document | 🟡 (✅ against mocked Graph and local repository) |
| F12 | No overwrite without approval; conflicting updates detected | ✅ |
| F13 | Configurable SharePoint destination and categories (no hardcoding) | ✅ |
| F14 | Error handling: interrupted recordings resumable, client offline queues, duplicate events ignored, AI failure falls back, repository errors keep the approved draft for retry | ✅ |

## Acceptance criteria (definition of success)

1. An employee opens the app, enters a title, starts recording, performs a task in a web console, stops, and receives structured documentation with screenshots — **verified by `test/e2e` with real Chromium + extension**.
2. The employee reviews, answers clarifications, an approver approves and publishes — **verified (local repository)**; publishing to SharePoint needs a tenant.
3. The employee selects an existing process, performs the changed procedure and gets a proposed update that highlights exactly what changed — **verified**: the e2e update run shows step 1 unchanged and step 2 modified (new Security tab, new MFA option, verification), and publishes v1.1 with v1.0 preserved.
4. A password typed during recording is never stored — **verified**.

## Automated tests

```bash
npm test                     # 23 unit/API tests (engines, redaction, API workflow, RBAC, conflicts, retention, Claude engine with a fake client, SharePoint adapter with a mocked Graph)
npm run test:e2e             # builds the app, launches Chromium with the extension, runs both workflows end to end
python3 -m unittest discover -s desktop-agent/tests   # 7 desktop-agent tests
```

`E2E_SCREENSHOTS=docs/screenshots npm run test:e2e` also saves screenshots of each screen.

## Manual test scenarios for a pilot tenant

| # | Scenario | Expected |
|---|---|---|
| M1 | Assign a license in the Microsoft 365 admin center with the extension | Steps name the actual blades/buttons; screenshots highlight the clicked element |
| M2 | Reset a password in Active Directory Users and Computers with the desktop agent | Password value never appears; step text names the dialog and buttons |
| M3 | Navigate to an excluded site (e.g. Outlook web) mid-recording | No events or screenshots from that site |
| M4 | Pull the network cable during a recording for 2 minutes | Events queued and uploaded after reconnect, no duplicates |
| M5 | Close the browser mid-recording, reopen the app | “Unfinished recordings” banner; recording can be continued or generated |
| M6 | Two approvers publish updates of the same process from two drafts | Second publish refused with a conflict message; nothing overwritten |
| M7 | Revoke the app's site permission, then publish | Clear error; draft stays approved and can be retried |
| M8 | Contributor tries to approve | Not possible (button hidden; API returns 403) |
| M9 | Wait past the retention period | Raw events and unused screenshots deleted; audit entry written |
| M10 | With `ANTHROPIC_API_KEY` set, record M1 again | Higher-level step titles, purpose left for clarification, every step lists evidence |
