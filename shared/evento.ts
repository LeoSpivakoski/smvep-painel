// Formato dos eventos que o app empurra para o painel (POST /eventos), um por
// mudança da vaga: OCCUPIED quando o veículo para, VACATED quando ele sai. Os
// dois de uma mesma parada têm o mesmo `occupancyId`. Exemplos em
// exemplos_json_integracao_ifsc_spark/ (01 e 03 são pedidos; 02 e 04, respostas).
// Só o servidor do painel importa este arquivo.
import { z } from "zod";

// As descrições (`.meta`) também vão para a documentação Swagger (server/openapi.ts).
const descrito = <T extends z.ZodType>(esquema: T, description: string): T => esquema.meta({ description });

/** Retângulo em pixels da foto inteira (origem no canto superior esquerdo). */
export const esquemaCaixa = descrito(
  z
    .object({
      xMin: z.number().min(0),
      yMin: z.number().min(0),
      xMax: z.number().min(0),
      yMax: z.number().min(0),
    })
    .refine((caixa) => caixa.xMax > caixa.xMin && caixa.yMax > caixa.yMin, "xMax/yMax precisam ser maiores que xMin/yMin"),
  "Retângulo em pixels da foto inteira (origem no canto superior esquerdo); xMax > xMin e yMax > yMin.",
);

const textoOpcional = z.string().nullable().optional();

export const esquemaImagem = z.looseObject({
  // O SMVEP não numera as fotos: manda `null`.
  imageId: z.union([z.string(), z.number()]).transform(String).nullable().optional(),
  purpose: descrito(
    z.string().min(1),
    "Nomes do SMVEP: PLATE_CROSSING (veículo cruzando a linha de snap), PARKING_ENTRY (entrada, no OCCUPIED) ou PARKING_EXIT (saída, no VACATED). Outras finalidades são aceitas, mas não aparecem na tela.",
  ),
  capturedAt: textoOpcional,
  mimeType: z.literal("image/jpeg"),
  encoding: z.literal("base64"),
  byteLength: descrito(
    z.number().int().min(1).optional(),
    "Tamanho da foto decodificada, em bytes; se vier, precisa conferir (senão: 422 IMAGE_INTEGRITY).",
  ),
  sha256: descrito(
    z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "sha256 precisa ter 64 dígitos hexadecimais")
      .optional(),
    "SHA-256 da foto decodificada, em hexadecimal; se vier, precisa conferir (senão: 422 IMAGE_INTEGRITY).",
  ),
  base64: descrito(
    z
      .string()
      .min(4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, "foto não está em base64"),
    "A foto JPEG inteira, em base64 padrão, sem quebras de linha.",
  ),
});

export const esquemaEvento = z.looseObject({
  schemaVersion: descrito(z.string().min(1), "Versão do contrato; o painel aceita 1.x."),
  messageId: descrito(
    z.string().min(1).max(200),
    "Identifica o evento. Repetido (mesmo deviceId), o painel responde DUPLICATE sem gravar de novo.",
  ),
  messageType: descrito(z.enum(["OCCUPIED", "VACATED"]), "OCCUPIED: o veículo parou na vaga. VACATED: o veículo saiu."),
  deviceId: z.string().min(1).max(100),
  installationId: textoOpcional,
  configVersion: z.number().nullable().optional(),
  bootId: textoOpcional,
  sequence: z.number().nullable().optional(),
  occurredAt: descrito(
    z
      .string()
      .refine((texto) => !Number.isNaN(Date.parse(texto)), "occurredAt não é uma data ISO 8601")
      .nullable(),
    "Quando aconteceu (ISO 8601): início da parada no OCCUPIED, fim no VACATED. null quando o SMVEP não tem o horário (VACATED de parada INTERRUPTED).",
  ),
  timeQuality: textoOpcional,
  cameraId: textoOpcional,
  spaceId: descrito(textoOpcional, "Vaga."),
  occupancyId: descrito(
    z.union([z.string().min(1).max(100), z.number()]).transform(String),
    "Junta o OCCUPIED e o VACATED da mesma parada: o registro do painel é deviceId:occupancyId.",
  ),
  plate: descrito(
    z
      .looseObject({
        status: descrito(z.string().min(1), "READ quando a placa foi lida; NOT_VISIBLE e outros, sem leitura."),
        value: z.string().min(1).max(16).nullable().optional(),
        plateConfidence: descrito(
          z.number().min(0).max(1).nullable().optional(),
          "Confiança da leitura dos caracteres (OCR): Conf. OCR na tela.",
        ),
        plateDetectionConfidence: descrito(
          z.number().min(0).max(1).nullable().optional(),
          "Confiança da detecção da placa na foto: Conf. Det na tela.",
        ),
        confidence: descrito(
          z.number().min(0).max(1).nullable().optional(),
          "Nome antigo da confiança do OCR; vale se faltar plateConfidence.",
        ),
        boundingBox: descrito(esquemaCaixa.nullable().optional(), "Caixa da placa na foto PLATE_CROSSING."),
      })
      .nullable()
      .optional(),
    "Só no OCCUPIED. Uma placa no VACATED é ignorada.",
  ),
  vehicle: z
    .looseObject({
      detected: z.boolean().optional(),
      boundingBox: descrito(
        esquemaCaixa.nullable().optional(),
        "Caixa do veículo: na foto PLATE_CROSSING (OCCUPIED) ou na PARKING_EXIT (VACATED).",
      ),
    })
    .nullable()
    .optional(),
  closureReason: descrito(
    textoOpcional,
    "Só no VACATED, com os valores do SMVEP: DEPARTURE_OBSERVED, VEHICLE_LOST, VIDEO_END ou INTERRUPTED (outros valores aparecem como vieram).",
  ),
  evidenceStatus: textoOpcional,
  images: descrito(z.array(esquemaImagem).max(10).default([]), "Fotos inteiras do evento (até 10)."),
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
    case "VIDEO_END":
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
