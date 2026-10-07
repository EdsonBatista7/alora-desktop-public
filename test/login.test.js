import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { get } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const folder = await mkdtemp(path.join(tmpdir(), 'alora-login-test-'));
  if (options.restoreModels) {
    const record = { hostId: 'test-host', deviceId: 'test-device', deviceToken: 'test-only-device-token',
      account: { clientId: 'oaiapp_test', accessToken: 'test-only-access', refreshToken: 'test-only-refresh',
        expiresAt: Date.now() + 3_600_000, modelsAt: Date.now(), models: options.restoreModels } };
    await writeFile(path.join(folder, 'alora-secure-state.json'), JSON.stringify({ encrypted: Buffer.from(JSON.stringify(record)).toString('base64') }));
  }
  t.after(async () => {
    assert.ok(folder.startsWith(path.join(tmpdir(), 'alora-login-test-')));
    await rm(folder, { recursive: true, force: true });
  });
  const ready = deferred(), tokenStarted = deferred(), catalogReady = deferred(), tokenGate = options.tokenGate ?? Promise.resolve();
  const handlers = new Map(), requests = [], states = [], preferences = [];
  const devicePreferences = { enabled: false, fallbackModel: null, fallbackReasoningEffort: null };
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
  let authorization, callbackResult, responseArrived = false, opened = 0, modelCalls = 0;
  class MockWindow {
    webContents = { on() {}, setWindowOpenHandler() {}, send(_channel, value) {
      states.push(value); if (value.models?.length && !value.error) catalogReady.resolve();
    } };
    loadFile() { return Promise.resolve(); }
    on() {}
  }
  const mockModule = t.mock.module('electron', { namedExports: {
    app: { getVersion: () => '0.1.4', getPath: () => folder, getAppPath: () => folder,
      getName: () => 'Alora Desktop', whenReady: () => Promise.resolve(), on() {}, quit() {} },
    BrowserWindow: MockWindow,
    ipcMain: { handle(name, handler) { handlers.set(name, handler); if (name === 'alora:enable') ready.resolve(); } },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() },
    net: { async fetch(input, init = {}) {
      const url = String(input); requests.push(url);
      if (url.endsWith('/api/local-agent/device/pair')) return Response.json({ deviceId: 'test-device', deviceToken: 'test-only-device-token' });
      if (url.endsWith('/api/local-agent/device/poll')) return Response.json(devicePreferences);
      if (url.endsWith('/api/local-agent/device/preferences')) {
        assert.equal(init.headers.Authorization, 'Device test-only-device-token');
        const body = JSON.parse(init.body); preferences.push(body); Object.assign(devicePreferences, body);
        return Response.json({ ok: true });
      }
      if (url.endsWith('/api/accounts/oauth/token')) {
        tokenStarted.resolve(); await tokenGate;
        if (options.exchangeError) throw options.exchangeError;
        const fields = new URLSearchParams(init.body);
        assert.equal(fields.get('client_id'), 'oaiapp_test');
        assert.equal(fields.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
        assert.equal(fields.get('resource'), 'https://api.openai.com/v1');
        assert.ok(fields.get('code_verifier'));
        const idToken = await new SignJWT({ nonce: options.invalidNonce ? 'wrong' : authorization.searchParams.get('nonce'), email: 'test@example.invalid', name: 'Test account' })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://auth.openai.com')
          .setAudience('oaiapp_test').setSubject('test-account').setIssuedAt().setExpirationTime('5m').sign(privateKey);
        return Response.json({ id_token: idToken, access_token: 'test-only-access', refresh_token: 'test-only-refresh', expires_in: 3600,
          scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' });
      }
      if (url.endsWith('/.well-known/openid-configuration')) return Response.json({ jwks_uri: 'https://auth.openai.com/test-jwks' });
      if (url.endsWith('/test-jwks')) return Response.json({ keys: [jwk] });
      if (url.endsWith('/v1/models')) {
        modelCalls++;
        if (options.modelsFailOnce && modelCalls === 1) throw new TypeError('fetch failed');
        return Response.json({ models: options.models ?? [{ slug: 'test-model', display_name: 'Test model', visibility: 'list' }] });
      }
      throw new Error(`Unexpected network request: ${url}`);
    } },
    shell: { async openExternal(value) {
      opened++; authorization = new URL(value);
      if (options.openError) throw new Error('Browser unavailable');
      const callback = new URL(authorization.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', options.invalidState === true ? 'wrong' : options.invalidState ?? authorization.searchParams.get('state'));
      callback.searchParams.set('code', 'test-only-code'); callback.searchParams.set('client_id', 'oaiapp_test');
      callbackResult = new Promise((resolve, reject) => {
        get(callback, (response) => {
          responseArrived = true;
          let text = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { text += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, text }));
        }).on('error', reject);
      });
    } },
  } });
  t.after(() => mockModule.restore());
  await import(`../src/main.js?test=${randomUUID()}`);
  await ready.promise;
  await handlers.get('alora:pair')(null, 'test_pairing_code_000000000');
  await nextTurn();
  return { signIn: () => handlers.get('alora:signin')(), state: () => handlers.get('alora:state')(), tokenStarted: tokenStarted.promise,
    callback: () => callbackResult, responseArrived: () => responseArrived, opened: () => opened, requests, states, catalogReady: catalogReady.promise,
    preferences, fallback: (model) => handlers.get('alora:fallback')(null, model), effort: (effort) => handlers.get('alora:effort')(null, effort),
    enable: (enabled) => handlers.get('alora:enable')(null, enabled),
    record: async () => JSON.parse(Buffer.from(JSON.parse(await readFile(path.join(folder, 'alora-secure-state.json'), 'utf8')).encrypted, 'base64').toString()) };
}

test('OAuth confirms only after verification, protected storage and UI update; JWKS also uses Electron networking', async (t) => {
  const gate = deferred(), app = await fixture(t, { tokenGate: gate.promise });
  const login = app.signIn();
  await app.tokenStarted;
  for (let i = 0; i < 5; i++) await nextTurn();
  assert.equal(app.responseArrived(), false, 'Browser must not announce success before exchange');
  gate.resolve();
  const state = await login, page = await app.callback(), record = await app.record();
  assert.equal(state.signedIn, true); assert.equal(state.signingIn, false); assert.equal(app.state().signingIn, false);
  assert.equal(record.account.subject, 'test-account'); assert.equal(record.deviceId, 'test-device');
  assert.deepEqual(state.models, [{ slug: 'test-model', displayName: 'Test model', reasoningEfforts: [] }]);
  assert.equal(page.status, 200); assert.match(page.text, /ChatGPT conectado/);
  assert.ok(app.requests.includes('https://auth.openai.com/test-jwks'));
  assert.ok(app.states.some((value) => value.signedIn && value.email === 'test@example.invalid'));
});

test('Connection failure reaches both the desktop and callback page without false success', async (t) => {
  const app = await fixture(t, { exchangeError: new TypeError('fetch failed', { cause: Object.assign(new Error('TLS'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }) }) });
  await assert.rejects(app.signIn(), /certificado de segurança/);
  const page = await app.callback();
  assert.equal(page.status, 502); assert.match(page.text, /Não foi possível conectar/);
  assert.doesNotMatch(page.text, /ChatGPT conectado/);
  assert.equal(app.state().signedIn, false); assert.equal(app.state().signingIn, false);
  assert.equal((await app.record()).account, null);
});

test('A mismatched ID-token nonce is rejected before credentials are stored', async (t) => {
  const app = await fixture(t, { invalidNonce: true });
  await assert.rejects(app.signIn(), /validação de segurança/);
  assert.equal((await app.callback()).status, 502);
  assert.equal(app.state().signedIn, false); assert.equal((await app.record()).account, null);
});

test('Temporary model failure preserves the authenticated account and poll recovers its catalog', { timeout: 3000 }, async (t) => {
  const app = await fixture(t, { modelsFailOnce: true });
  const state = await app.signIn();
  assert.equal(state.signedIn, true); assert.match(state.error, /Conta conectada/);
  assert.equal((await app.callback()).status, 200);
  t.mock.timers.tick(2500);
  await app.catalogReady;
  assert.equal(app.state().models[0]?.slug, 'test-model'); assert.equal(app.state().error, '');
});

test('Repeated sign-in requests share one authorization attempt', async (t) => {
  const gate = deferred(), app = await fixture(t, { tokenGate: gate.promise });
  const first = app.signIn(), second = app.signIn();
  assert.equal(first, second);
  await app.tokenStarted; assert.equal(app.opened(), 1);
  gate.resolve(); await first; await app.callback();
});

test('Invalid callback state is rejected before code exchange', async (t) => {
  const app = await fixture(t, { invalidState: true });
  await assert.rejects(app.signIn(), /estado de segurança/);
  assert.equal((await app.callback()).status, 502);
  assert.equal(app.state().signingIn, false);
});

test('Browser-opening failure clears the pending attempt', async (t) => {
  const app = await fixture(t, { openError: true });
  await assert.rejects(app.signIn(), /Browser unavailable/);
  assert.equal(app.state().signingIn, false);
});

test('Non-ASCII callback state of equal character length is safely rejected', async (t) => {
  const app = await fixture(t, { invalidState: 'é'.repeat(43) });
  await assert.rejects(app.signIn(), /estado de segurança/);
  assert.equal((await app.callback()).status, 502);
});

test('Desktop saves fallback model and effort with scoped device auth and returns updated UI state', async (t) => {
  const app = await fixture(t, { models: [{ slug: 'gpt-6-sol', display_name: 'Sol', visibility: 'list' }] });
  await app.signIn(); await app.callback();
  assert.equal((await app.enable(true)).enabled, true, 'Activation must not require a primary model override');
  assert.equal((await app.fallback('gpt-6-sol')).fallbackModel, 'gpt-6-sol');
  assert.equal((await app.effort('xhigh')).fallbackReasoningEffort, 'xhigh');
  assert.deepEqual(app.preferences, [{ enabled: true }, { fallbackModel: 'gpt-6-sol', fallbackReasoningEffort: null }, { fallbackReasoningEffort: 'xhigh' }]);
  assert.equal((await app.fallback('')).fallbackReasoningEffort, null);
  assert.deepEqual(app.preferences.at(-1), { fallbackModel: null, fallbackReasoningEffort: null });
  assert.ok(app.state().models[0].reasoningEfforts.includes('xhigh'));
});

test('Upgrade preserves login and makes effort choices available from the previous cached catalog immediately', async (t) => {
  const app = await fixture(t, { restoreModels: [{ slug: 'gpt-6-astra', displayName: 'Astra' }] });
  assert.equal(app.state().signedIn, true);
  assert.ok(app.state().models[0].reasoningEfforts.includes('xhigh'));
  assert.ok(!app.state().models[0].reasoningEfforts.includes('none'));
  assert.equal(app.opened(), 0);
  assert.equal((await app.record()).account.refreshToken, 'test-only-refresh');
});
