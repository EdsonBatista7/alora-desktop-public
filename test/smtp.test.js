import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { enviarSmtp, montarMensagem, respostaXoauth2 } from '../src/smtp.js';

/** Servidor SMTP falso; `respostas` troca a resposta padrão de uma etapa (null = derruba a conexão). */
async function servidor(respostas = {}) {
  const comandos = []; let dados = '';
  const srv = net.createServer((s) => {
    let modoDados = false; let buffer = '';
    const responder = (cmd, padrao) => {
      const r = Object.hasOwn(respostas, cmd) ? respostas[cmd] : padrao;
      if (r === null) { s.destroy(); return; }
      s.write(`${r}\r\n`);
    };
    s.write('220 fake ESMTP\r\n');
    s.on('data', (d) => {
      buffer += d.toString('utf8');
      if (modoDados) {
        const fim = buffer.indexOf('\r\n.\r\n'); if (fim < 0) return;
        dados = buffer.slice(0, fim); buffer = buffer.slice(fim + 5); modoDados = false; responder('FIM', '250 OK'); return;
      }
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const linha = buffer.slice(0, i); buffer = buffer.slice(i + 2); comandos.push(linha);
        const cmd = linha.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO') s.write('250-fake\r\n250 AUTH XOAUTH2\r\n');
        else if (cmd === 'AUTH') responder('AUTH', '235 ok');
        else if (cmd === 'MAIL') responder('MAIL', '250 ok');
        else if (cmd === 'RCPT') responder('RCPT', '250 ok');
        else if (cmd === 'DATA') { responder('DATA', '354 go'); modoDados = true; }
        else if (cmd === 'QUIT') s.end('221 bye\r\n');
      }
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const porta = srv.address().port;
  return { comandos, dados: () => dados, fechar: () => new Promise((ok) => srv.close(ok)),
    deps: { conectar: () => net.connect({ host: '127.0.0.1', port: porta }), iniciarTls: async (s) => s, prazoMs: 3000 } };
}

const smtp = { host: 'smtp.office365.com', usuario: 'edson@romefinancas.com.br', accessToken: 'TK', nome: 'Edson Batista' };
const email = { para: 'Dra@Clinica.com.br', assunto: 'Gestão financeira — conversa?', corpo: 'Olá!\n.linha com ponto\n\nEdson Batista' };

test('envia pelo SMTP com XOAUTH2, remetente da conta e corpo intacto', async () => {
  const s = await servidor();
  try {
    const r = await enviarSmtp(smtp, email, s.deps);
    assert.match(r.messageId, /@romefinancas\.com\.br>$/);
    assert.equal(s.comandos.find((c) => c.startsWith('AUTH')), `AUTH XOAUTH2 ${respostaXoauth2('edson@romefinancas.com.br', 'TK')}`);
    assert.ok(s.comandos.includes('RCPT TO:<dra@clinica.com.br>'));
    const msg = s.dados();
    assert.match(msg, /^From: Edson Batista <edson@romefinancas\.com\.br>\r\n/);
    assert.match(msg, /\r\nSubject: =\?UTF-8\?B\?/);
    const corpo = msg.split('\r\n\r\n')[1].replace(/\r\n/g, '');
    assert.equal(Buffer.from(corpo, 'base64').toString('utf8'), email.corpo);
  } finally { await s.fechar(); }
});

test('login recusado vira 403; recusa 5.7.708 no fim vira 503 com o código; queda após o conteúdo fica incerta', async () => {
  const a = await servidor({ AUTH: '535 5.7.139 Authentication unsuccessful' });
  try { await assert.rejects(enviarSmtp(smtp, email, a.deps), /^Error: microsoft_email_403: SMTP 535 AUTH/); } finally { await a.fechar(); }
  const b = await servidor({ FIM: '550 5.7.708 Access denied, traffic not accepted from this IP' });
  try { await assert.rejects(enviarSmtp(smtp, email, b.deps), /microsoft_email_503: SMTP 550 FIM 5\.7\.708/); } finally { await b.fechar(); }
  const c = await servidor({ FIM: null });
  try {
    const erro = await enviarSmtp(smtp, email, c.deps).catch((e) => e);
    assert.equal(erro.incerto, true);
    assert.match(erro.message, /^SMTP FIM:/);
  } finally { await c.fechar(); }
});

test('endereço inválido não chega a conectar', () => {
  assert.throws(() => montarMensagem({ de: 'edson@romefinancas.com.br', para: 'sem-arroba', assunto: 'x', corpo: 'y' }), /inválido/);
  const { mensagem } = montarMensagem({ de: 'a@b.com', para: 'c@d.com', assunto: 'Oi', corpo: 'x' }, { agora: new Date('2026-10-20T12:00:00Z'), id: 'id1' });
  assert.match(mensagem, /Date: Tue, 20 Oct 2026 12:00:00 \+0000/);
  assert.match(mensagem, /Message-ID: <id1@b\.com>/);
});

test('com HTML vai texto + HTML (multipart) e List-Unsubscribe', () => {
  const { mensagem } = montarMensagem({ de: 'a@b.com', para: 'c@d.com', assunto: 'Oi', corpo: 'texto', html: '<p>oi <a href="https://x.y/z">clique aqui</a></p>', descadastro: 'https://x.y/z' }, { id: 'id2' });
  assert.match(mensagem, /Content-Type: multipart\/alternative; boundary="alora-/);
  assert.match(mensagem, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(mensagem, /Content-Type: text\/html; charset="UTF-8"/);
  assert.match(mensagem, /List-Unsubscribe: <https:\/\/x\.y\/z>/);
  const partes = [...mensagem.matchAll(/base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)].map((m) => Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8'));
  assert.deepEqual(partes, ['texto', '<p>oi <a href="https://x.y/z">clique aqui</a></p>']);
  const simples = montarMensagem({ de: 'a@b.com', para: 'c@d.com', assunto: 'Oi', corpo: 'x', descadastro: 'javascript:alert(1)' }).mensagem;
  assert.doesNotMatch(simples, /multipart|List-Unsubscribe/);
});
