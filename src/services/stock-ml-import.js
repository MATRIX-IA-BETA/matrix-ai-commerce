const { supabase } = require("../db/supabase");
const {
  getMercadoLivreAccount,
  mercadoLivreFetch
} = require("./mercadolivre");

const SYNC_SOURCE = "mercadolivre_kits";
const BOOTSTRAP_REFRESH_MS = 10 * 60 * 1000;
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

function itemSellerSku(item) {
  return clean(item?.seller_custom_field) || skuFromAttributes(item?.attributes);
}

function variationSellerSku(variation) {
  return clean(variation?.seller_custom_field) || skuFromAttributes(variation?.attributes);
}

function inferProductType(item) {
  const title = clean(item?.title).toLowerCase();
  const looksLikePc = /\b(pc|cpu|computador|desktop|microcomputador)\b/i.test(title);
  const looksLikeUpgradeKit = /\bkit\b/i.test(title) && /(upgrade|placa\s*m[aã]e|processador|mem[oó]ria|intel|amd)/i.test(title);
  return looksLikePc || looksLikeUpgradeKit ? "kit" : "simple";
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

async function findProductByReference(reference) {
  const { data, error } = await supabase
    .from("inventory_products")
    .select("id,sku,name,product_type,metadata")
    .eq("sku", reference)
    .maybeSingle();
  if (error) throw new Error(`Erro buscando referência ${reference}: ${error.message}`);
  return data;
}

async function upsertKit({ title, item, account, retryOnConflict = true }) {
  const itemId = clean(item?.id);
  if (!itemId || !/^MLB\d+$/i.test(itemId)) {
    throw new Error(`Anúncio sem MLB válido: ${itemId || "vazio"}`);
  }

  // Regra Matrix: a referência principal do produto Mercado Livre é SEMPRE o MLB.
  // Seller SKU continua salvo apenas como metadado/vínculo auxiliar.
  const reference = itemId.toUpperCase();
  const productType = inferProductType(item);
  const directSellerSku = itemSellerSku(item) || null;
  const variations = Array.isArray(item?.variations) ? item.variations : [];
  const sellerSkus = [
    directSellerSku,
    ...variations.map(variationSellerSku)
  ].filter(Boolean);

  const itemRef = {
    item_id: reference,
    variation_id: null,
    status: item?.status || null,
    permalink: item?.permalink || null
  };

  const existing = await findProductByReference(reference);
  let product;

  if (existing) {
    const { data, error } = await supabase
      .from("inventory_products")
      .update({
        name: clean(title) || existing.name,
        product_type: productType,
        category: "Mercado Livre",
        metadata: {
          ...(existing.metadata || {}),
          source: "mercadolivre",
          reference_type: "mlb",
          mlb: reference,
          seller_sku: directSellerSku,
          seller_skus: [...new Set(sellerSkus)],
          mercadolivre_items: [itemRef]
        },
        updated_at: new Date().toISOString()
      })
      .eq("id", existing.id)
      .select("id,sku")
      .single();
    if (error) throw new Error(`Erro atualizando produto ${reference}: ${error.message}`);
    product = data;
  } else {
    const { data, error } = await supabase
      .from("inventory_products")
      .insert({
        sku: reference,
        name: clean(title) || reference,
        category: "Mercado Livre",
        product_type: productType,
        unit: "UN",
        minimum_stock: 0,
        average_cost: 0,
        active: true,
        metadata: {
          source: "mercadolivre",
          reference_type: "mlb",
          mlb: reference,
          seller_sku: directSellerSku,
          seller_skus: [...new Set(sellerSkus)],
          mercadolivre_items: [itemRef]
        },
        updated_at: new Date().toISOString()
      })
      .select("id,sku")
      .single();

    if (error) {
      const duplicate = String(error.message || "").toLowerCase().includes("duplicate key");
      if (duplicate && retryOnConflict) {
        return upsertKit({ title, item, account, retryOnConflict: false });
      }
      throw new Error(`Erro criando produto ${reference}: ${error.message}`);
    }
    product = data;
  }

  const linkRows = variations.length
    ? variations.map(variation => ({
        variationId: variation?.id != null ? clean(variation.id) : null,
        sellerSku: variationSellerSku(variation) || directSellerSku,
        availableQuantity: variation?.available_quantity != null
          ? Number(variation.available_quantity)
          : (item?.available_quantity != null ? Number(item.available_quantity) : null)
      }))
    : [{
        variationId: null,
        sellerSku: directSellerSku,
        availableQuantity: item?.available_quantity != null ? Number(item.available_quantity) : null
      }];

  for (const row of linkRows) {
    let linkQuery = supabase
      .from("inventory_marketplace_links")
      .select("id")
      .eq("marketplace", "mercadolivre")
      .eq("external_item_id", reference);

    linkQuery = row.variationId
      ? linkQuery.eq("variation_id", row.variationId)
      : linkQuery.is("variation_id", null);

    const { data: link, error: linkFindError } = await linkQuery.limit(1).maybeSingle();
    if (linkFindError) throw new Error(`Erro buscando vínculo ${reference}: ${linkFindError.message}`);

    const linkRecord = {
      product_id: product.id,
      marketplace: "mercadolivre",
      account_id: String(account.account_id || account.user_id || ""),
      external_item_id: reference,
      external_user_product_id: item?.user_product_id != null ? String(item.user_product_id) : null,
      variation_id: row.variationId,
      seller_sku: row.sellerSku || null,
      sync_enabled: true,
      last_external_quantity: row.availableQuantity,
      last_sync_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (link) {
      const { error } = await supabase.from("inventory_marketplace_links").update(linkRecord).eq("id", link.id);
      if (error) throw new Error(`Erro atualizando vínculo ${reference}: ${error.message}`);
    } else {
      const { error } = await supabase.from("inventory_marketplace_links").insert(linkRecord);
      if (error) throw new Error(`Erro criando vínculo ${reference}: ${error.message}`);
    }
  }

  return {
    productId: product.id,
    reference,
    itemId: reference,
    productType,
    variations: linkRows.length,
    sellerSkus: [...new Set(sellerSkus)]
  };
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
    referencias_mlb: [],
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
        const result = await upsertKit({ title: item.title, item, account });
        summary.kits_criados_ou_atualizados += 1;
        summary.referencias_mlb.push(result.reference);
      } catch (error) {
        summary.erros.push({ item_id: itemId, erro: error.message });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, ids.length)) }, () => worker()));

  summary.referencias_mlb = [...new Set(summary.referencias_mlb)].sort();

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
  if (error || !data?.last_finished_at) return true;

  const lastFinishedAt = new Date(data.last_finished_at).getTime();
  if (!Number.isFinite(lastFinishedAt)) return true;
  return Date.now() - lastFinishedAt >= BOOTSTRAP_REFRESH_MS;
}

async function bootstrapMercadoLivreKits() {
  if (!(await shouldBootstrap())) return { skipped: true, reason: "recently_synced" };
  return importMercadoLivreKits();
}

module.exports = {
  importMercadoLivreKits,
  bootstrapMercadoLivreKits
};
