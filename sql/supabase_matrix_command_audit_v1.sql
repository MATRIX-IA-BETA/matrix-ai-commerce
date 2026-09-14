create table if not exists public.matrix_command_audit (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  actor_key text,
  actor_role text,
  page text,
  command_text text not null,
  command_type text,
  status text not null default 'received',
  requires_confirmation boolean not null default false,
  result_summary text,
  pending_payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  confirmed_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_matrix_command_audit_actor_created
  on public.matrix_command_audit (actor_key, created_at desc);
create index if not exists idx_matrix_command_audit_pending
  on public.matrix_command_audit (actor_key, status, expires_at)
  where status = 'pending_confirmation';

alter table public.matrix_command_audit enable row level security;
revoke all on table public.matrix_command_audit from anon, authenticated;
grant select, insert, update on table public.matrix_command_audit to service_role;
