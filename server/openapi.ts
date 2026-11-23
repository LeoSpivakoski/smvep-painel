// Documentação da API do painel (OpenAPI 3.0), servida pelo Swagger em /docs.
// O corpo do POST /eventos vem do mesmo esquema zod que valida os eventos
// (shared/evento.ts): a documentação não se descola da validação.
import { createHash } from "node:crypto";
import { z } from "zod";
import { esquemaEvento } from "../shared/evento.ts";

type Esquema = Record<string, unknown>;

const texto = (description?: string, extra: Esquema = {}): Esquema => ({
  type: "string",
  ...extra,
  ...(description ? { description } : {}),
});
const anulavel = (esquema: Esquema): Esquema => ({ ...esquema, nullable: true });
const ref = (nome: string): Esquema => ({ $ref: `#/components/schemas/${nome}` });

// JPEG mínimo (2688×1520 no marcador SOF): o exemplo do "Try it out" passa na
// conferência de sha256 e byteLength e aparece na tela.
const JPEG_EXEMPLO = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x05, 0xf0, 0x0a, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11,
  0x01, 0xff, 0xd9,
]);

function imagemExemplo(imageId: string, purpose: string, capturedAt: string) {
  return {
    imageId,
    purpose,
    capturedAt,
    mimeType: "image/jpeg",
    encoding: "base64",
    byteLength: JPEG_EXEMPLO.length,
    sha256: createHash("sha256").update(JPEG_EXEMPLO).digest("hex"),
    base64: JPEG_EXEMPLO.toString("base64"),
  };
}

const EXEMPLO_OCCUPIED = {
  schemaVersion: "1.0",
  messageId: "evt-exemplo-0001",
  messageType: "OCCUPIED",
  deviceId: "EMB-001",
  installationId: "PONTO-001",
  configVersion: 1,
  bootId: "boot-7721",
  sequence: 104,
  occurredAt: "2026-09-21T13:54:54.986-03:00",
  timeQuality: "SYNCED",
  cameraId: "CAM-001",
  spaceId: "BAY-01",
  occupancyId: "exemplo-70",
  plate: {
    status: "READ",
    value: "QRP7J32",
    plateConfidence: 0.99,
    plateDetectionConfidence: 0.98,
    boundingBox: { xMin: 1973, yMin: 907, xMax: 2085, yMax: 953 },
  },
  vehicle: { detected: true, boundingBox: { xMin: 1569, yMin: 615, xMax: 2234, yMax: 1153 } },
  evidenceStatus: "AVAILABLE",
  images: [
    imagemExemplo("210", "PLATE_CROSSING", "2026-09-21T13:54:54.035-03:00"),
    imagemExemplo("211", "SPACE_OVERVIEW", "2026-09-21T13:54:54.986-03:00"),
  ],
};

const EXEMPLO_VACATED = {
  schemaVersion: "1.0",
  messageId: "evt-exemplo-0002",
  messageType: "VACATED",
  deviceId: "EMB-001",
  installationId: "PONTO-001",
  configVersion: 1,
  bootId: "boot-7721",
  sequence: 105,
  occurredAt: "2026-09-21T13:56:56.540-03:00",
  timeQuality: "SYNCED",
  cameraId: "CAM-001",
  spaceId: "BAY-01",
  occupancyId: "exemplo-70",
  vehicle: { detected: true, boundingBox: { xMin: 970, yMin: 523, xMax: 1867, yMax: 1001 } },
  closureReason: "DEPARTURE_OBSERVED",
  evidenceStatus: "AVAILABLE",
  images: [imagemExemplo("212", "SPACE_OVERVIEW", "2026-09-21T13:56:56.540-03:00")],
};

const identificacao = {
  schemaVersion: texto(undefined, { example: "1.0" }),
  messageId: anulavel(texto("O messageId do evento (null se o corpo não deu para ler).")),
  messageType: anulavel(texto(undefined, { enum: ["OCCUPIED", "VACATED"] })),
  deviceId: anulavel(texto()),
};

const RESPOSTA_EXEMPLO = {
  schemaVersion: "1.0",
  messageId: "evt-20261113-0001",
  messageType: "OCCUPIED",
  deviceId: "EMB-001",
  receiptId: "rcpt-evt-20261113-0001",
  receivedAt: "2026-11-13T09:24:27Z",
  durable: true,
};

function recusaExemplo(description: string, code: string, message: string) {
  return {
    description,
    content: {
      "application/json": {
        schema: ref("Recusa"),
        example: {
          schemaVersion: "1.0",
          messageId: "evt-20261113-0001",
          messageType: "OCCUPIED",
          deviceId: "EMB-001",
          result: "REJECTED",
          durable: false,
          error: { code, message },
        },
      },
    },
  };
}

const porFoto = (esquema: Esquema, description: string): Esquema => ({
  type: "object",
  description,
  properties: { linha: esquema, entrada: esquema, saida: esquema },
});

const CICLO: Esquema = {
  type: "object",
  description:
    "Um registro da tela: uma ocupação (OCCUPIED + VACATED do app) ou um ciclo completo do host. Pode ter outros campos, guardados como vieram.",
  required: ["chave", "fotos", "recebido_em"],
  properties: {
    chave: texto("`deviceId:occupancyId` (eventos do app) ou `dispositivo:id:início` (host).", { example: "EMB-001:70" }),
    id: anulavel({ type: "integer", description: "occupancyId numérico, ou o id do banco do host." }),
    dispositivo: texto(undefined, { example: "EMB-001" }),
    ocupacao: texto("occupancyId do app."),
    vaga: anulavel(texto(undefined, { example: "BAY-01" })),
    camera: anulavel(texto(undefined, { example: "CAM-001" })),
    situacao: texto("Só nos registros do app: `ocupada` até chegar o VACATED.", { enum: ["ocupada", "encerrada"] }),
    inicio_horario: anulavel(texto("occurredAt do OCCUPIED (ISO 8601).")),
    fim_horario: anulavel(texto("occurredAt do VACATED (ISO 8601).")),
    duracao_min: anulavel({ type: "number", description: "Minutos entre o início e o fim." }),
    encerrado_por: anulavel(
      texto("`null` com o veículo ainda na vaga.", {
        example: "saida",
        enum: ["saida", "veiculo_perdido", "fim_do_video", "interrompido"],
      }),
    ),
    placa: anulavel(ref("Placa")),
    fotos: porFoto(anulavel(texto(undefined, { example: "/fotos/EMB-001_70/linha.jpg" })), "URL de cada foto no painel, ou null."),
    caixas: porFoto({ type: "array", items: ref("Caixa") }, "Caixas a desenhar em cada foto."),
    dimensoes: porFoto(
      { type: "object", properties: { largura: { type: "integer" }, altura: { type: "integer" } } },
      "Tamanho real de cada foto (as caixas estão nessa escala).",
    ),
    eventos: {
      type: "array",
      description: "Eventos do app já aplicados (e o recibo dado a cada um).",
      items: {
        type: "object",
        properties: {
          messageId: texto(),
          messageType: texto(),
          occurredAt: texto(),
          sequence: anulavel({ type: "number" }),
          receiptId: texto(),
          receivedAt: texto(undefined, { format: "date-time" }),
        },
      },
    },
    recebido_em: texto("Quando o painel gravou o registro pela primeira vez.", { format: "date-time" }),
    atualizado_em: texto("Quando o painel o regravou (outro evento ou revisão).", { format: "date-time" }),
  },
};

export interface OpcoesDocumentacao {
  versao: string;
  rotaEventos: string;
  limiteCorpoMb: number;
}

export function documentoOpenApi({ versao, rotaEventos, limiteCorpoMb }: OpcoesDocumentacao) {
  const evento = z.toJSONSchema(esquemaEvento, { io: "input", target: "openapi-3.0", unrepresentable: "any" }) as Esquema;
  delete evento.$schema;

  return {
    openapi: "3.0.3",
    info: {
      title: "SMVEP · API do painel",
      version: versao,
      description: [
        "O **app** empurra os eventos da vaga para o painel (`POST /eventos`): `OCCUPIED` quando o veículo para e `VACATED` quando ele sai.",
        "Os dois de uma mesma parada (mesmo `deviceId` e `occupancyId`) viram um registro na tela, em qualquer ordem de chegada.",
        "",
        "O painel só responde `ACCEPTED` depois de gravar em disco. `ACCEPTED` e `DUPLICATE` são definitivos; `REJECTED` não adianta repetir; sem resposta ou com 5xx, o app tenta de novo.",
        "",
        "As demais rotas servem a tela do painel.",
      ].join("\n"),
    },
    tags: [
      { name: "Eventos do app", description: "O que o app envia ao painel." },
      { name: "Tela", description: "O que a tela do painel lê." },
    ],
    components: {
      securitySchemes: {
        token: {
          type: "http",
          scheme: "bearer",
          description: "A senha do painel (SMVEP_ENVIO_TOKEN ou token.txt). Sem senha configurada no painel, não é exigida.",
        },
      },
      schemas: {
        Evento: evento,
        Resposta: {
          type: "object",
          description: "Evento entregue (formato dos exemplos 02 e 04).",
          required: ["schemaVersion", "messageId", "messageType", "deviceId", "result", "receiptId", "receivedAt", "durable"],
          properties: {
            ...identificacao,
            result: texto("ACCEPTED: gravado agora. DUPLICATE: já estava gravado (recibo da primeira vez).", {
              enum: ["ACCEPTED", "DUPLICATE"],
            }),
            receiptId: texto(undefined, { example: "rcpt-evt-20261113-0001" }),
            receivedAt: texto(undefined, { format: "date-time" }),
            durable: { type: "boolean", enum: [true] },
          },
        },
        Recusa: {
          type: "object",
          description: "Evento recusado: repetir o mesmo evento não adianta.",
          required: ["schemaVersion", "result", "durable", "error"],
          properties: {
            ...identificacao,
            result: texto(undefined, { enum: ["REJECTED"] }),
            durable: { type: "boolean", enum: [false] },
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: texto(undefined, {
                  enum: ["UNAUTHORIZED", "INVALID_MESSAGE", "UNSUPPORTED_SCHEMA_VERSION", "IMAGE_INTEGRITY"],
                }),
                message: texto("O que está errado."),
              },
            },
          },
        },
        Placa: {
          type: "object",
          properties: {
            texto: texto(undefined, { example: "QRP7J32" }),
            confianca_ocr: anulavel({ type: "number", description: "plateConfidence do OCCUPIED." }),
            confianca_deteccao: anulavel({ type: "number", description: "plateDetectionConfidence do OCCUPIED." }),
            leitura_horario: anulavel(texto()),
          },
        },
        Caixa: {
          type: "object",
          description: "Retângulo em pixels da foto inteira (escala de `dimensoes`).",
          required: ["tipo", "xMin", "yMin", "xMax", "yMax"],
          properties: {
            tipo: texto(undefined, { enum: ["veiculo", "placa"] }),
            xMin: { type: "number" },
            yMin: { type: "number" },
            xMax: { type: "number" },
            yMax: { type: "number" },
          },
        },
        Ciclo: CICLO,
      },
    },
    paths: {
      [rotaEventos]: {
        post: {
          tags: ["Eventos do app"],
          summary: "Recebe um evento OCCUPIED ou VACATED",
          description: [
            "Grava o evento e atualiza a tela na hora.",
            "",
            "- **Fotos:** `PLATE_CROSSING` → linha de snap; `SPACE_OVERVIEW` → entrada (OCCUPIED) ou saída (VACATED). `sha256` e `byteLength`, se vierem, precisam conferir.",
            "- **Caixas:** as do OCCUPIED (veículo e placa) são da foto `PLATE_CROSSING`; a do VACATED (veículo), da `SPACE_OVERVIEW` de saída.",
            "- **Placa:** só no OCCUPIED, com `plateConfidence` (OCR) e `plateDetectionConfidence` (detecção).",
            `- Corpo de até ${limiteCorpoMb} MB.`,
          ].join("\n"),
          security: [{ token: [] }, {}],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: ref("Evento"),
                examples: {
                  OCCUPIED: { summary: "Entrada (o veículo parou)", value: EXEMPLO_OCCUPIED },
                  VACATED: { summary: "Saída (o veículo saiu)", value: EXEMPLO_VACATED },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Entregue: ACCEPTED (gravado agora) ou DUPLICATE (já estava gravado).",
              content: {
                "application/json": {
                  schema: ref("Resposta"),
                  examples: {
                    ACCEPTED: { value: { ...RESPOSTA_EXEMPLO, result: "ACCEPTED" } },
                    DUPLICATE: { value: { ...RESPOSTA_EXEMPLO, result: "DUPLICATE" } },
                  },
                },
              },
            },
            "400": recusaExemplo("JSON quebrado.", "INVALID_MESSAGE", "Body is not valid JSON"),
            "401": recusaExemplo(
              "Senha ausente ou diferente da do painel.",
              "UNAUTHORIZED",
              "token ausente ou inválido (Authorization: Bearer <token>)",
            ),
            "413": recusaExemplo(`Corpo acima de ${limiteCorpoMb} MB.`, "INVALID_MESSAGE", "Request body is too large"),
            "422": recusaExemplo(
              "Evento recusado: INVALID_MESSAGE (campo fora do formato), UNSUPPORTED_SCHEMA_VERSION (o painel aceita 1.x) ou IMAGE_INTEGRITY (sha256/byteLength).",
              "IMAGE_INTEGRITY",
              "images[0] (210): sha256 não confere com a foto recebida",
            ),
            "500": { description: "Não gravado (erro de disco, por exemplo): o app tenta de novo." },
          },
        },
      },
      "/api/ciclos": {
        get: {
          tags: ["Tela"],
          summary: "Registros mais recentes",
          description: "Pelo fim da parada; com o veículo ainda na vaga, pelo início.",
          parameters: [{ name: "limite", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 20 } }],
          responses: {
            "200": {
              description: "Lista de registros.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { ciclos: { type: "array", items: ref("Ciclo") }, total: { type: "integer" } },
                  },
                },
              },
            },
          },
        },
      },
      "/api/ciclos/{chave}": {
        get: {
          tags: ["Tela"],
          summary: "Um registro",
          parameters: [
            {
              name: "chave",
              in: "path",
              required: true,
              description: "Por exemplo `EMB-001:70` (`deviceId:occupancyId`).",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "O registro.", content: { "application/json": { schema: ref("Ciclo") } } },
            "404": { description: "Registro não encontrado." },
          },
        },
      },
      "/api/eventos": {
        get: {
          tags: ["Tela"],
          summary: "Atualizações em tempo real (Server-Sent Events)",
          description: [
            "Fluxo `text/event-stream` que a tela mantém aberto:",
            "",
            "- `ciclo`: um registro novo ou atualizado (o JSON de um Ciclo);",
            '- `host`: `{"conectado": true|false|null}` (null: sem host configurado);',
            "- `ping`: a cada 10 s.",
            "",
            "O Swagger não mostra um fluxo contínuo; use `curl.exe -N http://<painel>:8080/api/eventos`.",
          ].join("\n"),
          responses: {
            "200": { description: "Fluxo de eventos.", content: { "text/event-stream": { schema: { type: "string" } } } },
          },
        },
      },
      "/api/status": {
        get: {
          tags: ["Tela"],
          summary: "Saúde do painel",
          responses: {
            "200": {
              description: "Estado do painel.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      ciclos: { type: "integer", description: "Registros gravados." },
                      conexoes_tela: { type: "integer", description: "Telas abertas agora." },
                      host: anulavel(texto("Endereço do host, se configurado (SMVEP_HOST).")),
                      host_conectado: anulavel({ type: "boolean", description: "null: sem host configurado." }),
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/fotos/{pasta}/{arquivo}": {
        get: {
          tags: ["Tela"],
          summary: "Uma foto",
          description: "As URLs vêm em `Ciclo.fotos`.",
          parameters: [
            { name: "pasta", in: "path", required: true, schema: { type: "string" }, example: "EMB-001_70" },
            {
              name: "arquivo",
              in: "path",
              required: true,
              schema: { type: "string", enum: ["linha.jpg", "entrada.jpg", "saida.jpg"] },
            },
          ],
          responses: {
            "200": { description: "A foto.", content: { "image/jpeg": { schema: { type: "string", format: "binary" } } } },
            "404": { description: "Foto não encontrada." },
          },
        },
      },
    },
  };
}
