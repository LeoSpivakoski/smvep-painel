# SMVEP · Painel de monitoramento de vagas

Recebe os ciclos de estacionamento que o **host** (a máquina de visão) envia e
mostra na tela do Figma "Sistema de monitoramento": as 3 fotos do veículo
(linha de snap, entrada e saída, com setas e seletor para passar entre elas; ←
e → também funcionam), os detalhes do registro (placa, confianças, horários,
duração) e o histórico recente. Os ciclos novos aparecem na hora, sem
recarregar a página.

**O host decide quando enviar.** Ele roda a API em FastAPI
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
$env:SMVEP_HOST = "http://192.168.0.10:8000"   # PowerShell; o IP do host
$env:SMVEP_ENVIO_TOKEN = "<o mesmo token do host>"
npm start
```

No Windows, `INICIAR-PAINEL.cmd` faz o mesmo com dois cliques: na primeira vez
pergunta o endereço do host e o guarda em `host.txt`; lê o token de
`token.txt` (uma linha, o mesmo valor do host; o arquivo fica fora do git);
depois instala/compila o que faltar, sobe o painel e abre a tela no navegador. O passo a passo completo
para operar em duas máquinas, com todos os comandos, está em
`PASSO-A-PASSO.txt`.

Variáveis de ambiente:

| Variável | Padrão | Uso |
|---|---|---|
| `SMVEP_HOST` | — (obrigatória) | Endereço da API do host: `192.168.0.10`, `192.168.0.10:8000` ou `http://192.168.0.10:8000` (porta 8000 se faltar). |
| `SMVEP_PORTA` | `8080` | Porta da tela (o Vite usa a mesma para o proxy). |
| `SMVEP_INTERFACE` | `0.0.0.0` | Interface da tela; o padrão deixa outros computadores abrirem o painel. |
| `SMVEP_DADOS` | `dados/ciclos` | Pasta dos ciclos, relativa à raiz do projeto ou absoluta. |
| `SMVEP_ENVIO_TOKEN` | — | O mesmo token do host (vai na mensagem `ola`). O host só atende a rede com um token, então na prática é obrigatório; o `INICIAR-PAINEL.cmd` o lê de `token.txt`. |
| `SMVEP_ABRIR_NAVEGADOR` | — | `1` abre a tela no navegador ao iniciar (o `INICIAR-PAINEL.cmd` liga). |

Quem abre a conexão é o painel, então a porta que precisa estar liberada no
firewall é a **8000 do host**, não a do painel. A porta 8080 do painel só
precisa de liberação se outro computador for abrir a tela.

## Como o painel recebe

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

Sobe o servidor do painel (com `SMVEP_HOST` definido) em `http://localhost:8080`
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
quatro motivos de fim, a leitura, o SSE e a conexão WebSocket com um host falso (ola, confirmação, recusa,
reconexão, vigia de silêncio). `npm run verificar` confere os tipos da tela e
do servidor.

## Rotas do painel (para a tela)

| Método e caminho | Uso |
|---|---|
| `GET /api/ciclos?limite=20` | Ciclos mais recentes primeiro (pelo `fim_horario`), com as fotos como URLs. |
| `GET /api/ciclos/:chave` | Um ciclo. |
| `GET /api/eventos` | Server-Sent Events: `ciclo` a cada ciclo novo ou atualizado por uma revisão, `host` (`{"conectado": true}`) ao abrir e quando a conexão com o host muda, e `ping` a cada 10 s. |
| `GET /api/status` | Ciclos gravados, telas conectadas, endereço do host e `host_conectado`. |
| `GET /fotos/<pasta>/<linha\|entrada\|saida>.jpg` | Fotos. |

A pílula do cabeçalho mostra ONLINE (recebendo do host), SEM HOST (o painel
está no ar, mas sem conexão com a máquina de visão), RECONECTANDO ou OFFLINE
(a tela perdeu o servidor do painel). Sem carro estacionando, nada chega,
mesmo com tudo funcionando.

## Estrutura

```
shared/esquema.ts        formato do ciclo que o host envia (zod) e a chave do painel
shared/ciclo.ts          tipos e ordenação usados pelo servidor e pela tela
server/conexaoHost.ts    cliente WebSocket da API do host (ola, confirmação, reconexão)
server/app.ts            gravação dos ciclos recebidos e rotas para a tela
server/armazenamento.ts  pastas dos ciclos e índice em memória
server/index.ts          inicialização e variáveis de ambiente
web/src/                 tela React (App, components/, useCiclos, formatar, tema.css)
```

As cores do tema saíram das capturas do Figma (o Dev Mode pede login) e estão
todas em `web/src/tema.css`.

## Windows com Controle de Aplicativo

Neste PC, o Controle de Aplicativo do Windows bloqueia os binários nativos não
assinados do Rollup e do rolldown. Por isso o projeto usa o Vite 7 com o Rollup
em WebAssembly (`overrides` no `package.json`: `rollup` → `@rollup/wasm-node`)
e os testes rodam no executor nativo do Node (`node --test`). O resultado é o
mesmo; o build só fica um pouco mais lento.
