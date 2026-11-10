function Bandeira() {
  return (
    <svg className="placa-bandeira" viewBox="0 0 20 14" aria-hidden="true">
      <rect width="20" height="14" fill="#009c3b" />
      <path d="M10 1.6 18.2 7 10 12.4 1.8 7Z" fill="#ffdf00" />
      <circle cx="10" cy="7" r="3.1" fill="#002776" />
    </svg>
  );
}

interface Props {
  texto: string | null;
  /** Mostrado no lugar da placa quando `texto` é `null`. */
  semPlaca?: string;
}

export function PlacaMercosul({ texto, semPlaca = "SEM LEITURA" }: Props) {
  return (
    <div
      className={texto ? "placa" : "placa placa-vazia"}
      role="img"
      aria-label={texto ? `Placa ${texto}` : `Placa: ${semPlaca === "SEM LEITURA" ? "não lida" : "nenhum registro"}`}
    >
      <div className="placa-faixa">
        <span>Mercosul</span>
        <span>Brasil</span>
        <Bandeira />
      </div>
      <div className="placa-texto">{texto ?? semPlaca}</div>
    </div>
  );
}
