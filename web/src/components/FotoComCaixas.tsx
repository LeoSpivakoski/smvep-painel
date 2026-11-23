// Foto inteira com as caixas (veículo e placa) desenhadas por cima.
// As caixas vêm em pixels da foto original. A foto e os retângulos ficam no
// mesmo SVG, com o viewBox no tamanho original: o navegador encaixa a foto no
// espaço disponível (como object-fit: contain) e as caixas acompanham a escala.
// Sem o tamanho da foto (ciclos antigos ou do host), mostra só a imagem.
import type { Caixa, Dimensoes } from "../../../shared/ciclo.ts";

const ROTULOS: Record<Caixa["tipo"], string> = {
  veiculo: "VEÍCULO",
  placa: "PLACA",
};

interface Props {
  url: string;
  alt: string;
  caixas?: Caixa[] | undefined;
  dimensoes?: Dimensoes | undefined;
  /** Desenha as caixas (o visor deixa ligar e desligar). */
  mostrarCaixas?: boolean;
  /** Texto da placa lida, para o rótulo da caixa da placa. */
  placa?: string | null;
  /** Rótulos ("VEÍCULO", "PLACA ...") sobre as caixas; numa miniatura ficam ilegíveis. */
  rotulos?: boolean;
}

function RotuloCaixa({ caixa, texto, escala }: { caixa: Caixa; texto: string; escala: number }) {
  const fonte = 13 * escala;
  const margem = 5 * escala;
  // Largura aproximada (Inter, maiúsculas e negrito): o fundo não precisa ser exato.
  const largura = texto.length * fonte * 0.68 + margem * 2;
  const altura = fonte + margem * 1.4;
  // Acima da caixa; se não couber no topo da foto, por dentro dela.
  const y = caixa.yMin - altura >= 0 ? caixa.yMin - altura : caixa.yMin;
  return (
    <g className="caixa-rotulo">
      <rect x={caixa.xMin} y={y} width={largura} height={altura} rx={2 * escala} />
      <text x={caixa.xMin + margem} y={y + altura - margem * 0.95} fontSize={fonte}>
        {texto}
      </text>
    </g>
  );
}

export function FotoComCaixas({ url, alt, caixas, dimensoes, mostrarCaixas = true, placa, rotulos = true }: Props) {
  if (!dimensoes) return <img key={url} src={url} alt={alt} />;

  const { largura, altura } = dimensoes;
  // Rótulos com o mesmo tamanho na tela em qualquer resolução de câmera: ~13 px
  // com a foto exibida a 800 px de largura (o visor numa tela comum).
  const escala = Math.max(largura, 1) / 800;
  const desenhar = mostrarCaixas && caixas && caixas.length > 0;

  return (
    <svg
      key={url}
      className="foto-caixas"
      viewBox={`0 0 ${largura} ${altura}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={alt}
    >
      <image href={url} x={0} y={0} width={largura} height={altura} />
      {desenhar &&
        caixas.map((caixa, indice) => {
          const texto = caixa.tipo === "placa" && placa ? `${ROTULOS.placa} ${placa}` : ROTULOS[caixa.tipo];
          return (
            <g key={`${caixa.tipo}-${indice}`} className={`caixa caixa-${caixa.tipo}`}>
              <rect
                className="caixa-borda"
                x={caixa.xMin}
                y={caixa.yMin}
                width={caixa.xMax - caixa.xMin}
                height={caixa.yMax - caixa.yMin}
                vectorEffect="non-scaling-stroke"
              />
              {rotulos && <RotuloCaixa caixa={caixa} texto={texto} escala={escala} />}
            </g>
          );
        })}
    </svg>
  );
}
