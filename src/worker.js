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
//   GET  /pins?brand    POST /pins    curadoria: fixa produto numa vaga (bearer p/ escrita)
//   POST /pins/delete                 remove regra de curadoria (bearer)
//   POST /curate/:table               carga (bearer)
//   POST /curate/reset?table=         zera antes de recarga (bearer)

import { adaptDb, ensureSchema } from './db.js';
import {
  decide, mergeConfig, functionalKey, round2, DEFAULT_CONFIG,
  parseCollectible, normTax, hashSeed, rngFrom, tsWindow,
  PIN_SPECIFICITY, PIN_TRIGGER_FIELDS, comparePins,
} from './engine.js';

const DEFAULT_ORIGINS = [
  'https://thebarboursbeauty.com.br',
  'https://www.thebarboursbeauty.com.br',
  'https://rituaria.com.br',
  'https://www.rituaria.com.br',
];

const CURATE_TABLES = new Set([
  'product', 'kits', 'affinity', 'sku_orders', 'brand_orders', 'prior', 'pins',
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
  // Rotas de DIAGNÓSTICO, agora atrás do bearer.
  //
  // Eram abertas, e não dava mais para sustentar isso. `/log` devolve, para
  // qualquer um na internet, a margem esperada por produto, o preço, o score e
  // o carrinho de shoppers reais; `/offers` devolve o mesmo por âncora, com a
  // lista de rejeitados; e as duas passaram a carregar o relatório de curadoria
  // — o SKU que a marca quer empurrar e o código interno que o barrou.
  //
  // O `/recommend` é filtrado com cuidado justamente para não publicar isso, e
  // essa proteção era teatro enquanto um GET vizinho entregava tudo. A loja não
  // usa nenhuma das duas: o tema chama só /recommend e /event, que seguem
  // públicos.
  if (p === '/offers' && m === 'GET') return guard(request, env, () => handleOffers(url, db));
  if (p === '/log' && m === 'GET') return guard(request, env, () => handleLog(url, db));
  if (p === '/config' && m === 'GET') return handleGetConfig(url, db);
  if (p === '/config' && m === 'POST') return guard(request, env, () => handleSetConfig(request, db));
  // Curadoria. A leitura também é fechada: é o plano de merchandising da marca
  // mais o estado do estoque. DELETE seria o verbo certo, mas o CORS do app
  // libera GET/POST/OPTIONS, e /curate/reset já firmou esse padrão.
  if (p === '/pins' && m === 'GET') return guard(request, env, () => handleListPins(url, db));
  if (p === '/pins' && m === 'POST') return guard(request, env, () => handleSetPin(request, db));
  if (p === '/pins/delete' && m === 'POST') return guard(request, env, () => handleDeletePin(request, db));
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
  for (const t of ['product', 'kit_components', 'affinity', 'sku_orders', 'brand_orders', 'offer_stats', 'decision_log', 'pin_rule']) {
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
    // Forma explícita, não `...out`: o espalhamento publicava o objeto interno
    // inteiro — a lista de rejeitados, os tempos e, depois desta feature, o
    // relatório de curadoria com cada regra, seu produto e o motivo de não ter
    // agido — numa rota pública e sem debug.
    return json({
      offer_id: out.offer_id,
      offers: [],
      reason: out.reason,
      context: out.context,
      relaxed: out.relaxed.length ? out.relaxed : undefined,
      rejected: out.debug ? out.rejected : undefined,
      pins: pinsPublicaveis(out),
      pins_discarded: out.debug && out.pinsDiscarded.length ? out.pinsDiscarded : undefined,
      timings: out.debug ? out.timings : undefined,
      latency_ms: out.latency_ms,
    }, 200);
  }
  const top = out.offers[0];
  return json({
    offer_id: out.offer_id,
    ...top,
    ttl_seconds: 900,
    offers: n > 1 ? out.offers : undefined,
    context: out.context,
    pins: pinsPublicaveis(out),
    // O descarte só sai em debug: no carrinho ele seria uma lista por regra
    // pausada ou fora de gatilho em TODA requisição, e o tema não usa.
    pins_discarded: out.debug && out.pinsDiscarded.length ? out.pinsDiscarded : undefined,
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
  //
  // É por isso que as regras de curadoria vêm por um LEFT JOIN agregado com
  // ZERO parâmetro, correlacionado por `pr.brand = p.brand`. Um `?` de data ou
  // de `active` ali entraria no meio dessa ordem e zeraria a afinidade sem
  // avisar — e a validade é regra de negócio, que pertence ao engine, testável
  // sem banco. O filtro no SQL é só por marca; o resto `resolvePins` resolve.
  // Agregar por marca (em vez de subquery correlacionada na cláusula SELECT)
  // também evita reavaliar o group_concat nas 241 linhas do catálogo.
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
            pr.wire AS pin_rules,
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
       LEFT JOIN (
         SELECT brand, group_concat(
                  slot         || char(31) || offer_sku    || char(31) ||
                  trigger_type || char(31) || trigger_key  || char(31) ||
                  COALESCE(trigger_field, '') || char(31) ||
                  COALESCE(trigger_value, '') || char(31) ||
                  COALESCE(surface, '*')     || char(31) ||
                  COALESCE(goal, '*')        || char(31) ||
                  active       || char(31) ||
                  COALESCE(starts_at, '')    || char(31) ||
                  COALESCE(ends_at, '')      || char(31) ||
                  priority     || char(31) ||
                  COALESCE(updated_at, ''), char(30)) AS wire
           FROM pin_rule GROUP BY brand
       ) pr ON pr.brand = p.brand
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

  // Curadoria. `no_pins` existe para o simulador do painel mostrar, lado a
  // lado, o ranking com e sem intervenção humana — é o que permite defender ou
  // matar uma regra olhando a tela.
  const pinRules = opts.noPins ? [] : parsePinRules(first && first.pin_rules);

  const ctx = {
    cfg, cartSkus, giftSkus, giftKeys, cartTotal, kitComponentsOf,
    cartKitComponents, gap, thresholdLabel, goal, priceTarget, maxDiscount, anchorProd,
    cartProds, collectible, lineLabels, rndFor,
    pinRules, slots: n, surface, now: new Date().toISOString(),
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
  const { offers, rejected, relaxed, pins, pinsDiscarded } = decide(products, ctx);
  const tDecide = Date.now() - tDecide0;
  const top = offers.slice(0, n).map((o) => (debug ? o : stripDebug(o)));

  // Só os fixados que REALMENTE saíram, e só entre os devolvidos: é o que o
  // /event precisa para separar o braço do bandit. Sem curadoria os campos não
  // aparecem, e o decision_log fica idêntico ao que já era.
  const pinnedSkus = top.filter((o) => o.pinned).map((o) => o.sku);

  const offerId = 'of_' + randomId();
  const context = {
    brand, surface, goal, segment, anchor, cart_total: round2(cartTotal), gap: round2(gap),
    threshold_label: thresholdLabel,
    cart_skus: [...cartSkus], gift_skus: [...giftSkus],
    pool_size: products.length, candidates_after_filters: offers.length,
    ...(pins.length ? { slots: n, pin_rules_matched: pins.length } : {}),
  };
  const decision = top.length
    ? { offer_sku: top[0].sku, variant_id: top[0].variant_id, price: top[0].price,
        final_price: top[0].final_price, incentive: top[0].incentive, score: top[0].score,
        expected_margin: top[0].expected_margin, alternatives: top.slice(1).map((o) => o.sku),
        ...(pins.length ? { pins, pinned_skus: pinnedSkus } : {}) }
    : { offer_sku: null, ...(pins.length ? { pins } : {}) };
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
    offer_id: offerId, offers: top, rejected, relaxed, pins, pinsDiscarded, n,
    context, reason, debug,
    timings: { query_ms: tQuery, decide_ms: tDecide, log_ms: tLog, rows: products.length },
  };
}

function stripDebug(o) { const { _debug, ...rest } = o; return rest; }

/**
 * O relatório de curadoria que pode sair numa rota pública.
 *
 * As entradas `applied: false` são as interessantes para quem opera e as piores
 * para publicar: trazem o SKU que a marca QUERIA empurrar e o código interno que
 * o barrou (`below_margin_floor`, `over_price_cap`, `out_of_stock`). Qualquer
 * shopper enumeraria o plano de merchandising e o estado do estoque.
 *
 * O tema não precisa delas: cada oferta já carrega `pinned`, `slot` e
 * `pin_rule`. Diagnóstico é o `debug: true` e o simulador.
 */
function pinsPublicaveis(out) {
  if (out.debug) return out.pins.length ? out.pins : undefined;
  const aplicados = out.pins.filter((p) => p.applied);
  return aplicados.length ? aplicados : undefined;
}

// Ordem dos campos no `wire` do group_concat. Uma constante só, ao lado da
// query, porque isto é serialização — não decisão. `char(31)` (unit separator)
// e `char(30)` (record separator) não aparecem em SKU nem em rótulo de
// taxonomia, e `pinTuple` recusa na escrita qualquer valor que os contenha —
// que é o único ponto onde dá para avisar alguém. (`sqlLiteral` NÃO cobre isso:
// ele só recusa `\u0000`, e o caminho de /pins nem passa por ele.)
const PIN_WIRE = ['slot', 'offer_sku', 'trigger_type', 'trigger_key', 'trigger_field',
  'trigger_value', 'surface', 'goal', 'active', 'starts_at', 'ends_at', 'priority',
  'updated_at'];
const PIN_WIRE_NUM = new Set(['slot', 'active', 'priority']);
// `trigger_key` fica fora: '' é o valor legítimo do gatilho `always`, e virar
// null aqui faria `pinKey` e a comparação de gatilho lidarem com dois vazios.
const PIN_WIRE_NULLABLE = new Set(['trigger_field', 'trigger_value', 'starts_at',
  'ends_at', 'updated_at']);

function parsePinRules(wire) {
  if (!wire) return [];
  const out = [];
  for (const rec of String(wire).split('\u001e')) {
    if (!rec) continue;
    const parts = rec.split('\u001f');
    // Registro com contagem errada é dado corrompido, não regra: descartar é
    // mais seguro que adivinhar qual campo faltou.
    if (parts.length !== PIN_WIRE.length) continue;
    const r = {};
    PIN_WIRE.forEach((k, i) => {
      const v = parts[i];
      if (PIN_WIRE_NUM.has(k)) r[k] = Number(v);
      else r[k] = PIN_WIRE_NULLABLE.has(k) && v === '' ? null : v;
    });
    out.push(r);
  }
  return out;
}

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

  // `cart=` monta um carrinho de teste com vários itens. Sem isso não dá para
  // simular gatilho taxonômico — que casa contra o carrinho inteiro, não só a
  // âncora — e é justamente o caso mais difícil de acertar de cabeça.
  // Limitado como todo o resto do arquivo (`n` em 50, `limit` em 500): sem teto,
  // uma lista de mil SKUs vira um `IN (?, ?, …)` acima do máximo de variáveis do
  // SQLite, o erro sobe para o catch do topo e o 500 devolve o stack.
  const extras = (q.get('cart') || '').split(',')
    .map((s) => s.trim()).filter(Boolean).filter((s) => s !== anchor);
  const querSkus = [anchor, ...new Set(extras)].slice(0, MAX_CART_SIM);
  const rows = await db.all(
    `SELECT * FROM product WHERE brand = ? AND sku IN (${querSkus.map(() => '?').join(',')})`,
    [brand, ...querSkus],
  );
  const porSku = new Map(rows.map((r) => [r.sku, r]));
  const anchorRow = porSku.get(anchor) || null;
  const cart = querSkus.map((sku) => {
    const r = porSku.get(sku);
    if (r) return { sku, variant_id: r.variant_id, qty: 1, price: r.price };
    // SKU desconhecido só entra com preço quando é a âncora e o chamador o
    // informou; um extra fantasma entra a zero e não distorce o total.
    return { sku, qty: 1, price: sku === anchor ? Number(q.get('anchor_price')) || 0 : 0 };
  });

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
    noPins: q.get('no_pins') === '1',
  });

  return json({
    offer_id: out.offer_id,
    anchor,
    // A âncora é o item de maior valor do carrinho, então `cart=` pode mudá-la.
    // Devolver a efetiva evita o painel afirmar uma coisa e o motor outra.
    anchor_effective: out.context.anchor,
    anchor_known: !!anchorRow,
    anchor_title: anchorRow?.title ?? null,
    cart_skus: querSkus,
    context: out.context,
    relaxed: out.relaxed,
    pins: out.pins,
    // No simulador o descarte sai sempre: é aqui que alguém vai perguntar
    // "por que minha regra não apareceu?". `n` vem junto porque o padrão do
    // /offers é 10 e o da loja é bem menor — uma regra na vaga 3 pode agir aqui
    // e nunca agir lá, e `slot_fora_do_alcance` é o que denuncia isso.
    n: out.n,
    pins_discarded: out.pinsDiscarded,
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

  // Oferta que saiu por curadoria vai para um BRAÇO SEPARADO do bandit:
  // `segment` já é coluna da PK de offer_stats, então a separação sai sem ALTER
  // e sem PK nova — e o LEFT JOIN do /recommend liga o `segment` cru do request,
  // logo as linhas `|pin` nunca voltam para o amostrador.
  //
  // O motivo não é higiene. O pin injeta exposição forçada, quase sempre na
  // vaga 1, que converte melhor por POSIÇÃO e não por mérito. Misturado, um pin
  // de 30 dias deixaria a posterior daquele braço tão dominante que o bandit
  // continuaria escolhendo o mesmo SKU depois da regra expirar: o pin
  // sobreviveria à própria expiração, e desligar a curadoria não mudaria nada.
  const pinnedSkus = Array.isArray(dec.pinned_skus) ? dec.pinned_skus : [];
  const segBase = ctx.segment || 'new';
  const segment = pinnedSkus.includes(offerSku) ? `${segBase}|pin` : segBase;
  const key = [row.brand, ctx.anchor || '', offerSku, ctx.surface || 'cart', ctx.goal || 'aov', segment];
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

// Declarados aqui, e não junto dos handlers de /pins, porque SPECS os lê na
// avaliação do módulo — um `const` mais abaixo cairia na TDZ e o worker nem
// carregaria.
const PIN_COLS = ['brand', 'slot', 'trigger_type', 'trigger_key', 'offer_sku',
  'trigger_field', 'trigger_value', 'surface', 'goal', 'priority', 'active',
  'starts_at', 'ends_at', 'note', 'created_at', 'updated_at'];

const MAX_SLOT = 10; // o teto de `n` em /recommend
const MAX_CART_SIM = 30; // itens do carrinho de teste em /offers?cart=

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

  // Curadoria em lote (o "salvar tudo" do painel). `replace` sobre a chave
  // natural torna o re-push idempotente de graça.
  pins: {
    physical: 'pin_rule',
    mode: 'replace',
    cols: PIN_COLS,
    map: (r, ctx) => pinTuple({ ...r, brand: r.brand ?? ctx.meta.brand }, ctx.now),
  },
};

// ---------------------------------------------------------------------------
// /pins — curadoria manual
// ---------------------------------------------------------------------------

/** Escopo ausente ou vazio vale para todos — nunca undefined na coluna NOT NULL. */
function pinScope(v) {
  const s = v != null ? String(v).trim().toLowerCase() : '';
  return s && s !== '*' ? s : '*';
}

const SIM = new Set(['1', 't', 'true', 'y', 'yes', 's', 'sim', 'v', 'verdadeiro', 'on']);
const NAO = new Set(['0', 'f', 'false', 'n', 'no', 'nao', 'não', 'off']);

/**
 * `active` de uma regra: aceita o vocabulário que uma exportação de planilha
 * realmente produz, e RECUSA o que não reconhece.
 *
 * O `truthy` genérico do arquivo trata tudo que não é `1|t|true` como falso —
 * um lote com `active: "TRUE"` entraria com `applied: N`, `errors: []` e todas
 * as regras pausadas em silêncio. Errar para o lado do erro visível é melhor:
 * a linha ruim vira uma entrada em `errors[]` e alguém conserta.
 */
function pinActive(v) {
  if (v === undefined || v === null || v === '') return 1;
  if (v === true || v === 1) return 1;
  if (v === false || v === 0) return 0;
  const s = String(v).trim().toLowerCase();
  if (SIM.has(s)) return 1;
  if (NAO.has(s)) return 0;
  throw new Error(`active não reconhecido: ${v}`);
}

/**
 * Prioridade: número, ou erro. `Number('alta') || 0` virava 0 em silêncio, e o
 * desempate que o operador configurou simplesmente não se aplicava — com
 * `applied: N` e `errors: []` na resposta dizendo que deu tudo certo.
 */
function pinPriority(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`priority não numérico: ${v}`);
  return Math.round(n);
}

// Os separadores do `wire` do group_concat. Um SKU ou rótulo que os contenha
// produziria um registro com contagem de campos errada, e `parsePinRules` o
// descartaria em silêncio — a regra sumiria de todo /recommend sem erro.
// Recusar na escrita é o único ponto em que dá para avisar alguém.
const SEPARADORES = /[\u001e\u001f]/;

function semSeparador(v, campo) {
  if (v != null && SEPARADORES.test(String(v))) {
    throw new Error(`${campo} contém caractere de controle reservado`);
  }
  return v;
}

/**
 * Data → instante ISO em UTC, com o dia interpretado em BRT.
 *
 * Uma data pura como fim de vigência TEM que virar o FIM do dia: comparar
 * '2026-12-31' com um ISO completo é falso a partir de 00:00:00Z, e a campanha
 * morreria no próprio dia em que deveria valer. Normalizado aqui, na escrita,
 * porque `resolvePins` compara string e precisa de um formato só.
 */
function pinInstant(v, borda) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  let iso;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    iso = `${s}T${borda === 'fim' ? '23:59:59.999' : '00:00:00.000'}-03:00`;
  } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) {
    // `datetime-local` do HTML manda exatamente isto, sem fuso. Entregue cru ao
    // `new Date`, seria lido no fuso do HOST — o mesmo texto viraria instantes
    // diferentes gravado do Worker (UTC) ou da máquina de quem opera (BRT), e
    // "31/12 23:59" morreria às 20:59 do dia 31. Quem escreve pensa em BRT.
    iso = `${s.replace(' ', 'T')}-03:00`;
  } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    iso = s.replace(' ', 'T'); // fuso explícito: respeita-se como veio
  } else {
    // Recusar, não adivinhar. Assumir "já traz fuso" aceitava "12/31/2026" — que
    // o `new Date` lê no fuso do HOST, o bug que este função existe para evitar —
    // e "2026-12" ou "2026", que viram 1º de janeiro e expiram a campanha meses
    // antes, sem erro nenhum.
    throw new Error(`data em formato não reconhecido: ${v} (use AAAA-MM-DD, AAAA-MM-DDTHH:MM, ou ISO com fuso)`);
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`data inválida: ${v}`);
  return d.toISOString();
}

/**
 * Valida e normaliza uma regra de curadoria, devolvendo a tupla de PIN_COLS.
 * Lança com mensagem legível: o mapper de lote transforma isso em `errors[]`
 * por linha, sem derrubar o resto da carga.
 */
function pinTuple(r, now) {
  const brand = normBrand(r.brand);
  if (!brand) throw new Error('brand obrigatório');

  const slot = Math.round(Number(r.slot));
  if (!(slot >= 1 && slot <= MAX_SLOT)) {
    throw new Error(`slot entre 1 e ${MAX_SLOT} obrigatório`);
  }

  const tipo = String(r.trigger_type ?? '').trim().toLowerCase();
  if (!Object.hasOwn(PIN_SPECIFICITY, tipo)) {
    throw new Error(`trigger_type inválido: ${r.trigger_type} (use ${Object.keys(PIN_SPECIFICITY).join(', ')})`);
  }

  const offerSku = semSeparador(
    r.offer_sku != null ? String(r.offer_sku).trim() : '', 'offer_sku',
  );
  if (!offerSku) throw new Error('offer_sku obrigatório');

  let field = null;
  let value = null;
  let key = '';
  if (tipo === 'sku') {
    key = semSeparador(String(r.trigger_sku ?? r.trigger_key ?? '').trim(), 'trigger_sku');
    if (!key) throw new Error('trigger_sku obrigatório quando trigger_type=sku');
  } else if (tipo === 'taxonomy') {
    field = String(r.trigger_field ?? '').trim().toLowerCase();
    if (!PIN_TRIGGER_FIELDS.includes(field)) {
      throw new Error(`trigger_field deve ser ${PIN_TRIGGER_FIELDS.join(', ')}`);
    }
    // Gravado já normalizado: no seed medido, BODY SPLASH e Body Splash são a
    // mesma subcategoria. E "Não se aplica" é sentinela de ausência, não valor —
    // normTax devolve vazio e a regra é recusada aqui, não em produção.
    value = semSeparador(normTax(r.trigger_value), 'trigger_value');
    if (!value) throw new Error('trigger_value vazio ou sem significado taxonômico');
    key = `${field}=${value}`;
  }

  return [brand, slot, tipo, key, offerSku, field, value,
    semSeparador(pinScope(r.surface), 'surface'),
    semSeparador(pinScope(r.goal), 'goal'),
    pinPriority(r.priority),
    pinActive(r.active),
    pinInstant(r.starts_at, 'inicio'),
    pinInstant(r.ends_at, 'fim'),
    r.note != null ? String(r.note) : null,
    r.created_at ?? now, now];
}

/** Chave natural a partir de um corpo de request, para upsert e delete. */
function pinNaturalKey(body) {
  const tipo = String(body.trigger_type ?? '').trim().toLowerCase();
  if (tipo === 'sku') return String(body.trigger_sku ?? body.trigger_key ?? '').trim();
  if (tipo === 'taxonomy') {
    return `${String(body.trigger_field ?? '').trim().toLowerCase()}=${normTax(body.trigger_value)}`;
  }
  return '';
}

async function handleListPins(url, db) {
  const q = url.searchParams;
  const brand = normBrand(q.get('brand'));
  const where = [];
  const params = [];
  if (brand) { where.push('r.brand = ?'); params.push(brand); }
  const slotQ = q.get('slot');
  if (slotQ) {
    // Sem validar, `?slot=primeira` liga NaN, não casa com nada e a resposta é
    // um `count: 0` tranquilo — dizendo ao operador que a vaga está livre
    // enquanto a regra segue no ar fixando o carrinho.
    const s = Number(slotQ);
    if (!Number.isFinite(s) || s < 1 || s > MAX_SLOT) {
      return json({ error: 'invalid_slot', slot: slotQ }, 400);
    }
    where.push('r.slot = ?');
    params.push(Math.round(s));
  }
  const activeQ = q.get('active');
  if (activeQ != null && activeQ !== '') {
    // O mesmo vocabulário da escrita. Com o `truthy` genérico, `?active=sim`
    // virava `active = 0` e o painel pedia as regras no ar e recebia as
    // pausadas — a resposta mais enganosa possível para quem opera.
    let v;
    try { v = pinActive(activeQ); } catch {
      return json({ error: 'invalid_active', active: activeQ }, 400);
    }
    where.push('r.active = ?');
    params.push(v);
  }

  const rows = await db.all(
    `SELECT r.*, p.sku AS catalogo_sku, p.title AS offer_title, p.price AS offer_price,
            p.available AS offer_available
       FROM pin_rule r
       LEFT JOIN product p ON p.brand = r.brand AND p.sku = r.offer_sku
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.brand, r.slot`,
    params,
  );

  // A ordem dentro da vaga é a da DISPUTA, e vem do próprio comparador do
  // engine — reescrevê-la em SQL criaria uma segunda versão da precedência que
  // divergiria. Ordenar por `priority DESC` aqui, por exemplo, mostrava um
  // `always` de prioridade 99 acima do `sku` que realmente vence, ensinando ao
  // operador exatamente o modelo mental errado.
  rows.sort((a, b) => (
    String(a.brand).localeCompare(String(b.brand))
    || a.slot - b.slot
    || comparePins(a, b)
  ));

  // O estado calculado vai junto: sem ele o painel teria que reimplementar a
  // regra de validade em JavaScript e as duas versões divergiriam.
  const now = new Date().toISOString();
  return json({
    count: rows.length,
    now,
    rules: rows.map((r) => {
      const expirada = !!(r.ends_at && String(r.ends_at) < now);
      const naoComecou = !!(r.starts_at && String(r.starts_at) > now);
      const { catalogo_sku: catalogo, ...regra } = r;
      return {
        ...regra,
        expired: expirada,
        not_started: naoComecou,
        effective: Number(r.active) === 1 && !expirada && !naoComecou,
        // Pela CHAVE do join, nunca por `title`: a coluna é anulável e vem de
        // carga de planilha, então um produto sem título viraria "regra
        // apontando para SKU que não existe" na cara do operador.
        offer_in_catalog: catalogo != null,
      };
    }),
  });
}

/** A linha existente que este corpo identifica, ou null. */
async function pinAtual(db, body) {
  const brand = normBrand(body.brand);
  const slot = Number(body.slot);
  const tipo = String(body.trigger_type ?? '').trim().toLowerCase();
  if (!brand || !Number.isFinite(slot) || !tipo) return null;
  return (await db.all(
    'SELECT * FROM pin_rule WHERE brand=? AND slot=? AND trigger_type=? AND trigger_key=?',
    [brand, Math.round(slot), tipo, pinNaturalKey(body)],
  ))[0] || null;
}

/**
 * Colunas editáveis numa atualização parcial, cada uma com sua normalização.
 * O gatilho e a vaga ficam de fora de propósito: mudá-los muda a identidade da
 * regra, e isso é criar outra — não editar esta.
 */
const PIN_EDITAVEL = {
  offer_sku: (v) => {
    const s = semSeparador(v != null ? String(v).trim() : '', 'offer_sku');
    if (!s) throw new Error('offer_sku não pode ficar vazio');
    return s;
  },
  surface: (v) => semSeparador(pinScope(v), 'surface'),
  goal: (v) => semSeparador(pinScope(v), 'goal'),
  priority: pinPriority,
  // NÃO é o `pinActive` da criação. Lá, ausente vale 1 — é o default de uma
  // regra nova. Aqui, `""` ou `null` é o que um formulário manda quando o campo
  // não foi tocado, e cair no default de 1 REATIVA uma regra pausada em
  // silêncio, colocando a oferta de volta na frente do shopper.
  active: (v) => {
    if (v === '' || v === null) throw new Error('active vazio: envie 0 ou 1, ou omita o campo');
    return pinActive(v);
  },
  starts_at: (v) => pinInstant(v, 'inicio'),
  ends_at: (v) => pinInstant(v, 'fim'),
  note: (v) => (v != null ? String(v) : null),
};

async function handleSetPin(request, db) {
  const body = await readJson(request);
  const agora = new Date().toISOString();
  const atual = await pinAtual(db, body);

  let row;
  if (atual) {
    // Edição PARCIAL e atômica. Um `INSERT OR REPLACE` da linha mesclada em
    // memória perderia a escrita concorrente de outra aba — e como é a mescla
    // que torna `{"active": 0}` seguro, a escrita perdida seria uma pausa
    // silenciosamente revertida, não um campo velho.
    const cols = [];
    const vals = [];
    try {
      for (const [k, norm] of Object.entries(PIN_EDITAVEL)) {
        if (body[k] === undefined) continue;
        cols.push(k);
        vals.push(norm(body[k]));
      }
    } catch (e) {
      return json({ error: 'invalid_rule', detail: String(e.message || e) }, 400);
    }
    if (!cols.length) return json({ error: 'nothing_to_update' }, 400);

    cols.push('updated_at');
    vals.push(agora);
    await db.run(
      `UPDATE pin_rule SET ${cols.map((c) => `${c} = ?`).join(', ')}
        WHERE brand=? AND slot=? AND trigger_type=? AND trigger_key=?`,
      [...vals, atual.brand, atual.slot, atual.trigger_type, atual.trigger_key],
    );
    row = (await db.all(
      'SELECT * FROM pin_rule WHERE brand=? AND slot=? AND trigger_type=? AND trigger_key=?',
      [atual.brand, atual.slot, atual.trigger_type, atual.trigger_key],
    ))[0];
  } else {
    let tuple;
    try {
      tuple = pinTuple(body, agora);
    } catch (e) {
      return json({ error: 'invalid_rule', detail: String(e.message || e) }, 400);
    }
    await db.run(
      `INSERT OR REPLACE INTO pin_rule (${PIN_COLS.join(', ')})
       VALUES (${PIN_COLS.map(() => '?').join(', ')})`,
      tuple,
    );
    row = (await db.all(
      'SELECT * FROM pin_rule WHERE brand=? AND slot=? AND trigger_type=? AND trigger_key=?',
      [tuple[0], tuple[1], tuple[2], tuple[3]],
    ))[0];
  }

  // A regra pode ter sumido entre a escrita e a releitura — outra aba no
  // /pins/delete, ou um /curate/reset. Sem esta guarda, `row.brand` estoura um
  // TypeError que o catch do topo devolve como 500 COM stack, e o operador
  // recebe um rastro de pilha em vez de uma resposta. O 404 do delete existe
  // pela mesma razão: desfecho ambíguo aqui é justamente o que não pode haver.
  if (!row) {
    return json({ error: 'rule_vanished', detail: 'a regra foi removida durante a escrita' }, 409);
  }

  // Não recusar SKU fora do catálogo: a ordem de carga não é garantida e a
  // regra pode chegar antes do produto. Mas avisar, porque regra apontando para
  // SKU fantasma é regra que nunca vai aparecer. Vale para o gatilho também: o
  // casamento por SKU é exato, então um código com a caixa errada nunca dispara
  // e sai como `gatilho_nao_casou`, indistinguível de carrinho que não bate.
  const warnings = [];
  const noCatalogo = async (sku) => (await db.all(
    'SELECT 1 AS ok FROM product WHERE brand=? AND sku=?', [row.brand, sku],
  ))[0];
  if (!await noCatalogo(row.offer_sku)) {
    warnings.push(`offer_sku ${row.offer_sku} não está no catálogo de ${row.brand}`);
  }
  if (row.trigger_type === 'sku' && !await noCatalogo(row.trigger_key)) {
    warnings.push(`trigger_sku ${row.trigger_key} não está no catálogo de ${row.brand} — o casamento é exato, confira a grafia`);
  }

  // A vaga faz parte da identidade, então "mover de vaga" na verdade CRIA outra
  // regra e deixa a antiga no ar. Pior: a desduplicação por produto faz a vaga
  // MENOR vencer, então a regra antiga continua mandando e a edição parece não
  // ter surtido efeito nenhum.
  const gemeas = await db.all(
    `SELECT slot FROM pin_rule
      WHERE brand=? AND trigger_type=? AND trigger_key=? AND offer_sku=? AND slot<>?
      ORDER BY slot`,
    [row.brand, row.trigger_type, row.trigger_key, row.offer_sku, row.slot],
  );
  if (gemeas.length) {
    const vagas = gemeas.map((g) => g.slot).join(', ');
    warnings.push(`a mesma regra também existe na vaga ${vagas}; a vaga menor vence, apague a antiga para mover`);
  }

  return json({ ok: true, created: !atual, stored: row, warnings });
}

async function handleDeletePin(request, db) {
  const body = await readJson(request);
  const brand = normBrand(body.brand);
  if (!brand) return json({ error: 'brand_required' }, 400);

  const slot = body.slot != null && body.slot !== '' ? Math.round(Number(body.slot)) : null;
  if (slot != null && !(slot >= 1 && slot <= MAX_SLOT)) {
    return json({ error: 'invalid_slot', slot: body.slot }, 400);
  }

  // String vazia é ausência, não "tipo vazio". Um formulário que sempre envia o
  // campo cairia no ramo de regra única e rodaria um DELETE que não casa com
  // nada — devolvendo ok enquanto a regra segue no ar, fixando a vaga.
  const tipo = body.trigger_type != null && String(body.trigger_type).trim() !== ''
    ? String(body.trigger_type).trim().toLowerCase()
    : null;

  let escopo;
  let onde;
  let params;
  if (tipo) {
    if (slot == null) return json({ error: 'slot_required_with_trigger_type' }, 400);
    if (!Object.hasOwn(PIN_SPECIFICITY, tipo)) {
      return json({ error: 'invalid_trigger_type', trigger_type: body.trigger_type }, 400);
    }
    escopo = 'regra';
    onde = 'brand=? AND slot=? AND trigger_type=? AND trigger_key=?';
    params = [brand, slot, tipo, pinNaturalKey(body)];
  } else if (slot != null) {
    escopo = 'vaga';
    onde = 'brand=? AND slot=?';
    params = [brand, slot];
  } else {
    return json({ error: 'slot_or_trigger_type_required' }, 400);
  }

  // Conta ANTES de apagar, em vez de confiar no contador do driver. Nem todo
  // driver devolve linhas afetadas, e um `null` tratado como sucesso recria
  // exatamente o desfecho que o 404 existe para evitar: o operador acredita que
  // removeu, e a regra continua decidindo o carrinho.
  const alvo = (await db.all(`SELECT COUNT(*) AS n FROM pin_rule WHERE ${onde}`, params))[0].n;
  if (!alvo) {
    return json({ error: 'rule_not_found', brand, slot, scope: escopo }, 404);
  }
  await db.run(`DELETE FROM pin_rule WHERE ${onde}`, params);

  const n = (await db.all(
    'SELECT COUNT(*) AS n FROM pin_rule WHERE brand = ?', [brand],
  ))[0].n;
  return json({ ok: true, brand, scope: escopo, deleted: Number(alvo), remaining: n });
}

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
  const physical = physicalTable(table) || (['affinity', 'sku_orders', 'brand_orders', 'product', 'kit_components', 'offer_stats', 'decision_log', 'pin_rule'].includes(table) ? table : null);
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
