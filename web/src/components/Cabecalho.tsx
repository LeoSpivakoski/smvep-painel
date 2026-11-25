import { useEffect, useState } from "react";
import { formatarDataHora } from "../formatar.ts";
import type { Conexao } from "../useCiclos.ts";

const ROTULOS: Record<Conexao, string> = {
  conectando: "Conectando",
  online: "Online",
  "sem-host": "Sem host",
  reconectando: "Reconectando",
  offline: "Offline",
};

const DESCRICOES: Record<Conexao, string> = {
  conectando: "Conectando ao servidor do painel",
  online: "Recebendo os ciclos em tempo real",
  "sem-host": "O painel está no ar, mas sem conexão com o host (máquina de visão); tentando de novo a cada 2 s",
  reconectando: "Conexão com o servidor do painel perdida; tentando de novo",
  offline: "Sem conexão com o servidor do painel",
};

function useRelogio(): Date {
  const [agora, setAgora] = useState(() => new Date());
  useEffect(() => {
    const intervalo = setInterval(() => setAgora(new Date()), 1_000);
    return () => clearInterval(intervalo);
  }, []);
  return agora;
}

export function Cabecalho({ conexao }: { conexao: Conexao }) {
  const agora = useRelogio();
  return (
    <header className="cabecalho">
      <div className="marca">
        <img className="logo-img" src="/logo.png" alt="SMVEP" />
        <span className="marca-divisor" aria-hidden="true" />
        <h1>Sistema de monitoramento de vagas</h1>
      </div>
      <div className="cabecalho-direita">
        <span className={`conexao conexao-${conexao}`} role="status" title={DESCRICOES[conexao]}>
          <span className="conexao-ponto" aria-hidden="true" />
          {ROTULOS[conexao]}
        </span>
        <time className="relogio" dateTime={agora.toISOString()}>
          {formatarDataHora(agora)}
        </time>
      </div>
    </header>
  );
}