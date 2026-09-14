# Matrix Voice Command Center

## Web

O botão **Matrix • Voz** é injetado nas telas principais. O navegador grava o comando, o backend transcreve e executa apenas consultas de estoque no contexto público atual.

Exemplos:

- `Matrix, quantas memórias DDR3 de 8 GB Kingston temos?`
- `Matrix, quais itens estão abaixo do estoque mínimo?`

Operações que alteram estoque ficam bloqueadas no painel público até existir autenticação de usuário.

## WhatsApp administrativo

Números presentes em `MATRIX_ADMIN_WHATSAPPS` podem usar:

- consulta de estoque;
- itens abaixo do mínimo;
- vendas do dia;
- saldos financeiros;
- entrada de estoque com confirmação;
- baixa de estoque com confirmação.

Áudio de entrada gera áudio de resposta automaticamente. Em texto, use `me responda por áudio` para forçar resposta em voz.

### Confirmação de movimentação

`Matrix, dá entrada de 50 memórias DDR3 8GB Kingston a 42 reais cada.`

O Matrix responde com produto, quantidade, custo e saldo atual. A movimentação só é executada depois de `confirmo`. O comando pendente expira em 5 minutos.

## Auditoria

Todos os comandos de consulta processados e todas as movimentações confirmadas são gravados em `matrix_command_audit`, com origem, ator, intenção, resultado e metadados da operação.
