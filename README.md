# matrix-ai-commerce
Backend da Matrix AI Commerce para integração com Mercado Livre


## SAC IA Mercado Livre

Variáveis novas no Railway:
- `OPENAI_API_KEY` (obrigatória para gerar rascunhos)
- `OPENAI_MODEL` (opcional; padrão `gpt-5.6-terra`)
- `SAC_AUTO_SEND_SIMPLE` (opcional; padrão `false`)

Antes do deploy, execute `supabase_sac_ia.sql` no Supabase SQL Editor.

Rotas principais:
- `GET /sac/health/check`
- `GET /sac`
- `GET /sac/:id`
- `POST /sac/sync/messages`
- `POST /sac/sync/claims`
- `POST /sac/:id/draft`
- `POST /sac/:id/send`

Segurança operacional: o padrão é gerar rascunho e exigir aprovação humana. Reclamações e categorias sensíveis nunca entram em autoenvio por padrão.
