// Formato do JSON que a Jetson envia em POST /ciclos (versão 1 do contrato).
// Referência: CodigosVisao-Embarcado/docs/API.md e docs/openapi.yaml.
// Só o receptor importa este arquivo; a tela usa os tipos de ciclo.ts.
import { z } from "zod";

/** JPEG em base64 padrão (RFC 4648), com `=` de preenchimento e sem quebras de linha. */
const fotoBase64 = z
  .string()
  .min(4)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, "foto não está em base64")
  .nullable();

const horario = z.string().min(1).nullable();

export const esquemaPlaca = z.object({
  texto: z.string().min(1).max(16),
  confianca_ocr: z.number().min(0).max(1),
  confianca_deteccao: z.number().min(0).max(1),
  leitura_min: z.number().min(0),
  leitura_horario: horario,
});

const camposCiclo = z.object({
  id_envio: z.string().min(1).max(300),
  dispositivo: z.string().min(1),
  run_id: z.string().min(1),
  vid: z.number().int().min(1),
  ciclo: z.number().int().min(1),
  inicio_horario: horario,
  fim_horario: horario,
  inicio_min: z.number().min(0),
  fim_min: z.number().min(0),
  duracao_min: z.number().min(0),
  encerrado_por: z.enum(["saida", "veiculo_perdido"]),
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

/** Resume os erros de validação numa linha (o dispositivo guarda só 300 caracteres). */
export function descreverErros(erro: z.ZodError): string {
  return erro.issues
    .map((problema) => `${problema.path.join(".") || "corpo"}: ${problema.message}`)
    .join("; ");
}
