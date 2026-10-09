const api = window.aloraDesktop;
const $ = (id) => document.getElementById(id);
const pairCard = $('pairCard'), pairButton = $('pairButton'), signInButton = $('signinButton');
const enableToggle = $('enableToggle'), message = $('message');
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
  const guidance = value.error || (value.signingIn ? 'Conclua a autorização no navegador. Estou validando sua conexão…' : value.busy ? 'Executando uma tarefa da Alora com sua conta ChatGPT…' : value.enabled
    ? 'Pronto. O computador executa o modelo e o esforço configurados para cada funcionário.'
    : value.paired && value.signedIn ? 'Ative para executar neste computador as tarefas compatíveis com sua conta.'
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
enableToggle.addEventListener('change', async () => {
  const enabled = enableToggle.checked; enableToggle.disabled = true;
  try { await api.enable(enabled); render(await api.state()); showMessage(enabled ? 'Executor local ativado.' : 'Executor local pausado.', 'ok'); }
  catch (error) { enableToggle.checked = !enabled; showMessage(error?.message ?? 'Não foi possível alterar o estado.', 'error'); }
  finally { enableToggle.disabled = false; }
});
api.onState(render);
api.state().then(render).catch((error) => showMessage(error.message, 'error'));
