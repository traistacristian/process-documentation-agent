// Application Insights (Azure Monitor). Enabled only when APPLICATIONINSIGHTS_CONNECTION_STRING is
// set, which the Bicep template does. Requests, dependencies (Graph, Claude) and exceptions are
// collected automatically; audit entries are sent as custom events so they land in Log Analytics.
export async function initTelemetry({ audit }) {
  if (!process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) return null;
  const appInsights = (await import('applicationinsights')).default;
  appInsights.setup().setAutoCollectConsole(true, false).start();
  const client = appInsights.defaultClient;
  client.context.tags[client.context.keys.cloudRole] = 'process-documentation-agent';
  // Audit entries never contain captured values (they are redacted before they reach the log).
  audit.addSink((e) => client.trackEvent({ name: `audit.${e.action}`, properties: { user: e.user?.id || '', ...flat(e) } }));
  return client;
}

function flat(e) {
  const out = {};
  for (const [k, v] of Object.entries(e)) if (k !== 'user' && v !== undefined) out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return out;
}
