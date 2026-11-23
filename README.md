# SMVEP · Painel de monitoramento de vagas

Recebe os ciclos de estacionamento que o **host** (a máquina de visão) envia e
mostra na tela do Figma "Sistema de monitoramento": as 3 fotos do veículo
(linha de snap, entrada e saída, com setas e seletor para passar entre elas; ←
e → também funcionam), os detalhes do registro (placa, confianças, horários,
duração) e o histórico recente. Os ciclos novos aparecem na hora, sem
recarregar a página.

**O app empurra os eventos da vaga para o painel.** No app, informe o endereço
deste painel (o console mostra, ex.: `http://192.168.0.20:8080`); o app faz um
`POST /eventos` quando o veículo para (`OCCUPIED`) e outro quando ele sai
(`VACATED`). O veículo aparece na tela já na entrada, "na vaga", e o registro
se completa na saída, com as caixas de veículo e placa desenhadas sobre as
fotos. Veja [Envio pelo app](#envio-pelo-app-post-eventos).

**Opcional: conexão com o host.** Com `SMVEP_HOST` definido, o painel também se
conecta à API do host e recebe os ciclos que ela empurra. Ele roda a API em FastAPI
(`python -m api`, no repositório CodigosVisao-Embarcado), que lê o banco
`smvep.db` e empurra cada parada encerrada (um ciclo) por WebSocket assim que
ela fica pronta. O painel abre essa conexão, grava cada ciclo em disco, confirma
ao host e repassa à tela. O protocolo está em `CodigosVisao-Embarcado/docs/API.md` e no
Swagger do host (`http://<IP-DO-HOST>:8000/docs`).

```
HOST (máquina de visão)                         PAINEL (esta pasta)
python main.py ──grava──▶ output/smvep.db       node server/index.ts (porta 8080)
python -m api  ──lê a fila──┘                     │
      ▲  ◀──── WebSocket ws://<IP-DO-HOST>:8000/ws/ciclos (o painel conecta)
      └────── {"tipo":"ciclo"} ──────────────▶  grava dados/ciclos/<chave>/ e responde "recebido"
                                                  └── SSE ──▶ tela (React) em http://localhost:8080
```

## Requisitos

- Node.js 24 ou mais novo (roda o TypeScript do servidor direto, sem compilar).

```bash
npm install
```

## Produção

```bash
npm run build
```

```bash
$env:SMVEP_ENVIO_TOKEN = "<o mesmo token configurado no app>"   # PowerShell; opcional
npm start
```

No Windows, `INICIAR-PAINEL.cmd` faz o mesmo com dois cliques: lê o token de
`token.txt` (uma linha; o arquivo fica fora do git) e, se existir, o endereço
do host de `host.txt` (opcional);
depois instala/compila o que faltar, sobe o painel e abre a tela no navegador. O passo a passo completo
para operar em duas máquinas, com todos os comandos, está em
`PASSO-A-PASSO.txt`.

Variáveis de ambiente:

| Variável | Padrão | Uso |
|---|---|---|
| `SMVEP_HOST` | — | Opcional. Endereço da API do host, para receber também por WebSocket: `192.168.0.10`, `192.168.0.10:8000` ou `http://192.168.0.10:8000` (porta 8000 se faltar). |
| `SMVEP_PORTA` | `8080` | Porta da tela (o Vite usa a mesma para o proxy). |
| `SMVEP_INTERFACE` | `0.0.0.0` | Interface da tela; o padrão deixa outros computadores abrirem o painel. |
| `SMVEP_DADOS` | `dados/ciclos` | Pasta dos ciclos, relativa à raiz do projeto ou absoluta. |
| `SMVEP_ENVIO_TOKEN` | — | Definido, o `POST /eventos` exige `Authorization: Bearer <token>`; também vai ao host na mensagem `ola`. Recomendado em rede compartilhada; o `INICIAR-PAINEL.cmd` o lê de `token.txt`. |
| `SMVEP_ABRIR_NAVEGADOR` | — | `1` abre a tela no navegador ao iniciar (o `INICIAR-PAINEL.cmd` liga). |

Como o app envia para o painel, a porta **8080 do painel** precisa estar
liberada no firewall do Windows para a rede do app. Com `SMVEP_HOST`, quem abre
a conexão com o host é o painel, então lá a porta liberada é a 8000 do host.

## Envio pelo app (POST /eventos)

Um evento por mudança da vaga, no formato dos exemplos de
`exemplos_json_integracao_ifsc_spark/` (01 e 03 são pedidos; 02 e 04, respostas):

```
POST http://<IP-DO-PAINEL>:8080/eventos
Content-Type: application/json
Authorization: Bearer <token>        (só se o painel tiver SMVEP_ENVIO_TOKEN)

{
  "schemaVersion": "1.0",                    o painel aceita 1.x
  "messageId": "evt-20261113-0001",          único por deviceId; repetido = DUPLICATE
  "messageType": "OCCUPIED",                 OCCUPIED (parou) | VACATED (saiu)
  "deviceId": "EMB-001",
  "occupancyId": "70",                       junta o OCCUPIED e o VACATED da mesma parada
  "occurredAt": "2026-09-21T13:54:54.986-03:00",
  "cameraId": "CAM-001", "spaceId": "BAY-01",          opcionais (e os outros campos do exemplo)
  "plate": { "status": "READ", "value": "QRP7J32",        só no OCCUPIED
             "plateConfidence": 0.99,                    confiança do OCR → "Conf. OCR"
             "plateDetectionConfidence": 0.98,           confiança da detecção → "Conf. Det"
             "boundingBox": { "xMin": 1973, "yMin": 907, "xMax": 2085, "yMax": 953 } },
  "vehicle": { "detected": true,
               "boundingBox": { "xMin": 1569, "yMin": 615, "xMax": 2234, "yMax": 1153 } },
  "closureReason": "DEPARTURE_OBSERVED",     só no VACATED
  "images": [ { "imageId": "210", "purpose": "PLATE_CROSSING",
                "mimeType": "image/jpeg", "encoding": "base64",
                "byteLength": 1986690, "sha256": "2f71…", "base64": "<foto inteira>" } ]
}
```

Como o painel monta o registro:

- **Chave:** `deviceId:occupancyId`. O `OCCUPIED` cria o registro "na vaga"
  (início, placa, fotos); o `VACATED` o completa (fim, duração calculada,
  motivo, foto de saída). Chegando o `VACATED` antes, os dois são aceitos e o
  registro se completa quando o outro chegar.
- **Fotos:** `PLATE_CROSSING` → "linha de snap"; `SPACE_OVERVIEW` do
  `OCCUPIED` → "entrada"; `SPACE_OVERVIEW` do `VACATED` → "saída". Outras
  finalidades são aceitas, mas não aparecem.
- **Caixas:** estão em pixels da foto inteira. As do `OCCUPIED` (veículo e
  placa) são sempre da foto `PLATE_CROSSING`; a do `VACATED` (veículo) é da
  `SPACE_OVERVIEW` de saída. O painel lê o tamanho real de cada JPEG para
  desenhá-las na escala certa; o botão **Caixas** do visor mostra e oculta.
- **Placa:** só vem no `OCCUPIED` (`status: "READ"`), com `plateConfidence`
  (OCR) e `plateDetectionConfidence` (detecção); o nome antigo `confidence` vale
  como OCR. Uma placa no `VACATED` é ignorada (texto, confianças e caixa).
- **Motivo do fim:** `DEPARTURE_OBSERVED` → saída, `VEHICLE_LOST` → veículo
  perdido, `END_OF_VIDEO` → fim do vídeo, `INTERRUPTED` → interrompido.

Respostas (no formato dos exemplos 02 e 04):

| Status | `result` | Significado para o app |
|---|---|---|
| 200 | `ACCEPTED` | Gravado em disco e já na tela (`durable: true`, `receiptId: "rcpt-<messageId>"`). |
| 200 | `DUPLICATE` | O `messageId` já tinha sido gravado; volta o `receiptId` e o `receivedAt` da primeira vez. Dê por entregue. |
| 401 | `REJECTED` | `error.code: "UNAUTHORIZED"`: token ausente ou diferente do `SMVEP_ENVIO_TOKEN`. |
| 422 | `REJECTED` | `error.code`: `INVALID_MESSAGE` (campo fora do formato, a mensagem diz qual), `UNSUPPORTED_SCHEMA_VERSION` ou `IMAGE_INTEGRITY` (`sha256` ou `byteLength` não conferem com a foto). Repetir o mesmo evento não adianta. |
| 400/413 | `REJECTED` | JSON quebrado ou corpo acima de 50 MB. |
| 5xx ou sem resposta | — | Não foi gravado: tente de novo mais tarde. |

```json
{ "schemaVersion": "1.0", "messageId": "evt-1", "messageType": "OCCUPIED", "deviceId": "EMB-001",
  "result": "REJECTED", "durable": false,
  "error": { "code": "IMAGE_INTEGRITY", "message": "images[0] (210): sha256 não confere com a foto recebida" } }
```

O `POST /eventos` aceita chamadas de qualquer origem (CORS), para o app poder
rodar também num navegador.

## Como o painel recebe do host (opcional, com SMVEP_HOST)

- Conecta em `ws://<host>/ws/ciclos` e manda
  `{"tipo": "ola", "painel": "<nome>", "token": "<SMVEP_ENVIO_TOKEN>"}`.
- Para cada `{"tipo": "ciclo", "dados": {...}}`, valida (zod), grava as fotos e o
  `dados.json` e só então responde `{"tipo": "recebido", "id": 12}`. Um ciclo
  inválido recebe `{"tipo": "recusado", "id": 12, "erro": "..."}`. Se a gravação
  falhar (disco cheio, por exemplo), o painel não responde. Nos dois casos o
  host guarda o ciclo e tenta de novo depois de uma espera crescente, sem
  segurar os outros.
- O host só tira o ciclo da fila com o `recebido`; uma repetição (por exemplo,
  depois de a conexão cair) é confirmada sem regravar.
- **Revisão:** `dados.revisao` (ausente vale 1) sobe quando o host altera um
  registro já enviado, como a placa lida com atraso. Um ciclo com a mesma chave
  e revisão **maior** é regravado na mesma pasta (fotos e `dados.json`), mantém
  `recebido_em`, ganha `atualizado_em`, e a tela troca o ciclo na hora. Com
  revisão igual ou menor, é confirmado sem regravar. Gravações da mesma chave
  acontecem uma de cada vez.
- **Motivo do fim:** `encerrado_por` é `saida`, `veiculo_perdido`,
  `fim_do_video` (o vídeo acabou com o veículo na vaga) ou `interrompido` (o
  processamento do host foi parado ou caiu). Só `saida` traz a foto de saída;
  nos outros, a tela diz por que ela falta. No `interrompido` por queda,
  `fim_horario` e `duracao_min` vêm `null` e aparecem como "—".
- Sem conexão, tenta de novo a cada 2 s. Sem nenhuma mensagem do host em 25 s
  (ele manda `ping` a cada 10 s), dá a conexão por morta e abre outra.

Cada ciclo é guardado pela chave `<dispositivo>:<id>:<início>`, em que `id` é o
AUTOINCREMENT do banco do host (ele não se repete nem se o banco for zerado) e
o início separa um id repetido se o banco do host for apagado e recriado.
O ciclo não traz dados internos da análise do vídeo (execução, VID, ciclo do
VID, tempos no vídeo). Pastas gravadas por versões anteriores, inclusive as do
antigo envio por POST (chave = `id_envio`), continuam aparecendo.

## Desenvolvimento

```bash
npm run dev
```

Sobe o servidor do painel em `http://localhost:8080`
e a tela em `http://localhost:5173` (o Vite repassa `/api` e `/fotos` ao
servidor). Para testar sem a câmera, rode a API do host nesta mesma máquina
apontando para uma cópia do banco (`python -m api --db <cópia> --host 127.0.0.1`,
que dispensa o token) e use `SMVEP_HOST=http://localhost:8000`.

## Testes

```bash
npm test
```

```bash
npm run verificar
```

`npm test` cobre a gravação e a validação dos ciclos, repetições, revisões, os
quatro motivos de fim, a leitura, o SSE, o `POST /eventos` (OCCUPIED e VACATED
em qualquer ordem, caixas, DUPLICATE, integridade das fotos, token, CORS, corpo
grande) e a conexão WebSocket com um host falso (ola, confirmação, recusa,
reconexão, vigia de silêncio). `npm run verificar` confere os tipos da tela e
do servidor.

## Rotas do painel (para a tela)

| Método e caminho | Uso |
|---|---|
| `GET /api/ciclos?limite=20` | Ciclos mais recentes primeiro (pelo `fim_horario`; com o veículo na vaga, pelo início), com as fotos como URLs. Os montados por eventos trazem também `situacao` (`ocupada`/`encerrada`), `caixas` e `dimensoes` por foto. |
| `GET /api/ciclos/:chave` | Um ciclo. |
| `GET /api/eventos` | Server-Sent Events: `ciclo` a cada ciclo novo ou atualizado por uma revisão, `host` (`{"conectado": true}`; `null` sem host configurado) ao abrir e quando a conexão com o host muda, e `ping` a cada 10 s. |
| `GET /api/status` | Ciclos gravados, telas conectadas, endereço do host e `host_conectado`. |
| `GET /fotos/<pasta>/<linha\|entrada\|saida>.jpg` | Fotos. |

A pílula do cabeçalho mostra ONLINE (pronto para receber), SEM HOST (só com
`SMVEP_HOST`: o painel está no ar, mas sem conexão com a máquina de visão), RECONECTANDO ou OFFLINE
(a tela perdeu o servidor do painel). Sem carro estacionando, nada chega,
mesmo com tudo funcionando.

## Estrutura

```
shared/esquema.ts        formato do ciclo que o host envia (zod) e a chave do painel
shared/evento.ts         formato dos eventos do app (zod), tamanho do JPEG, motivo do fim
shared/ciclo.ts          tipos e ordenação usados pelo servidor e pela tela
server/eventos.ts        OCCUPIED/VACATED → ciclo, integridade das fotos e respostas ao app
server/conexaoHost.ts    cliente WebSocket da API do host (ola, confirmação, reconexão)
server/app.ts            gravação dos ciclos recebidos e rotas para a tela
server/armazenamento.ts  pastas dos ciclos e índice em memória
server/index.ts          inicialização e variáveis de ambiente
web/src/                 tela React (App, components/, useCiclos, formatar, tema.css);
                         components/FotoComCaixas.tsx desenha as caixas sobre as fotos
```

As cores do tema saíram das capturas do Figma (o Dev Mode pede login) e estão
todas em `web/src/tema.css`.

## Windows com Controle de Aplicativo

Neste PC, o Controle de Aplicativo do Windows bloqueia os binários nativos não
assinados do Rollup e do rolldown. Por isso o projeto usa o Vite 7 com o Rollup
em WebAssembly (`overrides` no `package.json`: `rollup` → `@rollup/wasm-node`)
e os testes rodam no executor nativo do Node (`node --test`). O resultado é o
mesmo; o build só fica um pouco mais lento.
