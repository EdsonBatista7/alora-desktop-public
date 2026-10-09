import { app, BrowserWindow, ipcMain, net, safeStorage, shell } from 'electron';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { reasoningEfforts } from './model-capabilities.js';
import { executarTarefaResponses } from './responses-executor.js';

const APP_VERSION = app.getVersion();
const ALORA_API = 'https://app.sintoniaads.com';
const OPENAI_AUTH = 'https://auth.openai.com';
const OPENAI_RESOURCE = 'https://api.openai.com/v1';
const CALLBACK_PATH = '/auth/callback';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
let mainWindow;
let encryptedState = null;
let account = null;
let hostId = randomUUID();
let polling = false;
let pollRequested = false;
let pollTimer = null;
// Tarefas simultâneas: a Alora produz em lote (vários posts, funcionários em paralelo). Uma por vez
// fazia a fila estourar o prazo e as chamadas caírem na API com o computador ligado.
const MAX_PARALLEL_JOBS = 3;
let activeJobs = 0;
let refreshPromise = null;
let signInPromise = null;
let currentStatus = { appVersion: APP_VERSION, paired: false, signedIn: false, signingIn: false, enabled: false, models: [], error: '' };

const statePath = () => path.join(app.getPath('userData'), 'alora-secure-state.json');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const base64url = (value) => Buffer.from(value).toString('base64url');
const safeMessage = (value) => String(value?.message ?? value ?? 'Falha de comunicação.').replace(/[\r\n]/g, ' ').slice(0, 260);

async function persist() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('O Windows não disponibilizou a proteção local de credenciais (DPAPI).');
  const record = { hostId, account, deviceId: encryptedState?.deviceId ?? null, deviceToken: encryptedState?.deviceToken ?? null };
  const encrypted = safeStorage.encryptString(JSON.stringify(record)).toString('base64');
  const target = statePath(), temporary = `${target}.tmp`;
  await writeFile(temporary, JSON.stringify({ encrypted }), { mode: 0o600 });
  await rename(temporary, target);
}

async function restore() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    const file = JSON.parse(await readFile(statePath(), 'utf8'));
    const record = JSON.parse(safeStorage.decryptString(Buffer.from(file.encrypted, 'base64')));
    if (typeof record.hostId === 'string') hostId = record.hostId;
    account = record.account ?? null;
    // Upgrades preserve login and enrich the cached 0.1.4 catalog immediately, without waiting five minutes.
    if (account && Array.isArray(account.models))
      account.models = account.models.map((model) => ({ ...model, reasoningEfforts: reasoningEfforts(model.slug) }));
    encryptedState = { deviceId: record.deviceId ?? null, deviceToken: record.deviceToken ?? null };
  } catch { encryptedState = { deviceId: null, deviceToken: null }; }
  if (!encryptedState) encryptedState = { deviceId: null, deviceToken: null };
}

function setStatus(patch) {
  currentStatus = { ...currentStatus, ...patch };
  mainWindow?.webContents.send('alora:state-changed', currentStatus);
}

function networkLabel(url) {
  const hostname = new URL(url).hostname;
  if (hostname === 'auth.openai.com' || hostname.endsWith('.openai.com')) return 'o ChatGPT';
  if (hostname === new URL(ALORA_API).hostname) return 'a Alora';
  return 'o serviço remoto';
}

/** Use Chromium's network stack so Windows trust roots and configured proxies apply. */
async function secureFetch(url, init = {}, label = networkLabel(url)) {
  try {
    return await net.fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) });
  } catch (error) {
    const code = error?.cause?.code ?? error?.code;
    if (['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'ERR_CERT_AUTHORITY_INVALID'].includes(code)) {
      throw new Error(`O certificado de segurança da conexão com ${label} não foi reconhecido pelo Windows. Confira o antivírus, a VPN ou o proxy e tente novamente.`, { cause: error });
    }
    if (error?.name === 'TypeError' && /fetch failed|failed to fetch/i.test(error.message)) {
      throw new Error(`Não foi possível concluir a conexão com ${label}. Verifique sua internet e tente novamente.`, { cause: error });
    }
    if (error?.name === 'TimeoutError') throw new Error(`A conexão com ${label} demorou demais. Tente novamente.`, { cause: error });
    throw error;
  }
}

function callbackPage(success, message) {
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const title = success ? 'ChatGPT conectado' : 'Não foi possível conectar';
  const color = success ? '#087f5b' : '#c92a2a';
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Alora Desktop</title><body style="margin:0;background:#f7f8fc;color:#17243b;font:16px system-ui,-apple-system,Segoe UI,sans-serif"><main style="max-width:520px;margin:12vh auto;padding:32px;background:#fff;border:1px solid #e0e6f0;border-radius:18px;box-shadow:0 12px 32px #20345c12"><div style="font-size:13px;font-weight:700;letter-spacing:.12em;color:#2864f0">ALORA DESKTOP</div><h1 style="margin:16px 0 8px;color:${color};font-size:25px">${title}</h1><p style="line-height:1.6">${escapeHtml(message)}</p></main></body></html>`;
}

async function requestJson(url, init = {}) {
  const response = await secureFetch(url, { ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}) } });
  const text = await response.text();
  let body = {};
  if (text) { try { body = JSON.parse(text); } catch { throw new Error('A Alora devolveu uma resposta inválida.'); } }
  if (!response.ok) throw new Error(body.error ?? `Falha HTTP ${response.status}.`);
  return body;
}

async function aloraRequest(pathname, init = {}) {
  if (!encryptedState?.deviceToken) throw new Error('Pareie o computador com a Alora primeiro.');
  return requestJson(`${ALORA_API}/api/local-agent${pathname}`, {
    ...init,
    headers: { Authorization: `Device ${encryptedState.deviceToken}`, ...(init.headers ?? {}) },
  });
}

function randomVerifier() { return base64url(randomBytes(32)); }

function sendCallbackResult(response, success, message) {
  if (!response || response.writableEnded) return;
  response.writeHead(success ? 200 : 502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(callbackPage(success, message));
}

async function waitForCallback(server, callback, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); server.close(); };
    const abort = () => { stop(); reject(new Error('O login foi interrompido. Tente conectar novamente.')); };
    const timer = setTimeout(() => { stop(); reject(new Error('O login expirou. Tente conectar novamente.')); }, 180_000);
    signal?.addEventListener('abort', abort, { once: true });
    server.on('request', (request, response) => {
      const callbackUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method !== 'GET' || callbackUrl.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end('Not found'); return;
      }
      const returnedState = callbackUrl.searchParams.get('state') ?? '';
      const receivedStateBytes = Buffer.from(returnedState), expectedStateBytes = Buffer.from(callback.state ?? '');
      if (!callback.state || receivedStateBytes.length !== expectedStateBytes.length
        || !timingSafeEqual(receivedStateBytes, expectedStateBytes)) {
        sendCallbackResult(response, false, 'A validação de segurança do login não corresponde. Volte ao Alora Desktop e tente novamente.');
        stop(); reject(new Error('O estado de segurança do login não corresponde.')); return;
      }
      const error = callbackUrl.searchParams.get('error');
      const code = callbackUrl.searchParams.get('code');
      const issuedClientId = callbackUrl.searchParams.get('client_id') ?? callback.clientId;
      if (error) {
        const message = error === 'access_denied' ? 'O acesso ao plano do ChatGPT não foi autorizado.' : `Login recusado (${error}).`;
        sendCallbackResult(response, false, message); stop(); reject(new Error(message));
      } else if (!code || !issuedClientId || issuedClientId === 'dynamic_agent_client') {
        const message = 'O registro do aplicativo não foi concluído pelo OpenAI. Tente conectar novamente.';
        sendCallbackResult(response, false, message); stop(); reject(new Error(message));
      } else {
        stop();
        resolve({ code, clientId: issuedClientId, response });
      }
    });
  });
}

async function discoverOpenAI() {
  const response = await secureFetch(`${OPENAI_AUTH}/.well-known/openid-configuration`, { headers: { Accept: 'application/json' } }, 'o ChatGPT');
  if (!response.ok) throw new Error('Não foi possível validar a identidade do ChatGPT.');
  return response.json();
}

async function exchangeToken(fields) {
  const body = new URLSearchParams(fields);
  const response = await secureFetch(`${OPENAI_AUTH}/api/accounts/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body,
  }, 'o ChatGPT');
  const raw = await response.text(); let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { /* sanitized below */ }
  if (!response.ok) throw Object.assign(new Error(payload.error_description ?? payload.error ?? `Login falhou (HTTP ${response.status}).`), { code: payload.error });
  return payload;
}

function signIn() {
  if (signInPromise) return signInPromise;
  setStatus({ signingIn: true, error: '' });
  signInPromise = performSignIn().catch((error) => {
    setStatus({ error: safeMessage(error) });
    throw error;
  }).finally(() => { signInPromise = null; setStatus({ signingIn: false }); }).then(() => currentStatus);
  return signInPromise;
}

async function performSignIn() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('A proteção de credenciais do Windows está indisponível.');
  const oauthState = base64url(randomBytes(32));
  const nonce = base64url(randomBytes(32));
  const verifier = randomVerifier();
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Não consegui abrir o retorno local do login.');
  const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
  const returning = !!account?.clientId;
  const pending = { state: oauthState, clientId: returning ? account.clientId : undefined };
  const authorization = new URL(`${OPENAI_AUTH}/api/accounts/authorize`);
  const params = {
    client_id: returning ? account.clientId : 'dynamic_agent_client',
    response_type: 'code', redirect_uri: redirectUri, scope: SCOPES,
    resource: OPENAI_RESOURCE, state: oauthState, nonce,
    code_challenge_method: 'S256', code_challenge: challenge,
    ext_agent_host_id: `urn:uuid:${hostId}`,
  };
  if (!returning) params.agent_name_hint = 'Alora Desktop';
  else if (account.idToken) params.id_token_hint = account.idToken;
  else if (account.email) params.login_hint = account.email;
  for (const [key, value] of Object.entries(params)) authorization.searchParams.set(key, value);
  const callbackAbort = new AbortController();
  const callbackPromise = waitForCallback(server, pending, callbackAbort.signal);
  // Opening the browser can fail before the callback is awaited.
  void callbackPromise.catch(() => {});
  let callbackResponse = null;
  try {
    await shell.openExternal(authorization.toString());
    const { code, clientId, response } = await callbackPromise;
    callbackResponse = response;
    if (returning && clientId !== account.clientId) throw new Error('O login retornou uma conta diferente da selecionada.');
    const tokens = await exchangeToken({ grant_type: 'authorization_code', client_id: clientId, code,
      code_verifier: verifier, redirect_uri: redirectUri, resource: OPENAI_RESOURCE });
    const scopes = String(tokens.scope ?? '').split(/\s+/).filter(Boolean);
    if (!scopes.includes('chatgpt.tokens.use.direct') || !scopes.includes('resource.invoke'))
      throw new Error('O ChatGPT não concedeu a permissão necessária para executar tarefas no plano.');
    const discovery = await discoverOpenAI();
    if (!discovery.jwks_uri) throw new Error('Não foi possível validar o retorno seguro do OpenAI.');
    const keys = createRemoteJWKSet(new URL(discovery.jwks_uri), {
      [customFetch]: (url, options) => secureFetch(url, options, 'o ChatGPT'),
    });
    const verified = await jwtVerify(tokens.id_token, keys, {
      issuer: 'https://auth.openai.com', audience: clientId, requiredClaims: ['exp', 'sub', 'nonce'],
    });
    const claims = verified.payload;
    if (claims.nonce !== nonce) throw new Error('A validação de segurança do ChatGPT não corresponde a este login. Tente novamente.');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('O ChatGPT não retornou uma identidade válida.');
    if (returning && account?.subject && claims.sub !== account.subject)
      throw new Error('A identidade autenticada não corresponde à conta ChatGPT já vinculada.');
    account = {
      clientId, subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : '',
      displayName: typeof claims.name === 'string' ? claims.name : '', idToken: tokens.id_token,
      accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + Number(tokens.expires_in ?? 3600) * 1000,
      scopes, models: [],
    };
    await persist();
    setStatus({ signedIn: true, email: account.email, displayName: account.displayName, models: [], error: '' });
    try {
      account.models = await listModels();
      account.modelsAt = Date.now();
      await persist();
      setStatus({ models: account.models, error: '' });
    } catch (error) {
      setStatus({ error: `Conta conectada. Não consegui carregar os modelos agora: ${safeMessage(error)}` });
    }
    sendCallbackResult(callbackResponse, true, currentStatus.error
      ? 'A conta está conectada. Volte ao Alora Desktop; a lista de modelos será carregada novamente.'
      : 'A autorização foi validada. Volte ao Alora Desktop para ativar. Cada funcionário usará seu próprio modelo e esforço.');
    callbackResponse = null;
    return currentStatus;
  } catch (error) {
    sendCallbackResult(callbackResponse, false, safeMessage(error));
    server.close(); throw error;
  } finally {
    callbackAbort.abort();
  }
}

async function accessToken(force = false) {
  if (!account?.refreshToken || !account?.clientId) throw Object.assign(new Error('Faça login novamente no ChatGPT.'), { code: 'oauth_reauth_required' });
  if (!force && account.accessToken && account.expiresAt > Date.now() + 90_000) return account.accessToken;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const tokens = await exchangeToken({ grant_type: 'refresh_token', client_id: account.clientId,
        refresh_token: account.refreshToken, resource: OPENAI_RESOURCE });
      account.accessToken = tokens.access_token;
      account.refreshToken = tokens.refresh_token ?? account.refreshToken;
      account.expiresAt = Date.now() + Number(tokens.expires_in ?? 3600) * 1000;
      account.scopes = String(tokens.scope ?? account.scopes.join(' ')).split(/\s+/).filter(Boolean);
      if (!account.scopes.includes('chatgpt.tokens.use.direct')) throw new Error('A permissão de uso do plano não está mais ativa.');
      await persist();
      return account.accessToken;
    } catch (error) {
      if (error.code === 'invalid_grant' || error.code === 'invalid_refresh_token') {
        setStatus({ signedIn: false, enabled: false, error: 'A sessão do ChatGPT expirou. Conecte a conta novamente.' });
        account.accessToken = ''; account.refreshToken = ''; await persist();
        throw Object.assign(new Error('Faça login novamente no ChatGPT.'), { code: 'oauth_reauth_required' });
      }
      throw error;
    } finally { refreshPromise = null; }
  })();
  return refreshPromise;
}

async function listModels() {
  const token = await accessToken();
  const body = await requestJson(`${OPENAI_RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` } });
  if (!Array.isArray(body.models)) throw new Error('O catálogo do ChatGPT veio em formato inesperado.');
  return body.models.filter((item) => item?.visibility === 'list' && typeof item.slug === 'string')
    .map((item) => ({ slug: item.slug, displayName: String(item.display_name ?? item.slug).slice(0, 100),
      reasoningEfforts: reasoningEfforts(item.slug) })).slice(0, 200);
}

async function pair(code) {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(String(code ?? '').trim())) throw new Error('Cole o código de pareamento gerado em Alora → Perfil.');
  const result = await requestJson(`${ALORA_API}/api/local-agent/device/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: String(code).trim(), name: app.getName() === 'Electron' ? 'Este computador' : app.getName(), appVersion: APP_VERSION }),
  });
  encryptedState = { deviceId: result.deviceId, deviceToken: result.deviceToken };
  await persist();
  setStatus({ paired: true, deviceId: result.deviceId, enabled: false, error: '' });
  return currentStatus;
}

async function postJobResult(job, value) {
  await aloraRequest('/device/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: job.id, claimId: job.claimId, ...value }) });
}

async function runInference(job) {
  return executarTarefaResponses(job, { accessToken, secureFetch, postJobResult });
}

async function doPoll() {
  if (polling) { pollRequested = true; return; }
  polling = true;
  try {
    if (!encryptedState?.deviceToken) { setStatus({ paired: false, signedIn: !!account, enabled: false }); return; }
    let models = account?.refreshToken ? account.models ?? [] : [];
    let modelError = '';
    if (account?.refreshToken && !currentStatus.signingIn) {
      try {
        if (!account.models?.length || !account.modelsAt || account.modelsAt < Date.now() - 5 * 60_000) {
          account.models = await listModels(); account.modelsAt = Date.now(); await persist();
        }
        models = account.models;
      } catch (error) {
        const needsSignin = error.code === 'oauth_reauth_required';
        if (needsSignin) models = [];
        modelError = safeMessage(error);
        setStatus({ signedIn: !needsSignin, enabled: false, error: modelError });
      }
    }
    // O poll também é o sinal de vida: continua durante as tarefas, pedindo trabalho só se há vaga.
    const slots = account?.refreshToken && !currentStatus.signingIn && !modelError ? Math.max(0, MAX_PARALLEL_JOBS - activeJobs) : 0;
    const state = await aloraRequest('/device/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models, appVersion: APP_VERSION, slots }) });
    setStatus({ paired: true, signedIn: !!account?.refreshToken, email: account?.email ?? '',
      displayName: account?.displayName ?? '', models: account?.models ?? models, enabled: state.enabled,
      fallbackModel: state.fallbackModel ?? state.selectedModel ?? null,
      fallbackReasoningEffort: state.fallbackReasoningEffort ?? null, online: true, error: modelError });
    if (state.job) {
      activeJobs++;
      setStatus({ busy: true });
      void runInference(state.job).finally(() => {
        activeJobs--;
        setStatus({ busy: activeJobs > 0 });
        schedulePoll(150);
      });
      // Pode haver mais tarefas na fila: busca a próxima logo, enquanto houver vaga.
      if (activeJobs < MAX_PARALLEL_JOBS) pollRequested = true;
    }
  } catch (error) {
    const message = safeMessage(error);
    if (/revogado/i.test(message)) { encryptedState = { deviceId: null, deviceToken: null }; await persist(); setStatus({ paired: false, enabled: false }); }
    else setStatus({ online: false, error: message });
  } finally {
    polling = false;
    const requested = pollRequested; pollRequested = false;
    schedulePoll(requested ? 150 : 2_500);
  }
}

/** Um único relógio de poll: chamadas de IPC e fim de tarefa antecipam o próximo, sem duplicar o laço. */
function schedulePoll(ms) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => { pollTimer = null; void doPoll(); }, ms);
}

async function logout() {
  const previous = account;
  if (previous?.refreshToken) {
    try {
      const discovery = await discoverOpenAI();
      if (discovery.revocation_endpoint) {
        await secureFetch(discovery.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: previous.refreshToken, token_type_hint: 'refresh_token', client_id: previous.clientId }) }, 'o ChatGPT');
      }
    } catch { /* local sign-out still clears local credentials */ }
  }
  account = null; await persist();
  setStatus({ signedIn: false, email: '', displayName: '', models: [], error: '' });
  void doPoll();
  return currentStatus;
}

async function updateDevice(body) {
  if (!encryptedState?.deviceId) throw new Error('Pareie o computador com a Alora primeiro.');
  await aloraRequest('/device/preferences', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  setStatus(body); schedulePoll(150); return currentStatus;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 760, height: 720, minWidth: 620, minHeight: 600,
    title: 'Alora Desktop', backgroundColor: '#f7f8fc',
    webPreferences: { preload: path.join(app.getAppPath(), 'src/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false },
  });
  const localUi = pathToFileURL(path.join(app.getAppPath(), 'src/index.html')).href;
  mainWindow.webContents.on('will-navigate', (event, target) => { if (target !== localUi) event.preventDefault(); });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void mainWindow.loadFile(path.join(app.getAppPath(), 'src/index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  await restore();
  createWindow();
  currentStatus = { ...currentStatus, paired: !!encryptedState?.deviceToken, signedIn: !!account?.refreshToken,
    email: account?.email ?? '', displayName: account?.displayName ?? '', models: account?.models ?? [] };
  ipcMain.handle('alora:state', () => currentStatus);
  ipcMain.handle('alora:pair', async (_event, code) => { const result = await pair(code); void doPoll(); return result; });
  ipcMain.handle('alora:signin', () => signIn());
  ipcMain.handle('alora:signout', () => logout());
  ipcMain.handle('alora:fallback', (_event, slug) => updateDevice({ fallbackModel: slug || null, fallbackReasoningEffort: null }));
  ipcMain.handle('alora:effort', (_event, effort) => updateDevice({ fallbackReasoningEffort: effort || null }));
  ipcMain.handle('alora:enable', (_event, enabled) => updateDevice({ enabled: !!enabled }));
  void doPoll();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
