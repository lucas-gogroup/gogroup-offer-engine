// Testes do núcleo determinístico. Sem banco, sem rede.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hardFilterReject, inGapBand, gapAtivo, decide, mergeConfig, affinityScore,
  marginPostIncentive, priceRoom, stockUrgency, sampleBeta, DEFAULT_CONFIG,
  ruleAffinity, ruleAffinityOverCart, parseCollectible, normTax, functionalKey,
  fitPreco, buildCopy, hashSeed, rngFrom, scoreOf,
} from '../src/engine.js';

const cfg = mergeConfig(null);

function prod(over = {}) {
  return {
    brand: 'rituaria', sku: 'X', variant_id: '1', title: 'X', is_kit: 0,
    category: 'suplemento', subcategory: 'magnesio', line: 'essenciais',
    price: 50, cogs: 15, available: 100, coverage_days: 40, stock_status: 'normal',
    ...over,
  };
}

function ctx(over = {}) {
  return {
    cfg, cartSkus: new Set(), giftSkus: new Set(), giftKeys: new Set(),
    cartTotal: 200, kitComponentsOf: new Map(), kitsContaining: new Map(),
    cartKitComponents: new Set(), gap: 0, goal: 'aov', priceTarget: null,
    maxDiscount: 0.15, anchorProd: null,
    affinityOf: () => ({ co: 0, anchorOrders: 0, candOrders: 0, brandOrders: 0 }),
    statsOf: () => ({ impressions: 0, accepts: 0, prior_alpha: null, prior_beta: null }),
    rnd: () => 0.5,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// PORTÃO: RT01008 no carrinho não pode ofertar KRT99078
// ---------------------------------------------------------------------------

const RT01008 = prod({ sku: 'RT01008', title: 'Magnésio Inositol', price: 89.90, cogs: 22 });
const KRT99078 = prod({
  sku: 'KRT99078', title: 'Trio de Queridinhos', price: 149.90, cogs: 45, is_kit: 1,
});
const kitMap = new Map([['KRT99078', new Set(['RT01008', 'RT01015', 'RT01022'])]]);

test('PORTÃO — carrinho com RT01008 nunca oferta KRT99078', () => {
  const c = ctx({
    cartSkus: new Set(['RT01008']),
    cartTotal: 89.90,
    kitComponentsOf: kitMap,
  });
  const rej = hardFilterReject(KRT99078, c);
  assert.ok(rej, 'o kit tem que ser rejeitado');
  assert.equal(rej.code, 'kit_contains_cart_sku');
});

test('PORTÃO — a rejeição é pela composição, não pelo teto de preço', () => {
  // Carrinho caro o bastante para o kit passar no teto de 60%.
  // Só a regra de composição pode barrar aqui.
  const c = ctx({
    cartSkus: new Set(['RT01008']),
    cartTotal: 1000,
    kitComponentsOf: kitMap,
  });
  assert.ok(KRT99078.price <= 0.6 * 1000, 'sanidade: o kit passa no teto de preço');
  const rej = hardFilterReject(KRT99078, c);
  assert.equal(rej && rej.code, 'kit_contains_cart_sku');
});

test('PORTÃO — decide() não devolve KRT99078 no ranking', () => {
  const pool = [KRT99078, prod({ sku: 'RT02001', title: 'Colágeno', price: 45, cogs: 12 })];
  const { offers, rejected } = decide(pool, ctx({
    cartSkus: new Set(['RT01008']), cartTotal: 1000, kitComponentsOf: kitMap,
  }));
  assert.ok(!offers.some((o) => o.sku === 'KRT99078'), 'KRT99078 não pode aparecer');
  assert.ok(rejected.some((r) => r.sku === 'KRT99078' && r.code === 'kit_contains_cart_sku'));
  assert.equal(offers[0].sku, 'RT02001');
});

test('sem o RT01008 no carrinho, o mesmo kit é ofertável', () => {
  const c = ctx({ cartSkus: new Set(['RT09999']), cartTotal: 1000, kitComponentsOf: kitMap });
  assert.equal(hardFilterReject(KRT99078, c), null);
});

// ---------------------------------------------------------------------------
// Demais filtros duros
// ---------------------------------------------------------------------------

test('não oferta SKU já no carrinho', () => {
  const c = ctx({ cartSkus: new Set(['RT01008']) });
  assert.equal(hardFilterReject(RT01008, c).code, 'sku_in_cart');
});

test('não oferta componente de kit já no carrinho', () => {
  const c = ctx({ cartSkus: new Set(['KRT99078']), cartKitComponents: new Set(['RT01008']) });
  assert.equal(hardFilterReject(RT01008, c).code, 'component_of_cart_kit');
});

test('não oferta o que está como brinde', () => {
  const c = ctx({ giftSkus: new Set(['RT01008']) });
  assert.equal(hardFilterReject(RT01008, c).code, 'sku_is_gift');
});

test('não oferta equivalente funcional do brinde (linha + subcategoria)', () => {
  const gift = prod({ sku: 'GIFT1', line: 'fit', subcategory: 'base' });
  const similar = prod({ sku: 'SELL1', line: 'fit', subcategory: 'base' });
  const c = ctx({ giftSkus: new Set(['GIFT1']), giftKeys: new Set(['fit|base']) });
  assert.equal(hardFilterReject(similar, c).code, 'gift_functional_equivalent');
  assert.equal(gift.sku !== similar.sku, true);
});

test('available <= 0 sai do pool — e nada de estoque de segurança por cima', () => {
  assert.equal(hardFilterReject(prod({ available: 0 }), ctx()).code, 'out_of_stock');
  assert.equal(hardFilterReject(prod({ available: -56057 }), ctx()).code, 'out_of_stock');
  // 5 unidades é pouco, mas o Cosmos já descontou safety_stock: tem que passar.
  assert.equal(hardFilterReject(prod({ available: 5 }), ctx()), null);
});

test('teto de 60% do carrinho', () => {
  const c = ctx({ cartTotal: 100 });
  assert.equal(hardFilterReject(prod({ price: 61 }), c).code, 'over_price_cap');
  assert.equal(hardFilterReject(prod({ price: 59 }), c), null);
});

test('goal=margin com price_target escapa do teto', () => {
  const c = ctx({ cartTotal: 100, goal: 'margin', priceTarget: 120 });
  assert.equal(hardFilterReject(prod({ price: 120 }), c), null);
});

test('sem cogs, sem variant_id ou sem preço o SKU não entra', () => {
  assert.equal(hardFilterReject(prod({ cogs: null }), ctx()).code, 'no_cogs');
  assert.equal(hardFilterReject(prod({ variant_id: null }), ctx()).code, 'no_variant_id');
  assert.equal(hardFilterReject(prod({ price: 0 }), ctx()).code, 'no_price');
});

// ---------------------------------------------------------------------------
// Gap de threshold
// ---------------------------------------------------------------------------

test('faixa [gap, 3×gap] com o topo grampeado no teto de preço', () => {
  assert.equal(inGapBand(30, 30), true);
  assert.equal(inGapBand(90, 30), true);
  assert.equal(inGapBand(91, 30), false);
  assert.equal(inGapBand(29, 30), false);
  assert.equal(inGapBand(50, 0), false);

  // §2.11: sem o grampo, a faixa pede um preço que o teto de 60% proíbe, os
  // dois se anulam e o carrinho fica sem oferta com benefício.
  assert.equal(inGapBand(90, 30, 100, 0.6), false, '3×gap=90 > 60% de 100');
  assert.equal(inGapBand(55, 30, 100, 0.6), true);
});

test('gap ativo é min(40, 30% do carrinho), não um valor fixo', () => {
  // Um gap de R$ 30 num carrinho de R$ 35 não é "quase lá": é 86% do carrinho.
  assert.equal(gapAtivo(30, 35, cfg), false);
  assert.equal(gapAtivo(30, 200, cfg), true);
  assert.equal(gapAtivo(45, 1000, cfg), false, 'o teto absoluto de 40 continua valendo');
  assert.equal(gapAtivo(0, 200, cfg), false);
});

test('gap pequeno vira filtro duro; relaxa e registra se esvaziar o pool', () => {
  const inBand = prod({ sku: 'IN', price: 25, cogs: 6 });
  const outBand = prod({ sku: 'OUT', price: 60, cogs: 15 });
  const r1 = decide([inBand, outBand], ctx({ gap: 10, cartTotal: 200 }));
  assert.deepEqual(r1.offers.map((o) => o.sku), ['IN']);
  assert.deepEqual(r1.relaxed, []);

  const r2 = decide([outBand], ctx({ gap: 10, cartTotal: 200 }));
  assert.deepEqual(r2.relaxed, ['gap_band'], 'pool vazio → relaxa e declara');
  assert.deepEqual(r2.offers.map((o) => o.sku), ['OUT']);
});

test('oferta que fecha o gap recebe incentivo threshold e copy de frete grátis', () => {
  const { offers } = decide([prod({ sku: 'IN', price: 25, cogs: 6 })], ctx({ gap: 10 }));
  assert.equal(offers[0].incentive.type, 'threshold');
  assert.equal(offers[0].incentive.value, 0, 'não custa desconto');
  assert.match(offers[0].copy, /frete grátis/);
});

// ---------------------------------------------------------------------------
// Margem e incentivo
// ---------------------------------------------------------------------------

test('margem abaixo do piso derruba o candidato', () => {
  const caro = prod({ sku: 'CARO', price: 50, cogs: 40 });
  const { offers, rejected } = decide([caro], ctx());
  assert.equal(offers.length, 0);
  assert.equal(rejected[0].code, 'below_margin_floor');
});

test('marginPostIncentive desconta cogs, frete marginal e imposto', () => {
  const m = marginPostIncentive({ cogs: 20 }, 100, { marginal_shipping: 5, tax_rate: 0.10 });
  assert.equal(Math.round(m * 1000) / 1000, 0.65); // (100-20-5-10)/100
});

test('priceRoom respeita o piso de margem', () => {
  const room = priceRoom({ price: 100, cogs: 20 }, mergeConfig({ margin_floor: 0.30, tax_rate: 0.10, marginal_shipping: 0 }));
  assert.equal(Math.round(room.floor_price * 100) / 100, 33.33);
  assert.ok(room.room_pct > 0.66 && room.room_pct < 0.67);
});

test('desconto % fica desligado por default (checkout Yampi não aplica)', () => {
  assert.equal(DEFAULT_CONFIG.allow_percent_discount, 0);
  const { offers } = decide([prod({ sku: 'A', price: 50, cogs: 5 })], ctx());
  assert.equal(offers[0].incentive.type, 'none');
  assert.equal(offers[0].final_price, 50);
});

test('com allow_percent_discount ligado, o desconto respeita o piso', () => {
  const c2 = mergeConfig({ allow_percent_discount: 1, max_discount: 0.15 });
  const { offers } = decide([prod({ sku: 'A', price: 50, cogs: 5 })], ctx({ cfg: c2 }));
  assert.equal(offers[0].incentive.type, 'percent');
  assert.equal(offers[0].incentive.value, 15);
  assert.ok(offers[0].expected_margin >= c2.margin_floor);
});

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

test('afinidade cai para a regra quando não há co-compra', () => {
  const a = prod({ line: 'essenciais', subcategory: 'magnesio' });
  // Mesma subcategoria é SUBSTITUTO: quem levou 4Mag não quer outro magnésio.
  assert.equal(affinityScore({ co: 0 }, a, prod({ subcategory: 'magnesio' })), 0.10);
  // Mesma linha, subcategoria diferente: 0,35.
  assert.equal(affinityScore({ co: 0 }, a, prod({ subcategory: 'colageno' })), 0.35);
  // Sem relação nenhuma: 0,20.
  assert.equal(affinityScore({ co: 0 }, a, prod({ line: 'outra', subcategory: 'z', category: 'w' })), 0.20);
});

test('co-compra forte sobe a afinidade acima da regra fraca', () => {
  const a = prod({ line: 'A', subcategory: 'x', category: 'c1' });
  const b = prod({ line: 'B', subcategory: 'y', category: 'c2' });
  const weak = affinityScore({ co: 0 }, a, b);
  const strong = affinityScore({ co: 200, anchorOrders: 1000, candOrders: 500, brandOrders: 100000 }, a, b);
  assert.ok(strong > weak);
});

test('urgência de estoque: rampa entre o limiar do handoff e o estoque morto', () => {
  assert.equal(stockUrgency(prod({ coverage_days: 20 }), cfg), 1.0);
  assert.equal(stockUrgency(prod({ coverage_days: 180 }), cfg), 1.0);
  assert.equal(stockUrgency(prod({ coverage_days: 181 }), cfg) > 1.5, true, 'logo acima do limiar já é 1,5+');
  assert.equal(stockUrgency(prod({ coverage_days: 1800 }), cfg), 2.0);
  assert.equal(stockUrgency(prod({ coverage_days: 99999 }), cfg), 2.0, 'satura, não estoura');
  assert.equal(stockUrgency(prod({ stock_status: 'dead' }), cfg), 2.0);
  assert.equal(stockUrgency(prod({ coverage_days: null }), cfg), 1.0, 'sem dado não vira urgência');
  // o que motiva a rampa: no pool real a mediana é 678 d
  const a = stockUrgency(prod({ coverage_days: 300 }), cfg);
  const b = stockUrgency(prod({ coverage_days: 678 }), cfg);
  assert.ok(b > a, 'cobertura maior tem que ordenar acima');
});

test('goal muda a ordem do ranking sobre o mesmo pool', () => {
  // AFIM é complemento: mesma linha da âncora, subcategoria DIFERENTE (0,35).
  // Mesma subcategoria seria substituto (0,10) — e era isso que o motor premiava.
  const afim = prod({ sku: 'AFIM', line: 'essenciais', subcategory: 'colageno', price: 40, cogs: 12, coverage_days: 10 });
  const parado = prod({ sku: 'PARADO', line: 'outra', subcategory: 'z', category: 'w', price: 40, cogs: 5, coverage_days: 400 });
  const anchorProd = prod({ sku: 'ANCHOR', line: 'essenciais', subcategory: 'magnesio' });

  const aov = decide([afim, parado], ctx({ goal: 'aov', anchorProd, cartTotal: 500 }));
  const stock = decide([afim, parado], ctx({ goal: 'stock', anchorProd, cartTotal: 500 }));
  assert.equal(aov.offers[0].sku, 'AFIM', 'aov prioriza afinidade');
  assert.equal(stock.offers[0].sku, 'PARADO', 'stock prioriza girar o parado');
});

test('sampleBeta fica em [0,1] e segue o prior', () => {
  let sum = 0;
  for (let i = 0; i < 4000; i++) {
    const s = sampleBeta(2, 18);
    assert.ok(s >= 0 && s <= 1);
    sum += s;
  }
  const mean = sum / 4000;
  assert.ok(Math.abs(mean - 0.1) < 0.02, `média ${mean} deveria ficar perto de 0,10`);
});

// ---------------------------------------------------------------------------
// Afinidade — tabela §2.8 e o que a auditoria não tinha medido
// ---------------------------------------------------------------------------

test('taxonomia normaliza antes de comparar: BODY SPLASH é Body Splash', () => {
  // Medido no seed: 26 SKUs gravados 'BODY SPLASH' e 20 gravados 'Body Splash'.
  // Com `===` cru, metade das canibalizações escapava da punição de substituto.
  const a = prod({ subcategory: 'BODY SPLASH', line: 'TROPICAL GLOW' });
  const b = prod({ subcategory: 'Body Splash', line: 'Tropical Glow' });
  assert.equal(ruleAffinity(a, b), 0.10, 'mesmo produto, grafia diferente, ainda é substituto');
  assert.equal(normTax('CÁPSULA'), normTax('Capsula'));
  assert.equal(normTax('  PÓ '), 'po');
});

test('"Não se aplica" é ausência de linha, não uma linha em comum', () => {
  const a = prod({ line: 'Não se aplica', subcategory: '' });
  const b = prod({ line: 'não se aplica', subcategory: '' });
  assert.equal(ruleAffinity(a, b), 0.20, 'dois produtos sem classificação não são da mesma linha');
  assert.equal(normTax('Não se aplica'), '');
});

test('colecionável muda substituto (0,10) em variedade (0,40)', () => {
  const coll = parseCollectible('Fragrances, Fragrancias');
  const a = prod({ subcategory: 'Body Splash', category: 'FRAGRANCES' });
  const b = prod({ subcategory: 'BODY SPLASH', category: 'Fragrancias' });
  assert.equal(ruleAffinity(a, b), 0.10, 'sem a marca declarar, é substituto');
  assert.equal(ruleAffinity(a, b, coll), 0.40, 'perfumaria: levar outra fragrância é compra real');
  assert.equal(ruleAffinity(a, b, coll) < 1.0, true, 'mas nunca volta ao 1,00 que canibalizava');
});

test('a regra vale contra o carrinho inteiro, e substituto manda', () => {
  const anchor = prod({ sku: 'A', line: 'essenciais', subcategory: 'colageno' });
  const segundo = prod({ sku: 'B', line: 'outra', subcategory: 'magnesio' });
  const cand = prod({ sku: 'C', line: 'essenciais', subcategory: 'magnesio' });

  // Só contra a âncora, este candidato seria complemento de linha (0,35).
  assert.equal(ruleAffinity(anchor, cand), 0.35);
  // Contra o carrinho, ele canibaliza o SEGUNDO item — e é isso que vale.
  assert.equal(ruleAffinityOverCart([anchor, segundo], cand), 0.10);

  // Sem substituto no carrinho, o melhor vínculo ganha.
  const neutro = prod({ sku: 'D', line: 'nenhuma', subcategory: 'zzz' });
  assert.equal(ruleAffinityOverCart([neutro, anchor], cand), 0.35);
});

test('carrinho de um item continua idêntico ao comportamento por âncora', () => {
  const anchor = prod({ line: 'essenciais', subcategory: 'colageno' });
  const cand = prod({ line: 'essenciais', subcategory: 'magnesio' });
  assert.equal(ruleAffinityOverCart([anchor], cand), ruleAffinity(anchor, cand));
});

// ---------------------------------------------------------------------------
// Filtros novos
// ---------------------------------------------------------------------------

test('kit que divide componente com o kit do carrinho é barrado', () => {
  // `cartSkus` com um kit dentro contém só o SKU do kit: comparar contra ele
  // deixa passar o kit vizinho que entrega metade do que o cliente já comprou.
  const c = ctx({
    cartSkus: new Set(['KRT99046']),
    cartKitComponents: new Set(['RT01003', 'RT01005']),
    kitComponentsOf: new Map([['KRT99049', new Set(['RT01005', 'RT02001'])]]),
    cartTotal: 569,
  });
  const r = hardFilterReject(prod({ sku: 'KRT99049', price: 300, cogs: 90, is_kit: 1 }), c);
  assert.equal(r.code, 'kit_overlaps_cart_kit');
  assert.equal(r.detail, 'KRT99049⊃RT01005', 'o log tem que dizer QUAL componente');
});

test('price_target é teto alternativo, não interruptor do teto', () => {
  // Carrinho de R$ 49,80: teto = max(60% × 49,80 = 29,88 ; piso absoluto 60) = 60.
  const cand = prod({ price: 90, cogs: 22 });
  // R$ 1 de price_target liberava o catálogo inteiro; agora é max(teto, alvo).
  assert.equal(hardFilterReject(cand, ctx({ goal: 'margin', priceTarget: 1, cartTotal: 49.8 })).code, 'over_price_cap');
  assert.equal(hardFilterReject(cand, ctx({ goal: 'margin', priceTarget: 120, cartTotal: 49.8 })), null);
  assert.equal(hardFilterReject(cand, ctx({ goal: 'aov', priceTarget: 999, cartTotal: 49.8 })).code, 'over_price_cap',
    'fora do goal=margin o alvo não vale');
});

test('piso absoluto do teto devolve o carrinho de entrada ao jogo', () => {
  // O SKU mais barato da Rituária é R$ 40 e o carrinho de entrada é R$ 49,90:
  // 60% dão R$ 29,94 e a marca inteira fica muda justamente na porta.
  const barato = prod({ price: 40, cogs: 10 });
  const semPiso = mergeConfig({ price_cap_abs: 0 });
  assert.equal(hardFilterReject(barato, ctx({ cfg: semPiso, cartTotal: 49.9 })).code, 'over_price_cap');
  assert.equal(hardFilterReject(barato, ctx({ cartTotal: 49.9 })), null, 'com o piso de R$ 60, entra');

  // E o piso só morde embaixo: acima de R$ 100 de carrinho o proporcional já é
  // maior que 60 e o piso vira inerte — quem manda volta a ser os 60%.
  const caro = prod({ price: 170, cogs: 45 });
  assert.equal(hardFilterReject(caro, ctx({ cartTotal: 300 })), null, '60% de 300 = 180');
  assert.equal(hardFilterReject(caro, ctx({ cartTotal: 200 })).code, 'over_price_cap', '60% de 200 = 120');
});

test('quem fecha o benefício passa por cima do teto — e só até 1,5× o gap', () => {
  // O caso real: carrinho de R$ 49,90, frete grátis em R$ 199, gap de R$ 149,10.
  const c = (over) => ctx({ cartTotal: 49.9, gap: 149.1, thresholdLabel: 'Frete Grátis', ...over });
  const fecha = prod({ sku: 'K149', price: 149.9, cogs: 45 });
  assert.equal(hardFilterReject(fecha, c()), null, 'leva o carrinho a R$ 199,80');

  // Passa longe demais: 569 > 1,5 × 149,10 = 223,65.
  assert.equal(hardFilterReject(prod({ price: 569, cogs: 170 }), c()).code, 'over_price_cap');
  // Não fecha o gap e não cabe no teto de R$ 60: continua fora.
  assert.equal(hardFilterReject(prod({ price: 99, cogs: 30 }), c()).code, 'over_price_cap');

  const { offers } = decide([fecha], c());
  assert.equal(offers[0].incentive.type, 'threshold');
  assert.equal(offers[0].closes_benefit, true);
  assert.equal(offers[0].benefit_label, 'Frete Grátis');
  assert.equal(offers[0].benefit_threshold, 199);
  assert.equal(offers[0].cart_total_after, 199.8);
  assert.match(offers[0].copy, /^Faltam R\$ 149,10 para Frete Grátis/);
});

test('oferta que não fecha o benefício não recebe a bandeira', () => {
  const { offers } = decide([prod({ price: 50, cogs: 12 })], ctx({ cartTotal: 200, gap: 149.1 }));
  assert.equal(offers[0].closes_benefit, false);
  assert.equal(offers[0].benefit_label, null);
  assert.equal(offers[0].benefit_threshold, null);
  assert.equal(offers[0].incentive.type, 'none');
});

test('piso de preço: abaixo dele não é oferta', () => {
  assert.equal(hardFilterReject(prod({ price: 14.9, cogs: 3 }), ctx()).code, 'below_min_price');
  assert.equal(hardFilterReject(prod({ price: 0.02, cogs: 2 }), ctx()).code, 'below_min_price');
  assert.equal(hardFilterReject(prod({ price: 15, cogs: 3 }), ctx()), null);
});

test('produto sem linha e sem subcategoria não equivale a nada', () => {
  // A chave "|" fazia um único brinde rejeitar 44 dos 96 SKUs da Rituária.
  assert.equal(functionalKey(prod({ line: '', subcategory: '' })), null);
  assert.equal(functionalKey(prod({ line: 'A', subcategory: '' })), 'a|');
  const c = ctx({ giftKeys: new Set(['|']) });
  assert.equal(hardFilterReject(prod({ line: '', subcategory: '' }), c), null);
});

test('equivalente funcional continua barrando quando HÁ grupo, e diz qual', () => {
  const c = ctx({ giftKeys: new Set(['essenciais|magnesio']) });
  const r = hardFilterReject(prod({ line: 'ESSENCIAIS', subcategory: 'Magnesio' }), c);
  assert.equal(r.code, 'gift_functional_equivalent');
  assert.equal(r.detail, 'essenciais|magnesio');
});

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

test('fit_preco põe o preço no score, que antes era cego abaixo do teto', () => {
  assert.equal(fitPreco(30, 100), 1.0);
  assert.equal(fitPreco(50, 100), 0.8);
  assert.equal(fitPreco(10, 100), 0.7, 'barato demais para o carrinho também desconta');
  assert.equal(fitPreco(50, 0), 1, 'sem carrinho o fator é neutro');
});

test('custo provisório penaliza o ranking, não o piso de margem', () => {
  const real = prod({ sku: 'REAL', price: 50, cogs: 15 });
  const prov = prod({ sku: 'PROV', price: 50, cogs: 15, cost_provisional: 1 });
  const { offers } = decide([real, prov], ctx({ cartTotal: 200 }));
  assert.equal(offers[0].sku, 'REAL', 'igual em tudo menos na confiança do custo');
  assert.equal(offers.length, 2, 'o provisório continua ofertável — só deixa de ser preferido');
});

test('goal=margin passa a mover a margem na direção certa', () => {
  const gordo = prod({ sku: 'GORDO', price: 60, cogs: 10, line: 'x', subcategory: 'x1' });
  const magro = prod({ sku: 'MAGRO', price: 60, cogs: 35, line: 'x', subcategory: 'x1' });
  const { offers } = decide([gordo, magro], ctx({ goal: 'margin', cartTotal: 200 }));
  assert.equal(offers[0].sku, 'GORDO');
});

test('urgência de estoque tem chave mestra, e ela cobre o atalho de `dead`', () => {
  const off = mergeConfig({ stock_urgency_enabled: 0 });
  // Empurrar slow_moving_days para 100000 NÃO cobriria este caso:
  assert.equal(stockUrgency(prod({ stock_status: 'dead' }), mergeConfig({ slow_moving_days: 100000 })), 2.0);
  assert.equal(stockUrgency(prod({ stock_status: 'dead' }), off), 1.0);
  assert.equal(stockUrgency(prod({ coverage_days: 90000 }), off), 1.0);
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

test('copy de linha só sai com rótulo público — nada de INSPIRADOS na tela', () => {
  const anchorProd = prod({ line: 'INSPIRADOS' });
  const cand = prod({ title: 'Body Splash Ocean', line: 'INSPIRADOS' });
  const base = { anchorProd, gap: 0, incentive: { type: 'none' }, urgency: 1, cfg };

  assert.match(buildCopy(cand, base), /Quem levou esse também levou/, 'sem rótulo, cai no genérico');
  assert.equal(
    buildCopy(cand, { ...base, lineLabels: { inspirados: 'Inspirados' } }),
    'Completa sua rotina Inspirados: Body Splash Ocean',
  );
});

test('"Últimas unidades" exige estoque de fato baixo', () => {
  const base = { anchorProd: null, gap: 0, incentive: { type: 'none' }, urgency: 2.0, cfg };
  // O Boné marcado como `dead` tem 4.170 unidades.
  assert.match(buildCopy(prod({ title: 'Boné', available: 4170 }), base), /Quem levou esse/);
  assert.match(buildCopy(prod({ title: 'Sérum', available: 12 }), base), /^Últimas unidades/);
});

test('reason não fala de cobertura quando não há cobertura', () => {
  const { offers } = decide(
    [prod({ sku: 'D', stock_status: 'dead', coverage_days: null, available: 4170 })],
    ctx({ cartTotal: 200 }),
  );
  assert.equal(offers[0].stock_urgency, 2.0);
  assert.ok(!/dias de cobertura/.test(offers[0].reason), `reason vazou cobertura: ${offers[0].reason}`);
});

// ---------------------------------------------------------------------------
// Thompson Sampling estável na janela
// ---------------------------------------------------------------------------

test('mesma chave e mesma janela devolvem o mesmo sorteio', () => {
  const key = 'rituaria|RT02015|cart|aov|new|1758200000';
  const a = sampleBeta(2, 18, rngFrom(hashSeed(key)));
  const b = sampleBeta(2, 18, rngFrom(hashSeed(key)));
  assert.equal(a, b, 'recarregar o carrinho não pode mudar a oferta');

  const outro = sampleBeta(2, 18, rngFrom(hashSeed('rituaria|RT02015|cart|aov|new|1758200001')));
  assert.notEqual(a, outro, 'entre janelas o bandit continua explorando');
});

test('o RNG semeado continua sendo um Beta honesto', () => {
  let sum = 0;
  for (let i = 0; i < 4000; i++) sum += sampleBeta(2, 18, rngFrom(hashSeed(`k${i}`)));
  assert.ok(Math.abs(sum / 4000 - 0.1) < 0.02, `média ${sum / 4000} deveria ficar perto de 0,10`);
});

test('o piso absoluto não vira licença em carrinho minúsculo', () => {
  // Carrinho de R$ 14,90 (existe: 3 SKUs da Barbour's). Sem a trava de uplift,
  // o piso de R$ 60 liberaria uma oferta 4× maior que o carrinho.
  const c = ctx({ cartTotal: 14.9, gap: 0 });
  assert.equal(hardFilterReject(prod({ price: 59.9, cogs: 15 }), c).code, 'over_price_cap');
  assert.equal(hardFilterReject(prod({ price: 19.9, cogs: 5 }), c), null, '1,5 × 14,90 = 22,35');
  // E o carrinho de entrada de R$ 49,90 continua recebendo: 1,5 × 49,90 > 60.
  assert.equal(hardFilterReject(prod({ price: 59.9, cogs: 15 }), ctx({ cartTotal: 49.9 })), null);
});
