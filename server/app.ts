// Servidor do painel. Os ciclos chegam do host pelo WebSocket (conexaoHost.ts),
// passam por `receber` e ficam gravados em disco; a tela os lê por aqui:
//   GET  /api/ciclos         lista para a tela, mais recentes primeiro
//   GET  /api/ciclos/:chave  um ciclo
//   GET  /api/eventos        Server-Sent Events: `ciclo` a cada ciclo novo ou atualizado
//                            (revisão maior), `host` quando a conexão com o host muda,
//                            `ping` a cada 10 s
//   GET  /api/status         saúde do painel e da conexão com o host
//   GET  /fotos/...          fotos dos ciclos
//   GET  /                   tela (build de web/dist), quando existe
import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { Ciclo, RespostaLista } from "../shared/ciclo.ts";
import { descreverErros, esquemaCiclo, revisaoDoCiclo } from "../shared/esquema.ts";
import { Armazenamento, PREFIXO_FOTOS } from "./armazenamento.ts";

/** A tela reabre a conexão depois de 2,5 intervalos sem nenhum evento (web/src/useCiclos.ts). */
export const INTERVALO_PING_MS = 10_000;

export interface OpcoesServidor {
  /** Pasta onde cada ciclo vira uma subpasta. */
  pastaDados: string;
  /** Build da tela (web/dist). */
  pastaWeb?: string | null;
  /** Endereço do host (só para /api/status e para a tela). */
  host?: string | null;
  log?: (mensagem: string) => void;
  intervaloKeepAliveMs?: number;
}

export type ResultadoRecebimento =
  | { ok: true; chave: string; duplicado: boolean }
  | { ok: false; erro: string };

function limiteDaConsulta(valor: string | undefined): number {
  const numero = Number.parseInt(valor ?? "", 10);
  return Number.isFinite(numero) ? Math.min(Math.max(numero, 1), 500) : 20;
}

export async function criarServidor(opcoes: OpcoesServidor) {
  const log = opcoes.log ?? ((mensagem: string) => console.log(mensagem));
  const armazenamento = new Armazenamento(opcoes.pastaDados);
  await armazenamento.carregar();
  const estadoHost = { endereco: opcoes.host ?? null, conectado: false };

  const app = Fastify({ logger: false });

  app.setErrorHandler((erro, requisicao, resposta) => {
    const { statusCode, message } = erro as { statusCode?: number; message?: string };
    const status = statusCode && statusCode >= 400 ? statusCode : 500;
    if (status >= 500) log(`[PAINEL] erro em ${requisicao.method} ${requisicao.url}: ${message}`);
    void resposta.code(status).send({ ok: false, erro: message ?? "erro interno" });
  });

  app.setNotFoundHandler((requisicao, resposta) => {
    void resposta.code(404).send({ ok: false, erro: `rota não encontrada: ${requisicao.method} ${requisicao.url}` });
  });

  // ---- Eventos em tempo real para a tela ----
  const clientes = new Set<ServerResponse>();

  function transmitir(evento: string, dados: unknown): void {
    const mensagem = `event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`;
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
    // Já na abertura: a tela fica sabendo se o host está conectado.
    saida.write(`retry: 3000\n\n${PING}event: host\ndata: ${JSON.stringify({ conectado: estadoHost.conectado })}\n\n`);
    clientes.add(saida);
    requisicao.raw.on("close", () => clientes.delete(saida));
  });

  // ---- Ciclos vindos do host ----

  /** Valida, grava e avisa a tela. Só depois de gravar o host recebe a confirmação. */
  async function receber(dados: unknown): Promise<ResultadoRecebimento> {
    const validacao = esquemaCiclo.safeParse(dados);
    if (!validacao.success) {
      const erro = descreverErros(validacao.error);
      log(`[PAINEL] ciclo recusado: ${erro}`);
      return { ok: false, erro };
    }
    const { duplicado, atualizado, ciclo } = await armazenamento.gravar(validacao.data);
    if (duplicado) {
      log(`[PAINEL] ciclo ${ciclo.chave} repetido (já estava gravado)`);
    } else {
      const placa = ciclo.placa?.texto ?? "sem placa";
      log(
        atualizado
          ? `[PAINEL] ciclo ${ciclo.chave} atualizado para a revisão ${revisaoDoCiclo(ciclo)} (${placa})`
          : `[PAINEL] ciclo ${ciclo.chave} gravado (${placa})`,
      );
      // Novo ou atualizado: a tela troca o ciclo pela chave (mesclarCiclos).
      transmitir("ciclo", ciclo);
    }
    return { ok: true, chave: ciclo.chave, duplicado };
  }

  /** Chamado pela conexão com o host: a tela mostra SEM HOST quando ela cai. */
  function definirHostConectado(conectado: boolean): void {
    if (estadoHost.conectado === conectado) return;
    estadoHost.conectado = conectado;
    transmitir("host", { conectado });
  }

  // ---- Leitura para a tela ----
  app.get<{ Querystring: { limite?: string } }>("/api/ciclos", async (requisicao) => {
    const resposta: RespostaLista = {
      ciclos: armazenamento.listar(limiteDaConsulta(requisicao.query.limite)),
      total: armazenamento.total,
    };
    return resposta;
  });

  app.get<{ Params: { chave: string } }>("/api/ciclos/:chave", async (requisicao, resposta) => {
    const ciclo: Ciclo | undefined = armazenamento.obter(requisicao.params.chave);
    if (!ciclo) return resposta.code(404).send({ ok: false, erro: "ciclo não encontrado" });
    return ciclo;
  });

  app.get("/api/status", async () => ({
    ok: true,
    ciclos: armazenamento.total,
    conexoes_tela: clientes.size,
    host: estadoHost.endereco,
    host_conectado: estadoHost.conectado,
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

  return { app, armazenamento, receber, definirHostConectado };
}
