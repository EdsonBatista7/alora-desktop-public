export type RespostaResponsesDesktop = Record<string, unknown>;

export function lerRespostaResponses(response: Response): Promise<RespostaResponsesDesktop>;

export function executarTarefaResponses(
  job: { id: string; claimId: string; body?: Record<string, unknown>; deadlineAt?: string | number },
  deps: {
    accessToken(): Promise<string>;
    secureFetch(url: string, init: RequestInit, provedor?: string): Promise<Response>;
    postJobResult(job: unknown, resultado: unknown): Promise<unknown>;
  },
  options?: { timeoutMs?: number },
): Promise<void>;
