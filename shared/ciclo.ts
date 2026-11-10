// Formato que o receptor devolve para a tela (GET /api/ciclos e evento SSE `ciclo`).
// Igual ao que a Jetson envia, mas com as fotos trocadas por URLs e com `recebido_em`.
import type { CicloRecebido, PlacaRecebida } from "./esquema.ts";

export type Placa = PlacaRecebida;

export type NomeFoto = "linha" | "entrada" | "saida";

export const NOMES_FOTOS: readonly NomeFoto[] = ["linha", "entrada", "saida"];

/** URL de cada foto no receptor, ou `null` quando a Jetson não mandou a foto. */
export type FotosCiclo = Record<NomeFoto, string | null>;

export interface Ciclo extends Omit<CicloRecebido, "fotos" | "encerrado_por"> {
  // `string` aceita valores que versões futuras do dispositivo venham a mandar.
  encerrado_por: CicloRecebido["encerrado_por"] | (string & {});
  fotos: FotosCiclo;
  /** Quando o receptor gravou o ciclo (ISO 8601, UTC). */
  recebido_em: string;
}

export interface RespostaLista {
  ciclos: Ciclo[];
  total: number;
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

/** Mais recente primeiro; empates pelo recebimento e, por fim, pelo id. */
export function compararRecentes(a: Ciclo, b: Ciclo): number {
  return (
    momentoDoCiclo(b) - momentoDoCiclo(a) ||
    (instante(b.recebido_em) || 0) - (instante(a.recebido_em) || 0) ||
    b.id_envio.localeCompare(a.id_envio)
  );
}

/** Junta duas listas sem repetir `id_envio`, ordena e corta no limite. */
export function mesclarCiclos(atuais: readonly Ciclo[], novos: readonly Ciclo[], limite: number): Ciclo[] {
  const porId = new Map<string, Ciclo>();
  for (const ciclo of atuais) porId.set(ciclo.id_envio, ciclo);
  for (const ciclo of novos) porId.set(ciclo.id_envio, ciclo);
  return [...porId.values()].sort(compararRecentes).slice(0, limite);
}
