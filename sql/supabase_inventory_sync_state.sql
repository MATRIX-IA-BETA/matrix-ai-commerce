-- MATRIX AI - controle de sincronizacao de estoque
create table if not exists public.inventory_sync_state (
  source text primary key,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  status text not null default 'idle',
  summary jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.inventory_sync_state enable row level security;
grant select, insert, update, delete on table public.inventory_sync_state to service_role;
