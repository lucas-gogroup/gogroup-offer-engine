// worker.js — offer-api (GoDeploy / Cloudflare Worker), público.
//
// O app NÃO lê as bases do grupo: o dado é empurrado para cá via POST /curate/*
// (bearer CURATE_TOKEN). Em tempo real ele só consulta o próprio SQLite.
// Zero chamada de modelo por requisição.
//
// Rotas
//   GET  /health                      contadores, frescor da carga
//   POST /recommend                   a oferta
//   POST /event                       impression|accept|reject|checkout → bandit
//   GET  /offers?brand&anchor         simulação: ranking para uma âncora
//   GET  /log?brand&limit             decision_log (autonomia visível)
//   GET  /config?brand  POST /config  pisos/tetos por marca, sem redeploy
//   POST /curate/:table               carga (bearer)
//   POST /curate/reset?table=         zera antes de recarga (bearer)

import { adaptDb, ensureSchema } from './db.js';
import {
  decide, mergeConfig, functionalKey, round2, DEFAULT_CONFIG,
  parseCollectible, normTax, hashSeed, rngFrom, tsWindow,
} from './engine.js';

const DEFAULT_ORIGINS = [
  'https://thebarboursbeauty.com.br',
  'https://www.thebarboursbeauty.com.br',
  'https://rituaria.com.br',
  'https://www.rituaria.com.br',
];

const CURATE_TABLES = new Set([
  'product', 'kits', 'affinity', 'sku_orders', 'brand_orders', 'prior',
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      const db = adaptDb(env.DB);
      await ensureSchema(db, env.DB);
      const res = await route(request, url, db, env);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (err) {
      return json({ error: String(err && err.message || err), stack: err && err.stack }, 500, cors);
    }
  },
};

async function route(request, url, db, env) {
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = request.method;

  if (p === '/' || p === '/health') return handleHealth(db);
  if (p === '/recommend' && m === 'POST') return handleRecommend(request, db);
  if (p === '/event' && m === 'POST') return handleEvent(request, db);
  if (p === '/offers' && m === 'GET') return handleOffers(url, db);
  if (p === '/log' && m === 'GET') return handleLog(url, db);
  if (p === '/config' && m === 'GET') return handleGetConfig(url, db);
  if (p === '/config' && m === 'POST') return guard(request, env, () => handleSetConfig(request, db));
  if (p === '/curate/reset' && m === 'POST') return guard(request, env, () => handleReset(url, db));
  if (p.startsWith('/curate/') && m === 'POST') {
    const table = p.slice('/curate/'.length);
    return guard(request, env, () => handleCurate(table, request, db));
  }
  return json({ error: 'not_found', path: p }, 404);
}

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------

async function handleHealth(db) {
  const counts = {};
  for (const t of ['product', 'kit_components', 'affinity', 'sku_orders', 'brand_orders', 'offer_stats', 'decision_log']) {
    counts[t] = (await db.all(`SELECT COUNT(*) AS n FROM ${t}`))[0].n;
  }
  const perBrand = await db.all(
    `SELECT brand, COUNT(*) AS skus, SUM(is_kit) AS kits, MAX(loaded_at) AS loaded_at
       FROM product GROUP BY brand ORDER BY brand`,
  );
  const loads = await db.all(
    `SELECT table_name, chunk, rows, window_start, window_end, loaded_at
       FROM load_log ORDER BY id DESC LIMIT 15`,
  );
  return json({ ok: true, ts: new Date().toISOString(), counts, product_by_brand: perBrand, recent_loads: loads });
}

// ---------------------------------------------------------------------------
// /recommend
// ---------------------------------------------------------------------------

async function handleRecommend(request, db) {
  const t0 = Date.now();
  const body = await readJson(request);
  const brand = normBrand(body.brand);
  if (!brand) return json({ error: 'brand_required' }, 400);

  const surface = body.surface || 'cart';
  const goal = ['aov', 'stock', 'margin'].includes(body.goal) ? body.goal : 'aov';
  const segment = body.customer && body.customer.is_returning ? 'returning' : 'new';
  const n = Math.max(1, Math.min(10, Number(body.n) || 1));
  const cart = Array.isArray(body.cart) ? body.cart : [];
  const gifts = Array.isArray(body.gifts) ? body.gifts : [];

  const out = await runDecision(db, {
    brand, surface, goal, segment, n, cart, gifts,
    cartTotalIn: body.cart_total ?? null,
    gapIn: body.gap ?? null,
    threshold: body.threshold ?? null,
    maxDiscount: body.max_discount ?? DEFAULT_CONFIG.max_discount,
    priceTarget: body.price_target ?? null,
    debug: !!body.debug,
    agent: 'ofertante',
  });

  out.latency_ms = Date.now() - t0;
  if (!out.offers.length) {
    return json({ ...out, offer_id: out.offer_id, offers: [], reason: out.reason }, 200);
  }
  const top = out.offers[0];
  return json({
    offer_id: out.offer_id,
    ...top,
    ttl_seconds: 900,
    offers: n > 1 ? out.offers : undefined,
    context: out.context,
    relaxed: out.relaxed.length ? out.relaxed : undefined,
    rejected: out.debug ? out.rejected : undefined,
    timings: out.debug ? out.timings : undefined,
    latency_ms: out.latency_ms,
  });
}

/** Núcleo compartilhado por /recommend e /offers. Sempre grava decision_log. */
async function runDecision(db, opts) {
  const {
    brand, surface, goal, segment, n, cart, gifts,
    gapIn, threshold, cartTotalIn, maxDiscount, priceTarget, debug, agent,
  } = opts;

  const cartSkus = new Set(cart.map((i) => String(i.sku)).filter(Boolean));
  const giftSkus = new Set(gifts.map((i) => String(i.sku ?? i)).filter(Boolean));
  // cart_total explícito vence a soma do carrinho: o tema já sabe o total real
  // (com desconto de linha), e o /recommend pode ser chamado só com o total.
  const cartSum = cart.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 1), 0);
  const cartTotal = cartTotalIn != null ? Number(cartTotalIn) : cartSum;

  // âncora = item de maior valor no carrinho
  let anchor = null, anchorVal = -1;
  for (const i of cart) {
    const v = (Number(i.price) || 0) * (Number(i.qty) || 1);
    if (v > anchorVal) { anchorVal = v; anchor = String(i.sku); }
  }
  if (!anchor && opts.anchor) anchor = opts.anchor;

  // ---- carrega do SQLite -------------------------------------------------
  // Uma leitura por conceito, e nada de varrer tabela inteira: a versão anterior
  // puxava as 826 linhas de kit_components e as 294 de sku_orders em TODA
  // chamada, o que colocava o /recommend em ~1 s. Agora a afinidade, os
  // denominadores e os contadores do bandit vêm juntos com o candidato, e de
  // kits só se lê o que o carrinho realmente toca.
  const cartList = [...cartSkus];
  const inCart = cartList.map(() => '?').join(',');

  // Duas leituras, não cinco. O que o candidato precisa — afinidade com a
  // âncora, denominador do lift, contadores do bandit e a relação com os kits
  // do carrinho — vem tudo junto com ele, resolvido por índice. Antes eram
  // quatro SELECTs e uma varredura de kit_components inteira por chamada.
  const kitHit = cartList.length
    ? `(SELECT k.component_sku FROM kit_components k
         WHERE k.brand = p.brand AND k.kit_sku = p.sku
           AND k.component_sku IN (${inCart}) LIMIT 1)`
    : 'NULL';
  // Sobreposição kit ∩ kit. `cartSkus` com um KIT dentro contém só o SKU do
  // kit, então `kit_hit` acima nunca acha o kit vizinho que divide componente:
  // é preciso comparar contra os COMPONENTES dos kits do carrinho. Sem esta
  // subquery, o filtro no engine não tem o que filtrar — ele só vê o que a
  // query trouxe. Mais uma subquery, zero ida a mais ao banco.
  const overlapHit = cartList.length
    ? `(SELECT k.component_sku FROM kit_components k
         WHERE k.brand = p.brand AND k.kit_sku = p.sku
           AND k.component_sku IN (
                 SELECT k3.component_sku FROM kit_components k3
                  WHERE k3.brand = p.brand AND k3.kit_sku IN (${inCart}))
         LIMIT 1)`
    : 'NULL';
  const compHit = cartList.length
    ? `(SELECT 1 FROM kit_components k2
         WHERE k2.brand = p.brand AND k2.component_sku = p.sku
           AND k2.kit_sku IN (${inCart}) LIMIT 1)`
    : 'NULL';

  // Os `?` ligam na ordem em que aparecem no TEXTO da query, e as subqueries de
  // kit estão na cláusula SELECT — ou seja, antes dos LEFT JOIN. Os SKUs do
  // carrinho vêm primeiro; inverter isso faz a afinidade voltar zerada em
  // silêncio, sem erro de SQL.
  // Medido no GoDeploy, CADA query do env.DB custa ~115 ms; o resto do request
  // é ruído. Por isso o /recommend faz UMA leitura só: catálogo, afinidade,
  // denominadores, contadores do bandit, relação com os kits do carrinho e a
  // config da marca saem todos do mesmo SELECT. Otimizar o JS não move nada;
  // tirar uma query move 115 ms.
  //
  // Os `?` ligam na ordem em que aparecem no TEXTO: as subqueries de kit estão
  // na cláusula SELECT, portanto antes de todos os JOIN. Inverter isso faz a
  // afinidade voltar zerada em silêncio, sem erro de SQL.
  const prodParams = [];
  if (cartList.length) prodParams.push(...cartList, ...cartList, ...cartList);
  prodParams.push(anchor || '', anchor || '', surface, goal, segment, anchor || '', brand);

  const cfgCols = Object.keys(DEFAULT_CONFIG);

  const tQuery0 = Date.now();
  const products = await db.all(
    `SELECT p.*,
            COALESCE(a.co_purchase_count, 0) AS co,
            COALESCE(so.n_orders, 0)         AS cand_orders,
            COALESCE(os.impressions, 0)      AS impressions,
            COALESCE(os.accepts, 0)          AS accepts,
            os.prior_alpha, os.prior_beta,
            ${kitHit}     AS kit_hit,
            ${overlapHit} AS overlap_hit,
            ${compHit}    AS comp_hit,
            bo.n_orders AS brand_orders,
            ao.n_orders AS anchor_orders,
            ${cfgCols.map((c) => `bc.${c} AS cfg_${c}`).join(',\n            ')}
       FROM product p
       LEFT JOIN affinity a
              ON a.brand = p.brand AND a.anchor_sku = ? AND a.candidate_sku = p.sku
       LEFT JOIN sku_orders so
              ON so.brand = p.brand AND so.sku = p.sku
       LEFT JOIN offer_stats os
              ON os.brand = p.brand AND os.anchor_sku = ? AND os.offer_sku = p.sku
             AND os.surface = ? AND os.goal = ? AND os.segment = ?
       LEFT JOIN brand_orders bo ON bo.brand = p.brand
       LEFT JOIN sku_orders   ao ON ao.brand = p.brand AND ao.sku = ?
       LEFT JOIN brand_config bc ON bc.brand = p.brand
      WHERE p.brand = ?`,
    prodParams,
  );
  const tQuery = Date.now() - tQuery0;

  // A config vem repetida em toda linha (241 linhas, custo zero) — a primeira basta.
  // Marca sem produto nenhum não traz linha: cai nos defaults, e o pool é vazio mesmo.
  const first = products[0];
  const cfgRows = [first
    ? Object.fromEntries(cfgCols.map((c) => [c, first[`cfg_${c}`]]))
    : undefined];
  const cfg = mergeConfig(cfgRows[0]);

  // Três formas de informar o benefício, nesta ordem de precedência:
  //   1. gap: R$ que faltam, já calculado pelo tema (a barra de progresso sabe)
  //   2. threshold: {value, label} — o motor calcula gap = value - cart_total
  //   3. free_shipping_threshold da brand_config
  // As três continuam válidas; nenhuma é removida. Antes, `threshold` era aceito
  // e silenciosamente ignorado — o contrato de §5.1 do plano dos temas entregava
  // a feature morta sem erro. Achado batendo na API, não lendo o plano.
  //
  // O arredondamento não é cosmético: 64,90 − 34,90 = 30.000000000000007 em
  // ponto flutuante, que é MAIOR que o `gap_hard_max` de 30 e desligava a faixa
  // dura. Dois carrinhos vizinhos reportavam o mesmo `context.gap` e se
  // comportavam de formas diferentes, sem nada no log explicando por quê.
  let gap = 0;
  let thresholdLabel = null;
  if (gapIn != null) {
    gap = round2(Number(gapIn) || 0);
    if (threshold && threshold.label) thresholdLabel = String(threshold.label);
  } else if (threshold && threshold.value != null) {
    gap = round2(Math.max(0, Number(threshold.value) - cartTotal));
    thresholdLabel = threshold.label ? String(threshold.label) : null;
  } else if (cfg.free_shipping_threshold) {
    gap = round2(Math.max(0, cfg.free_shipping_threshold - cartTotal));
  }

  const bySku = new Map(products.map((p) => [p.sku, p]));
  const anchorProd = anchor ? bySku.get(anchor) || null : null;
  const brandOrders = first?.brand_orders || 0;
  const anchorOrders = first?.anchor_orders || 0;

  // kit_hit     — candidato é kit e contém um SKU solto do carrinho (RT01008 → KRT99078)
  // overlap_hit — candidato é kit e divide componente com um KIT do carrinho
  // comp_hit    — candidato compõe um kit que já está no carrinho
  const kitComponentsOf = new Map();
  const cartKitComponents = new Set();
  for (const p of products) {
    if (p.kit_hit) kitComponentsOf.set(p.sku, new Set([p.kit_hit]));
    else if (p.overlap_hit) {
      kitComponentsOf.set(p.sku, new Set([p.overlap_hit]));
      cartKitComponents.add(p.overlap_hit);
    }
    if (p.comp_hit) cartKitComponents.add(p.sku);
  }

  // equivalência funcional dos brindes (P6, heurística linha+subcategoria).
  // `functionalKey` devolve null para quem não tem grupo funcional — e null
  // NÃO entra no conjunto, senão a classe sem taxonomia volta a se auto-rejeitar.
  const giftKeys = new Set();
  for (const g of giftSkus) {
    const gp = bySku.get(g);
    const k = gp && functionalKey(gp);
    if (k) giftKeys.add(k);
  }

  // A regra de afinidade vale contra o carrinho inteiro, não só a âncora: é o
  // que impede a punição de substituto de valer só para o item mais caro.
  const cartProds = cartList.map((sku) => bySku.get(sku)).filter(Boolean);
  const collectible = parseCollectible(cfg.collectible_categories);
  const lineLabels = parseLineLabels(cfg.line_labels);

  // Semente do Thompson Sampling por (marca, oferta, superfície, goal, segmento,
  // janela de 15 min). Mesmo carrinho, mesma oferta, dentro da janela.
  const win = tsWindow();
  const rndFor = (sku) => rngFrom(hashSeed(`${brand}|${sku}|${surface}|${goal}|${segment}|${win}`));

  const ctx = {
    cfg, cartSkus, giftSkus, giftKeys, cartTotal, kitComponentsOf,
    cartKitComponents, gap, thresholdLabel, goal, priceTarget, maxDiscount, anchorProd,
    cartProds, collectible, lineLabels, rndFor,
    affinityOf: (sku) => {
      const p = bySku.get(sku);
      return { co: p?.co || 0, anchorOrders, candOrders: p?.cand_orders || 0, brandOrders };
    },
    statsOf: (sku) => {
      const p = bySku.get(sku);
      return {
        impressions: p?.impressions || 0,
        accepts: p?.accepts || 0,
        prior_alpha: p?.prior_alpha ?? null,
        prior_beta: p?.prior_beta ?? null,
      };
    },
  };

  const tDecide0 = Date.now();
  const { offers, rejected, relaxed } = decide(products, ctx);
  const tDecide = Date.now() - tDecide0;
  const top = offers.slice(0, n).map((o) => (debug ? o : stripDebug(o)));

  const offerId = 'of_' + randomId();
  const context = {
    brand, surface, goal, segment, anchor, cart_total: round2(cartTotal), gap: round2(gap),
    threshold_label: thresholdLabel,
    cart_skus: [...cartSkus], gift_skus: [...giftSkus],
    pool_size: products.length, candidates_after_filters: offers.length,
  };
  const decision = top.length
    ? { offer_sku: top[0].sku, variant_id: top[0].variant_id, price: top[0].price,
        final_price: top[0].final_price, incentive: top[0].incentive, score: top[0].score,
        expected_margin: top[0].expected_margin, alternatives: top.slice(1).map((o) => o.sku) }
    : { offer_sku: null };
  const reason = top.length
    ? top[0].reason
    : `sem oferta: ${rejectSummary(rejected) || 'pool vazio'}`;

  const tLog0 = Date.now();
  await db.run(
    `INSERT INTO decision_log (offer_id, ts, brand, agent, context_json, decision_json, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [offerId, new Date().toISOString(), brand, agent,
      JSON.stringify(context), JSON.stringify(decision), reason],
  );
  const tLog = Date.now() - tLog0;

  return {
    offer_id: offerId, offers: top, rejected, relaxed, context, reason, debug,
    timings: { query_ms: tQuery, decide_ms: tDecide, log_ms: tLog, rows: products.length },
  };
}

function stripDebug(o) { const { _debug, ...rest } = o; return rest; }

/** `line_labels` da config: JSON {linha: rótulo público} com a chave normalizada. */
function parseLineLabels(raw) {
  if (!raw) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object') return null;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const nk = normTax(k);
      if (nk && v) out[nk] = String(v);
    }
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

function rejectSummary(rejected) {
  const by = {};
  for (const r of rejected) by[r.code] = (by[r.code] || 0) + 1;
  return Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', ');
}

// ---------------------------------------------------------------------------
// /offers — simulação sobre uma âncora, sem montar carrinho
// ---------------------------------------------------------------------------

async function handleOffers(url, db) {
  const q = url.searchParams;
  const brand = normBrand(q.get('brand'));
  const anchor = q.get('anchor');
  if (!brand) return json({ error: 'brand_required' }, 400);
  if (!anchor) return json({ error: 'anchor_required' }, 400);

  const anchorRow = (await db.all('SELECT * FROM product WHERE brand = ? AND sku = ?', [brand, anchor]))[0];
  const cart = anchorRow
    ? [{ sku: anchor, variant_id: anchorRow.variant_id, qty: 1, price: anchorRow.price }]
    : [{ sku: anchor, qty: 1, price: Number(q.get('anchor_price')) || 0 }];

  const out = await runDecision(db, {
    brand,
    surface: q.get('surface') || 'cart',
    goal: ['aov', 'stock', 'margin'].includes(q.get('goal')) ? q.get('goal') : 'aov',
    segment: q.get('segment') === 'returning' ? 'returning' : 'new',
    n: Math.max(1, Math.min(50, Number(q.get('n')) || 10)),
    cart,
    gifts: (q.get('gifts') || '').split(',').filter(Boolean).map((s) => ({ sku: s })),
    gapIn: q.get('gap') != null ? Number(q.get('gap')) : null,
    maxDiscount: q.get('max_discount') != null ? Number(q.get('max_discount')) : DEFAULT_CONFIG.max_discount,
    priceTarget: null,
    debug: q.get('debug') === '1',
    agent: 'simulacao',
    anchor,
  });

  return json({
    offer_id: out.offer_id,
    anchor,
    anchor_known: !!anchorRow,
    anchor_title: anchorRow?.title ?? null,
    context: out.context,
    relaxed: out.relaxed,
    offers: out.offers,
    rejected_summary: rejectSummary(out.rejected),
    rejected: out.debug ? out.rejected : undefined,
  });
}

// ---------------------------------------------------------------------------
// /log
// ---------------------------------------------------------------------------

async function handleLog(url, db) {
  const q = url.searchParams;
  const limit = Math.max(1, Math.min(500, Number(q.get('limit')) || 50));
  const brand = normBrand(q.get('brand'));
  const rows = brand
    ? await db.all('SELECT * FROM decision_log WHERE brand = ? ORDER BY ts DESC LIMIT ?', [brand, limit])
    : await db.all('SELECT * FROM decision_log ORDER BY ts DESC LIMIT ?', [limit]);
  return json({
    count: rows.length,
    entries: rows.map((r) => ({
      offer_id: r.offer_id, ts: r.ts, brand: r.brand, agent: r.agent, reason: r.reason,
      context: safeParse(r.context_json), decision: safeParse(r.decision_json),
    })),
  });
}

// ---------------------------------------------------------------------------
// /event — realimenta o bandit no próprio request
// ---------------------------------------------------------------------------

async function handleEvent(request, db) {
  const body = await readJson(request);
  const offerId = body.offer_id;
  const ev = body.event;
  if (!offerId || !ev) return json({ error: 'offer_id_and_event_required' }, 400);
  if (!['impression', 'accept', 'reject', 'checkout', 'purchase'].includes(ev)) {
    return json({ error: 'unknown_event', event: ev }, 400);
  }

  const row = (await db.all('SELECT * FROM decision_log WHERE offer_id = ?', [offerId]))[0];
  if (!row) return json({ error: 'unknown_offer_id', offer_id: offerId }, 404);

  const ctx = safeParse(row.context_json) || {};
  const dec = safeParse(row.decision_json) || {};
  const offerSku = body.offer_sku || dec.offer_sku;
  if (!offerSku) return json({ ok: true, ignored: 'no_offer_sku' });

  const key = [row.brand, ctx.anchor || '', offerSku, ctx.surface || 'cart', ctx.goal || 'aov', ctx.segment || 'new'];
  const cfg = mergeConfig((await db.all('SELECT * FROM brand_config WHERE brand = ?', [row.brand]))[0]);

  await db.run(
    `INSERT INTO offer_stats (brand, anchor_sku, offer_sku, surface, goal, segment,
                              impressions, accepts, prior_alpha, prior_beta)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
     ON CONFLICT (brand, anchor_sku, offer_sku, surface, goal, segment) DO NOTHING`,
    [...key, cfg.prior_alpha, cfg.prior_beta],
  );

  if (ev === 'impression') {
    await db.run(
      `UPDATE offer_stats SET impressions = impressions + 1
        WHERE brand=? AND anchor_sku=? AND offer_sku=? AND surface=? AND goal=? AND segment=?`, key);
  } else if (ev === 'accept') {
    // aceite sem impressão registrada ainda conta como tentativa
    await db.run(
      `UPDATE offer_stats SET accepts = accepts + 1,
              impressions = CASE WHEN impressions < accepts + 1 THEN accepts + 1 ELSE impressions END
        WHERE brand=? AND anchor_sku=? AND offer_sku=? AND surface=? AND goal=? AND segment=?`, key);
  }
  // reject/checkout/purchase: registrados no log; reject já está implícito em
  // impressions − accepts, então não mexe no contador para não contar duas vezes.

  const stats = (await db.all(
    `SELECT impressions, accepts, prior_alpha, prior_beta FROM offer_stats
      WHERE brand=? AND anchor_sku=? AND offer_sku=? AND surface=? AND goal=? AND segment=?`, key))[0];

  await db.run(
    `INSERT INTO decision_log (offer_id, ts, brand, agent, context_json, decision_json, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [`ev_${randomId()}`, new Date().toISOString(), row.brand, 'otimizador',
      JSON.stringify({ ...ctx, source_offer_id: offerId, order_id: body.order_id ?? null }),
      JSON.stringify({ event: ev, offer_sku: offerSku, stats }),
      `evento ${ev} → take rate ${stats.impressions ? (stats.accepts / stats.impressions * 100).toFixed(1) : '0.0'}% em ${stats.impressions} impressões`],
  );

  return json({ ok: true, offer_id: offerId, event: ev, stats });
}

// ---------------------------------------------------------------------------
// /config
// ---------------------------------------------------------------------------

async function handleGetConfig(url, db) {
  const brand = normBrand(url.searchParams.get('brand'));
  const rows = brand
    ? await db.all('SELECT * FROM brand_config WHERE brand = ?', [brand])
    : await db.all('SELECT * FROM brand_config ORDER BY brand');
  return json({ defaults: DEFAULT_CONFIG, brands: rows, effective: brand ? mergeConfig(rows[0]) : undefined });
}

async function handleSetConfig(request, db) {
  const body = await readJson(request);
  const brand = normBrand(body.brand);
  if (!brand) return json({ error: 'brand_required' }, 400);
  const cols = Object.keys(DEFAULT_CONFIG);
  const current = (await db.all('SELECT * FROM brand_config WHERE brand = ?', [brand]))[0] || {};
  // `line_labels` chega como objeto JSON; a coluna é TEXT e o driver só liga escalares.
  const vals = cols.map((c) => {
    const v = body[c] !== undefined ? body[c] : (current[c] ?? null);
    return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  });
  await db.run(
    `INSERT OR REPLACE INTO brand_config (brand, ${cols.join(', ')}, updated_at)
     VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`,
    [brand, ...vals, new Date().toISOString()],
  );
  const row = (await db.all('SELECT * FROM brand_config WHERE brand = ?', [brand]))[0];
  return json({ ok: true, brand, stored: row, effective: mergeConfig(row) });
}

// ---------------------------------------------------------------------------
// /curate — o dado é empurrado para cá; o app nunca puxa
// ---------------------------------------------------------------------------

// Uma linha por INSERT custa caro no SQLite do Worker (827 linhas ≈ 2 min), e o
// driver só aceita ~100 parâmetros por statement — o que limitaria um INSERT
// multi-linha a 4 produtos. Por isso a carga serializa os valores como literais
// escapados e corta por tamanho de statement, não por número de parâmetros.
const MAX_SQL_CHARS = 60000;

const SPECS = {
  product: {
    physical: 'product',
    mode: 'replace',
    cols: ['brand', 'sku', 'variant_id', 'product_id', 'title', 'is_kit', 'category',
      'subcategory', 'line', 'price', 'cogs', 'cost_provisional', 'margin_ref',
      'image_url', 'url', 'available', 'coverage_days', 'stock_status', 'source',
      'loaded_at', 'confidence'],
    map: (r, ctx) => {
      const brand = normBrand(r.brand);
      if (!brand || !r.sku) throw new Error('brand e sku obrigatórios');
      return [brand, String(r.sku),
        r.variant_id != null ? String(r.variant_id) : null,
        r.product_id != null ? String(r.product_id) : null,
        r.title ?? null,
        truthy(r.is_kit) ? 1 : 0,
        r.category ?? null, r.subcategory ?? null, r.line ?? null,
        numOrNull(r.price), numOrNull(r.cogs),
        truthy(r.cost_provisional) ? 1 : 0,
        numOrNull(r.margin_ref), r.image_url ?? null, r.url ?? null,
        r.available != null ? Math.round(Number(r.available)) : null,
        numOrNull(r.coverage_days), r.stock_status ?? null,
        r.source ?? 'datamart', ctx.now,
        r.confidence ?? (truthy(r.cost_provisional) ? 'low' : 'high')];
    },
  },

  kits: {
    physical: 'kit_components',
    mode: 'replace',
    cols: ['brand', 'kit_sku', 'component_sku', 'qty_per_kit', 'protheus_ok', 'cross_brand'],
    map: (r) => {
      const brand = normBrand(r.brand ?? r.kit_marca);
      const kit = r.kit_sku ?? r.kit_codigo;
      const comp = r.component_sku ?? r.componente_codigo;
      if (!brand || !kit || !comp) throw new Error('brand, kit_sku e component_sku obrigatórios');
      return [brand, String(kit), String(comp),
        numOrNull(r.qty_per_kit ?? r.quantidade),
        truthy(r.protheus_ok ?? r.kit_no_cadastro_protheus) ? 1 : 0,
        truthy(r.cross_brand ?? r.cruza_marca) ? 1 : 0];
    },
  },

  // Afinidade e denominadores ACUMULAM: o mesmo par aparece em vários chunks de 3 d.
  affinity: {
    physical: 'affinity',
    mode: 'upsert',
    cols: ['brand', 'anchor_sku', 'candidate_sku', 'co_purchase_count', 'window_start', 'window_end'],
    conflict: `ON CONFLICT (brand, anchor_sku, candidate_sku) DO UPDATE SET
       co_purchase_count = affinity.co_purchase_count + excluded.co_purchase_count,
       window_start = MIN(COALESCE(affinity.window_start, excluded.window_start), COALESCE(excluded.window_start, affinity.window_start)),
       window_end   = MAX(COALESCE(affinity.window_end,   excluded.window_end),   COALESCE(excluded.window_end,   affinity.window_end))`,
    map: (r, ctx) => {
      const brand = normBrand(r.brand ?? ctx.meta.brand);
      if (!brand || !r.anchor_sku || !r.candidate_sku) throw new Error('brand, anchor_sku e candidate_sku obrigatórios');
      return [brand, String(r.anchor_sku), String(r.candidate_sku),
        Number(r.co_purchase_count) || 0,
        r.window_start ?? ctx.meta.window_start ?? null,
        r.window_end ?? ctx.meta.window_end ?? null];
    },
  },

  sku_orders: {
    physical: 'sku_orders',
    mode: 'upsert',
    cols: ['brand', 'sku', 'n_orders'],
    conflict: 'ON CONFLICT (brand, sku) DO UPDATE SET n_orders = sku_orders.n_orders + excluded.n_orders',
    map: (r, ctx) => {
      const brand = normBrand(r.brand ?? ctx.meta.brand);
      if (!brand || !r.sku) throw new Error('brand e sku obrigatórios');
      return [brand, String(r.sku), Number(r.n_orders) || 0];
    },
  },

  brand_orders: {
    physical: 'brand_orders',
    mode: 'upsert',
    cols: ['brand', 'n_orders'],
    conflict: 'ON CONFLICT (brand) DO UPDATE SET n_orders = brand_orders.n_orders + excluded.n_orders',
    map: (r, ctx) => {
      const brand = normBrand(r.brand ?? ctx.meta.brand);
      if (!brand) throw new Error('brand obrigatório');
      return [brand, Number(r.n_orders) || 0];
    },
  },
};

async function handleCurate(table, request, db) {
  if (!CURATE_TABLES.has(table)) {
    return json({ error: 'unknown_table', table, allowed: [...CURATE_TABLES] }, 400);
  }
  const body = await readJson(request);
  const rows = Array.isArray(body) ? body : (body.rows || []);
  const meta = Array.isArray(body) ? {} : body;
  if (!Array.isArray(rows)) return json({ error: 'rows_must_be_array' }, 400);

  const now = new Date().toISOString();
  const ctx = { now, meta };
  const errors = [];
  let n = 0;

  if (table === 'prior') {
    for (const r of rows) {
      try { await upsertPrior(db, r); n++; }
      catch (e) { if (errors.length < 10) errors.push({ row: r, error: String(e.message || e) }); }
    }
  } else {
    const spec = SPECS[table];
    const tuples = [];
    for (const r of rows) {
      try { tuples.push(spec.map(r, ctx)); }
      catch (e) { if (errors.length < 10) errors.push({ row: r, error: String(e.message || e) }); }
    }
    n = await bulkInsert(db, spec, tuples);
  }

  await db.run(
    `INSERT INTO load_log (table_name, chunk, rows, window_start, window_end, loaded_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [table, meta.chunk ?? null, n, meta.window_start ?? null, meta.window_end ?? null, now],
  );

  const total = (await db.all(`SELECT COUNT(*) AS n FROM ${physicalTable(table)}`))[0].n;
  return json({ ok: true, table, received: rows.length, applied: n, table_rows: total, errors });
}

async function bulkInsert(db, spec, tuples) {
  if (!tuples.length) return 0;
  const cols = spec.cols;
  const head = spec.mode === 'replace'
    ? `INSERT OR REPLACE INTO ${spec.physical} (${cols.join(', ')}) VALUES `
    : `INSERT INTO ${spec.physical} (${cols.join(', ')}) VALUES `;
  const tail = spec.conflict ? `\n${spec.conflict}` : '';

  let done = 0;
  let buf = [];
  let size = head.length + tail.length;

  const flush = async () => {
    if (!buf.length) return;
    await db.run(head + buf.join(',') + tail, []);
    done += buf.length;
    buf = [];
    size = head.length + tail.length;
  };

  for (const t of tuples) {
    const frag = `(${t.map(sqlLiteral).join(',')})`;
    if (buf.length && size + frag.length + 1 > MAX_SQL_CHARS) await flush();
    buf.push(frag);
    size += frag.length + 1;
  }
  await flush();
  return done;
}

/**
 * Serializa um valor já validado pelo mapper como literal SQL.
 * Só emite NULL, número finito ou string entre aspas com `'` duplicado —
 * qualquer outra coisa (NaN, Infinity, objeto, byte NUL) vira erro em vez de SQL.
 */
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`valor numérico inválido: ${v}`);
    return String(v);
  }
  if (typeof v === 'string') {
    if (v.includes('\u0000')) throw new Error('string com byte NUL');
    return `'${v.replace(/'/g, "''")}'`;
  }
  throw new Error(`tipo não serializável: ${typeof v}`);
}

function physicalTable(t) {
  return t === 'prior' ? 'offer_stats' : (SPECS[t] ? SPECS[t].physical : null);
}

/**
 * Prior do bandit. Duas formas:
 *  • { brand, take_rate, weight }          → prior de toda a marca (brand_config)
 *  • { brand, anchor_sku, offer_sku, ... } → uma linha específica de offer_stats
 */
async function upsertPrior(db, r) {
  const brand = normBrand(r.brand);
  if (!brand) throw new Error('brand obrigatório');
  const rate = Number(r.take_rate);
  const w = Number(r.weight) || 20;
  if (!(rate >= 0 && rate <= 1)) throw new Error('take_rate entre 0 e 1 obrigatório');
  const alpha = rate * w, beta = (1 - rate) * w;

  if (r.anchor_sku && r.offer_sku) {
    await db.run(
      `INSERT INTO offer_stats (brand, anchor_sku, offer_sku, surface, goal, segment,
                                impressions, accepts, prior_alpha, prior_beta)
       VALUES (?,?,?,?,?,?,0,0,?,?)
       ON CONFLICT (brand, anchor_sku, offer_sku, surface, goal, segment)
       DO UPDATE SET prior_alpha = excluded.prior_alpha, prior_beta = excluded.prior_beta`,
      [brand, String(r.anchor_sku), String(r.offer_sku), r.surface || 'cart',
        r.goal || 'aov', r.segment || 'new', alpha, beta],
    );
    return;
  }
  const cur = (await db.all('SELECT * FROM brand_config WHERE brand = ?', [brand]))[0] || {};
  await db.run(
    `INSERT INTO brand_config (brand, margin_floor, max_discount, allow_percent_discount,
       free_shipping_threshold, gap_hard_max, price_cap_ratio, marginal_shipping, tax_rate,
       prior_alpha, prior_beta, slow_moving_days, dead_coverage_days, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (brand) DO UPDATE SET prior_alpha = excluded.prior_alpha,
       prior_beta = excluded.prior_beta, updated_at = excluded.updated_at`,
    [brand, cur.margin_floor ?? null, cur.max_discount ?? null, cur.allow_percent_discount ?? null,
      cur.free_shipping_threshold ?? null, cur.gap_hard_max ?? null, cur.price_cap_ratio ?? null,
      cur.marginal_shipping ?? null, cur.tax_rate ?? null,
      alpha, beta, cur.slow_moving_days ?? null, cur.dead_coverage_days ?? null,
      new Date().toISOString()],
  );
}

async function handleReset(url, db) {
  const table = url.searchParams.get('table');
  const brand = normBrand(url.searchParams.get('brand'));
  const physical = physicalTable(table) || (['affinity', 'sku_orders', 'brand_orders', 'product', 'kit_components', 'offer_stats', 'decision_log'].includes(table) ? table : null);
  if (!physical) return json({ error: 'unknown_table', table }, 400);
  if (brand && physical !== 'decision_log') await db.run(`DELETE FROM ${physical} WHERE brand = ?`, [brand]);
  else await db.run(`DELETE FROM ${physical}`, []);
  const n = (await db.all(`SELECT COUNT(*) AS n FROM ${physical}`))[0].n;
  return json({ ok: true, table: physical, brand: brand || 'all', remaining: n });
}

// ---------------------------------------------------------------------------
// infra
// ---------------------------------------------------------------------------

async function guard(request, env, fn) {
  const token = env.CURATE_TOKEN;
  if (!token) return json({ error: 'curate_token_not_configured' }, 503);
  const auth = request.headers.get('Authorization') || '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!timingSafeEqual(given, token)) return json({ error: 'unauthorized' }, 401);
  return fn();
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function corsHeaders(origin, env) {
  const allowed = (env && env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',') : DEFAULT_ORIGINS)
    .map((s) => s.trim()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && (allowed.includes(origin) || allowed.includes('*') || /\.myshopify\.com$/.test(new URL(origin).hostname))) {
    h['Access-Control-Allow-Origin'] = origin;
  }
  return h;
}

async function readJson(request) {
  try { return (await request.json()) || {}; } catch { return {}; }
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function normBrand(b) { return b ? String(b).trim().toLowerCase() : null; }
function numOrNull(v) { return v === null || v === undefined || v === '' ? null : Number(v); }
function truthy(v) { return v === true || v === 1 || v === '1' || v === 't' || v === 'true'; }
function randomId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

export { runDecision, corsHeaders, normBrand };
