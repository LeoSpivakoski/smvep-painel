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

if exist "web\dist\index.html" goto iniciar
echo Gerando a tela do painel (precisa de internet)...
call npm install
if errorlevel 1 goto falhou
call npm run build
if errorlevel 1 goto falhou

:iniciar
set "PORTA=8000"
if defined SMVEP_PORTA set "PORTA=%SMVEP_PORTA%"
echo.
echo  Painel SMVEP: deixe esta janela aberta. Para parar, feche-a ou use Ctrl+C.
echo  Tela: http://localhost:%PORTA%
echo.
node server\index.ts
echo.
pause
exit /b 0

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
