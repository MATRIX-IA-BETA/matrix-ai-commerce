const { supabase } = require("../db/supabase");
const {
  getMercadoLivreAccount,
  mercadoLivreFetch
} = require("./mercadolivre");

const SYNC_SOURCE = "mercadolivre_kits";
let activeImportPromise = null;

function clean(value) {
  return value == null ? "" : String(value).trim();
}

function skuFromAttributes(attributes = []) {
  const hit = Array.isArray(attributes)
    ? attributes.find(attr => String(attr?.id || "").toUpperCase() === "SELLER_SKU")
    : null;
  return clean(hit?.value_name || hit?.values?.[0]?.name || hit?.values?.[0]?.id);
}

function itemSku(item) {
  return clean(item?.seller_custom_field) || skuFromAttributes(item?.attributes);
}

function variationSku(variation) {
  return clean(variation?.seller_custom_field) || skuFromAttributes(variation?.attributes);
}

async function listItemIds(account) {
  const statuses = ["active", "paused"];
  const ids = [];

  for (const status of statuses) {
    let offset = 0;
    const limit = 50;

    while (true) {
      const params = new URLSearchParams({
        status,
        limit: String(limit),
        offset: String(offset)
      });

      const { response } = await mercadoLivreFetch(
        `/users/${account.user_id}/items/search?${params.toString()}`,
        account
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(`Mercado Livre recusou a listagem de anúncios (${status}): ${JSON.stringify(data)}`);
      }

      const page = Array.isArray(data?.results) ? data.results : [];
      ids.push(...page.map(clean).filter(Boolean));

      const total = Number(data?.paging?.total || 0);
      offset += page.length;
      if (!page.length || offset >= total) break;
    }
  }

  return [...new Set(ids)];
}

async function fetchItem(itemId, account) {
  const { response } = await mercadoLivreFetch(
    `/items/${encodeURIComponent(itemId)}?include_attributes=all`,
    account
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Falha consultando anúncio ${itemId}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function findProductBySku(sku) {
  const { data, error } = await supabase
    .from("inventory_products")
    .select("id,sku,name,product_type,metadata")
    .eq("sku", sku)
    .maybeSingle();
  if (error) throw new Error(`Erro buscando SKU ${sku}: ${error.message}`);
  return data;
}

async function upsertKit({ sku, title, item, variation, account, retryOnConflict = true }) {
  const normalizedSku = clean(sku);
  const itemId = clean(item?.id);
  const variationId = variation?.id != null ? clean(variation.id) : null;
  const existing = await findProductBySku(normalizedSku);

  const itemRef = {
    item_id: itemId,
    variation_id: variationId,
    status: item?.status || null,
    permalink: item?.permalink || null
  };

  let product;
  if (existing) {
    const previousRefs = Array.isArray(existing?.metadata?.mercadolivre_items)
      ? existing.metadata.mercadolivre_items
      : [];
    const refs = previousRefs.filter(ref => !(String(ref?.item_id) === itemId && String(ref?.variation_id || "") === String(variationId || "")));
    refs.push(itemRef);

    const { data, error } = await supabase
      .from("inventory_products")
      .update({
        name: clean(title) || existing.name,
        product_type: "kit",
        category: "Mercado Livre",
        metadata: {
          ...(existing.metadata || {}),
          source: "mercadolivre",
          mercadolivre_items: refs
        },
        updated_at: new Date().toISOString()
      })
      .eq("id", existing.id)
      .select("id,sku")
      .single();
    if (error) throw new Error(`Erro atualizando kit ${normalizedSku}: ${error.message}`);
    product = data;
  } else {
    const { data, error } = await supabase
      .from("inventory_products")
      .insert({
        sku: normalizedSku,
        name: clean(title) || normalizedSku,
        category: "Mercado Livre",
        product_type: "kit",
        unit: "UN",
        minimum_stock: 0,
        average_cost: 0,
        active: true,
        metadata: {
          source: "mercadolivre",
          mercadolivre_items: [itemRef]
        },
        updated_at: new Date().toISOString()
      })
      .select("id,sku")
      .single();

    if (error) {
      const duplicate = String(error.message || "").toLowerCase().includes("duplicate key");
      if (duplicate && retryOnConflict) {
        return upsertKit({ sku, title, item, variation, account, retryOnConflict: false });
      }
      throw new Error(`Erro criando kit ${normalizedSku}: ${error.message}`);
    }
    product = data;
  }

  let linkQuery = supabase
    .from("inventory_marketplace_links")
    .select("id")
    .eq("marketplace", "mercadolivre")
    .eq("external_item_id", itemId);

  linkQuery = variationId
    ? linkQuery.eq("variation_id", variationId)
    : linkQuery.is("variation_id", null);

  const { data: link, error: linkFindError } = await linkQuery.limit(1).maybeSingle();
  if (linkFindError) throw new Error(`Erro buscando vínculo ${itemId}: ${linkFindError.message}`);

  const linkRecord = {
    product_id: product.id,
    marketplace: "mercadolivre",
    account_id: String(account.account_id || account.user_id || ""),
    external_item_id: itemId,
    external_user_product_id: item?.user_product_id != null ? String(item.user_product_id) : null,
    variation_id: variationId,
    seller_sku: normalizedSku,
    sync_enabled: true,
    last_external_quantity: item?.available_quantity != null ? Number(item.available_quantity) : null,
    last_sync_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  if (link) {
    const { error } = await supabase.from("inventory_marketplace_links").update(linkRecord).eq("id", link.id);
    if (error) throw new Error(`Erro atualizando vínculo ${itemId}: ${error.message}`);
  } else {
    const { error } = await supabase.from("inventory_marketplace_links").insert(linkRecord);
    if (error) throw new Error(`Erro criando vínculo ${itemId}: ${error.message}`);
  }

  return { productId: product.id, sku: normalizedSku, itemId, variationId };
}

async function doImport() {
  const account = await getMercadoLivreAccount();
  if (!account) throw new Error("Nenhuma conta Mercado Livre conectada.");

  const startedAt = new Date().toISOString();
  await supabase.from("inventory_sync_state").upsert({
    source: SYNC_SOURCE,
    last_started_at: startedAt,
    status: "running",
    updated_at: startedAt
  }, { onConflict: "source" });

  const ids = await listItemIds(account);
  const summary = {
    anuncios_encontrados: ids.length,
    kits_criados_ou_atualizados: 0,
    anuncios_sem_sku: [],
    erros: []
  };

  const concurrency = 5;
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= ids.length) return;
      const itemId = ids[index];

      try {
        const item = await fetchItem(itemId, account);
        const directSku = itemSku(item);

        if (directSku) {
          await upsertKit({ sku: directSku, title: item.title, item, variation: null, account });
          summary.kits_criados_ou_atualizados += 1;
          continue;
        }

        const variations = Array.isArray(item?.variations) ? item.variations : [];
        const skuVariations = variations
          .map(variation => ({ variation, sku: variationSku(variation) }))
          .filter(row => row.sku);

        if (!skuVariations.length) {
          summary.anuncios_sem_sku.push({ item_id: itemId, titulo: item?.title || null });
          continue;
        }

        for (const row of skuVariations) {
          await upsertKit({ sku: row.sku, title: item.title, item, variation: row.variation, account });
          summary.kits_criados_ou_atualizados += 1;
        }
      } catch (error) {
        summary.erros.push({ item_id: itemId, erro: error.message });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, ids.length)) }, () => worker()));

  const finishedAt = new Date().toISOString();
  await supabase.from("inventory_sync_state").upsert({
    source: SYNC_SOURCE,
    last_started_at: startedAt,
    last_finished_at: finishedAt,
    status: summary.erros.length ? "completed_with_errors" : "success",
    summary,
    updated_at: finishedAt
  }, { onConflict: "source" });

  return summary;
}

async function importMercadoLivreKits() {
  if (activeImportPromise) return activeImportPromise;
  activeImportPromise = doImport().finally(() => { activeImportPromise = null; });
  return activeImportPromise;
}

async function shouldBootstrap() {
  const { data, error } = await supabase
    .from("inventory_sync_state")
    .select("last_finished_at,status")
    .eq("source", SYNC_SOURCE)
    .maybeSingle();
  if (error) return true;
  if (!data?.last_finished_at) return true;
  return false;
}

async function bootstrapMercadoLivreKits() {
  if (!(await shouldBootstrap())) return { skipped: true, reason: "already_bootstrapped" };
  return importMercadoLivreKits();
}

module.exports = {
  importMercadoLivreKits,
  bootstrapMercadoLivreKits
};
