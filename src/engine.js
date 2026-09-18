// engine.js — núcleo determinístico do go-offer-engine.
// Zero I/O, zero dependência: recebe objetos simples, devolve decisão + motivo.
// Tudo que decide oferta mora aqui para poder ser testado sem banco e sem rede.

// ---------------------------------------------------------------------------
// Configuração por marca (defaults; sobrescritos pela tabela brand_config)
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
  margin_floor: 0.30,            // piso de margem pós-incentivo (beauty)
  min_price: 15,                 // §3.1: abaixo disso não é oferta, é ruído
  max_discount: 0.15,            // teto do degrau 4 da escada
  allow_percent_discount: 0,     // POC: checkout Yampi não aplica % — degrau 4 desligado
  free_shipping_threshold: null, // R$; null = tema manda o gap no request
  gap_hard_max: 40,              // §2.11: gap ativo até min(40, ratio × carrinho)
  gap_hard_max_ratio: 0.30,
  price_cap_ratio: 0.6,          // teto de preço da oferta sobre o carrinho
  marginal_shipping: 0,          // R$/unidade — estimativa por marca (P5)
  tax_rate: 0.10,                // estimativa por marca (P5)
  prior_alpha: 0.98,             // take rate histórico de order bump × peso 10
  prior_beta: 9.02,
  slow_moving_days: 180,
  dead_coverage_days: 1800,      // cobertura em que a urgência satura em 2,0
  // Chave mestra da urgência de estoque. Enquanto o `available` vier da fonte
  // que a especificação proíbe (§1), NENHUMA cobertura é confiável — e desligar
  // aqui é mais honesto que empurrar `slow_moving_days` para 100000, porque
  // também cobre o atalho de `stock_status: dead`, que ignora a cobertura.
  stock_urgency_enabled: 1,
  low_stock_units: 500,          // acima disso "Últimas unidades" é mentira
  // Categorias em que variedade é compra legítima (§2.8): mesma subcategoria
  // vale 0,40 em vez dos 0,10 de substituto. Lista separada por vírgula.
  collectible_categories: null,
  // Mapa linha interna → rótulo público, JSON. Sem rótulo o copy cai no
  // genérico: é o que impede "Completa sua rotina INSPIRADOS" de sair.
  line_labels: null,
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
  //
  // Duas sobreposições, não uma. `cartSkus` com um KIT no carrinho contém só o
  // SKU do kit, então comparar apenas contra ele deixa passar o kit vizinho que
  // divide componente — o cliente recebe metade do que já comprou. `kit ∩ kit`
  // ganha código próprio para o decision_log poder separar os dois casos.
  const comps = ctx.kitComponentsOf.get(cand.sku);
  if (comps) {
    for (const c of comps) {
      if (ctx.cartSkus.has(c)) {
        return { code: 'kit_contains_cart_sku', detail: `${cand.sku}⊃${c}` };
      }
      if (ctx.cartKitComponents.has(c)) {
        return { code: 'kit_overlaps_cart_kit', detail: `${cand.sku}⊃${c}` };
      }
    }
  }

  // R1c — SKU que compõe um kit já presente no carrinho
  if (ctx.cartKitComponents.has(cand.sku)) {
    return { code: 'component_of_cart_kit', detail: cand.sku };
  }

  // R2 — item que já está como brinde no carrinho, ou equivalente funcional
  if (ctx.giftSkus.has(cand.sku)) return { code: 'sku_is_gift' };
  const fk = functionalKey(cand);
  if (fk && ctx.giftKeys.size && ctx.giftKeys.has(fk)) {
    return { code: 'gift_functional_equivalent', detail: fk };
  }

  // R5 — estoque. `available` já vem líquido de safety_stock e committed (Cosmos).
  // Não aplicar estoque de segurança de novo: descontaria duas vezes.
  if (!(cand.available > 0)) return { code: 'out_of_stock' };

  // Sem preço ou sem custo o motor não tem piso de margem — fora do pool.
  if (!(cand.price > 0)) return { code: 'no_price' };
  if (cand.cogs === null || cand.cogs === undefined) return { code: 'no_cogs' };
  if (!cand.variant_id) return { code: 'no_variant_id' };

  // §3.1 — piso absoluto. Ofertar R$ 14,90 num carrinho de R$ 719 não é upsell.
  if (cand.price < cfg.min_price) return { code: 'below_min_price' };

  // R4 — teto de 60% do carrinho. `price_target` é TETO ALTERNATIVO, não
  // interruptor: antes bastava a presença do campo para desligar o teto, e um
  // `price_target: 1` liberava o catálogo inteiro.
  const baseCap = cfg.price_cap_ratio * ctx.cartTotal;
  const cap = (ctx.goal === 'margin' && ctx.priceTarget > 0)
    ? Math.max(baseCap, ctx.priceTarget)
    : baseCap;
  if (ctx.cartTotal > 0 && cand.price > cap) {
    return { code: 'over_price_cap' };
  }

  return null;
}

/**
 * Normaliza rótulo de taxonomia antes de comparar.
 *
 * Medido no seed: `BODY SPLASH` (26 SKUs) e `Body Splash` (20) são a MESMA
 * subcategoria e não casavam em `===`. Metade das canibalizações que a regra de
 * substituto existe para punir escapava por diferença de caixa. Idem
 * `PERFUME CAPILAR`/`Perfume Capilar`, `CAPSULA`/`CÁPSULA`, `PÓ`/`Pó`.
 *
 * `Não se aplica` é sentinela de ausência, não um valor: dois produtos sem
 * classificação não são da mesma linha.
 */
const TAX_SENTINELS = new Set(['', 'nao se aplica', 'n/a', 'na', 'nao aplicavel', 'sem linha', '-']);
export function normTax(v) {
  const s = String(v ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toLowerCase().replace(/\s+/g, ' ');
  return TAX_SENTINELS.has(s) ? '' : s;
}

/**
 * Equivalência funcional aproximada (P6): linha + subcategoria.
 *
 * Sem linha E sem subcategoria não existe grupo funcional — devolver `"|"` fazia
 * essa classe inteira equivaler a si mesma, e um único brinde rejeitava 44 dos
 * 96 SKUs da Rituária. A classe nula tem 61% do catálogo da Rituária e 47% do
 * da Barbour's, então o custo do bug era quase todo o pool.
 */
export function functionalKey(p) {
  const l = normTax(p.line);
  const s = normTax(p.subcategory);
  if (!l && !s) return null;
  return `${l}|${s}`;
}

/** §2.11 — até que gap a faixa de preço vale como filtro duro. */
export function gapAtivo(gap, cartTotal, cfg) {
  if (!(gap > 0)) return false;
  const teto = Math.min(cfg.gap_hard_max, cfg.gap_hard_max_ratio * (cartTotal || 0));
  return gap <= teto;
}

/**
 * R3 — faixa de preço que fecha o gap do threshold.
 *
 * O topo é grampeado no teto de preço: sem isso a faixa pede um preço que o
 * filtro de teto já proíbe, os dois se anulam e o carrinho fica sem oferta com
 * benefício. Era parte da região "sem benefício" de 24,5% das células medidas.
 */
export function inGapBand(price, gap, cartTotal = 0, capRatio = Infinity) {
  if (!(gap > 0)) return false;
  const topo = cartTotal > 0 ? Math.min(3 * gap, capRatio * cartTotal) : 3 * gap;
  return price >= gap && price <= topo;
}

// ---------------------------------------------------------------------------
// Fatores do score
// ---------------------------------------------------------------------------

/**
 * afinidade 0–1: co-compra encolhida para a regra quando há pouco dado.
 *
 * `opts.cartProds` faz a regra valer contra TODO o carrinho, não só a âncora.
 * Sem isso o patch de substituto nasceria furado: num carrinho de dois Body
 * Splash, uma oferta que canibaliza o SEGUNDO item não seria comparada com ele
 * e cairia no 0,20 de "sem relação". A parte de co-compra continua só contra a
 * âncora — é mudança de SQL, e está registrada como pendência.
 */
export function affinityScore(
  { co = 0, anchorOrders = 0, candOrders = 0, brandOrders = 0 },
  anchorProd,
  cand,
  opts = {},
) {
  const collectible = opts.collectible || EMPTY_SET;
  const cartProds = opts.cartProds && opts.cartProds.length ? opts.cartProds : [anchorProd];
  const rule = ruleAffinityOverCart(cartProds, cand, collectible);
  if (!co || !anchorOrders || !brandOrders) return clamp01(rule);

  const pBgivenA = co / anchorOrders;
  const pB = candOrders && brandOrders ? candOrders / brandOrders : 0;
  const lift = pB > 0 ? pBgivenA / pB : 0;

  const dataAff = 0.5 * Math.min(1, pBgivenA / 0.10) + 0.5 * Math.min(1, lift / 5);
  const w = co / (co + SHRINKAGE_K); // §4: k = 5
  return clamp01(w * dataAff + (1 - w) * rule);
}

const EMPTY_SET = new Set();
export const SHRINKAGE_K = 5;

/**
 * Regra de afinidade sobre o carrinho inteiro.
 *
 * NÃO é o máximo puro que a especificação escreve, e a diferença importa:
 * com a punição de substituto no jogo, o máximo esconderia justamente o que a
 * punição existe para pegar — bastaria um item complementar no carrinho para
 * apagar a canibalização do outro. Substituto manda; no resto, o máximo vale.
 */
export function ruleAffinityOverCart(cartProds, cand, collectible = EMPTY_SET) {
  let best = 0;
  let any = false;
  for (const p of cartProds) {
    if (!p) continue;
    any = true;
    const v = ruleAffinity(p, cand, collectible);
    if (v <= SUBSTITUTE_AFF) return SUBSTITUTE_AFF;
    if (v > best) best = v;
  }
  return any ? best : NO_RELATION_AFF;
}

export const SUBSTITUTE_AFF = 0.10;
export const NO_RELATION_AFF = 0.20;

/**
 * Tabela §2.8, sem o mapa de complementaridade (que é curadoria de catálogo).
 *
 * Mesma subcategoria é SUBSTITUTO (0,10) — ou variedade (0,40) em categoria
 * colecionável. Antes valia 0,70, e mesma linha valia 1,00: era a regra que
 * mandava outra fragrância do mesmo Body Splash para o topo do ranking.
 *
 * A ordem dos testes inverteu de propósito. Item de mesma linha quase sempre é
 * também de mesma subcategoria, e é exatamente esse o padrão de canibalização —
 * testar linha primeiro devolveria 0,35 para o caso que precisa de 0,10.
 *
 * Não há 0,50 taxonômico: de 0,50 a 0,70 a especificação descreve RELAÇÕES
 * (complemento dependente, de rotina, reposição) que vêm do mapa, não da
 * taxonomia. Inventar um daria nota de complemento a categorias inteiras que
 * ninguém validou — o mesmo atalho que produziu o 1,00 que está saindo daqui.
 */
export function ruleAffinity(a, b, collectible = EMPTY_SET) {
  if (!a || !b) return NO_RELATION_AFF;
  const subA = normTax(a.subcategory), subB = normTax(b.subcategory);
  if (subA && subB && subA === subB) {
    return collectible.has(normTax(b.category)) || collectible.has(subB) ? 0.40 : SUBSTITUTE_AFF;
  }
  const lineA = normTax(a.line), lineB = normTax(b.line);
  if (lineA && lineB && lineA === lineB) return 0.35;
  return NO_RELATION_AFF;
}

/** `collectible_categories` da config → Set normalizado. */
export function parseCollectible(csv) {
  const out = new Set();
  for (const part of String(csv || '').split(',')) {
    const v = normTax(part);
    if (v) out.add(v);
  }
  return out;
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
  // Com a fonte de estoque errada (§1), toda cobertura é ficção. Desligar aqui
  // tira o fator do score E o ramo de escassez do copy de uma vez. Empurrar
  // `slow_moving_days` para 100000 faria só metade: o atalho de `dead` abaixo
  // não olha cobertura, e os 7 SKUs marcados assim continuariam com 2,0 —
  // virando os ÚNICOS com vantagem, já que todo o resto cairia para 1,0.
  if (cfg && cfg.stock_urgency_enabled === 0) return 1.0;
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

/**
 * §2.10 — quanto o preço da oferta "cabe" no carrinho.
 *
 * Sem este fator o preço não entrava no score em momento nenhum: o teto de 60%
 * é binário, então tudo abaixo dele valia igual e a mediana das ofertas ficava
 * colada no teto. A faixa confortável de order bump é 15% a 45% do carrinho.
 */
export function fitPreco(price, cartTotal) {
  if (!(cartTotal > 0)) return 1;
  const r = price / cartTotal;
  if (r >= 0.15 && r <= 0.45) return 1.0;
  if (r > 0.45 && r <= 0.60) return 0.8;
  return 0.7;
}

// Pesos por goal, como expoentes (§3.2). `margin` tinha margem com peso 0,3 —
// menos que afinidade — e movia a margem na direção errada.
export const GOAL_WEIGHTS = {
  aov:    { aff: 1.0,  take: 1.0, fit: 1.0, margin: 0.5, urgency: 0.25 },
  stock:  { aff: 0.75, take: 0.5, fit: 0.5, margin: 1.0, urgency: 1.0 },
  margin: { aff: 0.75, take: 1.0, fit: 0.5, margin: 1.0, urgency: 0.25 },
};

export function scoreOf({ aff, margin, urgency, take, fit = 1, goal, gapBonus = 1 }) {
  const w = GOAL_WEIGHTS[goal] || GOAL_WEIGHTS.aov;
  const f = (x, e) => Math.pow(Math.max(x, 1e-6), e);
  return f(aff, w.aff) * f(margin, w.margin) * f(urgency / 2, w.urgency)
       * f(take, w.take) * f(fit, w.fit) * gapBonus;
}

// §2.11 — bônus de quem fecha o gap. Era 1,35.
export const GAP_BONUS = 1.25;

// §2.7 — margem só para efeito de RANKING quando o custo é estimado. O piso de
// margem continua sendo cobrado sobre a margem real: o motor não deixa de
// vender por custo provisório, só deixa de preferir por causa dele.
export const PROVISIONAL_COST_PENALTY = 0.7;

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

export function buildCopy(cand, { anchorProd, gap, incentive, urgency, cfg, lineLabels }) {
  const title = cand.title || cand.sku;
  if (incentive.type === 'threshold') {
    return `Leve ${title} e ganhe ${incentive.label || 'frete grátis'}`;
  }
  if (incentive.type === 'percent') {
    return `${title} com ${incentive.value}% off só agora`;
  }
  // A linha só vai para a tela se tiver rótulo PÚBLICO. `line` é campo de
  // cadastro: os 169 usos deste molde imprimiam "Completa sua rotina
  // INSPIRADOS", "... CAPSULA", "... KIT" — jargão interno, sem exceção.
  const lineKey = normTax(anchorProd && anchorProd.line);
  const rotulo = lineKey && lineLabels ? lineLabels[lineKey] : null;
  if (rotulo && lineKey && lineKey === normTax(cand.line)) {
    return `Completa sua rotina ${rotulo}: ${title}`;
  }
  // Escassez só quando o estoque é de fato baixo. `urgency` sozinha mentia:
  // o Boné marcado como `dead` tem 4.170 unidades.
  const teto = (cfg && cfg.low_stock_units) ?? 500;
  if (urgency >= 1.5 && cand.available != null && cand.available < teto) {
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

/**
 * §2.9 — a posterior é re-amostrada a cada 15 MINUTOS, não a cada requisição.
 *
 * Sorteando por request, o mesmo carrinho recarregado devolve oferta diferente:
 * medido, 8 de 10 chamadas idênticas não prometiam o frete e 2 prometiam. Para
 * o shopper a loja muda de ideia sozinha; para a leitura do A/B, duas impressões
 * do mesmo carrinho viram dois experimentos. Semear por (chave, janela) resolve
 * sem tabela de cache, e o Thompson Sampling segue explorando entre janelas.
 */
export const TS_WINDOW_MS = 15 * 60 * 1000;

export function tsWindow(now = Date.now()) {
  return Math.floor(now / TS_WINDOW_MS);
}

/** FNV-1a 32 bits — determinístico e sem dependência. */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: PRNG de 32 bits, uniforme o bastante para o gamma de Marsaglia. */
export function rngFrom(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
  if (gapAtivo(ctx.gap, ctx.cartTotal, cfg)) {
    const banded = pool.filter((c) => inGapBand(c.price, ctx.gap, ctx.cartTotal, cfg.price_cap_ratio));
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
    const aff = affinityScore(ctx.affinityOf(cand.sku), ctx.anchorProd, cand, {
      collectible: ctx.collectible,
      cartProds: ctx.cartProds,
    });
    const urgency = stockUrgency(cand, cfg);
    const take = sampleBeta(
      (stats.prior_alpha ?? cfg.prior_alpha) + stats.accepts,
      (stats.prior_beta ?? cfg.prior_beta) + Math.max(0, stats.impressions - stats.accepts),
      (ctx.rndFor && ctx.rndFor(cand.sku)) || ctx.rnd,
    );
    const inBand = inGapBand(cand.price, ctx.gap, ctx.cartTotal, cfg.price_cap_ratio);
    const gapBonus = inBand ? GAP_BONUS : 1;
    const fit = fitPreco(cand.price, ctx.cartTotal);
    // §2.7: o piso de margem já foi cobrado acima sobre a margem REAL.
    const marginScore = cand.cost_provisional ? margin * PROVISIONAL_COST_PENALTY : margin;
    const score = scoreOf({ aff, margin: marginScore, urgency, take, fit, goal: ctx.goal, gapBonus });

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
      price_fit: fit,
      take_rate_sampled: round4(take),
      score: round6(score),
      copy: buildCopy(cand, {
        anchorProd: ctx.anchorProd, gap: ctx.gap, incentive: ladder.incentive,
        urgency, cfg, lineLabels: ctx.lineLabels,
      }),
      reason: buildReason([
        ladder.reason,
        aff >= 0.40 ? 'afinidade alta com o carrinho' : null,
        aff <= SUBSTITUTE_AFF ? 'substituto do que já está no carrinho' : null,
        // Só fala de cobertura quando existe cobertura: "0 dias" era o default
        // do `|| 0` aparecendo como se fosse medição.
        urgency >= 1.5 && cand.coverage_days != null
          ? `estoque com ${Math.round(cand.coverage_days)} dias de cobertura` : null,
        `margem ${(margin * 100).toFixed(0)}%`,
      ]),
      _debug: {
        affinity: ctx.affinityOf(cand.sku),
        stats,
        gap_band: inBand,
        price_fit: fit,
        margin_score: round4(marginScore),
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
