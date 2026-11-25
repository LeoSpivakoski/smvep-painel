import type { ReactNode } from "react";
import { textoSemFotoSaida } from "../../../shared/ciclo.ts";
import type { Ciclo } from "../../../shared/ciclo.ts";
import { formatarConfianca, formatarDiaHora, formatarMinutos } from "../formatar.ts";
import { FotoComCaixas } from "./FotoComCaixas.tsx";
import { PlacaMercosul } from "./PlacaMercosul.tsx";

type Tom = "ciano" | "verde" | "ambar" | "vermelho";

const ENCERRAMENTOS: Record<string, { texto: string; tom: Tom }> = {
  saida: { texto: "SAÍDA", tom: "ambar" },
  veiculo_perdido: { texto: "VEÍCULO PERDIDO", tom: "vermelho" },
  // O arquivo de vídeo acabou com o veículo na vaga (só nos testes com vídeo).
  fim_do_video: { texto: "FIM DO VÍDEO", tom: "ciano" },
  // O processamento do host parou ou caiu com o veículo na vaga.
  interrompido: { texto: "INTERROMPIDO", tom: "vermelho" },
};

function percentualConfianca(valor: number | null | undefined): number {
  if (typeof valor !== "number" || !Number.isFinite(valor)) return 0;
  const pct = valor <= 1 ? valor * 100 : valor;
  return Math.max(0, Math.min(100, pct));
}

function MetricaConfianca({ rotulo, valor }: { rotulo: string; valor: number | null | undefined }) {
  const texto = formatarConfianca(valor);
  const vazio = texto === null || texto === undefined || texto === "";
  const pct = vazio ? 0 : percentualConfianca(valor);

  return (
    <div className="metrica-card">
      <div className="metrica-cabecalho">
        <span>{rotulo}</span>
        <strong className={vazio ? "sem-valor" : undefined}>{vazio ? "—" : texto}</strong>
      </div>
      <div className="metrica-barra" aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

interface LinhaDetalheProps {
  rotulo: string;
  valor: ReactNode;
  tom?: Tom;
}

function LinhaDetalhe({ rotulo, valor, tom }: LinhaDetalheProps) {
  const vazio = valor === null || valor === undefined || valor === "";
  return (
    <div className="detalhe-linha">
      <dt>{rotulo}:</dt>
      <dd className={vazio ? "sem-valor" : tom}>{vazio ? "—" : valor}</dd>
    </div>
  );
}

/** Com o veículo ainda na vaga (só o OCCUPIED chegou). */
const NA_VAGA = { texto: "NA VAGA", tom: "verde" } as const;

function FotoSaida({ ciclo }: { ciclo: Ciclo | null }) {
  const foto = ciclo?.fotos.saida;
  if (foto) {
    return (
      <a className="foto-saida" href={foto} target="_blank" rel="noreferrer" title="Abrir a foto em tamanho real">
        <FotoComCaixas
          url={foto}
          alt={`Veículo ${ciclo.placa?.texto ?? "sem placa"} saindo da vaga`}
          caixas={ciclo.caixas?.saida}
          dimensoes={ciclo.dimensoes?.saida}
          placa={ciclo.placa?.texto ?? null}
          rotulos={false}
        />
      </a>
    );
  }
  const texto = ciclo ? textoSemFotoSaida(ciclo.encerrado_por) : "Foto saída";
  return (
    <div className="foto-saida">
      <span className="vazio">{texto}</span>
    </div>
  );
}

export function DetalhesRegistro({ ciclo }: { ciclo: Ciclo | null }) {
  const placa = ciclo?.placa ?? null;
  const motivo = ciclo?.encerrado_por;
  const encerramento = !ciclo
    ? null
    : motivo === null || motivo === undefined
      ? NA_VAGA
      : (ENCERRAMENTOS[motivo] ?? { texto: motivo.toUpperCase(), tom: "ambar" as const });

  return (
    <aside className="painel detalhes" aria-labelledby="titulo-detalhes">
      <header className="detalhes-topo">
        <h2 id="titulo-detalhes">Detalhes do registro</h2>
        {ciclo && (placa ? <span className="selo selo-verde">Processado</span> : <span className="selo selo-ambar">Sem placa</span>)}
      </header>

      <FotoSaida ciclo={ciclo} />

      <PlacaMercosul texto={placa?.texto ?? null} semPlaca={ciclo ? "SEM LEITURA" : "– – –"} />

      <div className="metrica-grade">
        <MetricaConfianca rotulo="Conf. OCR" valor={placa?.confianca_ocr} />
        <MetricaConfianca rotulo="Conf. Det" valor={placa?.confianca_deteccao} />
      </div>

      <div className="detalhes-secao">
        <span className="detalhes-subtitulo">Registro / Tempos</span>
        <dl className="detalhes-lista">
          <LinhaDetalhe rotulo="Início" valor={formatarDiaHora(ciclo?.inicio_horario)} />
          <LinhaDetalhe rotulo="Fim" valor={formatarDiaHora(ciclo?.fim_horario)} />
          <LinhaDetalhe rotulo="Duração" valor={formatarMinutos(ciclo?.duracao_min)} />
          <LinhaDetalhe
            rotulo={encerramento === NA_VAGA ? "Situação" : "Encerrado por"}
            valor={encerramento?.texto}
            tom={encerramento?.tom}
          />
        </dl>
      </div>
    </aside>
  );
}