// Sobe o receptor. Variáveis de ambiente:
//   SMVEP_PORTA        porta HTTP (padrão 8000)
//   SMVEP_HOST         interface (padrão 0.0.0.0, para a máquina de visão alcançar pela rede)
//   SMVEP_DADOS        pasta dos ciclos, relativa à raiz do projeto (padrão dados/ciclos)
//   SMVEP_ENVIO_TOKEN  se definido, exige o mesmo token que o processo de envio usa
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { criarServidor } from "./app.ts";

const raizProjeto = path.resolve(import.meta.dirname, "..");
const porta = Number(process.env.SMVEP_PORTA ?? 8000);
const host = process.env.SMVEP_HOST ?? "0.0.0.0";
const pastaDados = path.resolve(raizProjeto, process.env.SMVEP_DADOS ?? "dados/ciclos");
const token = process.env.SMVEP_ENVIO_TOKEN?.trim() || null;
const pastaWeb = path.join(raizProjeto, "web", "dist");

/** IPv4 desta máquina nas redes locais (é para um deles que a máquina de visão envia). */
function enderecosNaRede(): { interface: string; ip: string }[] {
  return Object.entries(os.networkInterfaces()).flatMap(([nome, enderecos]) =>
    (enderecos ?? [])
      .filter((endereco) => endereco.family === "IPv4" && !endereco.internal)
      .map((endereco) => ({ interface: nome, ip: endereco.address })),
  );
}

/**
 * No console do Windows, um clique na janela entra no modo "Selecionar" e congela
 * o painel na próxima mensagem que ele escreve, até alguém apertar Enter: o
 * receptor para de responder. Desliga essa "edição rápida" só nesta janela.
 * Precisa partir do próprio Node (o cmd.exe desfaz a mudança quando um filho dele termina).
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
      console.log("[RECEPTOR] Edição rápida do console desligada: clicar nesta janela não pausa mais o painel.");
    }
  });
}

desligarPausaDoConsole();

const { app, armazenamento } = await criarServidor({ pastaDados, token, pastaWeb });
await app.listen({ port: porta, host });

const aceitaRede = host === "0.0.0.0" || host === "::";
const enderecos = aceitaRede ? enderecosNaRede() : [{ interface: "SMVEP_HOST", ip: host }];
console.log(`[RECEPTOR] Escutando em ${host}:${porta}; ${armazenamento.total} ciclo(s) em ${pastaDados}`);
if (enderecos.length === 0) {
  console.log("[RECEPTOR] Nenhuma rede encontrada: só esta máquina alcança o receptor (http://localhost:" + porta + ")");
}
for (const { interface: nome, ip } of enderecos) {
  console.log(`[RECEPTOR] ${nome}: painel em http://${ip}:${porta}  |  envio: python -m sender --url http://${ip}:${porta}/ciclos`);
}
if (enderecos.length > 1) {
  console.log("[RECEPTOR] Use o IP da mesma rede da máquina de visão.");
}
console.log(token ? "[RECEPTOR] Token exigido (SMVEP_ENVIO_TOKEN)." : "[RECEPTOR] Sem token: qualquer máquina da rede pode enviar ciclos.");

for (const sinal of ["SIGINT", "SIGTERM"] as const) {
  process.once(sinal, () => {
    void app.close().then(() => process.exit(0));
  });
}
