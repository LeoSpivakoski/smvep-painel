// Formatação em pt-BR para a tela.

const decimal = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** `0.99` → `0,99`; ausente → `null`. */
export function formatarDecimal(valor: number | null | undefined): string | null {
  return valor == null ? null : decimal.format(valor);
}

/** `2.04` → `2,04 min`. */
export function formatarMinutos(valor: number | null | undefined): string | null {
  const numero = formatarDecimal(valor);
  return numero === null ? null : `${numero} min`;
}

// Os horários chegam como a Jetson gravou: `2026-09-21T13:56:51.988-03:00`.
// A tela mostra a hora do local da câmera (a escrita no texto), sem converter
// para o fuso de quem está olhando o painel.
const PADRAO_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/;

/** `2026-09-21T13:54:54.586-03:00` → `21/09 13:54:54`. */
export function formatarDiaHora(iso: string | null | undefined): string | null {
  const partes = iso?.match(PADRAO_ISO);
  return partes ? `${partes[3]}/${partes[2]} ${partes[4]}:${partes[5]}:${partes[6]}` : null;
}

/** `2026-09-21T13:57:35.758-03:00` → `13:57`. */
export function formatarHoraMinuto(iso: string | null | undefined): string | null {
  const partes = iso?.match(PADRAO_ISO);
  return partes ? `${partes[4]}:${partes[5]}` : null;
}

const doisDigitos = (numero: number) => String(numero).padStart(2, "0");

/** Relógio do cabeçalho: `09/11/2026 10:08:15`. */
export function formatarDataHora(data: Date): string {
  const dia = `${doisDigitos(data.getDate())}/${doisDigitos(data.getMonth() + 1)}/${data.getFullYear()}`;
  const hora = `${doisDigitos(data.getHours())}:${doisDigitos(data.getMinutes())}:${doisDigitos(data.getSeconds())}`;
  return `${dia} ${hora}`;
}
