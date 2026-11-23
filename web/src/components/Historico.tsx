import type { Ciclo } from "../../../shared/ciclo.ts";
import { formatarHoraMinuto, formatarMinutos } from "../formatar.ts";

interface Props {
  ciclos: Ciclo[];
  selecionado: string | null;
  onSelecionar: (chave: string) => void;
}

export function Historico({ ciclos, selecionado, onSelecionar }: Props) {
  return (
    <section className="historico" aria-labelledby="titulo-historico">
      <h2 id="titulo-historico" className="titulo-secao">
        Histórico de detecções recentes
      </h2>
      {ciclos.length === 0 ? (
        <p className="historico-vazio">Nenhum ciclo recebido ainda.</p>
      ) : (
        <ul className="historico-lista">
          {ciclos.map((ciclo) => {
            const miniatura = ciclo.fotos.entrada ?? ciclo.fotos.linha ?? ciclo.fotos.saida;
            const naVaga = ciclo.encerrado_por === null;
            const hora = formatarHoraMinuto(naVaga ? ciclo.inicio_horario : ciclo.fim_horario);
            return (
              <li key={ciclo.chave}>
                <button
                  type="button"
                  className="cartao"
                  aria-pressed={ciclo.chave === selecionado}
                  onClick={() => onSelecionar(ciclo.chave)}
                >
                  <span className="miniatura">
                    {miniatura ? <img src={miniatura} alt="" loading="lazy" /> : "IMG"}
                  </span>
                  <span className="cartao-info">
                    <strong className={ciclo.placa ? undefined : "sem-placa"}>{ciclo.placa?.texto ?? "SEM PLACA"}</strong>
                    <span className="cartao-meta">
                      {naVaga ? "Entrou" : "Fim"}: {hora ?? "—"}
                    </span>
                    {naVaga ? (
                      <span className="cartao-duracao cartao-na-vaga">Na vaga</span>
                    ) : (
                      <span className="cartao-duracao">Dur: {formatarMinutos(ciclo.duracao_min) ?? "—"}</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
