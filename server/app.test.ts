// node --test server/app.test.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Ciclo, RespostaLista } from "../shared/ciclo.ts";
import { LIMITE_CORPO, criarServidor } from "./app.ts";

// JPEG mínimo (SOI ... EOI), só para conferir que os bytes chegam intactos.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
const JPEG_BASE64 = JPEG.toString("base64");

const ID = "teste:20261109T165332-4edcdda9:5:1";
const PASTA = "teste_20261109T165332-4edcdda9_5_1";

function cicloExemplo(alterar: Record<string, unknown> = {}) {
  return {
    id_envio: ID,
    dispositivo: "teste",
    run_id: "20261109T165332-4edcdda9",
    vid: 5,
    ciclo: 1,
    inicio_horario: "2026-09-21T13:56:51.988-03:00",
    fim_horario: "2026-09-21T13:57:35.758-03:00",
    inicio_min: 2.07,
    fim_min: 2.8,
    duracao_min: 0.73,
    encerrado_por: "saida",
    placa: {
      texto: "TQF8B14",
      confianca_ocr: 1.0,
      confianca_deteccao: 0.98,
      leitura_min: 0.67,
      leitura_horario: "2026-09-21T13:55:27.901-03:00",
    },
    fotos: { linha: JPEG_BASE64, entrada: JPEG_BASE64, saida: JPEG_BASE64 },
    ...alterar,
  };
}

let pastaDados: string;
let servidor: Awaited<ReturnType<typeof criarServidor>> | undefined;

async function iniciar(token: string | null = null) {
  servidor = await criarServidor({ pastaDados, token, log: () => {} });
  return servidor.app;
}

function app() {
  assert.ok(servidor, "servidor não iniciado");
  return servidor.app;
}

function enviar(corpo: unknown, cabecalhos: Record<string, string> = {}) {
  return app().inject({
    method: "POST",
    url: "/ciclos",
    headers: { "content-type": "application/json; charset=utf-8", ...cabecalhos },
    payload: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
  });
}

async function listar(limite?: number): Promise<RespostaLista> {
  const resposta = await app().inject({ url: `/api/ciclos${limite ? `?limite=${limite}` : ""}` });
  assert.equal(resposta.statusCode, 200);
  return resposta.json();
}

beforeEach(async () => {
  pastaDados = await mkdtemp(path.join(os.tmpdir(), "smvep-painel-"));
});

afterEach(async () => {
  await servidor?.app.close();
  servidor = undefined;
  await rm(pastaDados, { recursive: true, force: true });
});

describe("POST /ciclos", () => {
  it("grava as fotos e o dados.json e responde 200", async () => {
    await iniciar();
    const resposta = await enviar(cicloExemplo({ campo_futuro: "mantido" }), { "idempotency-key": ID });

    assert.equal(resposta.statusCode, 200);
    assert.deepEqual(resposta.json(), { ok: true, id_envio: ID, duplicado: false });

    const pasta = path.join(pastaDados, PASTA);
    assert.deepEqual((await readdir(pasta)).sort(), ["dados.json", "entrada.jpg", "linha.jpg", "saida.jpg"]);
    assert.deepEqual(await readFile(path.join(pasta, "linha.jpg")), JPEG);

    const dados = JSON.parse(await readFile(path.join(pasta, "dados.json"), "utf8"));
    assert.deepEqual(dados.fotos, { linha: "linha.jpg", entrada: "entrada.jpg", saida: "saida.jpg" });
    assert.equal(dados.placa.texto, "TQF8B14");
    assert.equal(dados.campo_futuro, "mantido");
    assert.equal(typeof dados.recebido_em, "string");
  });

  it("responde 200 a uma repetição sem regravar", async () => {
    await iniciar();
    await enviar(cicloExemplo());
    const arquivo = path.join(pastaDados, PASTA, "dados.json");
    const antes = await readFile(arquivo, "utf8");

    const repeticao = await enviar(cicloExemplo());

    assert.equal(repeticao.statusCode, 200);
    assert.equal(repeticao.json().duplicado, true);
    assert.equal(await readFile(arquivo, "utf8"), antes);
    assert.equal((await listar()).total, 1);
  });

  it("trata repetições simultâneas como um ciclo só", async () => {
    await iniciar();
    const respostas = await Promise.all([enviar(cicloExemplo()), enviar(cicloExemplo())]);

    assert.deepEqual(respostas.map((r) => r.statusCode), [200, 200]);
    assert.deepEqual(respostas.map((r) => r.json().duplicado).sort(), [false, true]);
    assert.equal((await listar()).total, 1);
  });

  it("aceita placa e fotos nulas (veiculo_perdido sem leitura)", async () => {
    await iniciar();
    const resposta = await enviar(
      cicloExemplo({
        encerrado_por: "veiculo_perdido",
        inicio_horario: null,
        fim_horario: null,
        placa: null,
        fotos: { linha: null, entrada: null, saida: null },
      }),
    );

    assert.equal(resposta.statusCode, 200);
    assert.deepEqual(await readdir(path.join(pastaDados, PASTA)), ["dados.json"]);
    const [ciclo] = (await listar()).ciclos;
    assert.equal(ciclo?.placa, null);
    assert.deepEqual(ciclo?.fotos, { linha: null, entrada: null, saida: null });
  });

  const invalidos: [string, Record<string, unknown>][] = [
    ["encerrado_por fora do contrato", { encerrado_por: "fim_do_video" }],
    ["vid menor que 1", { vid: 0 }],
    ["campo obrigatório ausente", { duracao_min: undefined }],
    ["foto que não é base64", { fotos: { linha: "não é base64!", entrada: null, saida: null } }],
  ];
  for (const [caso, alterar] of invalidos) {
    it(`recusa com 422: ${caso}`, async () => {
      await iniciar();
      const resposta = await enviar(cicloExemplo(alterar));

      assert.equal(resposta.statusCode, 422);
      assert.equal(resposta.json().ok, false);
      assert.deepEqual(await readdir(pastaDados), []);
    });
  }

  it("recusa JSON malformado com 400", async () => {
    await iniciar();
    assert.equal((await enviar("{ não é json")).statusCode, 400);
  });

  it("recusa corpo acima do limite com 413", async () => {
    await iniciar();
    const enorme = "A".repeat(LIMITE_CORPO);
    const resposta = await enviar(cicloExemplo({ fotos: { linha: enorme, entrada: null, saida: null } }));
    assert.equal(resposta.statusCode, 413);
  });

  it("exige o token quando configurado", async () => {
    await iniciar("segredo");

    assert.equal((await enviar(cicloExemplo())).statusCode, 401);
    assert.equal((await enviar(cicloExemplo(), { authorization: "Bearer outro" })).statusCode, 401);
    assert.equal((await enviar(cicloExemplo(), { authorization: "Bearer segredo" })).statusCode, 200);
  });
});

describe("leitura para a tela", () => {
  it("lista os mais recentes primeiro, respeitando o limite", async () => {
    await iniciar();
    await enviar(cicloExemplo({ id_envio: "t:r:1:1", vid: 1, fim_horario: "2026-09-21T13:56:56.941-03:00" }));
    await enviar(cicloExemplo({ id_envio: "t:r:3:1", vid: 3, fim_horario: "2026-09-21T13:58:00.000-03:00" }));
    await enviar(cicloExemplo({ id_envio: "t:r:2:1", vid: 2, fim_horario: "2026-09-21T13:57:10.000-03:00" }));

    const lista = await listar();
    assert.equal(lista.total, 3);
    assert.deepEqual(lista.ciclos.map((c) => c.vid), [3, 2, 1]);
    assert.deepEqual((await listar(2)).ciclos.map((c) => c.vid), [3, 2]);
  });

  it("devolve um ciclo pelo id e 404 para id desconhecido", async () => {
    await iniciar();
    await enviar(cicloExemplo());

    const encontrado = await app().inject({ url: `/api/ciclos/${encodeURIComponent(ID)}` });
    assert.equal(encontrado.statusCode, 200);
    assert.equal(encontrado.json<Ciclo>().vid, 5);

    const ausente = await app().inject({ url: "/api/ciclos/nao-existe" });
    assert.equal(ausente.statusCode, 404);
  });

  it("serve as fotos pelas URLs da lista e nada além delas", async () => {
    await iniciar();
    await enviar(cicloExemplo());
    const [ciclo] = (await listar()).ciclos;
    assert.ok(ciclo?.fotos.entrada);

    const foto = await app().inject({ url: ciclo.fotos.entrada });
    assert.equal(foto.statusCode, 200);
    assert.match(String(foto.headers["content-type"]), /image\/jpeg/);
    assert.deepEqual(foto.rawPayload, JPEG);

    const dados = await app().inject({ url: `/fotos/${PASTA}/dados.json` });
    assert.equal(dados.statusCode, 404);
  });

  it("recarrega do disco, inclusive pastas do receptor de teste da Jetson", async () => {
    // Pasta no formato do sender/receiver.py: sem recebido_em, fotos pelo nome do arquivo.
    const legado = path.join(pastaDados, "pc-teste_run_1_1");
    await mkdir(legado);
    await writeFile(path.join(legado, "linha.jpg"), JPEG);
    const dadosLegado = {
      ...cicloExemplo({ id_envio: "pc-teste:run:1:1", vid: 1 }),
      fotos: { linha: "linha.jpg", entrada: null, saida: null },
    };
    await writeFile(path.join(legado, "dados.json"), JSON.stringify(dadosLegado));
    // Gravação interrompida: sem dados.json, não conta.
    await mkdir(path.join(pastaDados, "incompleta"));

    await iniciar();
    await enviar(cicloExemplo());
    await app().close();

    await iniciar();
    const lista = await listar();
    assert.equal(lista.total, 2);
    const recarregado = lista.ciclos.find((c) => c.id_envio === "pc-teste:run:1:1");
    assert.deepEqual(recarregado?.fotos, { linha: "/fotos/pc-teste_run_1_1/linha.jpg", entrada: null, saida: null });
    assert.equal(typeof recarregado?.recebido_em, "string");
  });

  it("avisa a tela por Server-Sent Events quando chega um ciclo novo", async () => {
    const endereco = await (await iniciar()).listen({ port: 0, host: "127.0.0.1" });
    const controle = new AbortController();
    const eventos = await fetch(`${endereco}/api/eventos`, { signal: controle.signal });
    assert.match(eventos.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.ok(eventos.body);

    const leitor = eventos.body.pipeThrough(new TextDecoderStream()).getReader();
    await enviar(cicloExemplo());

    let recebido = "";
    while (!recebido.includes("event: ciclo")) {
      const { value, done } = await leitor.read();
      if (done) break;
      recebido += value;
    }
    controle.abort();

    const blocos = recebido.split("\n\n");
    assert.ok(blocos.some((bloco) => bloco.startsWith("event: ping")), "sem ping ao conectar");
    const blocoCiclo = blocos.find((bloco) => bloco.startsWith("event: ciclo"));
    const linhaDados = blocoCiclo?.split("\n").find((linha) => linha.startsWith("data: "));
    assert.ok(linhaDados, "evento ciclo sem dados");
    const ciclo = JSON.parse(linhaDados.slice("data: ".length)) as Ciclo;
    assert.equal(ciclo.id_envio, ID);
    assert.equal(ciclo.fotos.linha, `/fotos/${PASTA}/linha.jpg`);
  });
});
