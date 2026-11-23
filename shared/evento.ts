// Formato dos eventos que o app empurra para o painel (POST /eventos), um por
// mudança da vaga: OCCUPIED quando o veículo para, VACATED quando ele sai. Os
// dois de uma mesma parada têm o mesmo `occupancyId`. Exemplos em
// exemplos_json_integracao_ifsc_spark/ (01 e 03 são pedidos; 02 e 04, respostas).
// Só o servidor do painel importa este arquivo.
import { z } from "zod";

/** Retângulo em pixels da foto inteira (origem no canto superior esquerdo). */
export const esquemaCaixa = z
  .object({
    xMin: z.number().min(0),
    yMin: z.number().min(0),
    xMax: z.number().min(0),
    yMax: z.number().min(0),
  })
  .refine((caixa) => caixa.xMax > caixa.xMin && caixa.yMax > caixa.yMin, "xMax/yMax precisam ser maiores que xMin/yMin");

const textoOpcional = z.string().nullable().optional();

export const esquemaImagem = z.looseObject({
  imageId: z.union([z.string(), z.number()]).transform(String).optional(),
  /** PLATE_CROSSING (veículo cruzando a linha) ou SPACE_OVERVIEW (vista da vaga). */
  purpose: z.string().min(1),
  capturedAt: textoOpcional,
  mimeType: z.literal("image/jpeg"),
  encoding: z.literal("base64"),
  byteLength: z.number().int().min(1).optional(),
  sha256: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "sha256 precisa ter 64 dígitos hexadecimais")
    .optional(),
  base64: z
    .string()
    .min(4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "foto não está em base64"),
});

export const esquemaEvento = z.looseObject({
  schemaVersion: z.string().min(1),
  messageId: z.string().min(1).max(200),
  messageType: z.enum(["OCCUPIED", "VACATED"]),
  deviceId: z.string().min(1).max(100),
  installationId: textoOpcional,
  configVersion: z.number().nullable().optional(),
  bootId: textoOpcional,
  sequence: z.number().nullable().optional(),
  occurredAt: z.string().refine((texto) => !Number.isNaN(Date.parse(texto)), "occurredAt não é uma data ISO 8601"),
  timeQuality: textoOpcional,
  cameraId: textoOpcional,
  spaceId: textoOpcional,
  occupancyId: z
    .union([z.string().min(1).max(100), z.number()])
    .transform(String),
  /** Só o OCCUPIED traz a placa; no VACATED o painel a ignora. */
  plate: z
    .looseObject({
      /** READ quando a placa foi lida; NOT_VISIBLE e outros, sem leitura. */
      status: z.string().min(1),
      value: z.string().min(1).max(16).nullable().optional(),
      /** Confiança da leitura dos caracteres (OCR). */
      plateConfidence: z.number().min(0).max(1).nullable().optional(),
      /** Confiança da detecção da placa na foto. */
      plateDetectionConfidence: z.number().min(0).max(1).nullable().optional(),
      /** Nome antigo da confiança do OCR (exemplo genérico 01); vale se faltar `plateConfidence`. */
      confidence: z.number().min(0).max(1).nullable().optional(),
      boundingBox: esquemaCaixa.nullable().optional(),
    })
    .nullable()
    .optional(),
  vehicle: z
    .looseObject({
      detected: z.boolean().optional(),
      boundingBox: esquemaCaixa.nullable().optional(),
    })
    .nullable()
    .optional(),
  /** Só no VACATED: DEPARTURE_OBSERVED, VEHICLE_LOST, END_OF_VIDEO, INTERRUPTED. */
  closureReason: textoOpcional,
  evidenceStatus: textoOpcional,
  images: z.array(esquemaImagem).max(10).default([]),
});

export type EventoRecebido = z.infer<typeof esquemaEvento>;
export type CaixaRecebida = z.infer<typeof esquemaCaixa>;

/** Versões do contrato que o painel entende: 1.x. */
export function versaoSuportada(versao: string): boolean {
  return /^1(\.\d+)*$/.test(versao);
}

/** `closureReason` do app → `encerrado_por` do painel (valores novos passam em minúsculas). */
export function motivoDoFim(motivo: string | null | undefined): string {
  switch (motivo) {
    case "DEPARTURE_OBSERVED":
      return "saida";
    case "VEHICLE_LOST":
      return "veiculo_perdido";
    case "END_OF_VIDEO":
      return "fim_do_video";
    case "INTERRUPTED":
      return "interrompido";
    default:
      return motivo ? motivo.toLowerCase() : "saida";
  }
}

/** Largura e altura de um JPEG (marcador SOF), ou `null` se não achar. */
export function dimensoesJpeg(bytes: Buffer): { largura: number; altura: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marcador = bytes[i + 1]!;
    // Marcadores sem tamanho (preenchimento, RST, SOI/EOI).
    if (marcador === 0xff || (marcador >= 0xd0 && marcador <= 0xd9) || marcador === 0x01) {
      i += marcador === 0xff ? 1 : 2;
      continue;
    }
    const tamanho = bytes.readUInt16BE(i + 2);
    // SOF0..SOF15, exceto DHT (C4), JPG (C8) e DAC (CC).
    if (marcador >= 0xc0 && marcador <= 0xcf && marcador !== 0xc4 && marcador !== 0xc8 && marcador !== 0xcc) {
      const altura = bytes.readUInt16BE(i + 5);
      const largura = bytes.readUInt16BE(i + 7);
      return largura > 0 && altura > 0 ? { largura, altura } : null;
    }
    i += 2 + tamanho;
  }
  return null;
}
