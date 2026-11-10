// Guarda os ciclos recebidos em disco, uma pasta por ciclo:
//   <raiz>/<id_envio sem ':'>/dados.json, linha.jpg, entrada.jpg, saida.jpg
// É o mesmo layout do receptor de teste da Jetson (sender/receiver.py), então
// as pastas gravadas por ele também abrem aqui. O índice fica em memória.
import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { NOMES_FOTOS, compararRecentes } from "../shared/ciclo.ts";
import type { Ciclo, FotosCiclo, NomeFoto } from "../shared/ciclo.ts";
import type { CicloRecebido } from "../shared/esquema.ts";

export const PREFIXO_FOTOS = "/fotos";

/** Mesmo nome de pasta do sender/receiver.py: só letras, dígitos, `.`, `_` e `-`. */
export function nomePasta(idEnvio: string): string {
  return idEnvio.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200) || "sem_id";
}

export interface ResultadoGravacao {
  duplicado: boolean;
  ciclo: Ciclo;
}

/** Grava e força o conteúdo para o disco: o 2xx só pode sair depois disso. */
async function gravarArquivo(caminho: string, conteudo: string | Buffer): Promise<void> {
  const arquivo = await open(caminho, "w");
  try {
    await arquivo.writeFile(conteudo);
    await arquivo.sync();
  } finally {
    await arquivo.close();
  }
}

export class Armazenamento {
  readonly raiz: string;
  #porId = new Map<string, Ciclo>();
  #idPorPasta = new Map<string, string>();
  #emAndamento = new Map<string, Promise<ResultadoGravacao>>();

  constructor(raiz: string) {
    this.raiz = path.resolve(raiz);
  }

  get total(): number {
    return this.#porId.size;
  }

  /** Lê as pastas que já existem. Pastas sem `dados.json` (gravação interrompida) são ignoradas. */
  async carregar(): Promise<number> {
    await mkdir(this.raiz, { recursive: true });
    const entradas = await readdir(this.raiz, { withFileTypes: true });
    for (const entrada of entradas) {
      if (!entrada.isDirectory()) continue;
      const ciclo = await this.#lerPasta(entrada.name).catch(() => null);
      if (ciclo && !this.#porId.has(ciclo.id_envio)) {
        this.#porId.set(ciclo.id_envio, ciclo);
        this.#idPorPasta.set(entrada.name, ciclo.id_envio);
      }
    }
    return this.#porId.size;
  }

  listar(limite: number): Ciclo[] {
    return [...this.#porId.values()].sort(compararRecentes).slice(0, limite);
  }

  obter(idEnvio: string): Ciclo | undefined {
    return this.#porId.get(idEnvio);
  }

  /**
   * Grava um ciclo novo. Um `id_envio` já gravado (repetição da entrega
   * "pelo menos uma vez") não é regravado e volta com `duplicado: true`.
   */
  async gravar(corpo: CicloRecebido): Promise<ResultadoGravacao> {
    const existente = this.#porId.get(corpo.id_envio);
    if (existente) return { duplicado: true, ciclo: existente };

    const emAndamento = this.#emAndamento.get(corpo.id_envio);
    if (emAndamento) return { duplicado: true, ciclo: (await emAndamento).ciclo };

    const gravacao = this.#gravarNovo(corpo);
    this.#emAndamento.set(corpo.id_envio, gravacao);
    try {
      return await gravacao;
    } finally {
      this.#emAndamento.delete(corpo.id_envio);
    }
  }

  async #gravarNovo(corpo: CicloRecebido): Promise<ResultadoGravacao> {
    const pasta = this.#reservarPasta(corpo.id_envio);
    try {
      const destino = path.join(this.raiz, pasta);
      await mkdir(destino, { recursive: true });

      // Fotos primeiro e dados.json por último: sem dados.json a pasta não conta,
      // e a repetição do mesmo ciclo grava tudo de novo.
      const arquivos = {} as Record<NomeFoto, string | null>;
      for (const nome of NOMES_FOTOS) {
        const arquivo = path.join(destino, `${nome}.jpg`);
        const base64 = corpo.fotos[nome];
        if (base64) {
          await gravarArquivo(arquivo, Buffer.from(base64, "base64"));
          arquivos[nome] = `${nome}.jpg`;
        } else {
          await rm(arquivo, { force: true });
          arquivos[nome] = null;
        }
      }

      const recebidoEm = new Date().toISOString();
      const temporario = path.join(destino, "dados.json.tmp");
      const dados = { ...corpo, fotos: arquivos, recebido_em: recebidoEm };
      await gravarArquivo(temporario, `${JSON.stringify(dados, null, 2)}\n`);
      await rename(temporario, path.join(destino, "dados.json"));

      const ciclo: Ciclo = {
        ...corpo,
        fotos: this.#urlsFotos(pasta, arquivos),
        recebido_em: recebidoEm,
      };
      this.#porId.set(ciclo.id_envio, ciclo);
      return { duplicado: false, ciclo };
    } catch (erro) {
      this.#idPorPasta.delete(pasta);
      throw erro;
    }
  }

  /** Pasta do ciclo; se outro `id_envio` já virou o mesmo nome, acrescenta um hash. */
  #reservarPasta(idEnvio: string): string {
    let pasta = nomePasta(idEnvio);
    const dono = this.#idPorPasta.get(pasta);
    if (dono !== undefined && dono !== idEnvio) {
      const hash = createHash("sha1").update(idEnvio).digest("hex").slice(0, 8);
      pasta = `${pasta.slice(0, 190)}-${hash}`;
    }
    this.#idPorPasta.set(pasta, idEnvio);
    return pasta;
  }

  async #lerPasta(pasta: string): Promise<Ciclo | null> {
    const arquivo = path.join(this.raiz, pasta, "dados.json");
    const [texto, info] = await Promise.all([readFile(arquivo, "utf8"), stat(arquivo)]);
    const dados = JSON.parse(texto);
    if (typeof dados?.id_envio !== "string" || typeof dados.vid !== "number") return null;
    const gravadas = (dados.fotos ?? {}) as Record<string, unknown>;
    const arquivos = {} as Record<NomeFoto, string | null>;
    for (const nome of NOMES_FOTOS) {
      arquivos[nome] = typeof gravadas[nome] === "string" ? `${nome}.jpg` : null;
    }
    return {
      ...dados,
      fotos: this.#urlsFotos(pasta, arquivos),
      // O receptor de teste da Jetson não grava recebido_em: usa a data do arquivo.
      recebido_em: typeof dados.recebido_em === "string" ? dados.recebido_em : info.mtime.toISOString(),
    } as Ciclo;
  }

  #urlsFotos(pasta: string, arquivos: Record<NomeFoto, string | null>): FotosCiclo {
    const urls = {} as FotosCiclo;
    for (const nome of NOMES_FOTOS) {
      const arquivo = arquivos[nome];
      urls[nome] = arquivo ? `${PREFIXO_FOTOS}/${encodeURIComponent(pasta)}/${arquivo}` : null;
    }
    return urls;
  }
}
