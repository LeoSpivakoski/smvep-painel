# Desliga a "edicao rapida" (QuickEdit) da janela do console em que o painel roda.
#
# Com ela ligada, um clique na janela entra no modo "Selecionar" e o Windows
# congela o programa na proxima vez que ele escreve na tela, ate alguem apertar
# Enter ou Esc. O receptor para de responder e a maquina de visao recebe timeout.
#
# Vale so para esta janela (nao muda a configuracao do Windows). Chamado pelo
# server/index.ts ao iniciar; sem console (servico, saida redirecionada), nao faz nada.
# Precisa ser chamado pelo proprio Node: o cmd.exe devolve o console ao modo
# anterior sempre que um programa filho dele termina.
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ConsoleSmvep {
    const int STD_INPUT_HANDLE = -10;
    const uint ENABLE_QUICK_EDIT_MODE = 0x0040;
    const uint ENABLE_EXTENDED_FLAGS = 0x0080;

    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr handle, out uint mode);
    [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr handle, uint mode);

    public static string DesligarEdicaoRapida() {
        IntPtr entrada = GetStdHandle(STD_INPUT_HANDLE);
        uint modo;
        if (!GetConsoleMode(entrada, out modo)) return "sem console";
        if (!SetConsoleMode(entrada, (modo & ~ENABLE_QUICK_EDIT_MODE) | ENABLE_EXTENDED_FLAGS)) return "falhou";
        GetConsoleMode(entrada, out modo);
        return (modo & ENABLE_QUICK_EDIT_MODE) == 0 ? "desligada" : "continua ligada";
    }
}
'@

[ConsoleSmvep]::DesligarEdicaoRapida()
