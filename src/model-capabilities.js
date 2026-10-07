// Account catalog controls model availability. Known model docs control effort choices.
// Unknown models keep the provider default rather than guessing unsupported parameters.
// https://developers.openai.com/api/docs/models/gpt-5.6-sol
// https://developers.openai.com/api/docs/models/gpt-6-astra
export function reasoningEfforts(model) {
  if (/^gpt-(?:5\.6-(?:sol|terra|luna)|6(?:\.1)?-(?:sol|luna))$/.test(model))
    return ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (model === 'gpt-6-astra') return ['low', 'medium', 'high', 'xhigh', 'max'];
  return [];
}

export const effortLabels = { none: 'Sem raciocínio', low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Extra alto', max: 'Máximo' };
