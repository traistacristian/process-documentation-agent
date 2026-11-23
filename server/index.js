import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createSaaSApp } from './saas.js';
import { applyRetention } from './retention.js';
import { aiAvailable, aiProvider } from './engine/generate-llm.js';
import { initTelemetry } from './telemetry.js';

const cfg = loadConfig();
// Never run the test-user picker on a real host: anyone could pick "IT Admin".
if (cfg.auth.mode === 'dev' && !cfg.multiTenant && process.env.WEBSITE_SITE_NAME && process.env.PDA_ALLOW_DEV_AUTH !== 'true') {
  console.error('Refusing to start: auth mode is "dev" on Azure App Service. Set PDA_AUTH_MODE=entra.');
  process.exit(1);
}

const telemetry = await initTelemetry().catch((e) => { console.error('Application Insights could not start:', e.message); return null; });
let app; let runRetention;
if (cfg.multiTenant) {
  // One deployment for many organisations (server/saas.js). Each tenant's audit log reports to
  // Application Insights with its tenant id.
  app = createSaaSApp(cfg, { onTenantApp: (tenantApp, t) => telemetry?.attach(tenantApp.locals.audit, { tenantId: t.id }) });
  const { registry, tenantApp } = app.locals;
  runRetention = () => {
    for (const t of registry.list()) {
      try {
        const { cfg: tcfg, store, audit } = tenantApp(t.id).locals;
        applyRetention({ cfg: tcfg, store, audit });
      } catch (e) { console.error(`Retention job failed for tenant ${t.id}`, e); }
    }
    try { registry.prune(); } catch (e) { console.error('Pruning the capture index failed', e); }
  };
} else {
  app = createApp(cfg);
  const { store, audit } = app.locals;
  telemetry?.attach(audit);
  runRetention = () => { try { applyRetention({ cfg, store, audit }); } catch (e) { console.error('Retention job failed', e); } };
}
runRetention();
setInterval(runRetention, 3600_000).unref();

const engine = aiAvailable(cfg) ? `${cfg.ai.model} via ${aiProvider(cfg) === 'foundry' ? 'Microsoft Foundry' : 'Claude API'}` : 'rule-based (no AI configured)';
const server = app.listen(cfg.port, () => {
  console.log(`Process Documentation Agent listening on port ${cfg.port}`);
  if (cfg.multiTenant) console.log(`  multi-tenant: ${app.locals.registry.list().length} tenant(s) registered | AI engine: ${engine}`);
  else console.log(`  auth: ${cfg.auth.mode} | repository: ${app.locals.repo.label} | AI engine: ${engine}`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
