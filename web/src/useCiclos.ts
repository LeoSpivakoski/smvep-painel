// Carrega os ciclos do receptor e acompanha os novos por Server-Sent Events.
import { useEffect, useState } from "react";
import { mesclarCiclos } from "../../shared/ciclo.ts";
import type { Ciclo, RespostaLista } from "../../shared/ciclo.ts";

/** Estado da ligação entre a tela e o receptor (a Jetson não manda sinal de vida, só ciclos). */
export type Conexao = "conectando" | "online" | "reconectando" | "offline";

const FALHAS_ATE_OFFLINE = 3;
const ESPERA_MAXIMA_MS = 10_000;
/** O receptor manda `ping` a cada 10 s; 25 s de silêncio = conexão morta sem aviso. */
const SILENCIO_MAXIMO_MS = 25_000;

export function useCiclos(limite: number) {
  const [ciclos, setCiclos] = useState<Ciclo[]>([]);
  const [conexao, setConexao] = useState<Conexao>("conectando");
  const [carregado, setCarregado] = useState(false);

  useEffect(() => {
    let ativo = true;
    let fonte: EventSource | null = null;
    let espera: ReturnType<typeof setTimeout> | undefined;
    let falhas = 0;
    let ultimoSinal = Date.now();

    // Mescla em vez de substituir: um ciclo que chegou pelo SSE enquanto a lista
    // era buscada não some quando a resposta chega.
    async function carregar() {
      try {
        const resposta = await fetch(`/api/ciclos?limite=${limite}`, { cache: "no-store" });
        if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
        const dados = (await resposta.json()) as RespostaLista;
        if (ativo) setCiclos((atuais) => mesclarCiclos(atuais, dados.ciclos, limite));
      } catch {
        // Sem receptor: o estado da conexão já mostra; a reconexão carrega de novo.
      } finally {
        if (ativo) setCarregado(true);
      }
    }

    function conectar() {
      if (!ativo) return;
      fonte = new EventSource("/api/eventos");

      // A cada (re)conexão a lista é recarregada, para recuperar ciclos que
      // chegaram enquanto a tela estava desconectada.
      fonte.onopen = () => {
        falhas = 0;
        ultimoSinal = Date.now();
        setConexao("online");
        void carregar();
      };

      fonte.addEventListener("ping", () => {
        ultimoSinal = Date.now();
      });

      fonte.addEventListener("ciclo", (evento) => {
        ultimoSinal = Date.now();
        const ciclo = JSON.parse((evento as MessageEvent<string>).data) as Ciclo;
        setCiclos((atuais) => mesclarCiclos(atuais, [ciclo], limite));
      });

      fonte.onerror = () => {
        falhas += 1;
        setConexao(falhas >= FALHAS_ATE_OFFLINE ? "offline" : "reconectando");
        // CLOSED: o navegador desistiu (por exemplo, o proxy do Vite respondeu
        // 500 com o receptor parado). Nesse caso a tela reabre por conta própria.
        if (fonte?.readyState === EventSource.CLOSED) {
          fonte.close();
          espera = setTimeout(conectar, Math.min(ESPERA_MAXIMA_MS, 1_000 * 2 ** falhas));
        }
      };
    }

    // Uma conexão pode morrer sem o navegador perceber (rede entre as máquinas
    // caiu no meio, proxy que não repassa o fechamento): sem ping, reabre.
    const vigia = setInterval(() => {
      if (fonte?.readyState === EventSource.OPEN && Date.now() - ultimoSinal > SILENCIO_MAXIMO_MS) {
        fonte.close();
        setConexao("reconectando");
        conectar();
      }
    }, 5_000);

    void carregar();
    conectar();

    return () => {
      ativo = false;
      fonte?.close();
      clearTimeout(espera);
      clearInterval(vigia);
    };
  }, [limite]);

  return { ciclos, conexao, carregado };
}
