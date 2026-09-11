-- MATRIX AI COMMERCE - resultado real por venda + status de baixa no estoque

create table if not exists public.marketplace_sale_financials (
  marketplace_order_id text primary key,
  marketplace text not null default 'mercadolivre',
  stock_status text not null default 'pending',
  stock_posted_at timestamptz,
  actual_net_received numeric(14,2),
  total_cost numeric(14,2) not null default 0,
  total_profit numeric(14,2),
  margin_percent numeric(9,2),
  nfe_amount numeric(14,2),
  nfe_number text,
  nfe_access_key text,
  reconciliation_status text,
  reconciliation_source text,
  payment_ids jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_marketplace_sale_financials_stock_status
on public.marketplace_sale_financials(stock_status, updated_at desc);

alter table public.marketplace_sale_financials enable row level security;
grant select, insert, update, delete on table public.marketplace_sale_financials to service_role;
