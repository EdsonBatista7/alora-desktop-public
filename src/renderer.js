import { effortLabels } from './model-capabilities.js';
const api = window.aloraDesktop;
const $ = (id) => document.getElementById(id);
const pairCard = $('pairCard'), pairButton = $('pairButton'), signInButton = $('signinButton');
const modelSelect = $('modelSelect'), effortSelect = $('effortSelect'), enableToggle = $('enableToggle'), message = $('message');
let state;

function showMessage(text = '', kind = '') { message.textContent = text; message.className = `status ${kind}`; }
function render(value) {
  state = value;
  $('appVersion').textContent = value.appVersion ? `· v${value.appVersion}` : '';
  $('connection').textContent = value.error ? 'Atenção necessária' : value.online ? 'Computador conectado' : value.paired ? 'Aguardando conexão' : 'Não conectado';
  $('connection').className = `badge ${value.error ? 'off' : value.enabled ? 'on' : ''}`;
  pairCard.hidden = !!value.paired;
  $('accountName').textContent = value.displayName || (value.signedIn ? 'ChatGPT conectado' : 'Nenhuma conta conectada');
  $('accountEmail').textContent = value.email || (value.signedIn ? 'Conta protegida neste computador' : 'Sua conta continua neste computador');
  signInButton.textContent = value.signingIn ? 'Conectando…' : value.signedIn ? 'Atualizar conexão' : 'Continuar com ChatGPT';
  signInButton.disabled = !value.paired || !!value.signingIn;
  $('signoutButton').disabled = !!value.signingIn;
  $('signoutButton').hidden = !value.signedIn;
  enableToggle.checked = !!value.enabled;
  enableToggle.disabled = !value.paired || !value.signedIn || !value.models?.length || !!value.signingIn;
  const options = value.models ?? [];
  const current = value.fallbackModel ?? '';
  modelSelect.innerHTML = '';
  const placeholder = document.createElement('option'); placeholder.value = '';
  placeholder.textContent = options.length ? 'Sem fallback local' : 'Conecte o ChatGPT para carregar os modelos';
  modelSelect.append(placeholder);
  for (const item of options) { const option = document.createElement('option'); option.value = item.slug; option.textContent = item.displayName; modelSelect.append(option); }
  modelSelect.value = options.some((model) => model.slug === current) ? current : '';
  modelSelect.disabled = !value.paired || !value.signedIn || !options.length || !!value.signingIn;
  const efforts = options.find((model) => model.slug === current)?.reasoningEfforts ?? [];
  effortSelect.replaceChildren();
  const automatic = document.createElement('option'); automatic.value = ''; automatic.textContent = 'Padrão do modelo'; effortSelect.append(automatic);
  for (const effort of efforts) {
    const option = document.createElement('option'); option.value = effort; option.textContent = effortLabels[effort] ?? effort; effortSelect.append(option);
  }
  effortSelect.value = value.fallbackReasoningEffort ?? '';
  effortSelect.disabled = !value.paired || !value.signedIn || !current || !efforts.length || !!value.signingIn;
  const guidance = value.error || (value.signingIn ? 'Conclua a autorização no navegador. Estou validando sua conexão…' : value.busy ? 'Executando uma tarefa da Alora com sua conta ChatGPT…' : value.enabled
    ? 'Pronto. Cada funcionário usa seu modelo e esforço; o fallback local atende quando necessário.'
    : value.paired && value.signedIn ? 'Ative para começar. Você pode definir um modelo e esforço de fallback local.'
    : value.paired ? 'Computador pareado. Conecte sua conta ChatGPT para continuar.'
    : 'Credenciais protegidas localmente pelo Windows.');
  $('statusText').textContent = guidance;
  if (value.error) showMessage(value.error, 'error');
  else if (value.busy) showMessage(guidance, 'ok');
}

async function action(button, run, success) {
  button.disabled = true; showMessage('Aguarde…');
  try { const result = await run(); render(result ?? await api.state()); if (success && !state?.error) showMessage(success, 'ok'); }
  catch (error) { showMessage(error?.message ?? 'Não foi possível concluir a ação.', 'error'); }
  finally { button.disabled = false; if (state) render(state); }
}

pairButton.addEventListener('click', () => action(pairButton, () => api.pair($('pairCode').value), 'Computador pareado. Agora conecte o ChatGPT.'));
signInButton.addEventListener('click', () => action(signInButton, () => api.signIn(), 'Conta ChatGPT conectada com segurança.'));
$('signoutButton').addEventListener('click', async () => {
  if (!window.confirm('Desconectar esta conta ChatGPT deste computador?')) return;
  await action($('signoutButton'), () => api.signOut(), 'A conta foi desconectada deste computador.');
});
modelSelect.addEventListener('change', async () => {
  const slug = modelSelect.value;
  modelSelect.disabled = true; effortSelect.disabled = true; showMessage('Salvando fallback…');
  try { render(await api.fallback(slug)); showMessage('Fallback local atualizado.', 'ok'); }
  catch (error) { showMessage(error?.message ?? 'Não foi possível salvar o modelo.', 'error'); }
  finally { if (state) render(state); }
});
effortSelect.addEventListener('change', async () => {
  const effort = effortSelect.value;
  effortSelect.disabled = true; showMessage('Salvando esforço do fallback…');
  try { render(await api.effort(effort)); showMessage('Esforço do fallback atualizado.', 'ok'); }
  catch (error) { showMessage(error?.message ?? 'Não foi possível salvar o esforço.', 'error'); }
  finally { if (state) render(state); }
});
enableToggle.addEventListener('change', async () => {
  const enabled = enableToggle.checked; enableToggle.disabled = true;
  try { await api.enable(enabled); render(await api.state()); showMessage(enabled ? 'Executor local ativado.' : 'Executor local pausado.', 'ok'); }
  catch (error) { enableToggle.checked = !enabled; showMessage(error?.message ?? 'Não foi possível alterar o estado.', 'error'); }
  finally { enableToggle.disabled = false; }
});
api.onState(render);
api.state().then(render).catch((error) => showMessage(error.message, 'error'));
