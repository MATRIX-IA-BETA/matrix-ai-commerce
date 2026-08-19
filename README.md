# Matrix AI Commerce — V2 Modular

Esta versão reorganiza o backend em módulos separados sem dividir a infraestrutura em vários serviços.

## Por que foi separado
O objetivo é impedir que uma alteração no Bling/Fiscal obrigue a mexer no SAC, WhatsApp ou Mercado Livre.
Continua sendo:
- 1 repositório
- 1 serviço Railway
- 1 Supabase
- módulos internos independentes

## Estrutura

```text
server.js
src/
  config/
    env.js
  db/
    supabase.js
  utils/
    common.js
  services/
    mercadolivre.js
    sac.js
    stock.js
    customers.js
    fiscal.js
    bling.js
  routes/
    basic.js
    webhooks-mercadolivre.js
    mercadolivre.js
    sac.js
    stock.js
    customers.js
    fiscal.js
    bling.js
    whatsapp.js
sql/
  supabase_sac_ia.sql
  supabase_stock_fiscal_bling_v1.sql
```

## Módulos

### Mercado Livre
OAuth, refresh de token, pedidos, sincronização, dashboard e detalhe de pedido.

### SAC IA
Mensagens pós-venda, reclamações, rascunho por IA, aprovação e envio.

### Stock Matrix
Produtos, saldo, movimentações, estoque mínimo, vínculos ML e kits/BOM.

### Clientes
Cadastro interno e criação/atualização a partir de pedidos do Mercado Livre.

### Fiscal
Configuração do desconto fiscal padrão, sugestão pela comissão do ML e prévia da NF-e.

### Bling
OAuth, refresh, cadastro de contato e criação de NF-e.

### WhatsApp
Webhook de verificação, recebimento de eventos e endpoint de envio.

## Regra fiscal preservada
A Matrix mantém separados:
- valor bruto da venda
- comissão
- frete
- líquido operacional
- percentual de desconto fiscal
- valor fiscal da NF-e

O desconto pode ser padrão, sugerido pela comissão do Mercado Livre ou sobrescrito manualmente por pedido.

## Deploy
Suba todo o conteúdo deste ZIP no repositório `matrix-ai-commerce`.
O Railway continua iniciando pelo `server.js`.

## SQL
Os SQLs agora ficam em `/sql`, fora do código de execução.
Execute apenas quando necessário no Supabase SQL Editor.

## Segurança
- Segredos ficam somente em variáveis do Railway.
- Nenhum token/chave deve ser commitado.
- Rotas e regras de negócio estão separadas por responsabilidade.
- Estoque usa movimentações idempotentes para reduzir dupla baixa.
