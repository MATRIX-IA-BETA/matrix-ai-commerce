-- =========================================================
-- MATRIX AI COMMERCE - CUSTO REAL + KITS VIRTUAIS
-- Kit/PC é uma composição (BOM), nunca patrimônio físico próprio.
-- O valor patrimonial usa o custo real atual quando disponível.
-- =========================================================

create or replace view public.inventory_stock as
with product_cost as (
  select
    p.*,
    coalesce(
      case
        when coalesce(p.metadata->>'actual_cost', '') ~ '^[0-9]+([.][0-9]+)?$'
          then (p.metadata->>'actual_cost')::numeric
      end,
      case
        when coalesce(p.metadata->>'manual_cost', '') ~ '^[0-9]+([.][0-9]+)?$'
          then (p.metadata->>'manual_cost')::numeric
      end,
      case
        when coalesce(p.metadata->>'last_cost', '') ~ '^[0-9]+([.][0-9]+)?$'
          then (p.metadata->>'last_cost')::numeric
      end,
      p.average_cost,
      0
    )::numeric(14,4) as actual_cost
  from public.inventory_products p
)
select
  p.id as product_id,
  p.sku,
  p.name,
  p.category,
  p.product_type,
  p.unit,
  p.minimum_stock,
  p.actual_cost as average_cost,
  p.actual_cost,
  p.supplier_name,
  p.location_code,
  p.active,
  (case when p.product_type = 'kit' then 0 else coalesce(m.on_hand, 0) end)::numeric(14,4) as on_hand,
  (case when p.product_type = 'kit' then 0 else coalesce(r.reserved, 0) end)::numeric(14,4) as reserved,
  (case when p.product_type = 'kit' then 0 else coalesce(m.on_hand, 0) - coalesce(r.reserved, 0) end)::numeric(14,4) as available,
  case
    when p.product_type = 'kit' then false
    else ((coalesce(m.on_hand, 0) - coalesce(r.reserved, 0)) <= p.minimum_stock)
  end as below_minimum,
  (case when p.product_type = 'kit' then 0 else coalesce(m.on_hand, 0) * p.actual_cost end)::numeric(14,2) as stock_value
from product_cost p
left join (
  select product_id, sum(quantity) as on_hand
  from public.inventory_movements
  group by product_id
) m on m.product_id = p.id
left join (
  select product_id, sum(quantity) as reserved
  from public.inventory_reservations
  where status = 'active'
  group by product_id
) r on r.product_id = p.id;

grant select on table public.inventory_stock to service_role;
