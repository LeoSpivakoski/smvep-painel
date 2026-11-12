// Formato do ciclo que a API do host empurra pelo WebSocket (mensagem `ciclo`).
// Referência: CodigosVisao-Embarcado/docs/API.md e o Swagger do host (/docs).
// Só o servidor do painel importa este arquivo; a tela usa os tipos de ciclo.ts.
import { z } from "zod";

/** JPEG em base64 padrão (RFC 4648), com `=` de preenchimento e sem quebras de linha. */
const fotoBase64 = z
  .string()
  .min(4)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, "foto não está em base64")
  .nullable();

const horario = z.string().min(1).nullable();
const confianca = z.number().min(0).max(1).nullable();

export const esquemaPlaca = z.object({
  texto: z.string().min(1).max(16),
  confianca_ocr: confianca,
  confianca_deteccao: confianca,
  leitura_horario: horario,
});

const camposCiclo = z.object({
  /** AUTOINCREMENT do banco do host: identifica o ciclo e nunca é reaproveitado. */
  id: z.number().int().min(1),
  dispositivo: z.string().min(1),
  inicio_horario: horario,
  fim_horario: horario,
  /** Nulo quando o fim da parada é desconhecido (`interrompido` depois de uma queda do host). */
  duracao_min: z.number().min(0).nullable(),
  /**
   * `saida` (saída vista), `veiculo_perdido` (sumiu sem a saída ser vista),
   * `fim_do_video` (o arquivo de vídeo acabou com o veículo na vaga) ou
   * `interrompido` (o processamento do host parou ou caiu com o veículo na vaga).
   */
  encerrado_por: z.enum(["saida", "veiculo_perdido", "fim_do_video", "interrompido"]),
  /**
   * Versão do conteúdo no host: soma 1 a cada alteração feita depois de o ciclo
   * entrar na fila (placa lida mais tarde, por exemplo). Ausente vale 1.
   */
  revisao: z.number().int().min(1).optional(),
  placa: esquemaPlaca.nullable(),
  fotos: z.object({
    linha: fotoBase64,
    entrada: fotoBase64,
    saida: fotoBase64,
  }),
});

// Campos desconhecidos são aceitos e guardados (o contrato só cresce com campos novos).
export const esquemaCiclo = z.looseObject(camposCiclo.shape);

/** Campos conhecidos do contrato (sem a assinatura de índice dos campos extras). */
export type CicloRecebido = z.infer<typeof camposCiclo>;
export type PlacaRecebida = z.infer<typeof esquemaPlaca>;

/**
 * Chave do ciclo no painel: `<dispositivo>:<id>:<início>`. O id já é único no
 * banco do host; o início separa um id repetido se esse banco for apagado e
 * recriado (a numeração recomeça), e o dispositivo separa hosts diferentes.
 */
export function chaveDoCiclo(ciclo: Pick<CicloRecebido, "dispositivo" | "id" | "inicio_horario">): string {
  return `${ciclo.dispositivo}:${ciclo.id}:${ciclo.inicio_horario ?? ""}`;
}

/** Revisão do ciclo; sem o campo (host ou pasta anteriores às revisões), 1. */
export function revisaoDoCiclo(ciclo: { revisao?: unknown }): number {
  const { revisao } = ciclo;
  return typeof revisao === "number" && Number.isInteger(revisao) && revisao >= 1 ? revisao : 1;
}

/** Resume os erros de validação numa linha (vai na recusa ao host e no log). */
export function descreverErros(erro: z.ZodError): string {
  return erro.issues
    .map((problema) => `${problema.path.join(".") || "corpo"}: ${problema.message}`)
    .join("; ");
}
