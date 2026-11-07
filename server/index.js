import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { applyRetention } from './retention.js';
import { aiAvailable, aiProvider } from './engine/generate-llm.js';
import { initTelemetry } from './telemetry.js';

const cfg = loadConfig();
// Never run the test-user picker on a real host: anyone could pick "IT Admin".
if (cfg.auth.mode === 'dev' && process.env.WEBSITE_SITE_NAME && process.env.PDA_ALLOW_DEV_AUTH !== 'true') {
  console.error('Refusing to start: auth mode is "dev" on Azure App Service. Set PDA_AUTH_MODE=entra.');
  process.exit(1);
}
const app = createApp(cfg);
const { store, audit } = app.locals;
await initTelemetry({ audit }).catch((e) => console.error('Application Insights could not start:', e.message));

const runRetention = () => { try { applyRetention({ cfg, store, audit }); } catch (e) { console.error('Retention job failed', e); } };
runRetention();
setInterval(runRetention, 3600_000).unref();

const engine = aiAvailable(cfg) ? `${cfg.ai.model} via ${aiProvider(cfg) === 'foundry' ? 'Microsoft Foundry' : 'Claude API'}` : 'rule-based (no AI configured)';
const server = app.listen(cfg.port, () => {
  console.log(`Process Documentation Agent listening on port ${cfg.port}`);
  console.log(`  auth: ${cfg.auth.mode} | repository: ${app.locals.repo.label} | AI engine: ${engine}`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
