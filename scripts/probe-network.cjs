const { app, net } = require('electron');

// No credentials are read or sent. Exercise the same TLS stack as the application.
app.whenReady().then(async () => {
  try {
    const discoveryResponse = await net.fetch('https://auth.openai.com/.well-known/openid-configuration', { signal: AbortSignal.timeout(15_000) });
    console.log('OpenAI discovery:', discoveryResponse.status);
    if (!discoveryResponse.ok) throw new Error('Discovery unavailable');
    const discovery = await discoveryResponse.json();
    const jwksResponse = await net.fetch(discovery.jwks_uri, { signal: AbortSignal.timeout(15_000) });
    console.log('OpenAI verification keys:', jwksResponse.status);
    if (!jwksResponse.ok || !Array.isArray((await jwksResponse.json()).keys)) throw new Error('JWKS unavailable');
    const modelsResponse = await net.fetch('https://api.openai.com/v1/models', { signal: AbortSignal.timeout(15_000) });
    console.log('OpenAI models without credentials:', modelsResponse.status);
    if (modelsResponse.status !== 401) throw new Error('Unexpected unauthenticated models response');
    console.log('PASS: TLS validation remains enabled; no credential or certificate override used.');
    app.exit(0);
  } catch (error) {
    console.error('FAIL:', error.message);
    app.exit(1);
  }
});
