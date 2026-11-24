// node --test server/app.test.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

describe("eventos empurrados pelo app (POST /eventos)", () => {
  // JPEG mínimo com o marcador SOF0 de uma foto 2688×1520 (o painel lê o tamanho dele).
  const FOTO_INTEIRA = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x05, 0xf0, 0x0a, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03,
    0x11, 0x01, 0xff, 0xd9,
  ]);
  const FOTO_SAIDA = Buffer.concat([FOTO_INTEIRA.subarray(0, -2), Buffer.from([0x00, 0xff, 0xd9])]);

  function imagem(purpose: string, bytes: Buffer, alterar: Record<string, unknown> = {}) {
    return {
      imageId: `img-${purpose}`,
      purpose,
      capturedAt: "2026-09-21T13:54:54.986-03:00",
      mimeType: "image/jpeg",
      encoding: "base64",
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      base64: bytes.toString("base64"),
      ...alterar,
    };
  }

  function ocupado(alterar: Record<string, unknown> = {}) {
    return {
      schemaVersion: "1.0",
      messageId: "evt-0001",
      messageType: "OCCUPIED",
      deviceId: "EMB-001",
      installationId: "PONTO-001",
      configVersion: 1,
      bootId: "boot-7721",
      sequence: 104,
      occurredAt: "2026-09-21T13:54:54.986-03:00",
      timeQuality: "SYNCED",
      cameraId: "CAM-001",
      spaceId: "BAY-01",
      occupancyId: "70",
      plate: {
        status: "READ",
        value: "QRP7J32",
        plateConfidence: 0.99,
        plateDetectionConfidence: 0.98,
        boundingBox: { xMin: 1973, yMin: 907, xMax: 2085, yMax: 953 },
      },
      vehicle: { detected: true, boundingBox: { xMin: 1569, yMin: 615, xMax: 2234, yMax: 1153 } },
      evidenceStatus: "AVAILABLE",
      images: [imagem("PLATE_CROSSING", FOTO_INTEIRA), imagem("PARKING_ENTRY", FOTO_INTEIRA)],
      ...alterar,
    };
  }

  function liberado(alterar: Record<string, unknown> = {}) {
    return {
      schemaVersion: "1.0",
      messageId: "evt-0002",
      messageType: "VACATED",
      deviceId: "EMB-001",
      sequence: 105,
      occurredAt: "2026-09-21T13:56:56.540-03:00",
      cameraId: "CAM-001",
      spaceId: "BAY-01",
      occupancyId: "70",
      vehicle: { detected: true, boundingBox: { xMin: 970, yMin: 523, xMax: 1867, yMax: 1001 } },
      closureReason: "DEPARTURE_OBSERVED",
      evidenceStatus: "AVAILABLE",
      images: [imagem("PARKING_EXIT", FOTO_SAIDA)],
      ...alterar,
    };
  }

  const CHAVE_OCUPACAO = "EMB-001:70";
  const PASTA_OCUPACAO = "EMB-001_70";

  async function iniciarSemHost(token: string | null = null) {
    servidor = await criarServidor({ pastaDados, token, log: () => {} });
    return servidor;
  }

  async function enviar(corpo: unknown, cabecalhos: Record<string, string> = {}) {
    return painel().app.inject({
      method: "POST",
      url: "/eventos",
      headers: { "content-type": "application/json", ...cabecalhos },
      payload: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
    });
  }

  async function cicloDaOcupacao(): Promise<Ciclo> {
    const resposta = await painel().app.inject({ url: `/api/ciclos/${encodeURIComponent(CHAVE_OCUPACAO)}` });
    assert.equal(resposta.statusCode, 200);
    return resposta.json();
  }

  it("OCCUPIED: responde ACCEPTED e o veículo aparece na vaga, com as caixas na foto da linha", async () => {
    await iniciarSemHost();
    const resposta = await enviar(ocupado());
    assert.equal(resposta.statusCode, 200);
    const corpo = resposta.json();
    assert.deepEqual(
      { ...corpo, receivedAt: typeof corpo.receivedAt },
      {
        schemaVersion: "1.0",
        messageId: "evt-0001",
        messageType: "OCCUPIED",
        deviceId: "EMB-001",
        result: "ACCEPTED",
        receiptId: "rcpt-evt-0001",
        receivedAt: "string",
        durable: true,
      },
    );
    assert.ok(!Number.isNaN(Date.parse(corpo.receivedAt)));

    const ciclo = await cicloDaOcupacao();
    assert.equal(ciclo.situacao, "ocupada");
    assert.equal(ciclo.encerrado_por, null);
    assert.equal(ciclo.inicio_horario, "2026-09-21T13:54:54.986-03:00");
    assert.equal(ciclo.fim_horario, null);
    assert.equal(ciclo.duracao_min, null);
    assert.equal(ciclo.id, 70);
    assert.equal(ciclo.vaga, "BAY-01");
    assert.deepEqual(ciclo.placa, {
      texto: "QRP7J32",
      confianca_ocr: 0.99,
      confianca_deteccao: 0.98,
      leitura_horario: "2026-09-21T13:54:54.986-03:00",
    });
    assert.deepEqual(ciclo.fotos, {
      linha: `/fotos/${PASTA_OCUPACAO}/linha.jpg`,
      entrada: `/fotos/${PASTA_OCUPACAO}/entrada.jpg`,
      saida: null,
    });
    assert.deepEqual(ciclo.caixas, {
      linha: [
        { tipo: "veiculo", xMin: 1569, yMin: 615, xMax: 2234, yMax: 1153 },
        { tipo: "placa", xMin: 1973, yMin: 907, xMax: 2085, yMax: 953 },
      ],
    });
    assert.deepEqual(ciclo.dimensoes, {
      linha: { largura: 2688, altura: 1520 },
      entrada: { largura: 2688, altura: 1520 },
    });
    assert.deepEqual(await readFile(path.join(pastaDados, PASTA_OCUPACAO, "linha.jpg")), FOTO_INTEIRA);
  });

  it("VACATED: completa o mesmo ciclo, com duração, motivo, foto e caixa de saída", async () => {
    await iniciarSemHost();
    await enviar(ocupado());
    const resposta = await enviar(liberado());
    assert.equal(resposta.statusCode, 200);
    assert.equal(resposta.json().result, "ACCEPTED");
    assert.equal(resposta.json().receiptId, "rcpt-evt-0002");

    const ciclo = await cicloDaOcupacao();
    assert.equal(ciclo.situacao, "encerrada");
    assert.equal(ciclo.encerrado_por, "saida");
    assert.equal(ciclo.fim_horario, "2026-09-21T13:56:56.540-03:00");
    assert.equal(ciclo.duracao_min, 2.03);
    // A placa lida na entrada continua (na saída ela não estava visível).
    assert.equal(ciclo.placa?.texto, "QRP7J32");
    assert.ok(ciclo.fotos.linha && ciclo.fotos.entrada && ciclo.fotos.saida);
    assert.deepEqual(ciclo.caixas?.saida, [{ tipo: "veiculo", xMin: 970, yMin: 523, xMax: 1867, yMax: 1001 }]);
    assert.equal(ciclo.caixas?.linha?.length, 2);
    assert.deepEqual(await readFile(path.join(pastaDados, PASTA_OCUPACAO, "saida.jpg")), FOTO_SAIDA);
    assert.deepEqual(await readFile(path.join(pastaDados, PASTA_OCUPACAO, "linha.jpg")), FOTO_INTEIRA);
    assert.equal((await listar()).total, 1);
  });

  it("VACATED antes do OCCUPIED: os dois são aceitos e o ciclo fica completo e encerrado", async () => {
    await iniciarSemHost();
    assert.equal((await enviar(liberado())).json().result, "ACCEPTED");
    let ciclo = await cicloDaOcupacao();
    assert.equal(ciclo.situacao, "encerrada");
    assert.equal(ciclo.inicio_horario, null);

    assert.equal((await enviar(ocupado())).json().result, "ACCEPTED");
    ciclo = await cicloDaOcupacao();
    assert.equal(ciclo.situacao, "encerrada");
    assert.equal(ciclo.encerrado_por, "saida");
    assert.equal(ciclo.inicio_horario, "2026-09-21T13:54:54.986-03:00");
    assert.equal(ciclo.duracao_min, 2.03);
    assert.ok(ciclo.fotos.linha && ciclo.fotos.entrada && ciclo.fotos.saida);
  });

  it("eventos do SMVEP (engine.sender): nomes do banco, imageId e campos sem origem null", async () => {
    await iniciarSemHost();
    const semOrigem = {
      installationId: null,
      configVersion: null,
      bootId: null,
      sequence: null,
      timeQuality: null,
      cameraId: null,
      spaceId: null,
    };
    const entrada = await enviar(
      ocupado({
        ...semOrigem,
        messageId: "70-partial",
        occupancyId: 70,
        images: [
          imagem("PLATE_CROSSING", FOTO_INTEIRA, { imageId: null, capturedAt: "2026-09-21T13:54:54.035-03:00" }),
          imagem("PARKING_ENTRY", FOTO_INTEIRA, { imageId: null }),
        ],
      }),
    );
    assert.equal(entrada.statusCode, 200, entrada.body);
    assert.equal(entrada.json().result, "ACCEPTED");
    const saida = await enviar(
      liberado({
        ...semOrigem,
        messageId: "70-final",
        occupancyId: 70,
        plate: { status: "READ", value: "QRP7J32", plateConfidence: 0.99, plateDetectionConfidence: 0.98 },
        closureReason: "VIDEO_END",
        images: [imagem("PARKING_EXIT", FOTO_SAIDA, { imageId: null })],
      }),
    );
    assert.equal(saida.statusCode, 200, saida.body);
    assert.equal(saida.json().result, "ACCEPTED");

    const ciclo = await cicloDaOcupacao();
    assert.equal(ciclo.id, 70);
    assert.equal(ciclo.situacao, "encerrada");
    assert.equal(ciclo.encerrado_por, "fim_do_video");
    assert.equal(ciclo.placa?.texto, "QRP7J32");
    assert.ok(ciclo.fotos.linha && ciclo.fotos.entrada && ciclo.fotos.saida);
    assert.equal(ciclo.caixas?.linha?.length, 2);
    assert.deepEqual(ciclo.caixas?.saida, [{ tipo: "veiculo", xMin: 970, yMin: 523, xMax: 1867, yMax: 1001 }]);
    assert.deepEqual(ciclo.dimensoes?.saida, { largura: 2688, altura: 1520 });
  });

  it("VACATED de parada interrompida (sem horário de saída): occurredAt null é aceito", async () => {
    await iniciarSemHost();
    await enviar(ocupado());
    const resposta = await enviar(
      liberado({ occurredAt: null, closureReason: "INTERRUPTED", vehicle: { detected: false, boundingBox: null }, images: [] }),
    );
    assert.equal(resposta.statusCode, 200, resposta.body);
    assert.equal(resposta.json().result, "ACCEPTED");
    const ciclo = await cicloDaOcupacao();
    assert.equal(ciclo.situacao, "encerrada");
    assert.equal(ciclo.encerrado_por, "interrompido");
    assert.equal(ciclo.fim_horario, null);
    assert.equal(ciclo.duracao_min, null);
  });

  it("a placa só vem no OCCUPIED: a do VACATED (texto, confianças e caixa) é ignorada", async () => {
    await iniciarSemHost();
    await enviar(ocupado());
    await enviar(
      liberado({
        plate: {
          status: "READ",
          value: "OUT9R99",
          plateConfidence: 0.5,
          plateDetectionConfidence: 0.5,
          boundingBox: { xMin: 1, yMin: 1, xMax: 10, yMax: 10 },
        },
      }),
    );
    const ciclo = await cicloDaOcupacao();
    assert.equal(ciclo.placa?.texto, "QRP7J32");
    assert.equal(ciclo.placa?.confianca_ocr, 0.99);
    assert.equal(ciclo.placa?.confianca_deteccao, 0.98);
    assert.deepEqual(
      ciclo.caixas?.saida?.map((caixa) => caixa.tipo),
      ["veiculo"],
    );

    // Sem leitura na entrada, o ciclo fica sem placa mesmo que o VACATED traga uma.
    await enviar(
      ocupado({ messageId: "evt-0003", occupancyId: "71", plate: { status: "NOT_VISIBLE", value: null } }),
    );
    await enviar(
      liberado({ messageId: "evt-0004", occupancyId: "71", plate: { status: "READ", value: "OUT9R99" } }),
    );
    const semPlaca = await painel().app.inject({ url: `/api/ciclos/${encodeURIComponent("EMB-001:71")}` });
    assert.equal(semPlaca.json().placa, null);
  });

  it("as caixas do OCCUPIED são sempre da foto PLATE_CROSSING, mesmo sem ela no evento", async () => {
    await iniciarSemHost();
    await enviar(ocupado({ images: [imagem("PARKING_ENTRY", FOTO_INTEIRA)] }));
    const ciclo = await cicloDaOcupacao();
    assert.equal(ciclo.fotos.linha, null);
    assert.ok(ciclo.fotos.entrada);
    assert.equal(ciclo.caixas?.entrada, undefined);
    assert.equal(ciclo.caixas?.linha?.length, 2);
  });

  it("aceita o nome antigo `confidence` como confiança do OCR", async () => {
    await iniciarSemHost();
    await enviar(ocupado({ plate: { status: "READ", value: "ABC1D23", confidence: 0.94 } }));
    const { placa } = await cicloDaOcupacao();
    assert.equal(placa?.confianca_ocr, 0.94);
    assert.equal(placa?.confianca_deteccao, null);
  });

  it("repetição do mesmo messageId: DUPLICATE com o recibo da primeira vez, também depois de reiniciar", async () => {
    await iniciarSemHost();
    const primeira = (await enviar(ocupado())).json();
    const arquivo = path.join(pastaDados, PASTA_OCUPACAO, "dados.json");
    const antes = await readFile(arquivo, "utf8");

    const repetida = await enviar(ocupado());
    assert.equal(repetida.statusCode, 200);
    assert.equal(repetida.json().result, "DUPLICATE");
    assert.equal(repetida.json().receiptId, primeira.receiptId);
    assert.equal(repetida.json().receivedAt, primeira.receivedAt);
    assert.equal(repetida.json().durable, true);
    assert.equal(await readFile(arquivo, "utf8"), antes);

    await painel().app.close();
    await iniciarSemHost();
    const depois = (await enviar(ocupado())).json();
    assert.equal(depois.result, "DUPLICATE");
    assert.equal(depois.receivedAt, primeira.receivedAt);
  });

  it("repetições simultâneas gravam uma vez só", async () => {
    await iniciarSemHost();
    const respostas = await Promise.all([enviar(ocupado()), enviar(ocupado())]);
    assert.deepEqual(respostas.map((r) => r.json().result).sort(), ["ACCEPTED", "DUPLICATE"]);
    assert.equal((await cicloDaOcupacao()).eventos?.length, 1);
  });

  it("recusa a foto cujo sha256 ou byteLength não confere (IMAGE_INTEGRITY), sem gravar nada", async () => {
    await iniciarSemHost();
    const shaErrado = await enviar(
      ocupado({ images: [imagem("PLATE_CROSSING", FOTO_INTEIRA, { sha256: "0".repeat(64) })] }),
    );
    assert.equal(shaErrado.statusCode, 422);
    assert.equal(shaErrado.json().result, "REJECTED");
    assert.equal(shaErrado.json().durable, false);
    assert.equal(shaErrado.json().messageId, "evt-0001");
    assert.equal(shaErrado.json().error.code, "IMAGE_INTEGRITY");
    assert.match(shaErrado.json().error.message, /sha256/);

    const tamanhoErrado = await enviar(ocupado({ images: [imagem("PARKING_ENTRY", FOTO_INTEIRA, { byteLength: 5 })] }));
    assert.equal(tamanhoErrado.statusCode, 422);
    assert.match(tamanhoErrado.json().error.message, /byteLength/);
    assert.equal((await listar()).total, 0);
  });

  it("recusa evento fora do formato (INVALID_MESSAGE) e versão desconhecida", async () => {
    await iniciarSemHost();
    const casos: [Record<string, unknown>, RegExp][] = [
      [{ messageType: "PARKED" }, /messageType/],
      [{ occupancyId: "" }, /occupancyId/],
      [{ occurredAt: "ontem" }, /occurredAt/],
      [{ plate: { status: "READ", value: "X", boundingBox: { xMin: 10, yMin: 0, xMax: 5, yMax: 3 } } }, /plate/],
      [{ images: [{ ...imagem("PARKING_ENTRY", FOTO_INTEIRA), mimeType: "image/png" }] }, /mimeType/],
    ];
    for (const [alterar, campo] of casos) {
      const resposta = await enviar(ocupado(alterar));
      assert.equal(resposta.statusCode, 422, JSON.stringify(alterar));
      assert.equal(resposta.json().error.code, "INVALID_MESSAGE");
      assert.match(resposta.json().error.message, campo);
    }

    const versao = await enviar(ocupado({ schemaVersion: "2.0" }));
    assert.equal(versao.statusCode, 422);
    assert.equal(versao.json().error.code, "UNSUPPORTED_SCHEMA_VERSION");
    assert.equal((await enviar(ocupado({ schemaVersion: "1.1" }))).statusCode, 200);
  });

  it("JSON quebrado recebe a recusa no formato do contrato", async () => {
    await iniciarSemHost();
    const resposta = await enviar("{ isto não é json");
    assert.equal(resposta.statusCode, 400);
    assert.equal(resposta.json().result, "REJECTED");
    assert.equal(resposta.json().error.code, "INVALID_MESSAGE");
  });

  it("com token configurado, exige Authorization: Bearer <token>", async () => {
    await iniciarSemHost("segredo");
    const sem = await enviar(ocupado());
    assert.equal(sem.statusCode, 401);
    assert.equal(sem.json().result, "REJECTED");
    assert.equal(sem.json().error.code, "UNAUTHORIZED");
    assert.equal((await enviar(ocupado(), { authorization: "Bearer errado" })).statusCode, 401);
    assert.equal((await enviar(ocupado(), { authorization: "Bearer segredo" })).statusCode, 200);
  });

  it("aceita eventos com fotos inteiras de vários MB", async () => {
    await iniciarSemHost();
    const grande = Buffer.concat([
      FOTO_INTEIRA.subarray(0, -2),
      Buffer.alloc(6 * 1024 * 1024, 7),
      Buffer.from([0xff, 0xd9]),
    ]);
    const resposta = await enviar(
      ocupado({ images: [imagem("PLATE_CROSSING", grande), imagem("PARKING_ENTRY", grande)] }),
    );
    assert.equal(resposta.statusCode, 200);
  });

  it("avisa a tela a cada evento gravado", async () => {
    const endereco = await (await iniciarSemHost()).app.listen({ port: 0, host: "127.0.0.1" });
    const controle = new AbortController();
    const eventos = await fetch(`${endereco}/api/eventos`, { signal: controle.signal });
    assert.ok(eventos.body);
    const leitor = eventos.body.pipeThrough(new TextDecoderStream()).getReader();
    await enviar(ocupado());
    await enviar(liberado());

    let recebido = "";
    while (!recebido.includes('"situacao":"encerrada"')) {
      const { value, done } = await leitor.read();
      if (done) break;
      recebido += value;
    }
    controle.abort();
    const ciclos = recebido
      .split("\n\n")
      .filter((bloco) => bloco.startsWith("event: ciclo"))
      .map((bloco) => JSON.parse(bloco.split("\n")[1]!.slice("data: ".length)) as Ciclo);
    assert.deepEqual(
      ciclos.map((ciclo) => ciclo.situacao),
      ["ocupada", "encerrada"],
    );
  });

  it("libera o envio a partir de um app no navegador (CORS), também nas recusas", async () => {
    await iniciarSemHost("segredo");
    const preflight = await painel().app.inject({
      method: "OPTIONS",
      url: "/eventos",
      headers: {
        origin: "http://app.exemplo",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, authorization",
      },
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], "*");
    assert.match(String(preflight.headers["access-control-allow-methods"]), /POST/);
    assert.match(String(preflight.headers["access-control-allow-headers"]), /authorization/i);

    const recusada = await enviar(ocupado(), { origin: "http://app.exemplo" });
    assert.equal(recusada.statusCode, 401);
    assert.equal(recusada.headers["access-control-allow-origin"], "*");
  });

  it("sem host configurado, a tela não recebe o aviso de host desconectado", async () => {
    const endereco = await (await iniciarSemHost()).app.listen({ port: 0, host: "127.0.0.1" });
    const controle = new AbortController();
    const eventos = await fetch(`${endereco}/api/eventos`, { signal: controle.signal });
    assert.ok(eventos.body);
    const leitor = eventos.body.pipeThrough(new TextDecoderStream()).getReader();
    let recebido = "";
    while (!recebido.includes("event: host")) {
      const { value, done } = await leitor.read();
      if (done) break;
      recebido += value;
    }
    controle.abort();
    assert.ok(recebido.includes('event: host\ndata: {"conectado":null}'));

    const status = (await painel().app.inject({ url: "/api/status" })).json();
    assert.equal(status.host, null);
    assert.equal(status.host_conectado, null);
  });
});

describe("documentação Swagger (/docs)", () => {
  async function especificacao() {
    servidor = await criarServidor({ pastaDados, log: () => {} });
    const resposta = await painel().app.inject({ url: "/docs/json" });
    assert.equal(resposta.statusCode, 200);
    return resposta.json();
  }

  it("serve a tela do Swagger", async () => {
    servidor = await criarServidor({ pastaDados, log: () => {} });
    const resposta = await painel().app.inject({ url: "/docs/" });
    assert.equal(resposta.statusCode, 200);
    assert.match(resposta.headers["content-type"] as string, /text\/html/);
    assert.match(resposta.body, /swagger/i);
  });

  it("descreve o POST /eventos com o esquema que valida os eventos", async () => {
    const doc = await especificacao();
    assert.equal(doc.openapi, "3.0.3");
    const post = doc.paths["/eventos"].post;
    assert.deepEqual(Object.keys(post.responses).sort(), ["200", "400", "401", "413", "422", "500"]);
    assert.deepEqual(post.security, [{ token: [] }, {}]);
    const evento = doc.components.schemas.Evento;
    assert.deepEqual(evento.properties.messageType.enum, ["OCCUPIED", "VACATED"]);
    assert.match(evento.properties.plate.description, /Só no OCCUPIED/);
    assert.ok(evento.required.includes("occupancyId"));
    for (const rota of ["/api/ciclos", "/api/ciclos/{chave}", "/api/eventos", "/api/status", "/fotos/{pasta}/{arquivo}"]) {
      assert.ok(doc.paths[rota]?.get, `falta ${rota} na documentação`);
    }
  });

  it("os exemplos do Swagger são aceitos pelo POST /eventos", async () => {
    const doc = await especificacao();
    const exemplos = doc.paths["/eventos"].post.requestBody.content["application/json"].examples;
    for (const nome of ["OCCUPIED", "VACATED"]) {
      const resposta = await painel().app.inject({
        method: "POST",
        url: "/eventos",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify(exemplos[nome].value),
      });
      assert.equal(resposta.statusCode, 200, resposta.body);
      assert.equal(resposta.json().result, "ACCEPTED");
    }
    const ciclo = (await painel().app.inject({ url: "/api/ciclos/EMB-001:exemplo-70" })).json();
    assert.equal(ciclo.situacao, "encerrada");
    assert.deepEqual(ciclo.dimensoes.linha, { largura: 2688, altura: 1520 });
  });
});
