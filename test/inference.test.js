import assert from 'node:assert/strict';
import test from 'node:test';
import { executarTarefaResponses } from '../src/responses-executor.js';

function event(type, payload = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function resposta(texto, extra = {}) {
  return {
    id: 'resp-test', object: 'response', status: 'completed', model: 'gpt-6-sol',
    output_text: texto,
    output: texto ? [{ id: 'msg-test', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer',
      content: [{ type: 'output_text', text: texto, annotations: [] }] }] : [],
    ...extra,
  };
}

function streamResponse(text, chunkBytes = [7, 2, 19, 1, 31]) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0, chunkIndex = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const end = Math.min(bytes.length, offset + chunkBytes[chunkIndex++ % chunkBytes.length]);
      controller.enqueue(bytes.slice(offset, end)); offset = end;
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function fixture(stream, opts = {}) {
  const job = { id: 'job-test', claimId: 'claim-test', body: {
    model: 'gpt-6-sol', reasoning: { effort: 'xhigh' }, max_output_tokens: 4096,
    input: [{ role: 'user', content: 'Responda ao pedido de teste.' }],
    previous_response_id: 'must-be-removed', background: true,
  } };
  const requests = [], reports = [];
  return {
    job, requests, reports,
    run: () => executarTarefaResponses(job, {
      accessToken: async () => 'test-only-access-token',
      secureFetch: async (url, init) => {
        requests.push({ url, init, body: JSON.parse(init.body) });
        return typeof stream === 'function' ? stream(url, init) : stream;
      },
      postJobResult: async (_job, result) => { reports.push(result); },
    }, opts),
  };
}

function fetchAteAbortar(_url, init) {
  return new Promise((_resolve, reject) => {
    // Uma conexão real mantém o event loop vivo; AbortSignal.timeout sozinho não mantém.
    const connection = setTimeout(() => reject(new Error('deadline did not abort')), 1000);
    const abort = () => {
      clearTimeout(connection);
      reject(new Error('fetch aborted'));
    };
    if (init.signal.aborted) abort();
    else init.signal.addEventListener('abort', abort, { once: true });
  });
}

test('executor não publica texto vazio quando completion omite texto já emitido em delta', async () => {
  const full = event('response.output_text.delta', { delta: 'A resposta está pronta.' })
    + event('response.completed', { response: resposta('', { output: [] }) });
  const f = fixture(streamResponse(full, [1, 4, 2, 3, 5]));
  await f.run();

  assert.equal(f.reports.length, 1);
  assert.equal(f.reports[0].response.output_text, 'A resposta está pronta.');
  assert.equal(f.reports[0].error, undefined);
  assert.equal(f.requests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(f.requests[0].init.headers.Authorization, 'Bearer test-only-access-token');
  assert.equal(f.requests[0].body.store, false);
  assert.equal(f.requests[0].body.stream, true);
  assert.equal(f.requests[0].body.model, 'gpt-6-sol');
  assert.equal(f.requests[0].body.reasoning.effort, 'xhigh');
  assert.equal(f.requests[0].body.max_output_tokens, 4096, 'não reduz os limites configurados pela Alora');
  assert.equal('previous_response_id' in f.requests[0].body, false);
  assert.equal('background' in f.requests[0].body, false);
});

test('executor despacha o último evento SSE quando EOF chega sem separador em branco', async () => {
  const full = event('response.output_text.delta', { delta: 'Resposta final.' })
    + 'event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: resposta('Resposta final.') });
  const f = fixture(streamResponse(full, [5, 1, 7]));
  await f.run();
  assert.equal(f.reports[0]?.response.output_text, 'Resposta final.');
  assert.equal(f.reports[0]?.error, undefined);
});

test('completion com resposta final visível é encaminhado sem misturar comentário', async () => {
  const completion = resposta('Resposta final.', { output: [
    { type: 'message', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: 'Vou analisar.' }] },
    { type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'Resposta final.' }] },
  ] });
  const f = fixture(streamResponse(event('response.completed', { response: completion })));
  await f.run();
  assert.equal(f.reports.length, 1);
  assert.equal(f.reports[0].response.output_text, 'Resposta final.');
  assert.deepEqual(f.reports[0].response.output, completion.output);
});

test('deltas ligados por item_id e output_index preenchem só o content de final_answer', async () => {
  const comentario = { id: 'msg-commentary', type: 'message', role: 'assistant', phase: 'commentary', content: [] };
  const final = { id: 'msg-final', type: 'message', role: 'assistant', phase: 'final_answer', content: [] };
  const sse = event('response.output_item.added', { output_index: 0, item: comentario })
    + event('response.output_item.added', { output_index: 1, item: final })
    + event('response.output_text.delta', { item_id: 'msg-commentary', output_index: 0, content_index: 0, delta: 'Comentário privado.' })
    + event('response.output_text.delta', { item_id: 'msg-final', output_index: 1, content_index: 0, delta: 'Resposta ' })
    + event('response.output_text.delta', { item_id: 'msg-final', output_index: 1, content_index: 0, delta: 'final.' })
    + event('response.completed', { response: resposta('Comentário privado. Resposta final.', {
      output: [
        { id: 'msg-commentary', type: 'message', role: 'assistant', content: [] },
        { id: 'msg-final', type: 'message', role: 'assistant', content: [] },
      ],
    }) });
  const f = fixture(streamResponse(sse, [1, 2, 3, 5]));
  await f.run();

  const completion = f.reports[0]?.response;
  assert.equal(completion?.output_text, 'Resposta final.');
  assert.equal(completion?.output?.[0]?.phase, 'commentary');
  assert.equal(completion?.output?.[1]?.phase, 'final_answer');
  assert.deepEqual(completion?.output?.[0]?.content, []);
  assert.deepEqual(completion?.output?.[1]?.content, [{ type: 'output_text', text: 'Resposta final.', annotations: [] }]);
  assert.equal(f.reports[0]?.error, undefined);
});

test('modelo sem phases preenche content pela correspondência de output_index', async () => {
  const sse = event('response.output_text.delta', { output_index: 0, content_index: 0, delta: 'Resposta sem phase.' })
    + event('response.completed', { response: resposta('', {
      output: [{ id: 'msg-plain', type: 'message', role: 'assistant', status: 'completed', content: [] }],
    }) });
  const f = fixture(streamResponse(sse));
  await f.run();
  assert.equal(f.reports[0]?.response?.output_text, 'Resposta sem phase.');
  assert.deepEqual(f.reports[0]?.response?.output?.[0]?.content, [
    { type: 'output_text', text: 'Resposta sem phase.', annotations: [] },
  ]);
});

test('comentário sem final_answer falha com diagnóstico específico', async () => {
  const sse = event('response.output_item.added', { output_index: 0, item: {
    id: 'msg-commentary-only', type: 'message', role: 'assistant', phase: 'commentary', content: [],
  } })
    + event('response.output_text.delta', { item_id: 'msg-commentary-only', output_index: 0, content_index: 0, delta: 'Só comentário.' })
    + event('response.completed', { response: resposta('Só comentário.', { output: [
      { id: 'msg-commentary-only', type: 'message', role: 'assistant', phase: 'commentary', content: [] },
    ] }) });
  const f = fixture(streamResponse(sse));
  await f.run();
  assert.deepEqual(f.reports, [{ error: { code: 'missing_final_answer' } }]);
});

test('eventos SSE com CRLF e limites de chunk preservam texto UTF-8', async () => {
  const sse = (event('response.output_text.delta', { delta: 'Olá, ação concluída.' })
    + event('response.completed', { response: resposta('Olá, ação concluída.') })).replaceAll('\n', '\r\n');
  const f = fixture(streamResponse(sse, [1, 1, 2, 1, 3]));
  await f.run();
  assert.equal(f.reports[0]?.response?.output_text, 'Olá, ação concluída.');
  assert.equal(f.reports[0]?.error, undefined);
});

test('completion legítima contendo somente chamada de ferramenta é aceita', async () => {
  const f = fixture(streamResponse(event('response.completed', { response: resposta('', { output: [
    { id: 'call-test', type: 'function_call', call_id: 'call-test', name: 'buscar', arguments: '{}', status: 'completed' },
  ] }) })));
  await f.run();
  assert.equal(f.reports.length, 1);
  assert.equal(f.reports[0]?.response?.output?.[0]?.type, 'function_call');
  assert.equal(f.reports[0]?.error, undefined);
});

test('erro terminal posterior ao completion invalida a resposta', async () => {
  const sse = event('response.completed', { response: resposta('Resposta válida.') })
    + event('response.failed', { response: { error: { code: 'late_failure' } } });
  const f = fixture(streamResponse(sse));
  await f.run();
  assert.deepEqual(f.reports, [{ error: { code: 'late_failure' } }]);
});

test('completion sem texto nem tool call não vira sucesso com mensagem vazia', async () => {
  const f = fixture(streamResponse(event('response.completed', { response: resposta('', {
    output: [{ type: 'reasoning', id: 'reason-test', summary: [] }],
  }) })));
  await f.run();
  assert.deepEqual(f.reports, [{ error: { code: 'empty_response_output' } }]);
});

test('resposta incomplete preserva motivo seguro do esgotamento de tokens', async () => {
  const f = fixture(streamResponse(event('response.incomplete', { response: {
    status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [],
  } })));
  await f.run();
  assert.deepEqual(f.reports, [{ error: { code: 'response_incomplete_max_output_tokens' } }]);
});

test('stream sem response.completed é reportado como interrompido, nunca como sucesso', async () => {
  const f = fixture(streamResponse(event('response.output_text.delta', { delta: 'parcial' }) + 'data: [DONE]\n\n'));
  await f.run();
  assert.deepEqual(f.reports, [{ error: { code: 'stream_ended_before_completion' } }]);
});

test('deadline aborta a requisição e reporta timeout sem repetir a tarefa', async () => {
  const f = fixture(fetchAteAbortar, { timeoutMs: 10 });
  await f.run();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.reports, [{ error: { code: 'request_timeout' } }]);
});

test('deadlineAt expirado não inicia uma inferência', async () => {
  const f = fixture(streamResponse(event('response.completed', { response: resposta('não deve executar') })));
  f.job.deadlineAt = new Date(Date.now() - 1000).toISOString();
  await f.run();
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.reports, [{ error: { code: 'job_deadline_exceeded' } }]);
});

test('deadlineAt limita o signal da inferência e encerra antes de expirar o job', async () => {
  const f = fixture(fetchAteAbortar, { timeoutMs: 1000 });
  f.job.deadlineAt = new Date(Date.now() + 40).toISOString();
  await f.run();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.reports, [{ error: { code: 'job_deadline_exceeded' } }]);
});
