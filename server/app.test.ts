// node --test server/app.test.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { WebSocketServer } from "ws";
import type { WebSocket as SocketDoHost } from "ws";
import type { Ciclo, RespostaLista } from "../shared/ciclo.ts";
import { criarServidor } from "./app.ts";
import { nomePasta } from "./armazenamento.ts";
import { conectarAoHost, enderecosDoHost } from "./conexaoHost.ts";

// JPEG mínimo (SOI ... EOI), só para conferir que os bytes chegam intactos.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
const JPEG_BASE64 = JPEG.toString("base64");

const INICIO = "2026-09-21T13:56:51.988-03:00";
const CHAVE = `teste:12:${INICIO}`;
const PASTA = "teste_12_2026-09-21T13_56_51.988-03_00";

function cicloExemplo(alterar: Record<string, unknown> = {}) {
  return {
    id: 12,
    dispositivo: "teste",
    inicio_horario: INICIO,
    fim_horario: "2026-09-21T13:57:35.758-03:00",
    duracao_min: 0.73,
    encerrado_por: "saida",
    placa: {
      texto: "TQF8B14",
      confianca_ocr: 1.0,
      confianca_deteccao: 0.98,
      leitura_horario: "2026-09-21T13:55:27.901-03:00",
    },
    fotos: { linha: JPEG_BASE64, entrada: JPEG_BASE64, saida: JPEG_BASE64 },
    ...alterar,
  };
}

let pastaDados: string;
let servidor: Awaited<ReturnType<typeof criarServidor>> | undefined;
const limpezas: (() => unknown)[] = [];

async function iniciar() {
  servidor = await criarServidor({ pastaDados, host: "http://127.0.0.1:8000", log: () => {} });
  return servidor;
}

function painel() {
  assert.ok(servidor, "servidor não iniciado");
  return servidor;
}

async function listar(limite?: number): Promise<RespostaLista> {
  const resposta = await painel().app.inject({ url: `/api/ciclos${limite ? `?limite=${limite}` : ""}` });
  assert.equal(resposta.statusCode, 200);
  return resposta.json();
}

beforeEach(async () => {
  pastaDados = await mkdtemp(path.join(os.tmpdir(), "smvep-painel-"));
});

afterEach(async () => {
  for (const limpar of limpezas.splice(0).reverse()) await limpar();
  await servidor?.app.close();
  servidor = undefined;
  await rm(pastaDados, { recursive: true, force: true });
});

describe("ciclo empurrado pelo host", () => {
  it("grava as fotos e o dados.json e confirma", async () => {
    await iniciar();
    const resultado = await painel().receber(cicloExemplo({ campo_futuro: "mantido" }));
    assert.deepEqual(resultado, { ok: true, chave: CHAVE, duplicado: false });
    assert.equal(nomePasta(CHAVE), PASTA);

    const pasta = path.join(pastaDados, PASTA);
    assert.deepEqual((await readdir(pasta)).sort(), ["dados.json", "entrada.jpg", "linha.jpg", "saida.jpg"]);
    assert.deepEqual(await readFile(path.join(pasta, "linha.jpg")), JPEG);

    const dados = JSON.parse(await readFile(path.join(pasta, "dados.json"), "utf8"));
    assert.equal(dados.chave, CHAVE);
    assert.equal(dados.id, 12);
    assert.deepEqual(dados.fotos, { linha: "linha.jpg", entrada: "entrada.jpg", saida: "saida.jpg" });
    assert.equal(dados.placa.texto, "TQF8B14");
    assert.equal(dados.campo_futuro, "mantido");
    assert.equal(typeof dados.recebido_em, "string");
  });

  it("confirma uma repetição sem regravar", async () => {
    await iniciar();
    await painel().receber(cicloExemplo());
    const arquivo = path.join(pastaDados, PASTA, "dados.json");
    const antes = await readFile(arquivo, "utf8");

    const repeticao = await painel().receber(cicloExemplo());

    assert.deepEqual(repeticao, { ok: true, chave: CHAVE, duplicado: true });
    assert.equal(await readFile(arquivo, "utf8"), antes);
    assert.equal((await listar()).total, 1);
  });

  it("trata repetições simultâneas como um ciclo só", async () => {
    await iniciar();
    const resultados = await Promise.all([painel().receber(cicloExemplo()), painel().receber(cicloExemplo())]);
    assert.deepEqual(resultados.map((r) => r.ok && r.duplicado).sort(), [false, true]);
    assert.equal((await listar()).total, 1);
  });

  it("o mesmo id com outro início é outro ciclo (banco do host recriado)", async () => {
    await iniciar();
    await painel().receber(cicloExemplo());
    const outro = await painel().receber(cicloExemplo({ inicio_horario: "2026-09-22T08:00:00.000-03:00" }));
    assert.deepEqual(outro, { ok: true, chave: "teste:12:2026-09-22T08:00:00.000-03:00", duplicado: false });
    assert.equal((await listar()).total, 2);
  });

  it("revisão maior regrava na mesma pasta e mantém recebido_em", async () => {
    await iniciar();
    await painel().receber(cicloExemplo({ placa: null, fotos: { linha: JPEG_BASE64, entrada: JPEG_BASE64, saida: null } }));
    const arquivo = path.join(pastaDados, PASTA, "dados.json");
    const antes = JSON.parse(await readFile(arquivo, "utf8"));
    assert.equal(antes.placa, null);

    // A placa e a foto de saída chegaram depois do primeiro envio: o host manda a revisão 2.
    const resultado = await painel().receber(cicloExemplo({ revisao: 2 }));

    assert.deepEqual(resultado, { ok: true, chave: CHAVE, duplicado: false });
    assert.deepEqual(await readdir(pastaDados), [PASTA]);
    assert.deepEqual((await readdir(path.join(pastaDados, PASTA))).sort(), ["dados.json", "entrada.jpg", "linha.jpg", "saida.jpg"]);
    const depois = JSON.parse(await readFile(arquivo, "utf8"));
    assert.equal(depois.placa.texto, "TQF8B14");
    assert.equal(depois.revisao, 2);
    assert.equal(depois.recebido_em, antes.recebido_em);
    assert.equal(typeof depois.atualizado_em, "string");
    const lista = await listar();
    assert.equal(lista.total, 1);
    assert.equal(lista.ciclos[0]?.placa?.texto, "TQF8B14");
    assert.equal(lista.ciclos[0]?.fotos.saida, `/fotos/${PASTA}/saida.jpg`);
  });

  it("revisão igual ou menor é descartada, mesmo depois de reiniciar o painel", async () => {
    await iniciar();
    await painel().receber(cicloExemplo({ placa: null }));
    await painel().receber(cicloExemplo({ revisao: 2 }));
    const arquivo = path.join(pastaDados, PASTA, "dados.json");
    const antes = await readFile(arquivo, "utf8");
    const repetido = { ok: true, chave: CHAVE, duplicado: true };

    assert.deepEqual(await painel().receber(cicloExemplo({ revisao: 2, placa: null })), repetido);
    // Sem `revisao`, vale 1 (host anterior às revisões).
    assert.deepEqual(await painel().receber(cicloExemplo({ placa: null })), repetido);
    await painel().app.close();
    await iniciar();
    assert.deepEqual(await painel().receber(cicloExemplo({ revisao: 2, placa: null })), repetido);
    assert.equal(await readFile(arquivo, "utf8"), antes);
  });

  it("revisão maior vence a gravação em andamento, em qualquer ordem de chegada", async () => {
    await iniciar();
    const resultados = await Promise.all([
      painel().receber(cicloExemplo({ placa: null })),
      painel().receber(cicloExemplo({ revisao: 2 })),
      painel().receber(cicloExemplo({ id: 14, revisao: 2 })),
      painel().receber(cicloExemplo({ id: 14, placa: null })),
    ]);
    assert.ok(resultados.every((resultado) => resultado.ok));
    for (const id of [12, 14]) {
      const pasta = nomePasta(`teste:${id}:${INICIO}`);
      const dados = JSON.parse(await readFile(path.join(pastaDados, pasta, "dados.json"), "utf8"));
      assert.equal(dados.revisao, 2, `ciclo ${id}`);
      assert.equal(dados.placa?.texto, "TQF8B14", `ciclo ${id}`);
    }
    assert.equal((await listar()).total, 2);
  });

  it("aceita fim_do_video e interrompido, com fim e duração nulos", async () => {
    await iniciar();
    const interrompido = await painel().receber(
      cicloExemplo({
        encerrado_por: "interrompido",
        fim_horario: null,
        duracao_min: null,
        fotos: { linha: JPEG_BASE64, entrada: null, saida: null },
      }),
    );
    assert.deepEqual(interrompido, { ok: true, chave: CHAVE, duplicado: false });
    const fimDoVideo = await painel().receber(cicloExemplo({ id: 13, encerrado_por: "fim_do_video" }));
    assert.equal(fimDoVideo.ok, true);

    const lista = await listar();
    assert.deepEqual(lista.ciclos.map((ciclo) => ciclo.encerrado_por).sort(), ["fim_do_video", "interrompido"]);
    assert.equal(lista.ciclos.find((ciclo) => ciclo.encerrado_por === "interrompido")?.duracao_min, null);
  });

  it("aceita horários, placa, confianças e fotos nulas", async () => {
    await iniciar();
    const resultado = await painel().receber(
      cicloExemplo({
        encerrado_por: "veiculo_perdido",
        inicio_horario: null,
        fim_horario: null,
        placa: null,
        fotos: { linha: null, entrada: null, saida: null },
      }),
    );
    assert.deepEqual(resultado, { ok: true, chave: "teste:12:", duplicado: false });
    assert.deepEqual(await readdir(path.join(pastaDados, nomePasta("teste:12:"))), ["dados.json"]);
    const [ciclo] = (await listar()).ciclos;
    assert.equal(ciclo?.placa, null);
    assert.deepEqual(ciclo?.fotos, { linha: null, entrada: null, saida: null });

    const semConfianca = await painel().receber(
      cicloExemplo({ id: 13, placa: { texto: "ABC1D23", confianca_ocr: null, confianca_deteccao: null, leitura_horario: null } }),
    );
    assert.equal(semConfianca.ok, true);
  });

  const invalidos: [string, Record<string, unknown>, RegExp][] = [
    ["encerrado_por fora do contrato", { encerrado_por: "desconhecido" }, /encerrado_por/],
    ["revisao menor que 1", { revisao: 0 }, /revisao/],
    ["id ausente", { id: undefined }, /id/],
    ["campo obrigatório ausente", { duracao_min: undefined }, /duracao_min/],
    ["foto que não é base64", { fotos: { linha: "não é base64!", entrada: null, saida: null } }, /fotos\.linha/],
  ];
  for (const [caso, alterar, mensagem] of invalidos) {
    it(`recusa: ${caso}`, async () => {
      await iniciar();
      const resultado = await painel().receber(cicloExemplo(alterar));
      assert.equal(resultado.ok, false);
      assert.match(resultado.ok ? "" : resultado.erro, mensagem);
      assert.deepEqual(await readdir(pastaDados), []);
    });
  }
});

describe("leitura para a tela", () => {
  it("lista os mais recentes primeiro, respeitando o limite", async () => {
    await iniciar();
    await painel().receber(cicloExemplo({ id: 1, fim_horario: "2026-09-21T13:56:56.941-03:00" }));
    await painel().receber(cicloExemplo({ id: 3, fim_horario: "2026-09-21T13:58:00.000-03:00" }));
    await painel().receber(cicloExemplo({ id: 2, fim_horario: "2026-09-21T13:57:10.000-03:00" }));

    const lista = await listar();
    assert.equal(lista.total, 3);
    assert.deepEqual(lista.ciclos.map((c) => c.id), [3, 2, 1]);
    assert.deepEqual((await listar(2)).ciclos.map((c) => c.id), [3, 2]);
  });

  it("devolve um ciclo pela chave e 404 para chave desconhecida", async () => {
    await iniciar();
    await painel().receber(cicloExemplo());

    const encontrado = await painel().app.inject({ url: `/api/ciclos/${encodeURIComponent(CHAVE)}` });
    assert.equal(encontrado.statusCode, 200);
    assert.equal(encontrado.json<Ciclo>().id, 12);
    assert.equal(encontrado.json<Ciclo>().placa?.texto, "TQF8B14");

    const ausente = await painel().app.inject({ url: "/api/ciclos/nao-existe" });
    assert.equal(ausente.statusCode, 404);
  });

  it("serve as fotos pelas URLs da lista e nada além delas", async () => {
    await iniciar();
    await painel().receber(cicloExemplo());
    const [ciclo] = (await listar()).ciclos;
    assert.ok(ciclo?.fotos.entrada);

    const foto = await painel().app.inject({ url: ciclo.fotos.entrada });
    assert.equal(foto.statusCode, 200);
    assert.match(String(foto.headers["content-type"]), /image\/jpeg/);
    assert.deepEqual(foto.rawPayload, JPEG);

    const dados = await painel().app.inject({ url: `/fotos/${PASTA}/dados.json` });
    assert.equal(dados.statusCode, 404);
  });

  it("recarrega do disco, inclusive as pastas de versões anteriores", async () => {
    // Pasta do antigo envio por POST: chave = id_envio, sem id nem chave.
    const legado = path.join(pastaDados, "pc-teste_run_1_1");
    await mkdir(legado);
    await writeFile(path.join(legado, "linha.jpg"), JPEG);
    const { id: _semId, ...semId } = cicloExemplo();
    const dadosLegado = { ...semId, id_envio: "pc-teste:run:1:1", run_id: "run", vid: 1, ciclo: 1, fotos: { linha: "linha.jpg", entrada: null, saida: null } };
    await writeFile(path.join(legado, "dados.json"), JSON.stringify(dadosLegado));
    // Pasta gravada com a chave antiga (dispositivo:run_id:id): vale a chave do dados.json.
    const comChave = path.join(pastaDados, "pc-teste_run_5");
    await mkdir(comChave);
    await writeFile(path.join(comChave, "dados.json"), JSON.stringify({ ...cicloExemplo({ id: 5 }), chave: "pc-teste:run:5", fotos: { linha: null, entrada: null, saida: null } }));
    // Gravação interrompida: sem dados.json, não conta.
    await mkdir(path.join(pastaDados, "incompleta"));

    await iniciar();
    await painel().receber(cicloExemplo());
    await painel().app.close();

    await iniciar();
    const lista = await listar();
    assert.equal(lista.total, 3);
    const recarregado = lista.ciclos.find((c) => c.chave === "pc-teste:run:1:1");
    assert.equal(recarregado?.id, null);
    assert.deepEqual(recarregado?.fotos, { linha: "/fotos/pc-teste_run_1_1/linha.jpg", entrada: null, saida: null });
    assert.equal(typeof recarregado?.recebido_em, "string");
    assert.equal(lista.ciclos.find((c) => c.chave === "pc-teste:run:5")?.id, 5);
    assert.equal(lista.ciclos.find((c) => c.chave === CHAVE)?.id, 12);
  });

  it("avisa a tela por Server-Sent Events: ciclo novo e estado do host", async () => {
    const endereco = await (await iniciar()).app.listen({ port: 0, host: "127.0.0.1" });
    const controle = new AbortController();
    const eventos = await fetch(`${endereco}/api/eventos`, { signal: controle.signal });
    assert.match(eventos.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.ok(eventos.body);

    const leitor = eventos.body.pipeThrough(new TextDecoderStream()).getReader();
    await painel().receber(cicloExemplo());
    painel().definirHostConectado(true);

    let recebido = "";
    while (!recebido.includes('"conectado":true')) {
      const { value, done } = await leitor.read();
      if (done) break;
      recebido += value;
    }
    controle.abort();

    const blocos = recebido.split("\n\n");
    assert.ok(blocos.some((bloco) => bloco.startsWith("event: ping")), "sem ping ao conectar");
    assert.ok(blocos.includes('event: host\ndata: {"conectado":false}'), "sem o estado do host ao conectar");
    const blocoCiclo = blocos.find((bloco) => bloco.startsWith("event: ciclo"));
    const linhaDados = blocoCiclo?.split("\n").find((linha) => linha.startsWith("data: "));
    assert.ok(linhaDados, "evento ciclo sem dados");
    const ciclo = JSON.parse(linhaDados.slice("data: ".length)) as Ciclo;
    assert.equal(ciclo.chave, CHAVE);
    assert.equal(ciclo.fotos.linha, `/fotos/${PASTA}/linha.jpg`);

    const status = (await painel().app.inject({ url: "/api/status" })).json();
    assert.equal(status.host, "http://127.0.0.1:8000");
    assert.equal(status.host_conectado, true);
  });

  it("avisa a tela quando uma revisão maior atualiza o ciclo, e não na repetição", async () => {
    const endereco = await (await iniciar()).app.listen({ port: 0, host: "127.0.0.1" });
    const controle = new AbortController();
    const eventos = await fetch(`${endereco}/api/eventos`, { signal: controle.signal });
    assert.ok(eventos.body);

    const leitor = eventos.body.pipeThrough(new TextDecoderStream()).getReader();
    await painel().receber(cicloExemplo({ placa: null }));
    await painel().receber(cicloExemplo({ revisao: 2 }));
    await painel().receber(cicloExemplo({ revisao: 2 }));
    painel().definirHostConectado(true);

    let recebido = "";
    while (!recebido.includes('"conectado":true')) {
      const { value, done } = await leitor.read();
      if (done) break;
      recebido += value;
    }
    controle.abort();

    const placas = recebido
      .split("\n\n")
      .filter((bloco) => bloco.startsWith("event: ciclo"))
      .map((bloco) => {
        const dados = bloco.split("\n").find((linha) => linha.startsWith("data: ")) ?? "data: {}";
        const ciclo = JSON.parse(dados.slice("data: ".length)) as Ciclo;
        return [ciclo.chave, ciclo.placa?.texto ?? null];
      });
    assert.deepEqual(placas, [[CHAVE, null], [CHAVE, "TQF8B14"]]);
  });
});

// ---- Conexão com um host falso (servidor WebSocket) ----

interface ConexaoNoHost {
  socket: SocketDoHost;
  proxima: (tempoMs?: number) => Promise<Record<string, unknown>>;
  fechou: Promise<void>;
}

async function hostFalso() {
  const servidorWs = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => servidorWs.once("listening", () => resolve()));
  limpezas.push(() => new Promise<void>((resolve) => {
    for (const cliente of servidorWs.clients) cliente.terminate();
    servidorWs.close(() => resolve());
  }));

  const conexoes: ConexaoNoHost[] = [];
  const aguardando: ((conexao: ConexaoNoHost) => void)[] = [];
  servidorWs.on("connection", (socket) => {
    const filaMensagens: Record<string, unknown>[] = [];
    const esperando: ((mensagem: Record<string, unknown>) => void)[] = [];
    socket.on("message", (dados) => {
      const mensagem = JSON.parse(String(dados)) as Record<string, unknown>;
      const resolver = esperando.shift();
      if (resolver) resolver(mensagem);
      else filaMensagens.push(mensagem);
    });
    const conexao: ConexaoNoHost = {
      socket,
      fechou: new Promise((resolve) => socket.once("close", () => resolve())),
      proxima: (tempoMs = 3_000) =>
        new Promise((resolve, reject) => {
          const pronta = filaMensagens.shift();
          if (pronta) return resolve(pronta);
          const resolver = (mensagem: Record<string, unknown>) => {
            clearTimeout(limite);
            resolve(mensagem);
          };
          const limite = setTimeout(() => {
            esperando.splice(esperando.indexOf(resolver), 1);
            reject(new Error("o painel não mandou mensagem"));
          }, tempoMs);
          esperando.push(resolver);
        }),
    };
    const resolverConexao = aguardando.shift();
    if (resolverConexao) resolverConexao(conexao);
    else conexoes.push(conexao);
  });

  const { port } = servidorWs.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/ws/ciclos`,
    proximaConexao: (tempoMs = 3_000) =>
      new Promise<ConexaoNoHost>((resolve, reject) => {
        const pronta = conexoes.shift();
        if (pronta) return resolve(pronta);
        const limite = setTimeout(() => reject(new Error("o painel não conectou")), tempoMs);
        aguardando.push((conexao) => {
          clearTimeout(limite);
          resolve(conexao);
        });
      }),
  };
}

function conectar(url: string, opcoes: { token?: string; silencioMaximoMs?: number; estados?: boolean[] } = {}) {
  const conexao = conectarAoHost({
    url,
    painel: "painel-teste",
    token: opcoes.token ?? null,
    receber: painel().receber,
    aoMudarEstado: (conectado) => {
      opcoes.estados?.push(conectado);
      painel().definirHostConectado(conectado);
    },
    log: () => {},
    intervaloReconexaoMs: 50,
    silencioMaximoMs: opcoes.silencioMaximoMs ?? 5_000,
  });
  limpezas.push(() => conexao.parar());
  return conexao;
}

describe("conexão com o host (WebSocket)", () => {
  it("manda ola, grava o ciclo empurrado e confirma; recusa o inválido", async () => {
    await iniciar();
    const host = await hostFalso();
    conectar(host.url, { token: "segredo" });
    const conexao = await host.proximaConexao();
    assert.deepEqual(await conexao.proxima(), { tipo: "ola", painel: "painel-teste", token: "segredo" });

    conexao.socket.send(JSON.stringify({ tipo: "ciclo", dados: cicloExemplo() }));
    assert.deepEqual(await conexao.proxima(), { tipo: "recebido", id: 12 });
    assert.deepEqual((await readdir(path.join(pastaDados, PASTA))).sort(), ["dados.json", "entrada.jpg", "linha.jpg", "saida.jpg"]);

    // O host reenvia o que não teve confirmação: o painel confirma sem duplicar.
    conexao.socket.send(JSON.stringify({ tipo: "ciclo", dados: cicloExemplo() }));
    assert.deepEqual(await conexao.proxima(), { tipo: "recebido", id: 12 });
    assert.equal((await listar()).total, 1);

    conexao.socket.send(JSON.stringify({ tipo: "ciclo", dados: cicloExemplo({ id: 13, encerrado_por: "desconhecido" }) }));
    const recusa = await conexao.proxima();
    assert.equal(recusa.tipo, "recusado");
    assert.equal(recusa.id, 13);
    assert.match(String(recusa.erro), /encerrado_por/);

    const status = (await painel().app.inject({ url: "/api/status" })).json();
    assert.equal(status.host_conectado, true);
  });

  it("sem token configurado, o ola vai sem token", async () => {
    await iniciar();
    const host = await hostFalso();
    conectar(host.url);
    const conexao = await host.proximaConexao();
    assert.deepEqual(await conexao.proxima(), { tipo: "ola", painel: "painel-teste" });
  });

  it("reconecta quando o host cai", async () => {
    await iniciar();
    const host = await hostFalso();
    const estados: boolean[] = [];
    conectar(host.url, { estados });
    const primeira = await host.proximaConexao();
    await primeira.proxima();
    primeira.socket.close(1001, "host reiniciando");

    const segunda = await host.proximaConexao();
    assert.equal((await segunda.proxima()).tipo, "ola");
    assert.deepEqual(estados.slice(0, 2), [true, false]);
  });

  it("dá a conexão por morta quando o host fica em silêncio", async () => {
    await iniciar();
    const host = await hostFalso();
    conectar(host.url, { silencioMaximoMs: 300 });
    const primeira = await host.proximaConexao();
    await primeira.proxima();
    // O host não manda nem ping: o painel abre outra conexão.
    const segunda = await host.proximaConexao(3_000);
    assert.equal((await segunda.proxima()).tipo, "ola");
  });

  it("o ping do host mantém a conexão viva", async () => {
    await iniciar();
    const host = await hostFalso();
    conectar(host.url, { silencioMaximoMs: 400 });
    const conexao = await host.proximaConexao();
    await conexao.proxima();
    const ping = setInterval(() => conexao.socket.send(JSON.stringify({ tipo: "ping" })), 100);
    limpezas.push(() => clearInterval(ping));
    await assert.rejects(host.proximaConexao(1_200), /não conectou/);
  });
});

describe("endereço do host", () => {
  it("aceita IP, IP:porta e URL, com a porta 8000 por padrão", () => {
    assert.deepEqual(enderecosDoHost("192.168.0.10"), {
      http: "http://192.168.0.10:8000",
      ws: "ws://192.168.0.10:8000/ws/ciclos",
    });
    assert.deepEqual(enderecosDoHost(" 192.168.0.10:9000 "), {
      http: "http://192.168.0.10:9000",
      ws: "ws://192.168.0.10:9000/ws/ciclos",
    });
    assert.deepEqual(enderecosDoHost("http://jetson.local:8000/docs"), {
      http: "http://jetson.local:8000",
      ws: "ws://jetson.local:8000/ws/ciclos",
    });
    assert.deepEqual(enderecosDoHost("https://smvep.exemplo.com"), {
      http: "https://smvep.exemplo.com",
      ws: "wss://smvep.exemplo.com/ws/ciclos",
    });
    assert.throws(() => enderecosDoHost("ftp://192.168.0.10"), /esquema/);
  });
});
