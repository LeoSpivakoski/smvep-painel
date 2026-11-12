import { useState } from "react";
import { Cabecalho } from "./components/Cabecalho.tsx";
import { DetalhesRegistro } from "./components/DetalhesRegistro.tsx";
import { Historico } from "./components/Historico.tsx";
import { VisorFotos } from "./components/VisorFotos.tsx";
import { useCiclos } from "./useCiclos.ts";

const LIMITE_HISTORICO = 30;

export function App() {
  const { ciclos, conexao, carregado } = useCiclos(LIMITE_HISTORICO);
  // `null` = acompanhar o mais recente: cada ciclo novo passa a ser o exibido.
  // Um ciclo antigo escolhido no histórico fica na tela até o usuário voltar ao primeiro.
  const [escolhido, setEscolhido] = useState<string | null>(null);

  const selecionado = (escolhido && ciclos.find((ciclo) => ciclo.chave === escolhido)) || ciclos[0] || null;

  function selecionar(chave: string) {
    setEscolhido(chave === ciclos[0]?.chave ? null : chave);
  }

  let mensagemVazia = "Aguardando o primeiro ciclo do host";
  if (!carregado) mensagemVazia = "Carregando…";
  else if (conexao === "offline") mensagemVazia = "Sem conexão com o servidor do painel";
  else if (conexao === "sem-host") mensagemVazia = "Sem conexão com o host (máquina de visão)";

  return (
    <div className="app">
      <Cabecalho conexao={conexao} />
      <main className="conteudo">
        <div className="coluna-principal">
          {/* key: cada detecção selecionada abre o visor de novo na linha de snap */}
          <VisorFotos key={selecionado?.chave ?? "vazio"} ciclo={selecionado} mensagemVazia={mensagemVazia} />
          <Historico ciclos={ciclos} selecionado={selecionado?.chave ?? null} onSelecionar={selecionar} />
        </div>
        <DetalhesRegistro ciclo={selecionado} />
      </main>
    </div>
  );
}
