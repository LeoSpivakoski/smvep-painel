// Visor principal: as 3 fotos do veículo selecionado (linha de snap, entrada e
// saída), com setas e um seletor para passar entre elas. Começa na linha de snap,
// como no Figma; o App recria o visor (key) a cada detecção selecionada.
import { useState } from "react";
import type { KeyboardEvent } from "react";
import { textoSemFotoSaida } from "../../../shared/ciclo.ts";
import type { Ciclo, NomeFoto } from "../../../shared/ciclo.ts";
import { FotoComCaixas } from "./FotoComCaixas.tsx";

// Escolha de mostrar as caixas: vale para todas as fotos e fica guardada no navegador.
const PREFERENCIA_CAIXAS = "smvep.mostrarCaixas";

function lerPreferenciaCaixas(): boolean {
  try {
    return localStorage.getItem(PREFERENCIA_CAIXAS) !== "0";
  } catch {
    return true;
  }
}

function gravarPreferenciaCaixas(mostrar: boolean): void {
  try {
    localStorage.setItem(PREFERENCIA_CAIXAS, mostrar ? "1" : "0");
  } catch {
    // sem armazenamento (janela privada): vale só até recarregar
  }
}

const FOTOS: readonly { nome: NomeFoto; rotulo: string }[] = [
  { nome: "linha", rotulo: "Linha de snap" },
  { nome: "entrada", rotulo: "Entrada" },
  { nome: "saida", rotulo: "Saída" },
];

function textoSemFoto(nome: NomeFoto, ciclo: Ciclo): string {
  if (nome === "linha") return "O veículo não tem captura na linha de snap";
  if (nome === "entrada") return "Sem foto de entrada";
  return textoSemFotoSaida(ciclo.encerrado_por);
}

function Seta({ direcao }: { direcao: "anterior" | "proxima" }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        d={direcao === "anterior" ? "M15 5 8 12l7 7" : "m9 5 7 7-7 7"}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface Props {
  ciclo: Ciclo | null;
  /** Mensagem quando não há detecção selecionada (carregando, sem conexão, aguardando). */
  mensagemVazia: string;
}

export function VisorFotos({ ciclo, mensagemVazia }: Props) {
  const [indice, setIndice] = useState(0);
  const [mostrarCaixas, setMostrarCaixas] = useState(lerPreferenciaCaixas);
  const atual = FOTOS[indice] ?? FOTOS[0]!;
  const url = ciclo?.fotos[atual.nome] ?? null;
  const placa = ciclo?.placa?.texto ?? "sem placa";
  const caixas = ciclo?.caixas?.[atual.nome];
  const temCaixas = Boolean(url && caixas && caixas.length > 0 && ciclo?.dimensoes?.[atual.nome]);

  function alternarCaixas() {
    setMostrarCaixas((mostrar) => {
      gravarPreferenciaCaixas(!mostrar);
      return !mostrar;
    });
  }

  const vizinha = (passo: number) => FOTOS[(indice + passo + FOTOS.length) % FOTOS.length]!;
  const passar = (passo: number) => setIndice((i) => (i + passo + FOTOS.length) % FOTOS.length);

  // ← e → trocam a foto enquanto o foco estiver nos controles do visor.
  function aoTeclar(evento: KeyboardEvent) {
    if (evento.key === "ArrowLeft" || evento.key === "ArrowRight") {
      evento.preventDefault();
      passar(evento.key === "ArrowLeft" ? -1 : 1);
    }
  }

  return (
    <section className="painel visor" aria-label="Fotos do veículo" onKeyDown={ciclo ? aoTeclar : undefined}>
      <span className="etiqueta">{atual.rotulo}</span>
      {/* Na faixa acima da foto: nunca cobre a imagem, qualquer que seja o tamanho dela. */}
      {ciclo && (
        <div className="visor-topo">
          {temCaixas && (
            <button
              type="button"
              className="visor-caixas"
              aria-pressed={mostrarCaixas}
              onClick={alternarCaixas}
              title={mostrarCaixas ? "Ocultar as caixas de veículo e placa" : "Mostrar as caixas de veículo e placa"}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <rect x="5.5" y="8" width="5" height="2.6" rx="0.6" fill="currentColor" />
              </svg>
              Caixas
            </button>
          )}
          <span className="origem">{ciclo.dispositivo}</span>
        </div>
      )}

      {!ciclo && <p className="vazio">{mensagemVazia}</p>}
      {ciclo && url && (
        <a className="visor-foto" href={url} target="_blank" rel="noreferrer" title="Abrir a foto em tamanho real">
          <FotoComCaixas
            url={url}
            alt={`${atual.rotulo}: veículo ${placa}`}
            caixas={caixas}
            dimensoes={ciclo.dimensoes?.[atual.nome]}
            mostrarCaixas={mostrarCaixas}
            placa={ciclo.placa?.texto ?? null}
          />
        </a>
      )}
      {ciclo && !url && <p className="vazio">{textoSemFoto(atual.nome, ciclo)}</p>}

      {ciclo && (
        <>
          <button
            type="button"
            className="visor-seta visor-seta-anterior"
            onClick={() => passar(-1)}
            aria-label={`Foto anterior: ${vizinha(-1).rotulo}`}
            title={vizinha(-1).rotulo}
          >
            <Seta direcao="anterior" />
          </button>
          <button
            type="button"
            className="visor-seta visor-seta-proxima"
            onClick={() => passar(1)}
            aria-label={`Próxima foto: ${vizinha(1).rotulo}`}
            title={vizinha(1).rotulo}
          >
            <Seta direcao="proxima" />
          </button>

          <div className="visor-seletor" role="group" aria-label="Escolher a foto">
            {FOTOS.map((foto, i) => {
              const existe = Boolean(ciclo.fotos[foto.nome]);
              return (
                <button
                  key={foto.nome}
                  type="button"
                  className={existe ? "visor-opcao" : "visor-opcao visor-opcao-sem-foto"}
                  aria-pressed={i === indice}
                  onClick={() => setIndice(i)}
                  title={existe ? foto.rotulo : `${foto.rotulo} (sem foto)`}
                >
                  {foto.rotulo}
                </button>
              );
            })}
            <span className="visor-contador" aria-live="polite">
              {indice + 1}/{FOTOS.length}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
