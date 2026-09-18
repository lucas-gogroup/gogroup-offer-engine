// Testes do núcleo determinístico. Sem banco, sem rede.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hardFilterReject, inGapBand, decide, mergeConfig, affinityScore,
  marginPostIncentive, priceRoom, stockUrgency, sampleBeta, DEFAULT_CONFIG,
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

test('faixa [gap, 3×gap]', () => {
  assert.equal(inGapBand(30, 30), true);
  assert.equal(inGapBand(90, 30), true);
  assert.equal(inGapBand(91, 30), false);
  assert.equal(inGapBand(29, 30), false);
  assert.equal(inGapBand(50, 0), false);
});

test('gap pequeno vira filtro duro; relaxa e registra se esvaziar o pool', () => {
  const inBand = prod({ sku: 'IN', price: 25, cogs: 6 });
  const outBand = prod({ sku: 'OUT', price: 5, cogs: 1 });
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
  const a = prod({ line: 'essenciais' });
  const b = prod({ line: 'essenciais' });
  assert.equal(affinityScore({ co: 0 }, a, b), 1.0);
  assert.equal(affinityScore({ co: 0 }, a, prod({ line: 'outra', subcategory: 'z', category: 'w' })), 0.2);
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
  const afim = prod({ sku: 'AFIM', line: 'essenciais', price: 40, cogs: 12, coverage_days: 10 });
  const parado = prod({ sku: 'PARADO', line: 'outra', subcategory: 'z', category: 'w', price: 40, cogs: 5, coverage_days: 400 });
  const anchorProd = prod({ sku: 'ANCHOR', line: 'essenciais' });

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
