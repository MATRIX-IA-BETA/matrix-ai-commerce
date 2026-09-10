insert into public.erp_sales_channels (legacy_control, name, commission_percent, registered_at, source, metadata)
values
  (2,  'Canal legado SIC #2',  0, null, 'sic', '{"legacy_orphan":true,"recovered_from":"sales_history"}'::jsonb),
  (3,  'Canal legado SIC #3',  0, null, 'sic', '{"legacy_orphan":true,"recovered_from":"sales_history"}'::jsonb),
  (4,  'Canal legado SIC #4',  0, null, 'sic', '{"legacy_orphan":true,"recovered_from":"sales_history"}'::jsonb),
  (6,  'Canal legado SIC #6',  0, null, 'sic', '{"legacy_orphan":true,"recovered_from":"sales_history"}'::jsonb),
  (7,  'Canal legado SIC #7',  0, null, 'sic', '{"legacy_orphan":true,"recovered_from":"sales_history"}'::jsonb),
  (8,  'Canal legado SIC #8',  0, null, 'sic', '{"legacy_orphan":true,"recovered_from":"sales_history"}'::jsonb),
  (9,  'Canal legado SIC #9',  0, null, 'sic', '{"legacy_orphan":true,"recovered_from":"sales_history"}'::jsonb),
  (10, 'Canal legado SIC #10', 0, null, 'sic', '{"legacy_orphan":true,"recovered_from":"sales_history"}'::jsonb),
  (11, 'Canal legado SIC #11', 0, null, 'sic', '{"legacy_orphan":true,"recovered_from":"sales_history"}'::jsonb),
  (12, 'Canal legado SIC #12', 0, null, 'sic', '{"legacy_orphan":true,"recovered_from":"sales_history"}'::jsonb),
  (14, 'Canal legado SIC #14', 0, null, 'sic', '{"legacy_orphan":true,"recovered_from":"sales_history"}'::jsonb)
on conflict (legacy_control) do nothing;

alter table public.erp_sale_payments
  drop constraint if exists erp_sale_payments_sale_legacy_control_fkey;

create index if not exists erp_sale_payments_sale_legacy_control_idx
  on public.erp_sale_payments (sale_legacy_control);

comment on column public.erp_sale_payments.sale_legacy_control is
  'Controle legado da venda no SIC. Pode apontar para uma venda já removida da tabela histórica do SIC; por isso não há FK obrigatória.';

create or replace view public.erp_sale_payments_orphans
with (security_invoker = true) as
select p.*
from public.erp_sale_payments p
left join public.erp_sales s on s.legacy_control = p.sale_legacy_control
where s.legacy_control is null;

grant select on public.erp_sale_payments_orphans to service_role;
