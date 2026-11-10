// Faz o papel da Jetson: reenvia ciclos gravados em pastas por POST /ciclos,
// um de cada vez, na ordem em que as paradas terminaram.
//
//   npm run simular -- <pasta> [--url http://localhost:8000/ciclos] [--intervalo 2] [--token X]
//
// <pasta> contém uma subpasta por ciclo com dados.json + linha.jpg, entrada.jpg
// e saida.jpg: o formato do receptor de teste da Jetson (sender/receiver.py,
// por exemplo CodigosVisao-Embarcado/output/recebidos) e também o deste painel.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { NOMES_FOTOS } from "../shared/ciclo.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    intervalo: { type: "string", default: "2" },
    token: { type: "string" },
  },
});

const pasta = positionals[0];
if (!pasta) {
  console.error("uso: npm run simular -- <pasta> [--url URL] [--intervalo segundos] [--token TOKEN]");
  process.exit(2);
}
const url = values.url ?? process.env.SMVEP_ENVIO_URL ?? "http://localhost:8000/ciclos";
const intervaloMs = Math.max(0, Number(values.intervalo) * 1000 || 0);
const token = values.token ?? process.env.SMVEP_ENVIO_TOKEN;

interface CicloEmDisco {
  pasta: string;
  dados: Record<string, unknown> & { id_envio: string; fim_horario?: string | null; fim_min?: number };
}

async function lerCiclos(raiz: string): Promise<CicloEmDisco[]> {
  const ciclos: CicloEmDisco[] = [];
  for (const entrada of await readdir(raiz, { withFileTypes: true })) {
    if (!entrada.isDirectory()) continue;
    const subpasta = path.join(raiz, entrada.name);
    try {
      const dados = JSON.parse(await readFile(path.join(subpasta, "dados.json"), "utf8"));
      if (typeof dados?.id_envio === "string") ciclos.push({ pasta: subpasta, dados });
    } catch {
      // Sem dados.json válido: não é a pasta de um ciclo.
    }
  }
  const momento = ({ dados }: CicloEmDisco) => Date.parse(dados.fim_horario ?? "") || (dados.fim_min ?? 0) * 60_000;
  return ciclos.sort((a, b) => momento(a) - momento(b));
}

async function montarCorpo({ pasta: subpasta, dados }: CicloEmDisco): Promise<string> {
  const gravadas = (dados.fotos ?? {}) as Record<string, unknown>;
  const fotos: Record<string, string | null> = {};
  for (const nome of NOMES_FOTOS) {
    const arquivo = gravadas[nome];
    fotos[nome] = typeof arquivo === "string" ? (await readFile(path.join(subpasta, arquivo))).toString("base64") : null;
  }
  // `recebido_em` é anotação do receptor, não faz parte do que a Jetson envia.
  const { recebido_em: _recebidoEm, ...corpo } = dados;
  return JSON.stringify({ ...corpo, fotos });
}

const ciclos = await lerCiclos(path.resolve(pasta));
if (ciclos.length === 0) {
  console.error(`nenhum ciclo (subpasta com dados.json) em ${path.resolve(pasta)}`);
  process.exit(1);
}
console.log(`[SIMULADOR] ${ciclos.length} ciclo(s) para ${url}`);

for (const [indice, ciclo] of ciclos.entries()) {
  if (indice > 0 && intervaloMs > 0) await new Promise((fim) => setTimeout(fim, intervaloMs));
  const corpo = await montarCorpo(ciclo);
  const cabecalhos: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Idempotency-Key": ciclo.dados.id_envio,
  };
  if (token) cabecalhos.Authorization = `Bearer ${token}`;
  try {
    const resposta = await fetch(url, { method: "POST", headers: cabecalhos, body: corpo, redirect: "manual" });
    const texto = (await resposta.text()).slice(0, 300);
    const tamanho = Math.round(Buffer.byteLength(corpo) / 1024);
    console.log(`[SIMULADOR] ${resposta.status} ${ciclo.dados.id_envio} (${tamanho} KB) ${resposta.ok ? "" : texto}`);
  } catch (erro) {
    console.error(`[SIMULADOR] falha ao enviar ${ciclo.dados.id_envio}: ${(erro as Error).message}`);
    process.exit(1);
  }
}
