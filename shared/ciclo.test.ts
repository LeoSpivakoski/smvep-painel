// node --test shared/ciclo.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { momentoDoCiclo, textoSemFotoSaida } from "./ciclo.ts";
import type { Ciclo } from "./ciclo.ts";
import { dimensoesJpeg, motivoDoFim, versaoSuportada } from "./evento.ts";

describe("ciclo com o veículo ainda na vaga", () => {
  const base = {
    chave: "EMB-001:71",
    id: 71,
    dispositivo: "EMB-001",
    duracao_min: null,
    placa: null,
    fotos: { linha: null, entrada: null, saida: null },
    recebido_em: "2026-11-23T18:00:00.000Z",
  };

  it("a saída ainda não existe", () => {
    assert.equal(textoSemFotoSaida(null), "Veículo ainda na vaga");
  });

  it("é ordenado pelo início (não tem fim)", () => {
    const naVaga = {
      ...base,
      inicio_horario: "2026-09-21T14:10:00.000-03:00",
      fim_horario: null,
      encerrado_por: null,
    } as Ciclo;
    assert.equal(momentoDoCiclo(naVaga), Date.parse("2026-09-21T14:10:00.000-03:00"));
  });
});

describe("eventos do app", () => {
  it("lê largura e altura do marcador SOF do JPEG", () => {
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x05, 0xf0, 0x0a, 0x80, 0x03, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9,
    ]);
    assert.deepEqual(dimensoesJpeg(jpeg), { largura: 2688, altura: 1520 });
    assert.equal(dimensoesJpeg(Buffer.from("não é jpeg")), null);
  });

  it("converte o closureReason no motivo do fim do painel", () => {
    assert.equal(motivoDoFim("DEPARTURE_OBSERVED"), "saida");
    assert.equal(motivoDoFim("VEHICLE_LOST"), "veiculo_perdido");
    assert.equal(motivoDoFim("VIDEO_END"), "fim_do_video");
    assert.equal(motivoDoFim("INTERRUPTED"), "interrompido");
    assert.equal(motivoDoFim("NEW_REASON"), "new_reason");
    assert.equal(motivoDoFim(null), "saida");
  });

  it("aceita as versões 1.x do contrato", () => {
    assert.ok(versaoSuportada("1.0"));
    assert.ok(versaoSuportada("1.2.3"));
    assert.ok(!versaoSuportada("2.0"));
    assert.ok(!versaoSuportada("1.x"));
  });
});

describe("texto da foto de saída ausente", () => {
  it("explica por que a saída não foi vista, conforme o motivo do encerramento", () => {
    assert.equal(textoSemFotoSaida("veiculo_perdido"), "Saída não vista (veículo perdido)");
    assert.equal(textoSemFotoSaida("fim_do_video"), "Saída não vista (o vídeo acabou)");
    assert.equal(textoSemFotoSaida("interrompido"), "Saída não vista (processamento interrompido)");
  });

  it("sem motivo que explique a falta (saída vista, ou valor de um host mais novo), só a informa", () => {
    assert.equal(textoSemFotoSaida("saida"), "Sem foto de saída");
    assert.equal(textoSemFotoSaida("motivo_futuro"), "Sem foto de saída");
  });
});
