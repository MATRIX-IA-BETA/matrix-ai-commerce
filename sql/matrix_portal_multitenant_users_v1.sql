create table if not exists public.matrix_tenants (
  id uuid primary key default gen_random_uuid(),
  cnpj text not null unique check (cnpj ~ '^[0-9]{14}$'),
  legal_name text not null,
  trade_name text,
  slug text unique,
  active boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.matrix_portal_users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.matrix_tenants(id) on delete cascade,
  name text not null,
  email text not null,
  phone text,
  role text not null default 'viewer' check (role in ('super_admin','admin','finance','stock','sac','sales','viewer','custom')),
  permissions jsonb not null default '{}'::jsonb,
  password_hash text not null,
  active boolean not null default true,
  must_change_password boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists matrix_portal_users_tenant_email_unique on public.matrix_portal_users (tenant_id, lower(email));
create index if not exists matrix_portal_users_tenant_idx on public.matrix_portal_users (tenant_id);

create table if not exists public.matrix_admin_audit (
  id bigserial primary key,
  tenant_id uuid references public.matrix_tenants(id) on delete set null,
  actor_type text not null default 'owner',
  actor_id uuid,
  action text not null,
  target_user_id uuid references public.matrix_portal_users(id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists matrix_admin_audit_tenant_created_idx on public.matrix_admin_audit (tenant_id, created_at desc);

alter table public.matrix_tenants enable row level security;
alter table public.matrix_portal_users enable row level security;
alter table public.matrix_admin_audit enable row level security;

insert into public.matrix_tenants (cnpj, legal_name, trade_name, slug, settings)
values ('04361355000167', 'SHOP MATRIX COMERCIAL DO BRASIL LTDA', 'Shop Matrix', 'shop-matrix', '{"default":true}'::jsonb)
on conflict (cnpj) do update set legal_name = excluded.legal_name, trade_name = excluded.trade_name, slug = coalesce(public.matrix_tenants.slug, excluded.slug), updated_at = now();
