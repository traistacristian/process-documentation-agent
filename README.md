# Process Documentation Agent

Captures how an IT employee actually performs a task, turns it into standardised process documentation with screenshots, and publishes it to SharePoint after human review and approval. When a process changes, it records the new execution and shows exactly which steps were added, changed, moved or removed.

**Architecture:** React web app + browser capture extension + desktop capture agent + Node.js API + Claude documentation engine + SharePoint via Microsoft Graph. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```bash
npm install && npm run build && npm start   # http://localhost:3000
npm test                                    # unit + API tests
npm run test:e2e                            # real Chromium + extension, full new and update workflows
```

Then load `extension/` as an unpacked extension in Edge/Chrome and start a recording.

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Hybrid architecture, capture components, diagram, stack, phase status |
| [docs/REQUIREMENTS-AND-TESTING.md](docs/REQUIREMENTS-AND-TESTING.md) | Functional requirements, acceptance criteria, automated and manual test scenarios |
| [docs/SECURITY.md](docs/SECURITY.md) | Roles, capture safeguards, GDPR, AI data handling |
| [docs/GO-LIVE.md](docs/GO-LIVE.md) | **Production go-live**: Azure deployment, Entra/SharePoint setup script, GitHub Actions, client rollout, pilot |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Local run, configuration, Entra / SharePoint / Azure setup, what is not yet verified |
| [docs/AI-AGENT.md](docs/AI-AGENT.md) | Agent instructions, model call and guardrails |
| [docs/screenshots/](docs/screenshots/) | Screens captured by the end-to-end test |
| [docs/sample-output-v1.1.docx](docs/sample-output-v1.1.docx) | A document produced by the end-to-end test (rule-based engine) |

**Prototype defaults:** test users instead of Entra sign-in, a local folder instead of SharePoint, and the rule-based engine unless `ANTHROPIC_API_KEY` is set. All three are shown as such in the UI.
