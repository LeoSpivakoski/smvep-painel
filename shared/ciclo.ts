// Formato que o servidor do painel devolve para a tela (GET /api/ciclos e evento SSE `ciclo`).
// Igual ao que o host envia, mas com as fotos trocadas por URLs, a chave do
// painel e `recebido_em`.
import type { CicloRecebido, PlacaRecebida } from "./esquema.ts";

export type Placa = PlacaRecebida;

export type NomeFoto = "linha" | "entrada" | "saida";

export const NOMES_FOTOS: readonly NomeFoto[] = ["linha", "entrada", "saida"];

/** URL de cada foto no servidor do painel, ou `null` quando o host não mandou a foto. */
export type FotosCiclo = Record<NomeFoto, string | null>;

export interface Ciclo extends Omit<CicloRecebido, "fotos" | "encerrado_por" | "id"> {
  /** `<dispositivo>:<id>:<início>` (veja chaveDoCiclo); nas pastas gravadas antes, a chave delas. */
  chave: string;
  /** id (AUTOINCREMENT) no banco do host; `null` nas pastas do antigo envio por POST. */
  id: number | null;
  // `string` aceita valores que versões futuras do host venham a mandar.
  encerrado_por: CicloRecebido["encerrado_por"] | (string & {});
  fotos: FotosCiclo;
  /** Quando o painel gravou o ciclo pela primeira vez (ISO 8601, UTC). */
  recebido_em: string;
  /** Quando o painel regravou o ciclo com uma revisão maior (ISO 8601, UTC); ausente se nunca. */
  atualizado_em?: string;
}

export interface RespostaLista {
  ciclos: Ciclo[];
  total: number;
}

/**
 * Texto da tela para um ciclo sem a foto de saída. Com `veiculo_perdido`,
 * `fim_do_video` e `interrompido` a saída não foi vista, e o texto diz por quê.
 */
export function textoSemFotoSaida(encerradoPor: string): string {
  if (encerradoPor === "veiculo_perdido") return "Saída não vista (veículo perdido)";
  if (encerradoPor === "fim_do_video") return "Saída não vista (o vídeo acabou)";
  if (encerradoPor === "interrompido") return "Saída não vista (processamento interrompido)";
  return "Sem foto de saída";
}

function instante(texto: string | null | undefined): number {
  if (!texto) return Number.NaN;
  return Date.parse(texto);
}

/** Momento usado para ordenar: fim da parada; sem horário real, a hora do recebimento. */
export function momentoDoCiclo(ciclo: Ciclo): number {
  const fim = instante(ciclo.fim_horario);
  if (!Number.isNaN(fim)) return fim;
  const recebido = instante(ciclo.recebido_em);
  return Number.isNaN(recebido) ? 0 : recebido;
}

/** Mais recente primeiro; empates pelo recebimento e, por fim, pela chave. */
export function compararRecentes(a: Ciclo, b: Ciclo): number {
  return (
    momentoDoCiclo(b) - momentoDoCiclo(a) ||
    (instante(b.recebido_em) || 0) - (instante(a.recebido_em) || 0) ||
    b.chave.localeCompare(a.chave)
  );
}

/** Junta duas listas sem repetir a chave, ordena e corta no limite. */
export function mesclarCiclos(atuais: readonly Ciclo[], novos: readonly Ciclo[], limite: number): Ciclo[] {
  const porChave = new Map<string, Ciclo>();
  for (const ciclo of atuais) porChave.set(ciclo.chave, ciclo);
  for (const ciclo of novos) porChave.set(ciclo.chave, ciclo);
  return [...porChave.values()].sort(compararRecentes).slice(0, limite);
}
