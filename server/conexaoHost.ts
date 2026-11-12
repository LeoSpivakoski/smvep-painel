// Conexão permanente com a API do host (CodigosVisao-Embarcado, python -m api).
// O host decide quando enviar: ele empurra cada ciclo completo por este
// WebSocket e espera a resposta. O painel só recebe, grava e confirma.
// Protocolo: CodigosVisao-Embarcado/docs/API.md e o Swagger do host (/docs).
import type { ResultadoRecebimento } from "./app.ts";

export interface OpcoesConexaoHost {
  /** ws://IP-DO-HOST:8000/ws/ciclos */
  url: string;
  /** Nome deste painel no log do host. */
  painel: string;
  /** O mesmo SMVEP_ENVIO_TOKEN do host, quando ele exige. */
  token?: string | null;
  /** Valida e grava um ciclo; só depois disso o host recebe a confirmação. */
  receber: (dados: unknown) => Promise<ResultadoRecebimento>;
  aoMudarEstado?: (conectado: boolean) => void;
  log?: (mensagem: string) => void;
  /** Espera antes de tentar de novo (padrão 2 s, sempre o mesmo intervalo). */
  intervaloReconexaoMs?: number;
  /** Espera quando outro painel tomou o host (código 4000), para os dois não se derrubarem. */
  esperaSubstituidaMs?: number;
  /** Sem nenhuma mensagem do host nesse tempo, a conexão é dada como morta (o host manda ping a cada 10 s). */
  silencioMaximoMs?: number;
}

/** Códigos de fechamento da API do host (docs/API.md). */
const MOTIVOS: Record<number, string> = {
  4000: "outro painel se conectou a este host",
  4400: "o host não entendeu a mensagem inicial",
  4401: "token recusado: use o mesmo SMVEP_ENVIO_TOKEN do host",
  4408: "o host não recebeu a confirmação de um ciclo a tempo",
};

interface MensagemHost {
  tipo?: unknown;
  dados?: unknown;
  erro?: unknown;
}

/**
 * Aceita "192.168.0.10", "192.168.0.10:8000" ou "http://192.168.0.10:8000" e
 * devolve o endereço HTTP do host e o do WebSocket (porta 8000 se faltar).
 */
export function enderecosDoHost(texto: string): { http: string; ws: string } {
  const comEsquema = /^[a-z][a-z0-9+.-]*:\/\//i.test(texto.trim()) ? texto.trim() : `http://${texto.trim()}`;
  const url = new URL(comEsquema);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new Error(`esquema não suportado: ${url.protocol}`);
  }
  if (!url.hostname) throw new Error("falta o IP ou o nome do host");
  const seguro = url.protocol === "https:" || url.protocol === "wss:";
  const porta = url.port || (seguro ? "" : "8000");
  const autoridade = `${url.hostname}${porta ? `:${porta}` : ""}`;
  return {
    http: `${seguro ? "https" : "http"}://${autoridade}`,
    ws: `${seguro ? "wss" : "ws"}://${autoridade}/ws/ciclos`,
  };
}

export function conectarAoHost(opcoes: OpcoesConexaoHost): { parar(): void } {
  const log = opcoes.log ?? ((mensagem: string) => console.log(mensagem));
  const reconexaoMs = opcoes.intervaloReconexaoMs ?? 2_000;
  const silencioMs = opcoes.silencioMaximoMs ?? 25_000;
  let ativo = true;
  let atual: WebSocket | null = null;
  let conectado = false;
  let ultimoSinal = Date.now();
  let espera: ReturnType<typeof setTimeout> | undefined;
  // A mesma falha não é repetida no log a cada nova tentativa.
  let ultimoAviso = "";
  // As mensagens são tratadas uma por vez, na ordem em que chegaram.
  let fila: Promise<void> = Promise.resolve();

  function mudarEstado(novo: boolean): void {
    if (conectado === novo) return;
    conectado = novo;
    opcoes.aoMudarEstado?.(novo);
  }

  function avisar(mensagem: string): void {
    if (mensagem === ultimoAviso) return;
    ultimoAviso = mensagem;
    log(mensagem);
  }

  function agendar(ms: number): void {
    clearTimeout(espera);
    if (ativo) espera = setTimeout(abrir, ms);
  }

  /** Dá a conexão por encerrada (uma vez só) e agenda a próxima tentativa. */
  function encerrar(ws: WebSocket, motivo: string, esperaMs = reconexaoMs): void {
    if (atual !== ws) return;
    atual = null;
    mudarEstado(false);
    avisar(`[PAINEL] Sem conexão com o host: ${motivo}. Nova tentativa a cada ${esperaMs / 1000} s.`);
    try {
      ws.close();
    } catch {
      // já fechada
    }
    agendar(esperaMs);
  }

  async function tratar(ws: WebSocket, texto: string): Promise<void> {
    let mensagem: MensagemHost;
    try {
      mensagem = JSON.parse(texto) as MensagemHost;
    } catch {
      return;
    }
    if (mensagem.tipo === "erro") {
      log(`[PAINEL] O host avisou: ${String(mensagem.erro)}`);
      return;
    }
    if (mensagem.tipo !== "ciclo") return; // ping: só renova o sinal

    const dados = mensagem.dados as { id?: unknown } | null | undefined;
    const id = typeof dados?.id === "number" ? dados.id : 0;
    let resultado: ResultadoRecebimento;
    try {
      resultado = await opcoes.receber(mensagem.dados);
    } catch (erro) {
      // Falha ao gravar (disco cheio, por exemplo): sem confirmação, o ciclo
      // continua pendente no host e volta mais tarde.
      log(`[PAINEL] Falha ao gravar o ciclo ${id}: ${(erro as Error).message}`);
      return;
    }
    if (atual !== ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify(
        resultado.ok ? { tipo: "recebido", id } : { tipo: "recusado", id, erro: resultado.erro.slice(0, 500) },
      ),
    );
  }

  function abrir(): void {
    if (!ativo) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(opcoes.url);
    } catch (erro) {
      avisar(`[PAINEL] Endereço do host inválido (${opcoes.url}): ${(erro as Error).message}`);
      agendar(reconexaoMs);
      return;
    }
    atual = ws;
    ultimoSinal = Date.now();

    ws.addEventListener("open", () => {
      if (atual !== ws) return;
      ultimoSinal = Date.now();
      ws.send(JSON.stringify({ tipo: "ola", painel: opcoes.painel, ...(opcoes.token ? { token: opcoes.token } : {}) }));
      ultimoAviso = "";
      log(`[PAINEL] Conectado ao host (${opcoes.url}).`);
      mudarEstado(true);
    });

    ws.addEventListener("message", (evento) => {
      if (atual !== ws) return;
      ultimoSinal = Date.now();
      const texto = typeof evento.data === "string" ? evento.data : "";
      fila = fila
        .then(() => tratar(ws, texto))
        .catch((erro: unknown) => log(`[PAINEL] Erro ao tratar a mensagem do host: ${String(erro)}`));
    });

    ws.addEventListener("close", (evento) => {
      const { code, reason } = evento as unknown as { code: number; reason: string };
      const motivo = MOTIVOS[code] ?? (reason || (conectado ? "a conexão caiu" : "host fora do ar ou inacessível"));
      encerrar(ws, motivo, code === 4000 ? (opcoes.esperaSubstituidaMs ?? 30_000) : reconexaoMs);
    });

    // O "close" vem logo depois de um "error" e cuida da reconexão.
    ws.addEventListener("error", () => {});
  }

  // Conexão que morreu sem aviso (cabo, Wi-Fi, host travado) ou que não abre:
  // sem nenhuma mensagem do host no prazo, abre outra.
  const vigia = setInterval(
    () => {
      const ws = atual;
      if (ws && Date.now() - ultimoSinal > silencioMs) {
        encerrar(ws, `${silencioMs / 1000} s sem notícias do host`);
      }
    },
    Math.min(1_000, Math.max(50, silencioMs / 4)),
  );
  vigia.unref();

  abrir();

  return {
    parar() {
      ativo = false;
      clearTimeout(espera);
      clearInterval(vigia);
      const ws = atual;
      atual = null;
      try {
        ws?.close();
      } catch {
        // já fechada
      }
    },
  };
}
