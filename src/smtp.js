// Envio por SMTP autenticado com OAuth (XOAUTH2), feito a partir deste computador.
//
// Por que existe: a Microsoft recusa (550 5.7.708) e-mails de contas Microsoft 365 novas quando
// saem de servidores de nuvem, e aceita quando saem da internet da pessoa. A Alora prepara o
// e-mail final e um token de SMTP de curta duração; este módulo só entrega pela conexão local.
// Cliente mínimo: STARTTLS, AUTH XOAUTH2, MAIL/RCPT/DATA, QUIT. Corpo em base64 (acentos e
// linhas longas passam intactos).
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

const EMAIL = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+$/;
const endereco = (v) => {
  const e = String(v ?? '').trim().toLowerCase();
  if (!EMAIL.test(e)) throw new Error(`Endereço de e-mail inválido: ${e || '(vazio)'}`);
  return e;
};
const semQuebra = (v) => String(v ?? '').replace(/[\r\n\u0000]/g, ' ').trim();
const cabecalhoTexto = (v) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`);
const base64Linhas = (texto) => (Buffer.from(texto, 'utf8').toString('base64').match(/.{1,76}/g) ?? ['']).join('\r\n');

export function respostaXoauth2(usuario, accessToken) {
  return Buffer.from(`user=${usuario}\x01auth=Bearer ${accessToken}\x01\x01`, 'utf8').toString('base64');
}

/**
 * Mensagem completa (RFC 5322) com remetente, data e Message-ID do domínio da conta. Com `html`,
 * vai como multipart/alternative (texto + HTML: o "clique aqui" do descadastro tem link); com
 * `descadastro`, leva o cabeçalho List-Unsubscribe que Outlook e Gmail mostram como "Cancelar inscrição".
 */
export function montarMensagem({ de, nome, para, assunto, corpo, html, descadastro }, opcoes = {}) {
  const remetente = endereco(de); const destino = endereco(para);
  const dominio = remetente.split('@')[1];
  const messageId = `<${opcoes.id ?? randomUUID()}@${dominio}>`;
  const nomeLimpo = semQuebra(nome).replace(/"/g, "'");
  const linhas = [
    `From: ${nomeLimpo ? `${cabecalhoTexto(nomeLimpo)} <${remetente}>` : remetente}`, `To: ${destino}`,
    `Subject: ${cabecalhoTexto(semQuebra(assunto) || '(sem assunto)')}`, `Date: ${(opcoes.agora ?? new Date()).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId}`, 'MIME-Version: 1.0',
  ];
  const sair = /^https:\/\/[^\s<>]+$/.test(String(descadastro ?? '')) ? String(descadastro) : '';
  if (sair) linhas.push(`List-Unsubscribe: <${sair}>`);
  if (html) {
    const fronteira = `alora-${randomUUID()}`;
    linhas.push(`Content-Type: multipart/alternative; boundary="${fronteira}"`, '',
      `--${fronteira}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', base64Linhas(String(corpo ?? '')),
      `--${fronteira}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', base64Linhas(String(html)),
      `--${fronteira}--`, '');
  } else {
    linhas.push('Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', base64Linhas(String(corpo ?? '')), '');
  }
  return { mensagem: linhas.join('\r\n'), messageId, remetente, destino };
}

/**
 * Erro no formato que a Alora já entende (`microsoft_email_<status>: …`): login recusado → 403,
 * destinatário recusado → 400, demais recusas → 503. Sem resposta depois do conteúdo → `incerto`
 * (pode ter saído; a Alora congela para conferir e não reenvia sozinha).
 */
export class ErroSmtp extends Error {
  constructor(codigo, etapa, texto, incerto = false) {
    const status = incerto ? 0 : (codigo === 535 || codigo === 530 || codigo === 534 || /AUTH/.test(etapa)) ? 403
      : etapa === 'RCPT' && codigo >= 500 ? 400 : codigo >= 400 ? 503 : 0;
    super(status ? `microsoft_email_${status}: SMTP ${codigo || ''} ${etapa} ${texto}`.replace(/\s+/g, ' ').trim().slice(0, 300) : `SMTP ${etapa}: ${texto}`.slice(0, 300));
    this.incerto = incerto;
  }
}

function leitor(socket, prazoMs) {
  let buffer = ''; let linhas = []; let esperando = null; let falha = null; const prontas = [];
  const aoDados = (d) => {
    buffer += d.toString('utf8'); let i;
    while ((i = buffer.indexOf('\r\n')) >= 0) {
      const linha = buffer.slice(0, i); buffer = buffer.slice(i + 2); linhas.push(linha);
      if (/^\d{3}( |$)/.test(linha)) {
        const r = { codigo: Number(linha.slice(0, 3)), texto: linhas.map((l) => l.slice(4)).join(' ') }; linhas = [];
        if (esperando) { const e = esperando; esperando = null; falha = null; e(r); } else prontas.push(r);
      }
    }
  };
  const aoErro = (e) => { if (falha) { const f = falha; esperando = null; falha = null; f(e); } };
  const aoFechar = () => aoErro(new Error('conexão encerrada pelo servidor'));
  socket.on('data', aoDados); socket.on('error', aoErro); socket.on('close', aoFechar);
  return {
    proxima(etapa) {
      const pronta = prontas.shift(); if (pronta) return Promise.resolve(pronta);
      return new Promise((ok, erro) => {
        const t = setTimeout(() => { esperando = null; falha = null; erro(new Error(`tempo esgotado em ${etapa}`)); }, prazoMs);
        esperando = (r) => { clearTimeout(t); ok(r); }; falha = (e) => { clearTimeout(t); erro(e); };
      });
    },
    soltar() { socket.off('data', aoDados); socket.off('error', aoErro); socket.off('close', aoFechar); },
  };
}

const conectarPadrao = (host, port) => net.connect({ host, port });
const tlsPadrao = (socket, host) => new Promise((ok, erro) => {
  const seguro = tls.connect({ socket, servername: host }, () => ok(seguro));
  seguro.once('error', erro);
});

/** Envia um e-mail; devolve o Message-ID. `smtp` = { host, port?, usuario, accessToken, nome? }. */
export async function enviarSmtp(smtp, { para, assunto, corpo, html, descadastro }, deps = {}) {
  const prazo = deps.prazoMs ?? 30_000;
  const { mensagem, messageId, remetente, destino } = montarMensagem({ de: smtp.usuario, nome: smtp.nome, para, assunto, corpo, html, descadastro });
  let socket = (deps.conectar ?? conectarPadrao)(smtp.host, smtp.port ?? 587);
  let r = leitor(socket, prazo); let enviado = false;
  const passo = async (etapa, linha, esperado) => {
    if (linha !== null) socket.write(`${linha}\r\n`);
    let resposta;
    try { resposta = await r.proxima(etapa); } catch (e) { throw new ErroSmtp(0, etapa, e.message, enviado); }
    if (!esperado.includes(resposta.codigo)) throw new ErroSmtp(resposta.codigo, etapa, resposta.texto);
    return resposta;
  };
  try {
    await passo('CONN', null, [220]);
    const helo = `EHLO ${remetente.split('@')[1]}`;
    const ehlo = await passo('EHLO', helo, [250]);
    if (/STARTTLS/i.test(ehlo.texto)) {
      await passo('STARTTLS', 'STARTTLS', [220]);
      r.soltar(); socket = await (deps.iniciarTls ?? tlsPadrao)(socket, smtp.host); r = leitor(socket, prazo);
      await passo('EHLO', helo, [250]);
    } else if (!deps.iniciarTls) throw new ErroSmtp(0, 'STARTTLS', 'o servidor não oferece conexão segura');
    await passo('AUTH XOAUTH2', `AUTH XOAUTH2 ${respostaXoauth2(remetente, smtp.accessToken)}`, [235]);
    await passo('MAIL', `MAIL FROM:<${remetente}>`, [250]);
    await passo('RCPT', `RCPT TO:<${destino}>`, [250, 251]);
    await passo('DATA', 'DATA', [354]);
    socket.write(`${mensagem.replace(/\r\n\./g, '\r\n..')}\r\n.\r\n`);
    enviado = true;
    await passo('FIM', null, [250]);
    socket.write('QUIT\r\n');
    return { messageId };
  } finally { r.soltar(); socket.end(); }
}

