import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { applyRetention } from './retention.js';

const cfg = loadConfig();
const app = createApp(cfg);
const { store, audit } = app.locals;
const runRetention = () => { try { applyRetention({ cfg, store, audit }); } catch (e) { console.error('Retention job failed', e); } };
runRetention();
setInterval(runRetention, 3600_000).unref();

app.listen(cfg.port, () => {
  console.log(`Process Documentation Agent listening on http://localhost:${cfg.port}`);
  console.log(`  auth: ${cfg.auth.mode} | repository: ${app.locals.repo.label} | AI engine: ${process.env.ANTHROPIC_API_KEY || cfg.ai.provider === 'claude' ? cfg.ai.model : 'rule-based (no ANTHROPIC_API_KEY set)'}`);
});
