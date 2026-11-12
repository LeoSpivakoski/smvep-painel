@echo off
rem Inicia o painel SMVEP. Este arquivo usa so caracteres ASCII de proposito:
rem acentos num .cmd quebram a leitura do arquivo pelo cmd do Windows.
title SMVEP - Painel
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto sem_node

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 goto node_antigo

if exist "node_modules\fastify\package.json" goto tem_pacotes
echo Instalando os pacotes do painel (precisa de internet)...
call npm install --omit=dev
if errorlevel 1 goto falhou
:tem_pacotes

if exist "web\dist\index.html" goto endereco_host
echo Gerando a tela do painel (precisa de internet)...
call npm install
if errorlevel 1 goto falhou
call npm run build
if errorlevel 1 goto falhou

:endereco_host
rem O endereco do host (maquina de visao com "python -m api") fica em host.txt.
if defined SMVEP_HOST goto iniciar
if exist "host.txt" set /p SMVEP_HOST=<host.txt
if defined SMVEP_HOST goto iniciar
echo.
echo  Endereco do host: a maquina de visao que roda "python -m api".
echo  A janela da API mostra a linha "No painel, use o endereco do host: ...".
echo  Exemplo: 192.168.0.10:8000
echo.
set /p SMVEP_HOST=Endereco do host:
if not defined SMVEP_HOST goto sem_host
>host.txt echo %SMVEP_HOST%
echo  Salvo em host.txt. Para trocar de host, edite ou apague esse arquivo.

:iniciar
rem O token (a mesma senha do host) fica em token.txt, numa linha so.
if not defined SMVEP_ENVIO_TOKEN if exist "token.txt" set /p SMVEP_ENVIO_TOKEN=<token.txt
set "TOKEN_ESTADO=ausente - grave em token.txt o mesmo token do host"
if defined SMVEP_ENVIO_TOKEN set "TOKEN_ESTADO=configurado"
set "PORTA=8080"
if defined SMVEP_PORTA set "PORTA=%SMVEP_PORTA%"
set "SMVEP_ABRIR_NAVEGADOR=1"
echo.
echo  Painel SMVEP: deixe esta janela aberta. Para parar, feche-a ou use Ctrl+C.
echo  Host: %SMVEP_HOST%
echo  Token: %TOKEN_ESTADO%
echo  Tela: http://localhost:%PORTA%
echo.
node server\index.ts
echo.
pause
exit /b 0

:sem_host
echo.
echo  Sem o endereco do host o painel nao tem de onde receber os ciclos.
echo  Abra este arquivo de novo e informe o IP da maquina de visao.
echo.
pause
exit /b 1

:sem_node
echo.
echo  Node.js ausente. Instale o Node.js 24 ou mais novo (https://nodejs.org)
echo  e depois abra este arquivo de novo.
echo.
pause
exit /b 1

:node_antigo
echo.
echo  O painel precisa do Node.js 24 ou mais novo. Node.js instalado:
node -v
echo  Instale a versao LTS atual em https://nodejs.org
echo.
pause
exit /b 1

:falhou
echo.
echo  Falha ao preparar o painel. Veja a mensagem acima.
echo.
pause
exit /b 1
