// Fila de e-mails da prospecção (modo "Alora Desktop" da Rotina diária): lista, seleção, limite,
// intervalo e progresso. O envio em si acontece no processo principal (main.js + smtp.js).
const api = window.aloraDesktop;
const $ = (id) => document.getElementById(id);
const emailCard = $('emailCard'), filaLista = $('filaLista'), filaInfo = $('filaInfo'), message = $('message');
let fila = []; const statusItem = new Map(); let enviando = false; let carregouUmaVez = false;
const ETAPAS = { primeira_abordagem: 'Primeira abordagem', qualificacao: 'Qualificação' };
const etapaTexto = (e) => ETAPAS[e] ?? (String(e).startsWith('follow_up') ? 'Follow-up' : 'Abordagem');
const STATUS = { enviando: 'Enviando…', enviado: 'Enviado', erro: 'Não enviado', sem_registro: 'Enviado (conferir)' };

function aviso(texto, tipo = '') { message.textContent = texto; message.className = `status ${tipo}`; }
function el(tag, attrs = {}, texto = '') {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (texto) n.textContent = texto;
  return n;
}

function selecionados() { return [...filaLista.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.getAttribute('data-id')); }
function atualizarContagem() { $('filaContagem').textContent = `${selecionados().length} selecionado(s)`; }

function desenharFila() {
  const marcados = new Set(selecionados());
  filaLista.replaceChildren();
  $('filaCabecalho').hidden = !fila.length;
  if (!fila.length) { filaInfo.textContent = 'Nenhum e-mail na fila. Confira se a Rotina diária está em "Você, pelo Alora Desktop" e se há leads novos.'; return; }
  const primeiro = fila[0];
  filaInfo.textContent = `${fila.length} e-mail(s) na fila · enviados hoje: ${primeiro.enviados_hoje} de ${primeiro.envios_dia} (limite "Envios/dia" da Rotina) · remetente: ${primeiro.remetente ?? '—'}`;
  for (const item of fila) {
    const st = statusItem.get(item.id);
    const linha = el('div', { class: 'fila-item' });
    const caixa = el('input', { type: 'checkbox', 'data-id': item.id, 'aria-label': `Selecionar ${item.empresa || item.para}` });
    caixa.checked = marcados.has(item.id) && st?.status !== 'enviado' && st?.status !== 'sem_registro';
    caixa.disabled = enviando || st?.status === 'enviado' || st?.status === 'sem_registro';
    const texto = el('div', { class: 'texto' });
    texto.append(el('b', {}, `${item.empresa || item.para} — ${item.para}`));
    texto.append(el('small', {}, `${item.assunto || '(sem assunto)'} · ${etapaTexto(item.etapa)}${item.campanha ? ` · ${item.campanha}` : ''} · ${item.marca}`));
    texto.append(el('small', { class: 'previa' }, item.previa));
    if (st?.erro) texto.append(el('small', { class: 'previa' }, st.erro));
    linha.append(caixa, texto);
    if (st) linha.append(el('span', { class: `chip ${st.status}` }, STATUS[st.status] ?? st.status));
    filaLista.append(linha);
  }
  atualizarContagem();
}

// Depois de um lote (manual ou automático), a lista reflete o que saiu.
function carregarFilaDepois() { return new Promise((ok) => setTimeout(() => { void carregarFila().finally(ok); }, 1500)); }

async function carregarFila() {
  if (enviando) return;
  $('filaAtualizar').disabled = true; filaInfo.textContent = 'Buscando a fila na Alora…';
  try { fila = await api.fila(); statusItem.clear(); desenharFila(); }
  catch (error) { filaInfo.textContent = error?.message ?? 'Não consegui buscar a fila.'; }
  finally { $('filaAtualizar').disabled = false; }
}

filaLista.addEventListener('change', atualizarContagem);
$('filaTodos').addEventListener('change', (e) => {
  for (const c of filaLista.querySelectorAll('input[type=checkbox]')) if (!c.disabled) c.checked = e.target.checked;
  atualizarContagem();
});
$('filaAtualizar').addEventListener('click', carregarFila);
$('filaEnviar').addEventListener('click', async () => {
  const maximo = Math.max(1, Math.min(500, Number($('filaMax').value) || 1));
  const ids = selecionados().slice(0, maximo);
  if (!ids.length) { aviso('Marque ao menos um e-mail da fila.', 'error'); return; }
  const intervalo = Math.max(5, Math.min(600, Number($('filaIntervalo').value) || 30));
  if (!window.confirm(`Enviar ${ids.length} e-mail(s) pela sua conta, um a cada ${intervalo} segundos?`)) return;
  try { await api.enviar(ids, intervalo); }
  catch (error) { aviso(error?.message ?? 'Não foi possível enviar.', 'error'); }
});
$('filaParar').addEventListener('click', () => { void api.parar(); aviso('Parando depois do e-mail atual…'); });

api.onEnvio((evento) => {
  if (evento.tipo === 'inicio') { enviando = true; $('filaEnviar').disabled = true; $('filaParar').hidden = false; aviso(`Enviando ${evento.total} e-mail(s)…`); }
  if (evento.tipo === 'item') statusItem.set(evento.id, { status: evento.status, erro: evento.erro });
  if (evento.tipo === 'aviso') aviso(evento.mensagem, 'error');
  if (evento.tipo === 'fim') {
    void carregarFilaDepois();
    enviando = false; $('filaEnviar').disabled = false; $('filaParar').hidden = true;
    aviso(`${evento.enviados} enviado(s)${evento.falhas ? `, ${evento.falhas} não enviado(s)` : ''}${evento.interrompido ? ' — lote interrompido' : ''}.`, evento.falhas ? 'error' : 'ok');
  }
  desenharFila();
});

// Envio automático: liga/desliga e intervalo; o processo principal faz o resto (a cada 5 minutos).
function mostrarAutomatico(a) {
  if (!a) return;
  $('autoToggle').checked = a.ativo === true;
  $('autoIntervalo').value = String(a.intervaloSegundos ?? 90);
  if (a.janela) $('autoJanela').value = a.janela;
  const proximo = a.proximo ? new Date(a.proximo).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
  $('autoStatus').textContent = a.ativo ? `${a.motivo || 'Ligado.'}${proximo ? ` Próxima conferência às ${proximo}.` : ''}` : 'Desligado: envie pela lista abaixo.';
}
async function salvarAutomatico(patch) {
  try { mostrarAutomatico(await api.salvarAutomatico(patch)); }
  catch (error) { aviso(error?.message ?? 'Não consegui salvar o envio automático.', 'error'); }
}
$('autoToggle').addEventListener('change', (e) => { void salvarAutomatico({ ativo: e.target.checked }); });
$('autoIntervalo').addEventListener('change', (e) => { void salvarAutomatico({ intervaloSegundos: Number(e.target.value) }); });
$('autoJanela').addEventListener('change', (e) => { void salvarAutomatico({ janela: e.target.value }); });
api.onAutomatico(mostrarAutomatico);
api.automatico().then(mostrarAutomatico).catch(() => {});

// A fila aparece quando o computador está pareado com a Alora (não depende do ChatGPT).
function aoEstado(value) {
  emailCard.hidden = !value?.paired;
  if (!emailCard.hidden && !carregouUmaVez) { carregouUmaVez = true; void carregarFila(); }
}
api.onState(aoEstado);
api.state().then(aoEstado).catch(() => {});
