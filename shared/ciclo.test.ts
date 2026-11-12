// node --test shared/ciclo.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { textoSemFotoSaida } from "./ciclo.ts";

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
