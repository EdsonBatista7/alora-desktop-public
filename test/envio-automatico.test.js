import test from 'node:test';
import assert from 'node:assert/strict';
import { estadoDepoisDoLote, idsParaEnviar, normalizarPreferencias, podeEnviarAgora } from '../src/envio-automatico.js';

const quarta10h = new Date(2026, 9, 21, 10, 0);
const sabado10h = new Date(2026, 9, 24, 10, 0);
const quarta19h = new Date(2026, 9, 21, 19, 0);

test('preferências: padrão desligado, intervalo e horário dentro dos limites', () => {
  assert.deepEqual(normalizarPreferencias(null), { ativo: false, intervaloSegundos: 90, inicio: 8, fim: 18, fimDeSemana: false });
  const p = normalizarPreferencias({ ativo: true, intervaloSegundos: 5, inicio: 20, fim: 9 });
  assert.equal(p.intervaloSegundos, 30);
  assert.equal(p.fim > p.inicio, true);
});

test('envia só ligado, em dia útil e no horário; descansa no dia em que a cota acabou ou o remetente foi recusado', () => {
  const ligado = normalizarPreferencias({ ativo: true });
  assert.equal(podeEnviarAgora(quarta10h, normalizarPreferencias({})).pode, false);
  assert.equal(podeEnviarAgora(quarta10h, ligado).pode, true);
  assert.match(podeEnviarAgora(sabado10h, ligado).motivo, /Fim de semana/);
  assert.match(podeEnviarAgora(quarta19h, ligado).motivo, /Fora do horário/);
  const semCota = estadoDepoisDoLote(quarta10h, {}, { limite: true });
  assert.match(podeEnviarAgora(quarta10h, ligado, semCota).motivo, /Limite de hoje/);
  assert.equal(podeEnviarAgora(new Date(2026, 9, 22, 10, 0), ligado, semCota).pode, true, 'no dia seguinte volta');
  const bloqueado = estadoDepoisDoLote(quarta10h, {}, { bloqueado: true });
  assert.match(podeEnviarAgora(quarta10h, ligado, bloqueado).motivo, /recusou/);
});

test('ids da fila: só os válidos, com teto', () => {
  assert.deepEqual(idsParaEnviar([{ id: 'a' }, {}, null, { id: 'b' }]), ['a', 'b']);
  assert.equal(idsParaEnviar(Array.from({ length: 300 }, (_, i) => ({ id: String(i) }))).length, 200);
});
