// Envio automático da fila de prospecção (regra pura, testável). Com ele ligado, o Alora Desktop
// envia sozinho os e-mails que a Rotina diária da Alora deixou na fila, em horário comercial e com
// intervalo entre eles. A cota do dia e o aquecimento continuam sendo decididos pela Alora em cada
// e-mail (`/prospeccao/preparar`); quando ela diz que o limite de hoje acabou, o automático descansa
// até o dia seguinte.

export const PADRAO = { ativo: false, intervaloSegundos: 90, inicio: 8, fim: 18, fimDeSemana: false };
export const CICLO_MS = 5 * 60 * 1000;
/** Janelas de envio que a pessoa escolhe na tela. */
export const JANELAS = {
  comercial: { inicio: 8, fim: 18, fimDeSemana: false },
  '24h_uteis': { inicio: 0, fim: 24, fimDeSemana: false },
  '24h_todos': { inicio: 0, fim: 24, fimDeSemana: true },
};
/** Qual janela as preferências representam (para mostrar na tela). */
export function janelaDe(p) {
  if (p.inicio === 0 && p.fim === 24) return p.fimDeSemana ? '24h_todos' : '24h_uteis';
  return 'comercial';
}

const inteiro = (v, min, max, padrao) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : padrao; };

/** Preferências salvas (arquivo local) → valores válidos. */
export function normalizarPreferencias(bruto) {
  const b = bruto && typeof bruto === 'object' ? bruto : {};
  const inicio = inteiro(b.inicio, 0, 23, PADRAO.inicio);
  const fim = inteiro(b.fim, 1, 24, PADRAO.fim);
  return {
    ativo: b.ativo === true,
    intervaloSegundos: inteiro(b.intervaloSegundos, 10, 900, PADRAO.intervaloSegundos),
    ...(fim > inicio ? { inicio, fim } : { inicio: PADRAO.inicio, fim: PADRAO.fim }),
    fimDeSemana: b.fimDeSemana === true,
  };
}

const diaLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Pode enviar agora? Devolve o motivo quando não pode (aparece na tela). */
export function podeEnviarAgora(agora, prefs, estado = {}) {
  if (!prefs.ativo) return { pode: false, motivo: 'Envio automático desligado.' };
  if (!prefs.fimDeSemana && (agora.getDay() === 0 || agora.getDay() === 6)) return { pode: false, motivo: 'Fim de semana: volto a enviar na segunda.' };
  const hora = agora.getHours();
  if (hora < prefs.inicio || hora >= prefs.fim) return { pode: false, motivo: `Fora do horário de envio (${prefs.inicio}h às ${prefs.fim}h).` };
  if (estado.limiteAtingidoEm === diaLocal(agora)) return { pode: false, motivo: 'Limite de hoje atingido (aquecimento da caixa). Continuo amanhã.' };
  if (estado.bloqueadoEm === diaLocal(agora)) return { pode: false, motivo: 'A Microsoft recusou o remetente hoje. Parei até amanhã; confira o e-mail na Alora.' };
  return { pode: true };
}

/** Depois de um lote: marca o dia se a cota acabou ou se o provedor recusou o remetente. */
export function estadoDepoisDoLote(agora, estado, resultado) {
  const hoje = diaLocal(agora);
  return {
    ...estado,
    ...(resultado?.limite ? { limiteAtingidoEm: hoje } : {}),
    ...(resultado?.bloqueado ? { bloqueadoEm: hoje } : {}),
  };
}

/** Itens da fila que ainda podem sair (a fila só traz o que aguarda envio; isto é defesa). */
export function idsParaEnviar(fila, max = 200) {
  return (Array.isArray(fila) ? fila : []).map((i) => i?.id).filter((id) => typeof id === 'string').slice(0, max);
}
