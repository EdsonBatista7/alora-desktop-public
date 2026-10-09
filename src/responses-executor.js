const OPENAI_RESOURCE = 'https://api.openai.com/v1';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function codigoSeguro(valor, padrao) {
  return typeof valor === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(valor.trim())
    ? valor.trim() : padrao;
}

function erroDaResposta(tipo, evento) {
  const resposta = evento?.response && typeof evento.response === 'object' ? evento.response : evento;
  const erro = resposta?.error ?? evento?.error ?? {};
  if (tipo === 'response.incomplete' || resposta?.status === 'incomplete') {
    const motivo = codigoSeguro(resposta?.incomplete_details?.reason, '');
    return { code: motivo ? `response_incomplete_${motivo}` : 'response_incomplete' };
  }
  return { code: codigoSeguro(erro?.code ?? erro?.type, 'response_failed') };
}

function chaveItem(id, indice) {
  if (typeof id === 'string' && id) return `id:${id}`;
  if (Number.isInteger(indice)) return `index:${indice}`;
  return undefined;
}

function registrarItem(estado, item, indice) {
  if (!item || typeof item !== 'object') return;
  const id = typeof item.id === 'string' ? item.id : undefined;
  const outputIndex = Number.isInteger(indice) ? indice : undefined;
  const fase = typeof item.phase === 'string' ? item.phase : undefined;
  const dados = { id, outputIndex, phase: fase, type: item.type };
  const idKey = chaveItem(id, undefined);
  const indexKey = chaveItem(undefined, outputIndex);
  const atualizar = (key) => {
    if (!key) return;
    const anterior = estado.itens.get(key) ?? {};
    const atualizado = { ...anterior };
    for (const [campo, valor] of Object.entries(dados)) if (valor !== undefined) atualizado[campo] = valor;
    estado.itens.set(key, atualizado);
  };
  atualizar(idKey);
  atualizar(indexKey);
  if (fase) {
    for (const registro of estado.textos) {
      if ((id && registro.itemId === id) || (Number.isInteger(outputIndex) && registro.outputIndex === outputIndex)) {
        registro.phase = fase;
      }
    }
  }
}

function faseDoItem(estado, id, indice, evento) {
  if (typeof evento?.phase === 'string') return evento.phase;
  const porId = chaveItem(id, undefined);
  const porIndice = chaveItem(undefined, indice);
  return estado.itens.get(porId)?.phase ?? estado.itens.get(porIndice)?.phase;
}

function encontrarRegistro(estado, id, indice, conteudoIndice) {
  return estado.textos.find((registro) =>
    (id && registro.itemId === id || !id && Number.isInteger(indice) && registro.outputIndex === indice
      || id && registro.outputIndex === indice)
    && (!Number.isInteger(conteudoIndice) || registro.contentIndex === conteudoIndice));
}

function guardarTextoStreamado(estado, evento, texto, substituir) {
  const itemId = typeof evento.item_id === 'string' ? evento.item_id : undefined;
  const outputIndex = Number.isInteger(evento.output_index) ? evento.output_index : undefined;
  const contentIndex = Number.isInteger(evento.content_index) ? evento.content_index : 0;
  const fase = faseDoItem(estado, itemId, outputIndex, evento);
  if (!itemId && !Number.isInteger(outputIndex)) {
    if (substituir) estado.textoSemItem = texto;
    else estado.textoSemItem += texto;
    return;
  }
  let registro = encontrarRegistro(estado, itemId, outputIndex, contentIndex);
  if (!registro) {
    registro = { itemId, outputIndex, contentIndex, phase: fase, text: '' };
    estado.textos.push(registro);
  }
  if (fase) registro.phase = fase;
  if (substituir) registro.text = texto;
  else registro.text += texto;
}

function emitirEvento(eventName, linhasDados, estado) {
  if (!linhasDados.length) return;
  const data = linhasDados.join('\n');
  if (data === '[DONE]') return;
  let evento;
  try { evento = JSON.parse(data); }
  catch { throw Object.assign(new Error('invalid_sse_event'), { code: 'invalid_sse_event' }); }
  if (!evento || typeof evento !== 'object' || Array.isArray(evento)) {
    throw Object.assign(new Error('invalid_sse_event'), { code: 'invalid_sse_event' });
  }
  const tipo = typeof evento.type === 'string' ? evento.type : eventName;
  if (tipo === 'response.output_item.added' || tipo === 'response.output_item.done') {
    registrarItem(estado, evento.item, evento.output_index);
  } else if (tipo === 'response.output_text.delta' && typeof evento.delta === 'string') {
    guardarTextoStreamado(estado, evento, evento.delta, false);
  } else if (tipo === 'response.output_text.done' && typeof evento.text === 'string') {
    guardarTextoStreamado(estado, evento, evento.text, true);
  } else if (tipo === 'response.failed' || tipo === 'response.incomplete' || tipo === 'error') {
    // A failure after response.completed still invalidates the stream.
    estado.falha ??= erroDaResposta(tipo, evento);
  } else if (tipo === 'response.completed') {
    if (estado.concluida) throw Object.assign(new Error('duplicate_completion_event'), { code: 'duplicate_completion_event' });
    estado.concluida = evento.response && typeof evento.response === 'object' ? evento.response : evento;
    const output = Array.isArray(estado.concluida.output) ? estado.concluida.output : [];
    output.forEach((item, indice) => registrarItem(estado, item, indice));
  }
}

function mensagemVisivel(mensagem) {
  if (!Array.isArray(mensagem?.content)) return '';
  const partes = [];
  for (const parte of mensagem.content) {
    if (parte?.type === 'output_text' && typeof parte.text === 'string') partes.push(parte.text);
    if (parte?.type === 'refusal' && typeof parte.refusal === 'string') partes.push(parte.refusal);
  }
  return partes.join('');
}

function textoDosRegistros(estado, itemId, outputIndex, fase, temFases) {
  return estado.textos
    .filter((registro) => {
      const corresponde = itemId && registro.itemId === itemId
        || Number.isInteger(outputIndex) && registro.outputIndex === outputIndex;
      if (!corresponde) return false;
      if (temFases) return fase === 'final_answer' && registro.phase === 'final_answer';
      return registro.phase !== 'commentary';
    })
    .sort((a, b) => a.contentIndex - b.contentIndex)
    .map((registro) => registro.text)
    .join('');
}

function preencherMensagensDaResposta(resposta, estado, temFases) {
  if (!Array.isArray(resposta.output)) resposta.output = [];
  const mensagens = [];
  resposta.output.forEach((item, indice) => {
    if (item?.type !== 'message') return;
    const id = typeof item.id === 'string' ? item.id : undefined;
    const outputIndex = indice;
    const fase = item.phase ?? faseDoItem(estado, id, outputIndex);
    if (fase && !item.phase) item.phase = fase;
    if (temFases && fase !== 'final_answer') return;
    mensagens.push(item);
    const delta = textoDosRegistros(estado, id, outputIndex, fase, temFases);
    if (!delta) return;
    if (!Array.isArray(item.content)) item.content = [];
    const partesTexto = item.content.filter((parte) => parte?.type === 'output_text');
    if (partesTexto.length) {
      for (let indiceParte = 0; indiceParte < partesTexto.length; indiceParte++) {
        const parte = partesTexto[indiceParte];
        if (typeof parte.text === 'string' && parte.text.trim()) continue;
        const registro = estado.textos.find((candidato) =>
          (id && candidato.itemId === id || candidato.outputIndex === outputIndex)
          && candidato.contentIndex === item.content.indexOf(parte)
          && (!temFases || candidato.phase === 'final_answer'));
        if (registro) parte.text = registro.text;
      }
      // Some completions omit empty output_text parts entirely, even though the stream carried them.
      if (!mensagemVisivel(item)) {
        const textoPreenchido = textoDosRegistros(estado, id, outputIndex, fase, temFases);
        if (textoPreenchido) item.content.push({ type: 'output_text', text: textoPreenchido, annotations: [] });
      }
    } else {
      item.content.push({ type: 'output_text', text: delta, annotations: [] });
    }
  });

  // A final message can be absent from the terminal object while its item and deltas were streamed.
  if (temFases) {
    for (const registro of estado.textos) {
      if (registro.phase !== 'final_answer' || !registro.text || !Number.isInteger(registro.outputIndex)) continue;
      const existe = mensagens.some((item) =>
        registro.itemId && item.id === registro.itemId
        || resposta.output.indexOf(item) === registro.outputIndex);
      if (existe) continue;
      resposta.output.push({
        ...(registro.itemId ? { id: registro.itemId } : {}),
        type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer',
        content: [{ type: 'output_text', text: registro.text, annotations: [] }],
      });
      mensagens.push(resposta.output[resposta.output.length - 1]);
    }
  }
  return mensagens;
}

function extrairTextoVisivel(resposta, estado) {
  const output = Array.isArray(resposta?.output) ? resposta.output : [];
  const fasesConhecidas = output.some((item) => item?.phase === 'commentary' || item?.phase === 'final_answer')
    || estado.textos.some((registro) => registro.phase === 'commentary' || registro.phase === 'final_answer')
    || [...estado.itens.values()].some((item) => item.phase === 'commentary' || item.phase === 'final_answer');
  const mensagens = preencherMensagensDaResposta(resposta, estado, fasesConhecidas);

  if (fasesConhecidas) {
    const finais = mensagens.filter((item) => item.phase === 'final_answer');
    const texto = finais.map(mensagemVisivel).join('');
    if (texto.trim()) resposta.output_text = texto;
    else delete resposta.output_text; // Top-level output_text may include commentary; final items are authoritative.
    return texto;
  }

  if (typeof resposta.output_text === 'string' && resposta.output_text.trim()) return resposta.output_text;
  const textoMensagens = mensagens.map(mensagemVisivel).join('');
  if (textoMensagens.trim()) {
    resposta.output_text = textoMensagens;
    return textoMensagens;
  }
  const textoStreamado = estado.textos
    .filter((registro) => registro.phase !== 'commentary')
    .sort((a, b) => (a.outputIndex ?? Number.MAX_SAFE_INTEGER) - (b.outputIndex ?? Number.MAX_SAFE_INTEGER)
      || a.contentIndex - b.contentIndex)
    .map((registro) => registro.text)
    .join('') || estado.textoSemItem;
  if (textoStreamado.trim()) resposta.output_text = textoStreamado;
  return textoStreamado;
}

function temChamadaDeFerramenta(resposta) {
  return Array.isArray(resposta?.output) && resposta.output.some((item) => item?.type === 'function_call');
}

/** Lê SSE sem aceitar EOF, [DONE] ou stream fechado como conclusão bem-sucedida. */
export async function lerRespostaResponses(response) {
  if (!response?.body) throw Object.assign(new Error('stream_missing'), { code: 'stream_missing' });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const estado = { concluida: null, falha: null, textos: [], textoSemItem: '', itens: new Map() };
  let buffer = '';
  let eventName = '';
  let linhasDados = [];
  let bytes = 0;
  let terminou = false;

  const despachar = () => {
    emitirEvento(eventName, linhasDados, estado);
    eventName = '';
    linhasDados = [];
  };
  const linha = (valor) => {
    if (valor === '') { despachar(); return; }
    if (valor.startsWith(':')) return;
    const doisPontos = valor.indexOf(':');
    const campo = doisPontos < 0 ? valor : valor.slice(0, doisPontos);
    let conteudo = doisPontos < 0 ? '' : valor.slice(doisPontos + 1);
    if (conteudo.startsWith(' ')) conteudo = conteudo.slice(1);
    if (campo === 'event') eventName = conteudo;
    else if (campo === 'data') linhasDados.push(conteudo);
  };
  const retirarLinhas = (final = false) => {
    for (;;) {
      let fim = -1, tamanho = 0;
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] === '\n') { fim = i; tamanho = 1; break; }
        if (buffer[i] === '\r') {
          if (i + 1 === buffer.length && !final) break;
          fim = i; tamanho = buffer[i + 1] === '\n' ? 2 : 1; break;
        }
      }
      if (fim < 0) break;
      const valor = buffer.slice(0, fim);
      buffer = buffer.slice(fim + tamanho);
      linha(valor);
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { terminou = true; break; }
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw Object.assign(new Error('response_too_large'), { code: 'response_too_large' });
      buffer += decoder.decode(value, { stream: true });
      retirarLinhas();
      if (buffer.length > MAX_RESPONSE_BYTES) throw Object.assign(new Error('response_too_large'), { code: 'response_too_large' });
    }
    buffer += decoder.decode();
    retirarLinhas(true);
    if (buffer) { linha(buffer); buffer = ''; }
    // SSE dispatches a final data event at EOF even without a trailing blank line.
    despachar();
  } finally {
    if (!terminou) void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* a cancelled read may settle after this turn */ }
  }

  if (estado.falha) throw Object.assign(new Error(estado.falha.code), estado.falha);
  const resposta = estado.concluida;
  if (!resposta || resposta.status !== 'completed') {
    throw Object.assign(new Error(resposta?.status === 'incomplete' ? erroDaResposta('response.incomplete', resposta).code : 'stream_ended_before_completion'),
      resposta?.status === 'incomplete' ? erroDaResposta('response.incomplete', resposta) : { code: 'stream_ended_before_completion' });
  }

  const texto = extrairTextoVisivel(resposta, estado);
  const temFaseFinal = Array.isArray(resposta.output)
    && resposta.output.some((item) => item?.type === 'message' && item.phase === 'final_answer');
  if (!texto.trim() && fasesPresentes(estado, resposta) && !temFaseFinal && !temChamadaDeFerramenta(resposta)) {
    throw Object.assign(new Error('A resposta concluída não trouxe uma mensagem final.'), { code: 'missing_final_answer' });
  }
  if (!texto.trim() && !temChamadaDeFerramenta(resposta)) {
    const code = fasesPresentes(estado, resposta) ? 'missing_final_answer' : 'empty_response_output';
    throw Object.assign(new Error('A resposta concluída não trouxe texto visível nem chamada de ferramenta.'), { code });
  }
  return resposta;
}

function fasesPresentes(estado, resposta) {
  return (Array.isArray(resposta.output) && resposta.output.some((item) => item?.phase === 'commentary' || item?.phase === 'final_answer'))
    || estado.textos.some((registro) => registro.phase === 'commentary' || registro.phase === 'final_answer')
    || [...estado.itens.values()].some((item) => item.phase === 'commentary' || item.phase === 'final_answer');
}

function deadlineMs(job) {
  if (job?.deadlineAt == null) return undefined;
  const valor = typeof job.deadlineAt === 'number' ? job.deadlineAt : Date.parse(job.deadlineAt);
  if (!Number.isFinite(valor)) throw Object.assign(new Error('job_deadline_invalid'), { code: 'job_deadline_invalid' });
  return valor;
}

async function publicarErro(job, deps, code) {
  await deps.postJobResult(job, { error: { code } });
}

/** Executa uma tarefa já montada pela Alora e publica somente uma resposta terminal validada. */
export async function executarTarefaResponses(job, deps, { timeoutMs = 110_000 } = {}) {
  let publicado = false;
  let deadlineLimita = false;
  let requestSignal;
  const publicar = async (resultado) => {
    if (publicado) return;
    publicado = true;
    await deps.postJobResult(job, resultado);
  };
  try {
    const prazo = deadlineMs(job);
    if (prazo != null && prazo <= Date.now()) {
      await publicarErro(job, deps, 'job_deadline_exceeded');
      return;
    }
    const token = await deps.accessToken();
    const restante = prazo == null ? timeoutMs : prazo - Date.now();
    if (restante <= 0) {
      await publicarErro(job, deps, 'job_deadline_exceeded');
      return;
    }
    deadlineLimita = prazo != null && restante <= timeoutMs;
    const limiteRequisicao = Math.max(1, Math.min(timeoutMs, Math.floor(restante)));
    requestSignal = AbortSignal.timeout(limiteRequisicao);
    const payload = { ...(job.body ?? {}), store: false, stream: true };
    delete payload.previous_response_id;
    delete payload.background;
    const response = await deps.secureFetch(`${OPENAI_RESOURCE}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(payload), signal: requestSignal,
    }, 'o ChatGPT');
    if (!response.ok) {
      let body = {};
      try { body = await response.json(); } catch { /* only a sanitized machine code leaves this process */ }
      const code = codigoSeguro(body?.error?.code ?? body?.error?.type, `http_${response.status}`);
      await publicar({ error: { code } });
      return;
    }
    const completed = await lerRespostaResponses(response);
    await publicar({ response: completed });
  } catch (error) {
    const prazo = (() => { try { return deadlineMs(job); } catch { return undefined; } })();
    const deadlineExpirou = prazo != null && Date.now() >= prazo;
    const signalAbortou = requestSignal?.aborted === true;
    const code = deadlineExpirou || deadlineLimita && signalAbortou ? 'job_deadline_exceeded'
      : signalAbortou || error?.name === 'TimeoutError' ? 'request_timeout'
        : codigoSeguro(error?.code, 'local_executor_error');
    try { await publicar({ error: { code } }); } catch { /* Alora expires an unacknowledged job; never replay it. */ }
  }
}
