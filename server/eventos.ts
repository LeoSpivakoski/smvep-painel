// Eventos do app (POST /eventos) → ciclos do painel.
// OCCUPIED abre o ciclo da ocupação (o veículo aparece "na vaga"); VACATED o
// fecha. Os dois se juntam pela chave `<deviceId>:<occupancyId>` e podem chegar
// em qualquer ordem. Cada evento é identificado pelo `messageId`: repetido,
// recebe de novo a resposta da primeira vez (DUPLICATE) sem regravar nada.
//
// Respostas (o app só dá o evento por entregue com ACCEPTED ou DUPLICATE):
//   200 ACCEPTED    gravado em disco (durable: true)
//   200 DUPLICATE   já estava gravado; receiptId e receivedAt da primeira vez
//   401 REJECTED    UNAUTHORIZED (token)
//   422 REJECTED    INVALID_MESSAGE, UNSUPPORTED_SCHEMA_VERSION ou IMAGE_INTEGRITY
//                   (repetir o mesmo evento não adianta)
//   5xx             não gravado: o app tenta de novo
import { createHash } from "node:crypto";
import type { Caixa, Ciclo, Dimensoes, EventoAplicado, NomeFoto, Placa } from "../shared/ciclo.ts";
import { descreverErros } from "../shared/esquema.ts";
import { dimensoesJpeg, esquemaEvento, motivoDoFim, versaoSuportada } from "../shared/evento.ts";
import type { CaixaRecebida, EventoRecebido } from "../shared/evento.ts";
import type { Armazenamento } from "./armazenamento.ts";

export const VERSAO_CONTRATO = "1.0";

export type CodigoRecusa = "UNAUTHORIZED" | "INVALID_MESSAGE" | "UNSUPPORTED_SCHEMA_VERSION" | "IMAGE_INTEGRITY";

interface Identificacao {
  schemaVersion: string;
  messageId: string | null;
  messageType: string | null;
  deviceId: string | null;
}

export type RespostaEvento =
  | (Identificacao & {
      result: "ACCEPTED" | "DUPLICATE";
      receiptId: string;
      receivedAt: string;
      durable: true;
    })
  | (Identificacao & {
      result: "REJECTED";
      durable: false;
      error: { code: CodigoRecusa; message: string };
    });

export interface ResultadoEvento {
  status: 200 | 401 | 422;
  resposta: RespostaEvento;
  /** Ciclo novo ou alterado, para avisar a tela; ausente na repetição e na recusa. */
  ciclo?: Ciclo;
}

/** Os campos de identificação que der para ler, mesmo de um corpo inválido. */
function identificar(corpo: unknown): Identificacao {
  const objeto = (typeof corpo === "object" && corpo !== null ? corpo : {}) as Record<string, unknown>;
  const texto = (valor: unknown) => (typeof valor === "string" ? valor : null);
  return {
    schemaVersion: VERSAO_CONTRATO,
    messageId: texto(objeto.messageId),
    messageType: texto(objeto.messageType),
    deviceId: texto(objeto.deviceId),
  };
}

export function recusa(corpo: unknown, status: 401 | 422, code: CodigoRecusa, message: string): ResultadoEvento {
  return {
    status,
    resposta: { ...identificar(corpo), result: "REJECTED", durable: false, error: { code, message: message.slice(0, 500) } },
  };
}

export function chaveDaOcupacao(evento: Pick<EventoRecebido, "deviceId" | "occupancyId">): string {
  return `${evento.deviceId}:${evento.occupancyId}`;
}

/** Foto do evento → lugar no visor do painel (nomes de ImagePurpose do SMVEP). */
const LUGAR_DA_FOTO: Record<string, NomeFoto> = {
  PLATE_CROSSING: "linha",
  PARKING_ENTRY: "entrada",
  PARKING_EXIT: "saida",
};

function lugarDaFoto(purpose: string): NomeFoto | null {
  return LUGAR_DA_FOTO[purpose] ?? null;
}

interface FotoDecodificada {
  lugar: NomeFoto;
  bytes: Buffer;
  dimensoes: Dimensoes | null;
}

/** Decodifica as fotos e confere byteLength e sha256; devolve a recusa se algo não bate. */
function decodificarFotos(evento: EventoRecebido): FotoDecodificada[] | string {
  const fotos: FotoDecodificada[] = [];
  for (const [indice, imagem] of evento.images.entries()) {
    const bytes = Buffer.from(imagem.base64, "base64");
    const nome = `images[${indice}]${imagem.imageId ? ` (${imagem.imageId})` : ""}`;
    if (imagem.byteLength !== undefined && bytes.length !== imagem.byteLength) {
      return `${nome}: byteLength ${imagem.byteLength}, mas a foto decodificada tem ${bytes.length} bytes`;
    }
    if (imagem.sha256 !== undefined) {
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (sha !== imagem.sha256.toLowerCase()) return `${nome}: sha256 não confere com a foto recebida`;
    }
    const lugar = lugarDaFoto(imagem.purpose);
    // Finalidade desconhecida: a foto é aceita (íntegra), mas não tem lugar no visor.
    if (lugar && !fotos.some((foto) => foto.lugar === lugar)) {
      fotos.push({ lugar, bytes, dimensoes: dimensoesJpeg(bytes) });
    }
  }
  return fotos;
}

/**
 * Foto onde as caixas do evento são desenhadas. No OCCUPIED, sempre a do
 * veículo cruzando a linha (PLATE_CROSSING), mesmo que o evento não traga essa
 * foto. No VACATED, a foto de saída (PARKING_EXIT).
 */
function lugarDasCaixas(tipo: EventoRecebido["messageType"]): NomeFoto {
  return tipo === "OCCUPIED" ? "linha" : "saida";
}

/** Caixas do evento; a da placa só no OCCUPIED (a placa só vem na entrada). */
function caixasDoEvento(evento: EventoRecebido): Caixa[] {
  const caixas: Caixa[] = [];
  const adicionar = (tipo: Caixa["tipo"], caixa: CaixaRecebida | null | undefined) => {
    if (caixa) caixas.push({ tipo, xMin: caixa.xMin, yMin: caixa.yMin, xMax: caixa.xMax, yMax: caixa.yMax });
  };
  adicionar("veiculo", evento.vehicle?.boundingBox);
  if (evento.messageType === "OCCUPIED") adicionar("placa", evento.plate?.boundingBox);
  return caixas;
}

/** Placa lida na entrada; o VACATED não traz placa (e, se trouxer, é ignorada). */
function placaDoEvento(evento: EventoRecebido): Placa | null {
  const placa = evento.plate;
  if (evento.messageType !== "OCCUPIED" || !placa?.value || placa.status !== "READ") return null;
  return {
    texto: placa.value,
    confianca_ocr: placa.plateConfidence ?? placa.confidence ?? null,
    confianca_deteccao: placa.plateDetectionConfidence ?? null,
    leitura_horario: evento.occurredAt,
  };
}

function duracaoEmMinutos(inicio: string | null, fim: string | null): number | null {
  if (!inicio || !fim) return null;
  const minutos = (Date.parse(fim) - Date.parse(inicio)) / 60_000;
  return Number.isFinite(minutos) && minutos >= 0 ? Math.round(minutos * 100) / 100 : null;
}

/** Mescla o evento no ciclo da ocupação (ou cria o ciclo). */
function mesclar(
  existente: Ciclo | undefined,
  evento: EventoRecebido,
  fotos: FotoDecodificada[],
  aplicado: EventoAplicado,
): Record<string, unknown> {
  const entrada = evento.messageType === "OCCUPIED";
  const anteriores = existente?.eventos ?? [];
  const encerrado = !entrada || anteriores.some((e) => e.messageType === "VACATED");

  const inicio = entrada ? evento.occurredAt : (existente?.inicio_horario ?? null);
  const fim = entrada ? (existente?.fim_horario ?? null) : evento.occurredAt;

  // A placa só vem no OCCUPIED; o VACATED mantém a que já estava.
  const placa = entrada ? placaDoEvento(evento) : (existente?.placa ?? null);

  const caixas: Partial<Record<NomeFoto, Caixa[]>> = { ...(existente?.caixas ?? {}) };
  const novasCaixas = caixasDoEvento(evento);
  if (novasCaixas.length > 0) caixas[lugarDasCaixas(evento.messageType)] = novasCaixas;

  const dimensoes: Partial<Record<NomeFoto, Dimensoes>> = { ...(existente?.dimensoes ?? {}) };
  for (const foto of fotos) {
    if (foto.dimensoes) dimensoes[foto.lugar] = foto.dimensoes;
    else delete dimensoes[foto.lugar];
  }

  const id = /^\d+$/.test(evento.occupancyId) ? Number(evento.occupancyId) : null;

  return {
    // Campos extras do OCCUPIED (installationId, bootId...) não interessam à tela.
    id: existente?.id ?? (id !== null && Number.isSafeInteger(id) && id >= 1 ? id : null),
    dispositivo: evento.deviceId,
    ocupacao: evento.occupancyId,
    vaga: evento.spaceId ?? existente?.vaga ?? null,
    camera: evento.cameraId ?? existente?.camera ?? null,
    situacao: encerrado ? "encerrada" : "ocupada",
    inicio_horario: inicio,
    fim_horario: fim,
    duracao_min: duracaoEmMinutos(inicio, fim),
    encerrado_por: entrada ? (existente?.encerrado_por ?? null) : motivoDoFim(evento.closureReason),
    placa,
    caixas,
    dimensoes,
    eventos: [...anteriores, aplicado],
  };
}

/** Valida, grava e monta a resposta para o app. Erro de disco é lançado (vira 5xx). */
export async function processarEvento(armazenamento: Armazenamento, corpo: unknown): Promise<ResultadoEvento> {
  const validacao = esquemaEvento.safeParse(corpo);
  if (!validacao.success) return recusa(corpo, 422, "INVALID_MESSAGE", descreverErros(validacao.error));
  const evento = validacao.data;

  if (!versaoSuportada(evento.schemaVersion)) {
    return recusa(
      corpo,
      422,
      "UNSUPPORTED_SCHEMA_VERSION",
      `schemaVersion ${evento.schemaVersion} não suportada (o painel entende ${VERSAO_CONTRATO})`,
    );
  }

  const fotos = decodificarFotos(evento);
  if (typeof fotos === "string") return recusa(corpo, 422, "IMAGE_INTEGRITY", fotos);

  const identificacao = {
    schemaVersion: VERSAO_CONTRATO,
    messageId: evento.messageId,
    messageType: evento.messageType,
    deviceId: evento.deviceId,
  };
  const duplicado = (anterior: EventoAplicado): ResultadoEvento => ({
    status: 200,
    resposta: {
      ...identificacao,
      result: "DUPLICATE",
      receiptId: anterior.receiptId,
      receivedAt: anterior.receivedAt,
      durable: true,
    },
  });
  const anteriorDe = (ciclo: Ciclo | undefined) => ciclo?.eventos?.find((e) => e.messageId === evento.messageId);

  // Mesmo messageId já gravado (talvez com outro occupancyId): repetição.
  const jaGravado = anteriorDe(armazenamento.cicloDaMensagem(evento.deviceId, evento.messageId));
  if (jaGravado) return duplicado(jaGravado);

  const aplicado: EventoAplicado = {
    messageId: evento.messageId,
    messageType: evento.messageType,
    occurredAt: evento.occurredAt,
    sequence: evento.sequence ?? null,
    receiptId: `rcpt-${evento.messageId}`,
    receivedAt: new Date().toISOString(),
  };

  let repetido: EventoAplicado | undefined;
  const { alterado, ciclo } = await armazenamento.alterar(chaveDaOcupacao(evento), (existente) => {
    // Repetição que chegou junto com a primeira: a conferência vale dentro da fila da chave.
    repetido = anteriorDe(existente);
    if (repetido) return null;
    const fotosNovas: Partial<Record<NomeFoto, Buffer>> = {};
    for (const foto of fotos) fotosNovas[foto.lugar] = foto.bytes;
    return { campos: mesclar(existente, evento, fotos, aplicado), fotos: fotosNovas };
  });
  if (!alterado && repetido) return duplicado(repetido);

  return {
    status: 200,
    resposta: { ...identificacao, result: "ACCEPTED", receiptId: aplicado.receiptId, receivedAt: aplicado.receivedAt, durable: true },
    ...(ciclo ? { ciclo } : {}),
  };
}
