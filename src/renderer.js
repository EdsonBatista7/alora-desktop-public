const api = window.aloraDesktop;
const $ = (id) => document.getElementById(id);
const pairCard = $('pairCard'), pairButton = $('pairButton'), signInButton = $('signinButton');
const modelSelect = $('modelSelect'), enableToggle = $('enableToggle'), message = $('message');
let state;

function showMessage(text = '', kind = '') { message.textContent = text; message.className = `status ${kind}`; }
function render(value) {
  state = value;
  $('connection').textContent = value.error ? 'Atenção necessária' : value.online ? 'Computador conectado' : value.paired ? 'Aguardando conexão' : 'Não conectado';
  $('connection').className = `badge ${value.error ? 'off' : value.enabled ? 'on' : ''}`;
  pairCard.hidden = !!value.paired;
  $('accountName').textContent = value.displayName || (value.signedIn ? 'ChatGPT conectado' : 'Nenhuma conta conectada');
  $('accountEmail').textContent = value.email || (value.signedIn ? 'Conta protegida neste computador' : 'Sua conta continua neste computador');
  signInButton.textContent = value.signedIn ? 'Atualizar conexão' : 'Continuar com ChatGPT';
  signInButton.disabled = !value.paired;
  $('signoutButton').hidden = !value.signedIn;
  enableToggle.checked = !!value.enabled;
  enableToggle.disabled = !value.paired || !value.signedIn || !value.selectedModel;
  const options = value.models ?? [];
  const current = value.selectedModel ?? '';
  modelSelect.innerHTML = '';
  const placeholder = document.createElement('option'); placeholder.value = '';
  placeholder.textContent = options.length ? 'Selecione um modelo' : 'Conecte o ChatGPT para carregar os modelos';
  modelSelect.append(placeholder);
  for (const item of options) { const option = document.createElement('option'); option.value = item.slug; option.textContent = item.displayName; modelSelect.append(option); }
  modelSelect.value = options.some((model) => model.slug === current) ? current : '';
  modelSelect.disabled = !value.paired || !value.signedIn || !options.length;
  const guidance = value.error || (value.busy ? 'Executando uma tarefa da Alora com sua conta ChatGPT…' : value.enabled
    ? 'Pronto. A Alora pode enviar tarefas de texto para este computador.'
    : value.paired && value.signedIn ? 'Escolha um modelo e ative para começar.'
    : value.paired ? 'Computador pareado. Conecte sua conta ChatGPT para continuar.'
    : 'Credenciais protegidas localmente pelo Windows.');
  $('statusText').textContent = guidance;
  if (value.error) showMessage(value.error, 'error');
  else if (value.busy) showMessage(guidance, 'ok');
}

async function action(button, run, success) {
  button.disabled = true; showMessage('Aguarde…');
  try { const result = await run(); render(result ?? await api.state()); if (success) showMessage(success, 'ok'); }
  catch (error) { showMessage(error?.message ?? 'Não foi possível concluir a ação.', 'error'); }
  finally { button.disabled = false; if (button === signInButton && !state?.paired) button.disabled = true; }
}

pairButton.addEventListener('click', () => action(pairButton, () => api.pair($('pairCode').value), 'Computador pareado. Agora conecte o ChatGPT.'));
signInButton.addEventListener('click', () => action(signInButton, () => api.signIn(), 'Conta ChatGPT conectada com segurança.'));
$('signoutButton').addEventListener('click', async () => {
  if (!window.confirm('Desconectar esta conta ChatGPT deste computador?')) return;
  await action($('signoutButton'), () => api.signOut(), 'A conta foi desconectada deste computador.');
});
modelSelect.addEventListener('change', async () => {
  if (!modelSelect.value) return;
  showMessage('Salvando modelo…');
  try { await api.model(modelSelect.value); render(await api.state()); showMessage('Modelo atualizado.', 'ok'); }
  catch (error) { showMessage(error?.message ?? 'Não foi possível salvar o modelo.', 'error'); }
});
enableToggle.addEventListener('change', async () => {
  const enabled = enableToggle.checked; enableToggle.disabled = true;
  try { await api.enable(enabled); render(await api.state()); showMessage(enabled ? 'Executor local ativado.' : 'Executor local pausado.', 'ok'); }
  catch (error) { enableToggle.checked = !enabled; showMessage(error?.message ?? 'Não foi possível alterar o estado.', 'error'); }
  finally { enableToggle.disabled = false; }
});
api.onState(render);
api.state().then(render).catch((error) => showMessage(error.message, 'error'));
