# SMVEP · Painel de monitoramento de vagas

Recebe os ciclos de estacionamento que a Jetson envia e mostra na tela do
Figma "Sistema de monitoramento": as 3 fotos do veículo (linha de snap,
entrada e saída, com setas e seletor para passar entre elas; ← e → também
funcionam), os detalhes do registro (placa, VID, ciclo, confianças, horários,
duração) e o histórico recente. Os ciclos novos aparecem na hora, sem
recarregar a página.

A Jetson é quem envia: a cada ciclo completo (o carro entrou na vaga e saiu),
ela faz um `POST /ciclos` com um JSON e 3 fotos em base64. O contrato está em
`CodigosVisao-Embarcado/docs/API.md` e `docs/openapi.yaml`. Como o navegador
não consegue receber um POST, o projeto tem um receptor pequeno em Node que
grava cada ciclo em disco e repassa à tela.

```
Jetson ──POST /ciclos──▶ receptor (Node, porta 8000) ──SSE──▶ tela (React)
                              │
                              └── dados/ciclos/<id_envio>/dados.json + linha/entrada/saida.jpg
```

## Requisitos

- Node.js 24 ou mais novo (roda o TypeScript do receptor direto, sem compilar).

```bash
npm install
```

## Desenvolvimento

```bash
npm run dev
```

Sobe o receptor em `http://localhost:8000` e a tela em
`http://localhost:5173` (o Vite repassa `/api` e `/fotos` ao receptor).

## Produção

```bash
npm run build
```

```bash
npm start
```

No Windows, `INICIAR-PAINEL.cmd` faz o mesmo que `npm start` com dois
cliques (e instala/compila antes, se faltar algo). O passo a passo completo
para operar em duas máquinas, com todos os comandos, está em
`PASSO-A-PASSO.txt`.

Tudo fica na porta 8000: a tela em `http://<ip-do-pc>:8000` e o endpoint de
envio em `http://<ip-do-pc>:8000/ciclos`. Ao iniciar, o receptor mostra os IPs
desta máquina e o comando de envio pronto para copiar.

Variáveis de ambiente do receptor:

| Variável | Padrão | Uso |
|---|---|---|
| `SMVEP_PORTA` | `8000` | Porta HTTP (o Vite usa a mesma para o proxy). |
| `SMVEP_HOST` | `0.0.0.0` | Interface; o padrão aceita conexões da rede. |
| `SMVEP_DADOS` | `dados/ciclos` | Pasta dos ciclos, relativa à raiz do projeto ou absoluta. |
| `SMVEP_ENVIO_TOKEN` | — | Se definido, exige `Authorization: Bearer <token>`. Use o mesmo valor da Jetson. |

Fora da rede local, coloque HTTPS (proxy reverso) ou VPN na frente: o token e
as fotos viajam na requisição.

## Visão numa máquina, painel em outra

```
Máquina de visão (CodigosVisao-Embarcado)          Máquina do painel (SMVEP-Painel)
  python main.py ...  ──grava──▶ output/smvep.db
  python -m sender    ──lê a fila──┘
        │
        └──── POST http://<IP-DO-PAINEL>:8000/ciclos ────▶ npm start (porta 8000)
                                                              └─ tela em http://<IP-DO-PAINEL>:8000
```

As duas máquinas precisam estar na mesma rede (ou numa VPN) e a do painel
precisa aceitar conexões na porta 8000.

### 1. Máquina do painel

1. Copie a pasta `SMVEP-Painel` **sem** `node_modules/`, `dados/` e `web/dist/`
   (ou clone o repositório) e instale o Node.js 24 ou mais novo.
2. Instale, gere a tela e suba o receptor:

   ```bash
   npm install
   ```

   ```bash
   npm run build
   ```

   ```bash
   npm start
   ```

3. Anote o IP que o receptor mostra, por exemplo:

   ```
   [RECEPTOR] Ethernet: painel em http://192.168.0.20:8000  |  envio: python -m sender --url http://192.168.0.20:8000/ciclos
   ```

   Com várias redes (Wi-Fi, Ethernet, VPN), use o IP da mesma rede da máquina
   de visão. Para o IP não mudar, fixe-o no roteador (reserva de DHCP) ou na
   placa de rede.

4. Libere a porta 8000 no firewall. No Windows, quando o Node pedir acesso à
   rede na primeira vez, permita em **redes privadas**. Se o aviso não aparecer,
   num PowerShell como administrador:

   ```powershell
   New-NetFirewallRule -DisplayName "SMVEP painel (8000)" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow -Profile Private
   ```

   No Linux com ufw: `sudo ufw allow 8000/tcp`. Se a rede estiver marcada como
   **pública** no Windows, troque para privada ou use `-Profile Any` na regra.

5. Abra a tela no navegador dessa máquina (`http://localhost:8000`) ou de
   qualquer outra da rede (`http://<IP-DO-PAINEL>:8000`).

### 2. Máquina de visão

O banco `smvep.db` e o processo de envio (`sender/`) estão no clone
`CodigosVisao-Embarcado`; rode tudo a partir da raiz dele.

1. Teste se o painel é alcançável:

   ```bash
   curl http://<IP-DO-PAINEL>:8000/api/status
   ```

   A resposta esperada é `{"ok":true,...}`. Se der timeout, veja o firewall da
   máquina do painel e se as duas estão na mesma rede.

2. Rode o processamento como de costume (ele grava `output/smvep.db`) e, em
   outro terminal, o envio:

   ```bash
   python -m sender --url http://<IP-DO-PAINEL>:8000/ciclos
   ```

   O envio fica consultando a fila a cada 2 s. Pode ser iniciado antes ou
   depois do processamento, e parado e reiniciado à vontade: o que não foi
   enviado continua na fila do banco. Se o painel cair, ele tenta de novo
   sozinho e envia tudo quando o painel voltar.

3. (Opcional) Token compartilhado: defina a mesma `SMVEP_ENVIO_TOKEN` nas duas
   máquinas antes de iniciar o `npm start` e o `python -m sender`. Sem ela,
   qualquer máquina da rede consegue enviar ciclos ao painel.

### Se nada aparecer na tela

| Sintoma | O que ver |
|---|---|
| `curl .../api/status` dá timeout | Firewall da máquina do painel, rede diferente, IP errado. |
| O envio mostra `envio_erro` com `HTTP 401` | `SMVEP_ENVIO_TOKEN` diferente entre as máquinas. |
| O envio mostra `HTTP 422` | O JSON não passou na validação; a mensagem diz qual campo. |
| O envio roda sem erro, mas nada chega | Só chegam ciclos **completos** (o carro entrou e saiu da vaga); paradas abertas e `fim_do_video` não são enviadas. |
| Pílula RECONECTANDO/OFFLINE | A tela perdeu o receptor; ela volta sozinha quando ele voltar. |

## Ver ciclos sem a Jetson

O simulador reenvia ciclos gravados em pastas, como a Jetson faria:

```bash
npm run simular -- C:\Users\leosp\Desktop\CodigosVisao-Embarcado\output\recebidos --intervalo 3
```

Ele aceita o formato do receptor de teste da Jetson (`python -m sender.receiver`)
e o deste painel. Opções: `--url` (padrão `http://localhost:8000/ciclos`),
`--intervalo` em segundos e `--token`.

Para só abrir as pastas do receptor de teste, sem reenviar, aponte o receptor
para elas: `SMVEP_DADOS=C:\...\output\recebidos npm start`.

## Testes

```bash
npm test
```

```bash
npm run verificar
```

`npm test` cobre o contrato do `POST /ciclos` (gravação, repetições, 422, 401,
413), a leitura e o SSE. `npm run verificar` confere os tipos da tela e do
receptor.

## Endpoints

| Método e caminho | Uso |
|---|---|
| `POST /ciclos` | Entrega da Jetson. `200 {"ok": true, "duplicado": false}` depois de gravar; repetição do mesmo `id_envio` também recebe `200` (com `duplicado: true`) e não regrava. JSON fora do contrato: `422`; token errado: `401`; corpo acima de 20 MB: `413`. |
| `GET /api/ciclos?limite=20` | Ciclos mais recentes primeiro (pelo `fim_horario`), com as fotos como URLs. |
| `GET /api/ciclos/:id_envio` | Um ciclo. |
| `GET /api/eventos` | Server-Sent Events: evento `ciclo` a cada ciclo novo e `ping` a cada 10 s (a tela reabre a conexão depois de 25 s sem nenhum evento). |
| `GET /api/status` | Quantidade de ciclos e de telas conectadas. |
| `GET /fotos/<pasta>/<linha\|entrada\|saida>.jpg` | Fotos. |

A pílula ONLINE do cabeçalho mostra a conexão da tela com o receptor. A Jetson
não manda sinal de vida, só ciclos completos: sem carro estacionando, nada
chega, mesmo com tudo funcionando.

## Estrutura

```
shared/esquema.ts     contrato do POST /ciclos (zod), usado pelo receptor
shared/ciclo.ts       tipos e ordenação usados pelo receptor e pela tela
server/app.ts         rotas do receptor
server/armazenamento.ts  pastas dos ciclos e índice em memória
server/index.ts       inicialização e variáveis de ambiente
web/src/              tela React (App, components/, useCiclos, formatar, tema.css)
scripts/simular.ts    reenvio de ciclos gravados
```

As cores do tema saíram das capturas do Figma (o Dev Mode pede login) e estão
todas em `web/src/tema.css`.

## Windows com Controle de Aplicativo

Neste PC, o Controle de Aplicativo do Windows bloqueia os binários nativos não
assinados do Rollup e do rolldown. Por isso o projeto usa o Vite 7 com o Rollup
em WebAssembly (`overrides` no `package.json`: `rollup` → `@rollup/wasm-node`)
e os testes rodam no executor nativo do Node (`node --test`). O resultado é o
mesmo; o build só fica um pouco mais lento.
