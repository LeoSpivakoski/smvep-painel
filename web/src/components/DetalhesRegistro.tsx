import type { ReactNode } from "react";
import type { Ciclo } from "../../../shared/ciclo.ts";
import { formatarDecimal, formatarDiaHora, formatarMinutos } from "../formatar.ts";
import { PlacaMercosul } from "./PlacaMercosul.tsx";

type Tom = "ciano" | "verde" | "ambar" | "vermelho";

const ENCERRAMENTOS: Record<string, { texto: string; tom: Tom }> = {
  saida: { texto: "SAÍDA", tom: "ambar" },
  veiculo_perdido: { texto: "VEÍCULO PERDIDO", tom: "vermelho" },
};

interface CampoProps {
  rotulo: string;
  valor: ReactNode;
  tom?: Tom;
  largo?: boolean;
  compacto?: boolean;
}

function Campo({ rotulo, valor, tom, largo, compacto }: CampoProps) {
  const classes = ["campo", largo && "campo-largo", compacto && "campo-compacto"].filter(Boolean).join(" ");
  const vazio = valor === null || valor === undefined || valor === "";
  return (
    <div className={classes}>
      <dt>{rotulo}</dt>
      <dd className={vazio ? "sem-valor" : tom}>{vazio ? "—" : valor}</dd>
    </div>
  );
}

function FotoSaida({ ciclo }: { ciclo: Ciclo | null }) {
  const foto = ciclo?.fotos.saida;
  if (foto) {
    return (
      <a className="foto-saida" href={foto} target="_blank" rel="noreferrer" title="Abrir a foto em tamanho real">
        <img key={foto} src={foto} alt={`Veículo ${ciclo.placa?.texto ?? "sem placa"} saindo da vaga`} />
      </a>
    );
  }
  let texto = "Foto saída";
  if (ciclo) texto = ciclo.encerrado_por === "veiculo_perdido" ? "Saída não vista (veículo perdido)" : "Sem foto de saída";
  return (
    <div className="foto-saida">
      <span className="vazio">{texto}</span>
    </div>
  );
}

export function DetalhesRegistro({ ciclo }: { ciclo: Ciclo | null }) {
  const placa = ciclo?.placa ?? null;
  const encerramento = ciclo
    ? (ENCERRAMENTOS[ciclo.encerrado_por] ?? { texto: ciclo.encerrado_por.toUpperCase(), tom: "ambar" as const })
    : null;

  return (
    <aside className="painel detalhes" aria-labelledby="titulo-detalhes">
      <header className="detalhes-topo">
        <h2 id="titulo-detalhes">Detalhes do registro</h2>
        {ciclo && (placa ? <span className="selo selo-verde">Processado</span> : <span className="selo selo-ambar">Sem placa</span>)}
      </header>

      <FotoSaida ciclo={ciclo} />

      <PlacaMercosul texto={placa?.texto ?? null} semPlaca={ciclo ? "SEM LEITURA" : "– – –"} />

      <dl className="grade">
        <Campo rotulo="Conf. OCR" valor={formatarDecimal(placa?.confianca_ocr)} tom="verde" />
        <Campo rotulo="Conf. Det" valor={formatarDecimal(placa?.confianca_deteccao)} tom="verde" />
      </dl>
      <hr className="separador" />
      <dl className="grade">
        <Campo rotulo="Início" valor={formatarDiaHora(ciclo?.inicio_horario)} compacto />
        <Campo rotulo="Fim" valor={formatarDiaHora(ciclo?.fim_horario)} compacto />
        <Campo rotulo="Duração" valor={formatarMinutos(ciclo?.duracao_min)} largo />
      </dl>
      <hr className="separador" />
      <dl className="grade">
        <Campo rotulo="Encerrado por" valor={encerramento?.texto} tom={encerramento?.tom} largo />
      </dl>
    </aside>
  );
}
