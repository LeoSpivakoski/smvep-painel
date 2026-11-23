// Guarda os ciclos recebidos do host em disco, uma pasta por ciclo:
//   <raiz>/<chave sem ':'>/dados.json, linha.jpg, entrada.jpg, saida.jpg
// A chave é "<dispositivo>:<id>:<início>" (chaveDoCiclo). Pastas gravadas por
// versões anteriores (com a chave no dados.json, ou o id_envio do antigo envio
// por POST) continuam abrindo. O índice fica em memória. Um ciclo que volta com
// `revisao` maior é regravado na mesma pasta.
import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { NOMES_FOTOS, compararRecentes } from "../shared/ciclo.ts";
import type { Ciclo, FotosCiclo, NomeFoto } from "../shared/ciclo.ts";
import { chaveDoCiclo, revisaoDoCiclo } from "../shared/esquema.ts";
import type { CicloRecebido } from "../shared/esquema.ts";

export const PREFIXO_FOTOS = "/fotos";

/** Nome de pasta válido também no Windows: só letras, dígitos, `.`, `_` e `-`. */
export function nomePasta(chave: string): string {
  return chave.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200) || "sem_chave";
}

export interface ResultadoGravacao {
  /** A chave já estava gravada com revisão igual ou maior: nada foi escrito. */
  duplicado: boolean;
  /** A chave já estava gravada e foi regravada com uma revisão maior. */
  atualizado: boolean;
  ciclo: Ciclo;
}

/** Grava e força o conteúdo para o disco: a confirmação ao host só sai depois disso. */
async function gravarArquivo(caminho: string, conteudo: string | Buffer): Promise<void> {
  const arquivo = await open(caminho, "w");
  try {
    await arquivo.writeFile(conteudo);
    await arquivo.sync();
  } finally {
    await arquivo.close();
  }
}

/**
 * O que um evento muda num ciclo: `campos` é o ciclo inteiro já mesclado (sem
 * chave, fotos e datas de recebimento); `fotos` só as fotos novas; as outras
 * continuam como estavam gravadas.
 */
export interface Alteracao {
  campos: Record<string, unknown>;
  fotos: Partial<Record<NomeFoto, Buffer>>;
}

export interface ResultadoAlteracao {
  /** `false` quando `montar` devolveu `null` (nada a gravar). */
  alterado: boolean;
  ciclo: Ciclo | undefined;
}

const chaveDaMensagem = (dispositivo: string, messageId: string) => `${dispositivo}\n${messageId}`;

export class Armazenamento {
  readonly raiz: string;
  #porChave = new Map<string, Ciclo>();
  #chavePorPasta = new Map<string, string>();
  /** `<dispositivo>\n<messageId>` → chave do ciclo que recebeu o evento. */
  #porMensagem = new Map<string, string>();
  #emAndamento = new Map<string, Promise<unknown>>();

  constructor(raiz: string) {
    this.raiz = path.resolve(raiz);
  }

  get total(): number {
    return this.#porChave.size;
  }

  /** Lê as pastas que já existem. Pastas sem `dados.json` (gravação interrompida) são ignoradas. */
  async carregar(): Promise<number> {
    await mkdir(this.raiz, { recursive: true });
    const entradas = await readdir(this.raiz, { withFileTypes: true });
    for (const entrada of entradas) {
      if (!entrada.isDirectory()) continue;
      const ciclo = await this.#lerPasta(entrada.name).catch(() => null);
      if (ciclo && !this.#porChave.has(ciclo.chave)) {
        this.#guardar(ciclo);
        this.#chavePorPasta.set(entrada.name, ciclo.chave);
      }
    }
    return this.#porChave.size;
  }

  /** Ciclo que já recebeu este evento do app (o mesmo `messageId` do mesmo dispositivo). */
  cicloDaMensagem(dispositivo: string, messageId: string): Ciclo | undefined {
    const chave = this.#porMensagem.get(chaveDaMensagem(dispositivo, messageId));
    return chave === undefined ? undefined : this.#porChave.get(chave);
  }

  #guardar(ciclo: Ciclo): void {
    this.#porChave.set(ciclo.chave, ciclo);
    if (Array.isArray(ciclo.eventos) && typeof ciclo.dispositivo === "string") {
      for (const evento of ciclo.eventos) {
        this.#porMensagem.set(chaveDaMensagem(ciclo.dispositivo, evento.messageId), ciclo.chave);
      }
    }
  }

  /** Uma operação por vez em cada chave, na ordem de chegada. */
  async #emFila<T>(chave: string, operacao: () => Promise<T>): Promise<T> {
    const anterior = this.#emAndamento.get(chave);
    const atual = (anterior ?? Promise.resolve()).catch(() => undefined).then(operacao);
    this.#emAndamento.set(chave, atual);
    try {
      return await atual;
    } finally {
      if (this.#emAndamento.get(chave) === atual) this.#emAndamento.delete(chave);
    }
  }

  /**
   * Aplica uma alteração ao ciclo da chave (criando-o se não existe). `montar`
   * recebe o ciclo como está gravado, já depois das alterações anteriores da
   * mesma chave, e devolve o que gravar, ou `null` para não gravar nada.
   */
  async alterar(chave: string, montar: (existente: Ciclo | undefined) => Alteracao | null): Promise<ResultadoAlteracao> {
    return this.#emFila(chave, async () => {
      const existente = this.#porChave.get(chave);
      const alteracao = montar(existente);
      if (!alteracao) return { alterado: false, ciclo: existente };
      const ciclo = await this.#escrever(chave, alteracao.campos, alteracao.fotos, existente);
      return { alterado: true, ciclo };
    });
  }

  listar(limite: number): Ciclo[] {
    return [...this.#porChave.values()].sort(compararRecentes).slice(0, limite);
  }

  obter(chave: string): Ciclo | undefined {
    return this.#porChave.get(chave);
  }

  /**
   * Grava um ciclo novo, ou regrava um já gravado quando a `revisao` é maior
   * (o host alterou o registro depois do primeiro envio). Uma chave já gravada
   * com revisão igual ou maior (o host reenvia o que não teve confirmação) não
   * é regravada e volta com `duplicado: true`.
   */
  async gravar(corpo: CicloRecebido): Promise<ResultadoGravacao> {
    const chave = chaveDoCiclo(corpo);
    // A que chega espera a gravação anterior da chave e só então compara as
    // revisões, com o que ficou gravado.
    return this.#emFila(chave, async () => {
      const existente = this.#porChave.get(chave);
      if (existente && revisaoDoCiclo(corpo) <= revisaoDoCiclo(existente)) {
        return { duplicado: true, atualizado: false, ciclo: existente };
      }
      // O ciclo do host vem completo: foto ausente apaga a que estava gravada.
      const { fotos, ...campos } = corpo;
      const novas: Partial<Record<NomeFoto, Buffer | null>> = {};
      for (const nome of NOMES_FOTOS) novas[nome] = fotos[nome] ? Buffer.from(fotos[nome], "base64") : null;
      const ciclo = await this.#escrever(chave, campos, novas, existente);
      return { duplicado: false, atualizado: existente !== undefined, ciclo };
    });
  }

  /**
   * Escreve as fotos e o dados.json. `fotos`: Buffer grava, `null` apaga, foto
   * ausente fica como estava. `existente` é o ciclo que esta gravação substitui.
   */
  async #escrever(
    chave: string,
    campos: Record<string, unknown>,
    fotos: Partial<Record<NomeFoto, Buffer | null>>,
    existente?: Ciclo,
  ): Promise<Ciclo> {
    const pasta = this.#reservarPasta(chave);
    try {
      const destino = path.join(this.raiz, pasta);
      await mkdir(destino, { recursive: true });

      // Fotos primeiro e dados.json por último: sem dados.json a pasta não conta,
      // e a repetição do mesmo ciclo grava tudo de novo.
      const arquivos = {} as Record<NomeFoto, string | null>;
      for (const nome of NOMES_FOTOS) {
        const arquivo = path.join(destino, `${nome}.jpg`);
        const foto = fotos[nome];
        if (foto) {
          await gravarArquivo(arquivo, foto);
          arquivos[nome] = `${nome}.jpg`;
        } else if (foto === null) {
          await rm(arquivo, { force: true });
          arquivos[nome] = null;
        } else {
          arquivos[nome] = existente?.fotos[nome] ? `${nome}.jpg` : null;
        }
      }

      // Uma atualização mantém a data do primeiro recebimento e ganha a própria.
      const agora = new Date().toISOString();
      const datas = existente
        ? { recebido_em: existente.recebido_em, atualizado_em: agora }
        : { recebido_em: agora };
      const temporario = path.join(destino, "dados.json.tmp");
      const dados = { chave, ...campos, fotos: arquivos, ...datas };
      await gravarArquivo(temporario, `${JSON.stringify(dados, null, 2)}\n`);
      await rename(temporario, path.join(destino, "dados.json"));

      const ciclo = {
        ...campos,
        chave,
        fotos: this.#urlsFotos(pasta, arquivos),
        ...datas,
      } as Ciclo;
      this.#guardar(ciclo);
      return ciclo;
    } catch (erro) {
      // A pasta de um ciclo já gravado continua dele: o dados.json anterior vale.
      if (!existente) this.#chavePorPasta.delete(pasta);
      throw erro;
    }
  }

  /** Pasta do ciclo; se outra chave já virou o mesmo nome, acrescenta um hash. */
  #reservarPasta(chave: string): string {
    let pasta = nomePasta(chave);
    const dono = this.#chavePorPasta.get(pasta);
    if (dono !== undefined && dono !== chave) {
      const hash = createHash("sha1").update(chave).digest("hex").slice(0, 8);
      pasta = `${pasta.slice(0, 190)}-${hash}`;
    }
    this.#chavePorPasta.set(pasta, chave);
    return pasta;
  }

  async #lerPasta(pasta: string): Promise<Ciclo | null> {
    const arquivo = path.join(this.raiz, pasta, "dados.json");
    const [texto, info] = await Promise.all([readFile(arquivo, "utf8"), stat(arquivo)]);
    const dados = JSON.parse(texto);
    if (typeof dados !== "object" || dados === null) return null;
    let chave: string | null = null;
    if (typeof dados.chave === "string") chave = dados.chave;
    else if (typeof dados.id === "number" && typeof dados.dispositivo === "string") chave = chaveDoCiclo(dados);
    else if (typeof dados.id_envio === "string") chave = dados.id_envio; // antigo envio por POST
    if (!chave) return null;
    const gravadas = (dados.fotos ?? {}) as Record<string, unknown>;
    const arquivos = {} as Record<NomeFoto, string | null>;
    for (const nome of NOMES_FOTOS) {
      arquivos[nome] = typeof gravadas[nome] === "string" ? `${nome}.jpg` : null;
    }
    return {
      ...dados,
      chave,
      id: typeof dados.id === "number" ? dados.id : null,
      fotos: this.#urlsFotos(pasta, arquivos),
      // Pastas antigas sem recebido_em: usa a data do arquivo.
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
