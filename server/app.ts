// Receptor HTTP do painel.
//   POST /ciclos          a Jetson entrega cada ciclo completo (contrato do docs/API.md)
//   GET  /api/ciclos      lista para a tela, mais recentes primeiro
//   GET  /api/ciclos/:id  um ciclo
//   GET  /api/eventos     Server-Sent Events: evento `ciclo` a cada ciclo novo
//   GET  /api/status      saúde do receptor
//   GET  /fotos/...       fotos dos ciclos
//   GET  /                tela (build de web/dist), quando existe
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { Ciclo, RespostaLista } from "../shared/ciclo.ts";
import { descreverErros, esquemaCiclo } from "../shared/esquema.ts";
import { Armazenamento, PREFIXO_FOTOS } from "./armazenamento.ts";

/** O API.md pede pelo menos 2 MB; os ciclos reais têm de 176 a 425 KB. */
export const LIMITE_CORPO = 20 * 1024 * 1024;

/** A tela reabre a conexão depois de 2,5 intervalos sem nenhum evento (web/src/useCiclos.ts). */
export const INTERVALO_PING_MS = 10_000;

export interface OpcoesServidor {
  /** Pasta onde cada ciclo vira uma subpasta. */
  pastaDados: string;
  /** Quando definido, exige `Authorization: Bearer <token>` no POST (SMVEP_ENVIO_TOKEN). */
  token?: string | null;
  /** Build da tela (web/dist). */
  pastaWeb?: string | null;
  log?: (mensagem: string) => void;
  intervaloKeepAliveMs?: number;
}

function tokenConfere(cabecalho: string | undefined, token: string): boolean {
  const recebido = Buffer.from(cabecalho ?? "", "utf8");
  const esperado = Buffer.from(`Bearer ${token}`, "utf8");
  return recebido.length === esperado.length && timingSafeEqual(recebido, esperado);
}

function limiteDaConsulta(valor: string | undefined): number {
  const numero = Number.parseInt(valor ?? "", 10);
  return Number.isFinite(numero) ? Math.min(Math.max(numero, 1), 500) : 20;
}

export async function criarServidor(opcoes: OpcoesServidor) {
  const log = opcoes.log ?? ((mensagem: string) => console.log(mensagem));
  const armazenamento = new Armazenamento(opcoes.pastaDados);
  await armazenamento.carregar();

  const app = Fastify({ bodyLimit: LIMITE_CORPO, logger: false });

  // A Jetson guarda os primeiros 300 caracteres da resposta de erro: mensagem curta e clara.
  app.setErrorHandler((erro, requisicao, resposta) => {
    const { statusCode, message } = erro as { statusCode?: number; message?: string };
    const status = statusCode && statusCode >= 400 ? statusCode : 500;
    if (status >= 500) log(`[RECEPTOR] erro em ${requisicao.method} ${requisicao.url}: ${message}`);
    else if (requisicao.method === "POST") log(`[RECEPTOR] recusado (${status}): ${message}`);
    void resposta.code(status).send({ ok: false, erro: message ?? "erro interno" });
  });

  app.setNotFoundHandler((requisicao, resposta) => {
    void resposta.code(404).send({ ok: false, erro: `rota não encontrada: ${requisicao.method} ${requisicao.url}` });
  });

  // ---- Eventos em tempo real para a tela ----
  const clientes = new Set<ServerResponse>();

  function transmitir(ciclo: Ciclo): void {
    const mensagem = `event: ciclo\ndata: ${JSON.stringify(ciclo)}\n\n`;
    for (const cliente of clientes) cliente.write(mensagem);
  }

  // `ping` é um evento (não um comentário SSE) para a tela poder perceber uma
  // conexão que morreu sem aviso (rede caiu, proxy) e reabrir sozinha.
  const PING = "event: ping\ndata: {}\n\n";
  const keepAlive = setInterval(() => {
    for (const cliente of clientes) cliente.write(PING);
  }, opcoes.intervaloKeepAliveMs ?? INTERVALO_PING_MS);
  keepAlive.unref();

  app.addHook("preClose", async () => {
    clearInterval(keepAlive);
    for (const cliente of clientes) cliente.end();
    clientes.clear();
  });

  app.get("/api/eventos", (requisicao, resposta) => {
    resposta.hijack();
    const saida = resposta.raw;
    saida.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    saida.write(`retry: 3000\n\n${PING}`);
    clientes.add(saida);
    requisicao.raw.on("close", () => clientes.delete(saida));
  });

  // ---- Entrega da Jetson ----
  app.post("/ciclos", async (requisicao, resposta) => {
    if (opcoes.token && !tokenConfere(requisicao.headers.authorization, opcoes.token)) {
      log("[RECEPTOR] recusado (401): token inválido");
      return resposta.code(401).send({ ok: false, erro: "token inválido" });
    }
    const validacao = esquemaCiclo.safeParse(requisicao.body);
    if (!validacao.success) {
      const erro = descreverErros(validacao.error);
      log(`[RECEPTOR] recusado (422): ${erro}`);
      return resposta.code(422).send({ ok: false, erro });
    }
    // Só responde 2xx depois de gravar: para a Jetson, 2xx é definitivo.
    const { duplicado, ciclo } = await armazenamento.gravar(validacao.data);
    if (duplicado) {
      log(`[RECEPTOR] ${ciclo.id_envio} repetido (já estava gravado)`);
    } else {
      log(`[RECEPTOR] ${ciclo.id_envio} gravado (${ciclo.placa?.texto ?? "sem placa"})`);
      transmitir(ciclo);
    }
    // Repetição também recebe 2xx (nunca 409), senão a Jetson não marca como enviado.
    return { ok: true, id_envio: ciclo.id_envio, duplicado };
  });

  // ---- Leitura para a tela ----
  app.get<{ Querystring: { limite?: string } }>("/api/ciclos", async (requisicao) => {
    const resposta: RespostaLista = {
      ciclos: armazenamento.listar(limiteDaConsulta(requisicao.query.limite)),
      total: armazenamento.total,
    };
    return resposta;
  });

  app.get<{ Params: { id: string } }>("/api/ciclos/:id", async (requisicao, resposta) => {
    const ciclo = armazenamento.obter(requisicao.params.id);
    if (!ciclo) return resposta.code(404).send({ ok: false, erro: "ciclo não encontrado" });
    return ciclo;
  });

  app.get("/api/status", async () => ({
    ok: true,
    ciclos: armazenamento.total,
    conexoes_tela: clientes.size,
    token_exigido: Boolean(opcoes.token),
  }));

  await app.register(fastifyStatic, {
    root: armazenamento.raiz,
    prefix: `${PREFIXO_FOTOS}/`,
    index: false,
    allowedPath: (caminho) => /\/(linha|entrada|saida)\.jpg$/.test(caminho),
    maxAge: "1h",
  });

  if (opcoes.pastaWeb && existsSync(opcoes.pastaWeb)) {
    await app.register(fastifyStatic, {
      root: opcoes.pastaWeb,
      prefix: "/",
      decorateReply: false,
    });
  }

  return { app, armazenamento };
}
