# Matrix AI — Admin preview

Branch de teste para o painel administrativo multiempresa.

## Rotas
- `/` login de usuário por CNPJ + e-mail + senha
- `/owner` login do proprietário usando `PORTAL_ACCESS_PASSWORD`
- `/admin` painel de empresas, usuários, perfis, permissões, bloqueio e reset de senha
- `/app` redireciona para o Matrix AI atual apenas para o proprietário ou para usuários da Shop Matrix

## Variáveis necessárias
- `PORTAL_ACCESS_PASSWORD`
- `PORTAL_SESSION_SECRET`
- `MATRIX_APP_URL`
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`

## Segurança
As tabelas administrativas usam RLS e não possuem políticas públicas. O backend usa a chave secreta do Supabase. Usuários de outras empresas podem ser cadastrados, mas não recebem acesso ao aplicativo operacional até a camada de isolamento multiempresa ser aplicada no app principal.
