// engine.js — núcleo determinístico do go-offer-engine.
// Zero I/O, zero dependência: recebe objetos simples, devolve decisão + motivo.
// Tudo que decide oferta mora aqui para poder ser testado sem banco e sem rede.

// ---------------------------------------------------------------------------
// Configuração por marca (defaults; sobrescritos pela tabela brand_config)
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
  margin_floor: 0.30,            // piso de margem pós-incentivo (beauty)
  max_discount: 0.15,            // teto do degrau 4 da escada
  allow_percent_discount: 0,     // POC: checkout Yampi não aplica % — degrau 4 desligado
  free_shipping_threshold: null, // R$; null = tema manda o gap no request
  gap_hard_max: 30,              // até este gap a faixa [gap, 3×gap] é filtro duro
  price_cap_ratio: 0.6,          // teto de preço da oferta sobre o carrinho
  marginal_shipping: 0,          // R$/unidade — estimativa por marca (P5)
  tax_rate: 0.10,                // estimativa por marca (P5)
  prior_alpha: 0.98,             // take rate histórico de order bump × peso 10
  prior_beta: 9.02,
  slow_moving_days: 180,
  dead_coverage_days: 1800,  // cobertura em que a urgência satura em 2,0
};

export function mergeConfig(row) {
  const cfg = { ...DEFAULT_CONFIG };
  if (!row) return cfg;
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (row[k] !== undefined && row[k] !== null) cfg[k] = row[k];
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Filtros duros — rodam antes do score, sem exceção.
// Cada rejeição devolve um código legível que vai para o decision_log.
// ---------------------------------------------------------------------------

/**
 * @param {object} cand        linha de `product`
 * @param {object} ctx         { cartSkus:Set, giftSkus:Set, giftKeys:Set, cartTotal,
 *                               kitComponentsOf:Map<kit,Set<comp>>,
 *                               cartKitComponents:Set, gap, goal, priceTarget, cfg }
 * @returns {null|{code:string, detail?:string}} null = passou
 */
export function hardFilterReject(cand, ctx) {
  const cfg = ctx.cfg;

  // R1a — o próprio SKU já está no carrinho
  if (ctx.cartSkus.has(cand.sku)) return { code: 'sku_in_cart' };

  // R1b — kit que contém qualquer SKU do carrinho  (caso RT01008 → KRT99078)
  const comps = ctx.kitComponentsOf.get(cand.sku);
  if (comps) {
    for (const c of comps) {
      if (ctx.cartSkus.has(c)) {
        return { code: 'kit_contains_cart_sku', detail: `${cand.sku}⊃${c}` };
      }
    }
  }

  // R1c — SKU que compõe um kit já presente no carrinho
  if (ctx.cartKitComponents.has(cand.sku)) {
    return { code: 'component_of_cart_kit' };
  }

  // R2 — item que já está como brinde no carrinho, ou equivalente funcional
  if (ctx.giftSkus.has(cand.sku)) return { code: 'sku_is_gift' };
  if (ctx.giftKeys.size && ctx.giftKeys.has(functionalKey(cand))) {
    return { code: 'gift_functional_equivalent' };
  }

  // R5 — estoque. `available` já vem líquido de safety_stock e committed (Cosmos).
  // Não aplicar estoque de segurança de novo: descontaria duas vezes.
  if (!(cand.available > 0)) return { code: 'out_of_stock' };

  // Sem preço ou sem custo o motor não tem piso de margem — fora do pool.
  if (!(cand.price > 0)) return { code: 'no_price' };
  if (cand.cogs === null || cand.cogs === undefined) return { code: 'no_cogs' };
  if (!cand.variant_id) return { code: 'no_variant_id' };

  // R4 — teto de 60% do carrinho, salvo goal=margin com price_target explícito
  const capExempt = ctx.goal === 'margin' && ctx.priceTarget != null;
  if (!capExempt && ctx.cartTotal > 0 && cand.price > cfg.price_cap_ratio * ctx.cartTotal) {
    return { code: 'over_price_cap' };
  }

  return null;
}

/** Equivalência funcional aproximada (P6): linha + subcategoria. Heurística declarada. */
export function functionalKey(p) {
  return `${(p.line || '').toLowerCase()}|${(p.subcategory || '').toLowerCase()}`;
}

/** R3 — faixa de preço que fecha o gap do threshold. */
export function inGapBand(price, gap) {
  return gap > 0 && price >= gap && price <= 3 * gap;
}

// ---------------------------------------------------------------------------
// Fatores do score
// ---------------------------------------------------------------------------

/** afinidade 0–1: co-compra encolhida para a regra quando há pouco dado. */
export function affinityScore({ co = 0, anchorOrders = 0, candOrders = 0, brandOrders = 0 }, anchorProd, cand) {
  const rule = ruleAffinity(anchorProd, cand);
  if (!co || !anchorOrders || !brandOrders) return clamp01(rule);

  const pBgivenA = co / anchorOrders;
  const pB = candOrders && brandOrders ? candOrders / brandOrders : 0;
  const lift = pB > 0 ? pBgivenA / pB : 0;

  const dataAff = 0.5 * Math.min(1, pBgivenA / 0.10) + 0.5 * Math.min(1, lift / 5);
  const w = co / (co + 3); // shrinkage: 3 co-compras ≈ metade do peso
  return clamp01(w * dataAff + (1 - w) * rule);
}

export function ruleAffinity(a, b) {
  if (!a || !b) return 0.20;
  if (a.line && b.line && a.line === b.line) return 1.0;
  if (a.subcategory && b.subcategory && a.subcategory === b.subcategory) return 0.7;
  if (a.category && b.category && a.category === b.category) return 0.5;
  return 0.2;
}

/**
 * Urgência de estoque 0–2 (handoff). 0 é impossível aqui: available>0 é filtro duro.
 *
 * O handoff define 1,5 para cobertura > 180 d. Medido no pool real, 184 dos 241
 * SKUs passam de 180 d (mediana 678 d), então o degrau fixo colocaria 76% do pool
 * no mesmo valor e o goal=stock deixaria de ordenar. A regra vira uma rampa que
 * mantém os dois pontos do handoff — 1,5 no limiar, 2,0 no estoque morto — e
 * discrimina no meio. `dead_coverage_days` é ajustável por marca.
 */
export function stockUrgency(cand, cfg) {
  const st = (cand.stock_status || '').toLowerCase();
  if (st === 'dead' || st === 'discontinued') return 2.0;
  const cov = cand.coverage_days;
  if (cov == null || cov <= cfg.slow_moving_days) return 1.0;
  const top = cfg.dead_coverage_days || 1800;
  const ramp = Math.min(1, (cov - cfg.slow_moving_days) / Math.max(1, top - cfg.slow_moving_days));
  return 1.5 + 0.5 * ramp;
}

/** margem líquida pós-incentivo. Frete marginal e imposto são estimativa por marca (P5). */
export function marginPostIncentive(cand, finalPrice, cfg) {
  if (!(finalPrice > 0)) return 0;
  const net = finalPrice - cand.cogs - cfg.marginal_shipping - cfg.tax_rate * finalPrice;
  return net / finalPrice;
}

/** espaço de desconto sem furar o piso (price_room do handoff). */
export function priceRoom(cand, cfg) {
  const denom = 1 - cfg.tax_rate - cfg.margin_floor;
  if (denom <= 0) return { floor_price: cand.price, room_abs: 0, room_pct: 0 };
  const floorPrice = (cand.cogs + cfg.marginal_shipping) / denom;
  const roomAbs = Math.max(0, cand.price - floorPrice);
  return { floor_price: floorPrice, room_abs: roomAbs, room_pct: cand.price > 0 ? roomAbs / cand.price : 0 };
}

// Pesos por goal, como expoentes sobre os quatro fatores.
export const GOAL_WEIGHTS = {
  aov:    { aff: 1.0, margin: 0.3, urgency: 0.3, take: 1.0 },
  stock:  { aff: 0.3, margin: 1.0, urgency: 1.0, take: 0.3 },
  margin: { aff: 0.3, margin: 1.0, urgency: 0.3, take: 1.0 },
};

export function scoreOf({ aff, margin, urgency, take, goal, gapBonus = 1 }) {
  const w = GOAL_WEIGHTS[goal] || GOAL_WEIGHTS.aov;
  const f = (x, e) => Math.pow(Math.max(x, 1e-6), e);
  return f(aff, w.aff) * f(margin, w.margin) * f(urgency / 2, w.urgency) * f(take, w.take) * gapBonus;
}

// ---------------------------------------------------------------------------
// Escada de incentivo — sempre o menor degrau que converte.
// Degrau 4 (% off) fica desligado enquanto o checkout Yampi não aplicar desconto.
// ---------------------------------------------------------------------------

export function incentiveLadder(cand, ctx) {
  const cfg = ctx.cfg;
  const gap = ctx.gap || 0;

  // Degrau 2 — a própria oferta fecha o gap do benefício: incentivo sem custo.
  // O rótulo vem do tema (`threshold.label`), porque o benefício nem sempre é
  // frete grátis — pode ser 3x sem juros ou brinde por faixa.
  if (gap > 0 && cand.price >= gap) {
    const label = ctx.thresholdLabel || 'frete grátis';
    return {
      incentive: { type: 'threshold', value: 0, label },
      final_price: cand.price,
      step: 2,
      reason: `fecha o gap de R$ ${gap.toFixed(2)} para ${label}`,
    };
  }

  // Degrau 3 — brinde de slow moving não é decidido aqui (precisa de ticket mínimo
  // e de regra de validade, P4). Fica para o goal=stock com flag explícita.

  // Degrau 4 — % off, só se a marca habilitar e houver espaço até o piso.
  if (cfg.allow_percent_discount && ctx.maxDiscount > 0) {
    const room = priceRoom(cand, cfg);
    const pct = Math.min(ctx.maxDiscount, cfg.max_discount, room.room_pct);
    if (pct >= 0.05) {
      const finalPrice = round2(cand.price * (1 - pct));
      return {
        incentive: { type: 'percent', value: Math.round(pct * 100) },
        final_price: finalPrice,
        step: 4,
        reason: `desconto de ${Math.round(pct * 100)}% dentro do piso de margem`,
      };
    }
  }

  // Degrau 1 — preço cheio.
  return {
    incentive: { type: 'none', value: 0 },
    final_price: cand.price,
    step: 1,
    reason: 'preço cheio',
  };
}

// ---------------------------------------------------------------------------
// Copy determinístico por regra (AI Proxy é roadmap; não bloqueia)
// ---------------------------------------------------------------------------

export function buildCopy(cand, { anchorProd, gap, incentive, urgency }) {
  const title = cand.title || cand.sku;
  if (incentive.type === 'threshold') {
    return `Leve ${title} e ganhe ${incentive.label || 'frete grátis'}`;
  }
  if (incentive.type === 'percent') {
    return `${title} com ${incentive.value}% off só agora`;
  }
  if (anchorProd && anchorProd.line && anchorProd.line === cand.line) {
    return `Completa sua rotina ${anchorProd.line}: ${title}`;
  }
  if (urgency >= 1.5) {
    return `Últimas unidades: ${title}`;
  }
  return `Quem levou esse também levou ${title}`;
}

export function buildReason(parts) {
  return parts.filter(Boolean).join('; ');
}

// ---------------------------------------------------------------------------
// Thompson Sampling
// ---------------------------------------------------------------------------

export function sampleBeta(alpha, beta, rnd = Math.random) {
  const x = sampleGamma(Math.max(alpha, 1e-6), rnd);
  const y = sampleGamma(Math.max(beta, 1e-6), rnd);
  return x + y === 0 ? 0 : x / (x + y);
}

function sampleGamma(k, rnd) {
  if (k < 1) return sampleGamma(k + 1, rnd) * Math.pow(rnd() || 1e-12, 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      x = gaussian(rnd);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rnd();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function gaussian(rnd) {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// Decisão completa
// ---------------------------------------------------------------------------

/**
 * Ranqueia candidatos já carregados do banco.
 * Não toca em I/O: quem chama monta `ctx` a partir do SQLite.
 *
 * @returns {{ offers: object[], rejected: object[], relaxed: string[] }}
 */
export function decide(candidates, ctx) {
  const cfg = ctx.cfg;
  const rejected = [];
  const relaxed = [];

  // 1) filtros duros
  let pool = [];
  for (const cand of candidates) {
    const rej = hardFilterReject(cand, ctx);
    if (rej) { rejected.push({ sku: cand.sku, ...rej }); continue; }
    pool.push(cand);
  }

  // 2) faixa de gap como filtro duro — relaxa se esvaziar o pool, e registra
  if (ctx.gap > 0 && ctx.gap <= cfg.gap_hard_max) {
    const banded = pool.filter((c) => inGapBand(c.price, ctx.gap));
    if (banded.length) pool = banded;
    else relaxed.push('gap_band');
  }

  // 3) score
  const scored = [];
  for (const cand of pool) {
    const ladder = incentiveLadder(cand, ctx);
    const margin = marginPostIncentive(cand, ladder.final_price, cfg);

    if (margin < cfg.margin_floor) {
      rejected.push({ sku: cand.sku, code: 'below_margin_floor', detail: margin.toFixed(3) });
      continue;
    }

    const stats = ctx.statsOf(cand.sku);
    const aff = affinityScore(ctx.affinityOf(cand.sku), ctx.anchorProd, cand);
    const urgency = stockUrgency(cand, cfg);
    const take = sampleBeta(
      (stats.prior_alpha ?? cfg.prior_alpha) + stats.accepts,
      (stats.prior_beta ?? cfg.prior_beta) + Math.max(0, stats.impressions - stats.accepts),
      ctx.rnd,
    );
    const gapBonus = inGapBand(cand.price, ctx.gap) ? 1.35 : 1;
    const score = scoreOf({ aff, margin, urgency, take, goal: ctx.goal, gapBonus });

    scored.push({
      sku: cand.sku,
      variant_id: cand.variant_id,
      product_id: cand.product_id,
      title: cand.title,
      image_url: cand.image_url,
      url: cand.url,
      is_kit: !!cand.is_kit,
      price: round2(cand.price),
      incentive: ladder.incentive,
      final_price: round2(ladder.final_price),
      incentive_step: ladder.step,
      expected_margin: round4(margin),
      stock_coverage_days: cand.coverage_days ?? null,
      available: cand.available,
      affinity_score: round4(aff),
      stock_urgency: urgency,
      take_rate_sampled: round4(take),
      score: round6(score),
      copy: buildCopy(cand, { anchorProd: ctx.anchorProd, gap: ctx.gap, incentive: ladder.incentive, urgency }),
      reason: buildReason([
        ladder.reason,
        aff >= 0.7 ? 'afinidade alta com o carrinho' : null,
        urgency >= 1.5 ? `estoque com ${Math.round(cand.coverage_days || 0)} dias de cobertura` : null,
        `margem ${(margin * 100).toFixed(0)}%`,
      ]),
      _debug: {
        affinity: ctx.affinityOf(cand.sku),
        stats,
        gap_band: inGapBand(cand.price, ctx.gap),
      },
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return { offers: scored, rejected, relaxed };
}

// ---------------------------------------------------------------------------

export const round2 = (n) => Math.round(n * 100) / 100;
export const round4 = (n) => Math.round(n * 1e4) / 1e4;
export const round6 = (n) => Math.round(n * 1e6) / 1e6;
export const clamp01 = (n) => Math.min(1, Math.max(0, n));
