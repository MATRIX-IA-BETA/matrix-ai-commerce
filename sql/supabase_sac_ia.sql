-- Matrix AI Commerce - SAC IA Mercado Livre
-- Execute uma vez no Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.sac_threads (
  id uuid primary key default gen_random_uuid(),
  channel text not null,
  external_id text not null,
  type text not null check (type in ('message','claim','whatsapp')),
  pack_id text,
  claim_id text,
  seller_id text,
  order_id text,
  buyer_id text,
  buyer_nickname text,
  status text default 'open',
  priority text default 'normal',
  affects_reputation boolean default false,
  due_date timestamptz,
  subject text,
  available_actions jsonb default '[]'::jsonb,
  ai_draft text,
  ai_category text,
  ai_requires_approval boolean default true,
  ai_generated_at timestamptz,
  last_response_text text,
  last_response_at timestamptz,
  last_message_at timestamptz,
  raw_data jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(channel, external_id)
);

create table if not exists public.sac_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.sac_threads(id) on delete cascade,
  channel text not null,
  external_message_id text not null,
  direction text not null check (direction in ('inbound','outbound')),
  sender_role text,
  text text,
  date_created timestamptz,
  raw_data jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(channel, external_message_id)
);

create index if not exists sac_threads_last_message_idx on public.sac_threads(last_message_at desc);
create index if not exists sac_threads_priority_idx on public.sac_threads(priority, status);
create index if not exists sac_threads_order_idx on public.sac_threads(order_id);
create index if not exists sac_messages_thread_idx on public.sac_messages(thread_id, date_created);
