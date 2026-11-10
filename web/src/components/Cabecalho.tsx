import { useEffect, useState } from "react";
import { formatarDataHora } from "../formatar.ts";
import type { Conexao } from "../useCiclos.ts";

const ROTULOS: Record<Conexao, string> = {
  conectando: "Conectando",
  online: "Online",
  reconectando: "Reconectando",
  offline: "Offline",
};

const DESCRICOES: Record<Conexao, string> = {
  conectando: "Conectando ao receptor",
  online: "Recebendo os ciclos em tempo real",
  reconectando: "Conexão com o receptor perdida; tentando de novo",
  offline: "Sem conexão com o receptor",
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
        <span className="logo">SMVEP</span>
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
