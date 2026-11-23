// Sobe o painel: recebe os eventos que o app empurra (POST /eventos), grava e serve a tela.
// Variáveis de ambiente:
//   SMVEP_HOST         opcional: endereço da API do host, ex.: http://192.168.0.10:8000;
//                      definido, o painel também se conecta a ele por WebSocket
//   SMVEP_PORTA        porta da tela (padrão 8080)
//   SMVEP_INTERFACE    interface da tela (padrão 0.0.0.0: outros computadores também abrem)
//   SMVEP_DADOS        pasta dos ciclos, relativa à raiz do projeto (padrão dados/ciclos)
//   SMVEP_ENVIO_TOKEN  definido, o POST /eventos exige "Authorization: Bearer <token>";
//                      também vai para o host no WebSocket
//   SMVEP_ABRIR_NAVEGADOR=1  abre a tela no navegador ao iniciar (INICIAR-PAINEL.cmd)
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { criarServidor } from "./app.ts";
import { conectarAoHost, enderecosDoHost } from "./conexaoHost.ts";

const raizProjeto = path.resolve(import.meta.dirname, "..");
const porta = Number(process.env.SMVEP_PORTA ?? 8080);
const interfaceRede = process.env.SMVEP_INTERFACE ?? "0.0.0.0";
const pastaDados = path.resolve(raizProjeto, process.env.SMVEP_DADOS ?? "dados/ciclos");
const token = process.env.SMVEP_ENVIO_TOKEN?.trim() || null;
const pastaWeb = path.join(raizProjeto, "web", "dist");

/**
 * No console do Windows, um clique na janela entra no modo "Selecionar" e congela
 * o painel na próxima mensagem que ele escreve, até alguém apertar Enter. Desliga
 * essa "edição rápida" só nesta janela. Precisa partir do próprio Node (o cmd.exe
 * desfaz a mudança quando um filho dele termina).
 */
function desligarPausaDoConsole(): void {
  if (process.platform !== "win32" || !process.stdin.isTTY) return;
  const script = path.join(raizProjeto, "scripts", "console-sem-pausa.ps1");
  // A entrada é herdada: o script precisa do console desta janela, não de um pipe.
  const filho = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
    { stdio: ["inherit", "pipe", "ignore"], timeout: 30_000 },
  );
  let saida = "";
  filho.stdout?.setEncoding("utf8").on("data", (parte: string) => (saida += parte));
  filho.on("error", () => {}); // sem PowerShell: segue sem desligar
  filho.on("close", () => {
    if (saida.trim() === "desligada") {
      console.log("[PAINEL] Edição rápida do console desligada: clicar nesta janela não pausa mais o painel.");
    }
  });
}

function abrirNavegador(url: string): void {
  const [comando, argumentos] =
    process.platform === "win32"
      ? ["cmd.exe", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const filho = spawn(comando, argumentos, { stdio: "ignore", detached: true });
  filho.on("error", () => {});
  filho.unref();
}

/** IPv4 desta máquina na rede local: os endereços que o app pode usar para chegar ao painel. */
function enderecosLocais(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((rede) => rede && rede.family === "IPv4" && !rede.internal)
    .map((rede) => rede!.address);
}

function principal(): void {
  const enderecoHost = process.env.SMVEP_HOST?.trim();
  let host: { http: string; ws: string } | null = null;
  if (enderecoHost) {
    try {
      host = enderecosDoHost(enderecoHost);
    } catch (erro) {
      console.error(`[PAINEL] Endereço do host inválido: "${enderecoHost}" (${(erro as Error).message}).`);
      process.exit(2);
    }
  }

  desligarPausaDoConsole();
  void iniciar(host);
}

async function iniciar(host: { http: string; ws: string } | null): Promise<void> {
  const servidor = await criarServidor({ pastaDados, pastaWeb, host: host?.http ?? null, token });
  const { app, armazenamento } = servidor;
  await app.listen({ port: porta, host: interfaceRede });

  const tela = `http://localhost:${porta}`;
  console.log(`[PAINEL] Tela: ${tela}  (${armazenamento.total} ciclo(s) em ${pastaDados})`);
  const locais = interfaceRede === "0.0.0.0" ? enderecosLocais() : [interfaceRede];
  console.log("[PAINEL] No app, use o endereço deste painel (o app envia POST /eventos):");
  for (const ip of locais.length ? locais : ["localhost"]) console.log(`         http://${ip}:${porta}`);
  console.log(
    token
      ? "[PAINEL] Token configurado: o app precisa enviar Authorization: Bearer <token>."
      : "[PAINEL] Sem token: qualquer app na rede pode enviar eventos.",
  );

  let conexao: { parar(): void } | null = null;
  if (host) {
    console.log(`[PAINEL] Host: ${host.http}  (Swagger da API: ${host.http}/docs)`);
    conexao = conectarAoHost({
      url: host.ws,
      painel: os.hostname(),
      token,
      receber: servidor.receber,
      aoMudarEstado: servidor.definirHostConectado,
    });
  }

  if (process.env.SMVEP_ABRIR_NAVEGADOR === "1") abrirNavegador(tela);

  for (const sinal of ["SIGINT", "SIGTERM"] as const) {
    process.once(sinal, () => {
      conexao?.parar();
      void app.close().then(() => process.exit(0));
    });
  }
}

principal();
