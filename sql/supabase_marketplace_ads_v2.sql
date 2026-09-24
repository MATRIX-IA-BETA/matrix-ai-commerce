-- Mercado Ads Product Ads v2
-- Enriquecimento da tabela existente de métricas diárias.
-- Compatível com campanhas e Ad Groups; hoje o sync persiste campanha/dia.

alter table public.marketplace_ads_daily
  add column if not exists row_key text,
  add column if not exists advertiser_id text,
  add column if not exists site_id text,
  add column if not exists level text default 'campaign',
  add column if not exists ad_group_id text,
  add column if not exists campaign_status text,
  add column if not exists strategy text,
  add column if not exists currency_id text,
  add column if not exists budget numeric,
  add column if not exists roas_target numeric,
  add column if not exists ctr numeric,
  add column if not exists cpc numeric,
  add column if not exists cvr numeric,
  add column if not exists sov numeric,
  add column if not exists tacos numeric,
  add column if not exists organic_units_quantity numeric,
  add column if not exists organic_units_amount numeric,
  add column if not exists organic_items_quantity numeric,
  add column if not exists direct_items_quantity numeric,
  add column if not exists indirect_items_quantity numeric,
  add column if not exists advertising_items_quantity numeric,
  add column if not exists direct_units_quantity numeric,
  add column if not exists indirect_units_quantity numeric,
  add column if not exists direct_amount numeric,
  add column if not exists indirect_amount numeric,
  add column if not exists total_amount numeric,
  add column if not exists impression_share numeric,
  add column if not exists top_impression_share numeric,
  add column if not exists lost_impression_share_by_budget numeric,
  add column if not exists lost_impression_share_by_ad_rank numeric,
  add column if not exists acos_benchmark numeric,
  add column if not exists updated_at timestamptz default now();

create unique index if not exists marketplace_ads_daily_row_key_uidx
  on public.marketplace_ads_daily(row_key);

create index if not exists marketplace_ads_daily_date_idx
  on public.marketplace_ads_daily(date desc);

create index if not exists marketplace_ads_daily_campaign_idx
  on public.marketplace_ads_daily(campaign_id, date desc);

create index if not exists marketplace_ads_daily_ad_group_idx
  on public.marketplace_ads_daily(ad_group_id, date desc);
