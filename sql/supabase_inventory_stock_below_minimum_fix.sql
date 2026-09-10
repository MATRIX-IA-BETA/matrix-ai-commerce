-- MATRIX AI - correção da regra de estoque mínimo
-- Regra correta: um item só está abaixo do mínimo quando disponível < mínimo.
-- Ex.: disponível 0 / mínimo 0 = normal, não alerta.

create or replace view public.inventory_stock
with (security_invoker = true)
as
select
  p.id as product_id,
  p.sku,
  p.name,
  p.category,
  p.product_type,
  p.unit,
  p.minimum_stock,
  p.average_cost,
  p.supplier_name,
  p.location_code,
  p.active,
  coalesce(m.on_hand, 0)::numeric(14,4) as on_hand,
  coalesce(r.reserved, 0)::numeric(14,4) as reserved,
  (coalesce(m.on_hand, 0) - coalesce(r.reserved, 0))::numeric(14,4) as available,
  ((coalesce(m.on_hand, 0) - coalesce(r.reserved, 0)) < p.minimum_stock) as below_minimum,
  (coalesce(m.on_hand, 0) * p.average_cost)::numeric(14,2) as stock_value
from public.inventory_products p
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
