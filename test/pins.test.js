// Curadoria manual (pin por vaga) — núcleo determinístico.
// Sem banco, sem rede e sem relógio de sistema: o instante entra por ctx.now.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decide, hardFilterReject, mergeConfig, resolvePins, comparePins,
  pinTriggerMatches, assembleSlots, pinKey,
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

const AGORA = '2026-09-19T12:00:00.000Z';

function ctx(over = {}) {
  return {
    cfg, cartSkus: new Set(), giftSkus: new Set(), giftKeys: new Set(),
    cartTotal: 200, kitComponentsOf: new Map(), cartKitComponents: new Set(),
    gap: 0, goal: 'aov', surface: 'cart', priceTarget: null, maxDiscount: 0.15,
    anchorProd: null, cartProds: [], pinRules: [], slots: 3, now: AGORA,
    affinityOf: () => ({ co: 0, anchorOrders: 0, candOrders: 0, brandOrders: 0 }),
    statsOf: () => ({ impressions: 0, accepts: 0, prior_alpha: null, prior_beta: null }),
    rnd: () => 0.5,
    ...over,
  };
}

/** Regra completa com os defaults que o mapper gravaria. */
function rule(over = {}) {
  return {
    slot: 1, trigger_type: 'always', trigger_key: '', offer_sku: 'P',
    trigger_field: null, trigger_value: null, surface: '*', goal: '*',
    priority: 0, active: 1, starts_at: null, ends_at: null,
    updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// PORTÃO — a curadoria não passa por cima de integridade
// ---------------------------------------------------------------------------

const RT01008 = prod({ sku: 'RT01008', title: 'Fórmula 4Mag', price: 73.51, cogs: 22 });
const KRT99078 = prod({
  sku: 'KRT99078', title: 'Trio de Queridinhos', price: 149.90, cogs: 45, is_kit: 1,
});
const kitMap = new Map([['KRT99078', new Set(['RT01008', 'RT01015', 'RT01022'])]]);
const OUTRO = prod({ sku: 'RT02001', title: 'Colágeno', price: 45, cogs: 11 });

test('PORTÃO DO PIN — kit fixado que contém item do carrinho continua barrado', () => {
  // cartTotal alto de propósito: o teto de preço não pode ser quem protege.
  const c = ctx({
    cartSkus: new Set(['RT01008']),
    cartProds: [RT01008],
    cartTotal: 1000,
    kitComponentsOf: kitMap,
    pinRules: [rule({ slot: 1, offer_sku: 'KRT99078' })],
  });
  assert.ok(KRT99078.price <= 0.6 * 1000, 'sanidade: o kit passaria no teto');

  const { offers, rejected, pins } = decide([KRT99078, OUTRO], c);

  assert.ok(!offers.some((o) => o.sku === 'KRT99078'), 'o kit fixado não pode sair');
  assert.ok(rejected.some((r) => r.sku === 'KRT99078' && r.code === 'kit_contains_cart_sku'));
  assert.equal(pins.length, 1);
  assert.equal(pins[0].applied, false);
  assert.equal(pins[0].fallback_reason, 'kit_contains_cart_sku');
  assert.equal(offers[0].sku, 'RT02001', 'a vaga cai no melhor score restante');
});

test('PORTÃO DO PIN — as outras travas de integridade também resistem', () => {
  const casos = [
    {
      nome: 'sku_in_cart',
      cand: OUTRO,
      over: { cartSkus: new Set(['RT02001']), cartProds: [OUTRO] },
    },
    {
      nome: 'out_of_stock',
      cand: prod({ sku: 'RT02001', available: 0 }),
      over: {},
    },
    {
      nome: 'component_of_cart_kit',
      cand: OUTRO,
      over: { cartKitComponents: new Set(['RT02001']) },
    },
    {
      nome: 'no_cogs',
      cand: prod({ sku: 'RT02001', cogs: null }),
      over: {},
    },
    {
      nome: 'no_variant_id',
      cand: prod({ sku: 'RT02001', variant_id: null }),
      over: {},
    },
  ];

  for (const { nome, cand, over } of casos) {
    const c = ctx({
      pinnedSkus: new Set(['RT02001']),
      cartTotal: 1000,
      ...over,
    });
    const rej = hardFilterReject(cand, c);
    assert.ok(rej, `${nome}: tinha que rejeitar mesmo fixado`);
    assert.equal(rej.code, nome);
  }
});

test('o piso de margem NÃO é furado pela curadoria', () => {
  // margem = 0,9 − cogs/price. 35/50 = 0,7 → margem 0,20, abaixo do piso 0,30.
  const ruim = prod({ sku: 'RUIM', price: 50, cogs: 35 });
  const c = ctx({
    cartTotal: 1000,
    pinRules: [rule({ slot: 1, offer_sku: 'RUIM' })],
  });
  const { offers, rejected, pins } = decide([ruim, OUTRO], c);

  assert.ok(!offers.some((o) => o.sku === 'RUIM'));
  assert.ok(rejected.some((r) => r.sku === 'RUIM' && r.code === 'below_margin_floor'));
  assert.equal(pins[0].fallback_reason, 'below_margin_floor');
});

// ---------------------------------------------------------------------------
// O que o pin FURA: só as travas econômicas
// ---------------------------------------------------------------------------

test('o pin fura o teto de preço', () => {
  const caro = prod({ sku: 'CARO', price: 300, cogs: 60 });
  const base = ctx({ cartTotal: 89.90 });

  const semPin = hardFilterReject(caro, base);
  assert.equal(semPin && semPin.code, 'over_price_cap', 'sem pin, o teto barra');

  const comPin = hardFilterReject(caro, ctx({ cartTotal: 89.90, pinnedSkus: new Set(['CARO']) }));
  assert.equal(comPin, null, 'fixado passa do teto');
});

test('o pin fura o piso de preço mínimo', () => {
  const barato = prod({ sku: 'MINI', price: 10, cogs: 2 });
  const semPin = hardFilterReject(barato, ctx({ cartTotal: 200 }));
  assert.equal(semPin && semPin.code, 'below_min_price');

  const comPin = hardFilterReject(barato, ctx({ cartTotal: 200, pinnedSkus: new Set(['MINI']) }));
  assert.equal(comPin, null);
});

test('o pin entra fora da faixa de gap sem apagar o relaxed dos demais', () => {
  // gap 30 em carrinho de 200: faixa é [30, min(90, 120)] = [30, 90].
  const foraDaFaixa = prod({ sku: 'FORA', price: 100, cogs: 25 });   // passa no teto (120), fora da faixa
  const fixado = prod({ sku: 'PIN', price: 50, cogs: 12 });          // DENTRO da faixa

  const c = ctx({
    cartTotal: 200,
    gap: 30,
    pinRules: [rule({ slot: 1, offer_sku: 'PIN' })],
  });
  const { offers, relaxed } = decide([foraDaFaixa, fixado], c);

  // O fixado está na faixa, mas o relaxamento é decidido sobre os NÃO fixados —
  // senão o pool viraria só o fixado e as outras vagas ficariam vazias.
  assert.deepEqual(relaxed, ['gap_band']);
  assert.equal(offers.length, 2, 'o candidato comum sobrevive');
  assert.equal(offers[0].sku, 'PIN', 'a vaga 1 é do fixado');
});

test('pin dentro do pool não inventa relaxed quando há candidato na faixa', () => {
  const naFaixa = prod({ sku: 'OK', price: 50, cogs: 12 });
  const fixado = prod({ sku: 'PIN', price: 100, cogs: 25 }); // fora da faixa
  const c = ctx({
    cartTotal: 200,
    gap: 30,
    pinRules: [rule({ slot: 1, offer_sku: 'PIN' })],
  });
  const { offers, relaxed } = decide([naFaixa, fixado], c);
  assert.deepEqual(relaxed, [], 'há candidato comum na faixa: nada foi relaxado');
  assert.equal(offers[0].sku, 'PIN');
  assert.ok(offers.some((o) => o.sku === 'OK'));
});

// ---------------------------------------------------------------------------
// Precedência
// ---------------------------------------------------------------------------

test('disputa de vaga: o gatilho mais específico vence', () => {
  const cartProds = [prod({ sku: 'A', line: 'essenciais', subcategory: 'magnesio' })];
  const base = {
    cartSkus: new Set(['A']),
    cartProds,
    slots: 3,
    now: AGORA,
    surface: 'cart',
    goal: 'aov',
  };

  const rSku = rule({ slot: 1, trigger_type: 'sku', trigger_key: 'A', offer_sku: 'POR_SKU' });
  const rTax = rule({
    slot: 1, trigger_type: 'taxonomy', trigger_key: 'line=essenciais',
    trigger_field: 'line', trigger_value: 'essenciais', offer_sku: 'POR_LINHA',
  });
  const rAll = rule({ slot: 1, trigger_type: 'always', trigger_key: '', offer_sku: 'SEMPRE' });

  const comTodas = resolvePins([rAll, rTax, rSku], base);
  assert.equal(comTodas.bySlot.get(1).offer_sku, 'POR_SKU');

  const semSku = resolvePins([rAll, rTax], base);
  assert.equal(semSku.bySlot.get(1).offer_sku, 'POR_LINHA');

  const soAll = resolvePins([rAll], base);
  assert.equal(soAll.bySlot.get(1).offer_sku, 'SEMPRE');
});

test('entre gatilhos taxonômicos, subcategoria vence linha, que vence categoria', () => {
  const cartProds = [prod({ sku: 'A', category: 'suplemento', line: 'essenciais', subcategory: 'magnesio' })];
  const base = { cartSkus: new Set(['A']), cartProds, slots: 3, now: AGORA };

  const mk = (field, value, alvo) => rule({
    slot: 1, trigger_type: 'taxonomy', trigger_key: `${field}=${value}`,
    trigger_field: field, trigger_value: value, offer_sku: alvo,
  });
  const cat = mk('category', 'suplemento', 'POR_CATEGORIA');
  const lin = mk('line', 'essenciais', 'POR_LINHA');
  const sub = mk('subcategory', 'magnesio', 'POR_SUBCATEGORIA');

  assert.equal(resolvePins([cat, lin, sub], base).bySlot.get(1).offer_sku, 'POR_SUBCATEGORIA');
  assert.equal(resolvePins([cat, lin], base).bySlot.get(1).offer_sku, 'POR_LINHA');
  assert.equal(resolvePins([cat], base).bySlot.get(1).offer_sku, 'POR_CATEGORIA');
});

test('prioridade só desempata dentro da mesma especificidade', () => {
  const cartProds = [prod({ sku: 'A' }), prod({ sku: 'B' })];
  const base = { cartSkus: new Set(['A', 'B']), cartProds, slots: 3, now: AGORA };

  const baixa = rule({ slot: 1, trigger_type: 'sku', trigger_key: 'A', offer_sku: 'BAIXA', priority: 0 });
  const alta = rule({ slot: 1, trigger_type: 'sku', trigger_key: 'B', offer_sku: 'ALTA', priority: 10 });
  assert.equal(resolvePins([baixa, alta], base).bySlot.get(1).offer_sku, 'ALTA');

  // ...e NÃO atravessa especificidade: um "sempre" com prioridade 99 continua
  // perdendo de um gatilho por SKU. É o que mantém a frase "mais específico
  // vence" verdadeira, que é o modelo mental do operador.
  const sempreForte = rule({ slot: 1, trigger_type: 'always', trigger_key: '', offer_sku: 'SEMPRE', priority: 99 });
  assert.equal(resolvePins([sempreForte, baixa], base).bySlot.get(1).offer_sku, 'BAIXA');
});

test('empate total: quem foi mexido por último ganha', () => {
  const cartProds = [prod({ sku: 'A' }), prod({ sku: 'B' })];
  const base = { cartSkus: new Set(['A', 'B']), cartProds, slots: 3, now: AGORA };
  const velha = rule({ slot: 1, trigger_type: 'sku', trigger_key: 'A', offer_sku: 'VELHA', updated_at: '2026-01-01T00:00:00.000Z' });
  const nova = rule({ slot: 1, trigger_type: 'sku', trigger_key: 'B', offer_sku: 'NOVA', updated_at: '2026-09-18T00:00:00.000Z' });
  assert.equal(resolvePins([velha, nova], base).bySlot.get(1).offer_sku, 'NOVA');
  assert.equal(resolvePins([nova, velha], base).bySlot.get(1).offer_sku, 'NOVA');
});

test('a ordem de entrada não muda o resultado', () => {
  const cartProds = [prod({ sku: 'A', line: 'essenciais', subcategory: 'magnesio' })];
  const base = { cartSkus: new Set(['A']), cartProds, slots: 3, now: AGORA };
  const regras = [
    rule({ slot: 1, trigger_type: 'always', trigger_key: '', offer_sku: 'S1' }),
    rule({ slot: 1, trigger_type: 'sku', trigger_key: 'A', offer_sku: 'S2' }),
    rule({
      slot: 1, trigger_type: 'taxonomy', trigger_key: 'line=essenciais',
      trigger_field: 'line', trigger_value: 'essenciais', offer_sku: 'S3',
    }),
    rule({ slot: 2, trigger_type: 'always', trigger_key: '', offer_sku: 'S4' }),
  ];

  const esperado = 'S2';
  // Todas as permutações da disputa da vaga 1 têm que dar o mesmo vencedor.
  for (const perm of permutacoes(regras)) {
    const r = resolvePins(perm, base);
    assert.equal(r.bySlot.get(1).offer_sku, esperado);
    assert.equal(r.bySlot.get(2).offer_sku, 'S4');
  }
  assert.equal(comparePins(regras[1], regras[0]) < 0, true, 'sanidade do comparador');
});

function permutacoes(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const resto = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutacoes(resto)) out.push([arr[i], ...p]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validade e escopo
// ---------------------------------------------------------------------------

test('regra expirada não vale; a que termina hoje em BRT ainda vale', () => {
  const base = { cartSkus: new Set(), cartProds: [], slots: 3, now: AGORA };

  const ontem = rule({ offer_sku: 'ONTEM', ends_at: '2026-09-18T02:59:59.999Z' });
  assert.equal(resolvePins([ontem], base).bySlot.size, 0, 'expirada fica fora');

  // 19/09 em BRT termina às 02:59:59.999Z do dia 20 — é exatamente a conversão
  // que o mapper faz, e sem ela a campanha morreria no próprio dia de fim.
  const hoje = rule({ offer_sku: 'HOJE', ends_at: '2026-09-20T02:59:59.999Z' });
  assert.equal(resolvePins([hoje], base).bySlot.get(1).offer_sku, 'HOJE');

  const amanha = rule({ offer_sku: 'FUTURA', starts_at: '2026-09-20T03:00:00.000Z' });
  assert.equal(resolvePins([amanha], base).bySlot.size, 0, 'ainda não começou');

  const pausada = rule({ offer_sku: 'PAUSADA', active: 0 });
  assert.equal(resolvePins([pausada], base).bySlot.size, 0);
});

test('escopo: regra de outra superfície ou outro goal não age', () => {
  const base = { cartSkus: new Set(), cartProds: [], slots: 3, now: AGORA, surface: 'cart', goal: 'aov' };
  assert.equal(resolvePins([rule({ surface: 'pdp' })], base).bySlot.size, 0);
  assert.equal(resolvePins([rule({ goal: 'stock' })], base).bySlot.size, 0);
  assert.equal(resolvePins([rule({ surface: 'cart', goal: 'aov' })], base).bySlot.size, 1);
  assert.equal(resolvePins([rule({ surface: '*', goal: '*' })], base).bySlot.size, 1);
});

test('vaga além do que o carrinho renderiza é ignorada', () => {
  const base = { cartSkus: new Set(), cartProds: [], slots: 3, now: AGORA };
  const r = resolvePins([rule({ slot: 5, offer_sku: 'LONGE' })], base);
  assert.equal(r.bySlot.size, 0);
  assert.ok(r.discarded.some((d) => d.why === 'slot_fora_do_alcance'));
});

// ---------------------------------------------------------------------------
// Gatilhos
// ---------------------------------------------------------------------------

test('gatilho por SKU só dispara com o SKU no carrinho', () => {
  const r = rule({ trigger_type: 'sku', trigger_key: 'RT01008' });
  assert.equal(pinTriggerMatches(r, { cartSkus: new Set(['RT01008']) }), true);
  assert.equal(pinTriggerMatches(r, { cartSkus: new Set(['OUTRO']) }), false);
});

test('gatilho taxonômico casa com grafia diferente', () => {
  // Medido no seed: BODY SPLASH (26 SKUs) e Body Splash (20) são a MESMA
  // subcategoria e não casavam em ===.
  const r = rule({
    trigger_type: 'taxonomy', trigger_key: 'subcategory=body splash',
    trigger_field: 'subcategory', trigger_value: 'body splash',
  });
  const cartProds = [prod({ subcategory: 'BODY SPLASH' })];
  assert.equal(pinTriggerMatches(r, { cartProds }), true);
});

test('gatilho taxonômico vale contra o carrinho inteiro, não só a âncora', () => {
  const r = rule({
    trigger_type: 'taxonomy', trigger_key: 'line=beleza',
    trigger_field: 'line', trigger_value: 'beleza',
  });
  const cartProds = [
    prod({ sku: 'CARO', line: 'essenciais', price: 200 }),  // âncora
    prod({ sku: 'BARATO', line: 'beleza', price: 30 }),
  ];
  assert.equal(pinTriggerMatches(r, { cartProds }), true);
});

test('"Não se aplica" é sentinela de ausência, não gatilho', () => {
  const r = rule({
    trigger_type: 'taxonomy', trigger_key: 'line=nao se aplica',
    trigger_field: 'line', trigger_value: 'Não se aplica',
  });
  const cartProds = [prod({ line: 'Não se aplica' })];
  assert.equal(pinTriggerMatches(r, { cartProds }), false);
});

test('gatilho com campo taxonômico inválido não dispara', () => {
  const r = rule({
    trigger_type: 'taxonomy', trigger_key: 'marca=x',
    trigger_field: 'brand', trigger_value: 'rituaria',
  });
  assert.equal(pinTriggerMatches(r, { cartProds: [prod({ brand: 'rituaria' })] }), false);
});

// ---------------------------------------------------------------------------
// Montagem das vagas
// ---------------------------------------------------------------------------

test('o mesmo produto fixado em duas vagas ocupa só a menor', () => {
  const base = { cartSkus: new Set(), cartProds: [], slots: 3, now: AGORA };
  const r = resolvePins([
    rule({ slot: 1, offer_sku: 'MESMO' }),
    rule({ slot: 3, offer_sku: 'MESMO' }),
  ], base);
  assert.equal(r.bySlot.get(1).offer_sku, 'MESMO');
  assert.equal(r.bySlot.has(3), false);
  assert.equal(r.pinnedSkus.size, 1);
  assert.ok(r.discarded.some((d) => d.why === 'produto_ja_fixado_em_vaga_menor'));
});

test('vaga sem regra cai no ranking por score, e nada se repete', () => {
  // FIX tem a MELHOR margem: sem curadoria ele seria o primeiro. Fixá-lo na
  // vaga 3 prova as duas coisas de uma vez — o pin empurra para baixo, e as
  // vagas livres se preenchem por score.
  const pool = [
    prod({ sku: 'A', price: 60, cogs: 12 }),   // margem 0,70
    prod({ sku: 'B', price: 55, cogs: 13 }),   // margem 0,66
    prod({ sku: 'FIX', price: 50, cogs: 5 }),  // margem 0,80
  ];
  const semPin = decide(pool, ctx({ cartTotal: 200 }));
  assert.equal(semPin.offers[0].sku, 'FIX', 'sanidade: sem pin ele lidera');

  const c = ctx({ cartTotal: 200, pinRules: [rule({ slot: 3, offer_sku: 'FIX' })] });
  const { offers, pins } = decide(pool, c);

  assert.equal(offers.length, 3);
  assert.deepEqual(offers.slice(0, 2).map((o) => o.sku), ['A', 'B'], 'vagas livres por score');
  assert.equal(offers[2].sku, 'FIX', 'o fixado fica na vaga 3');
  assert.equal(offers[2].slot, 3);
  assert.equal(offers[2].pinned, true);
  assert.equal(offers[0].pinned, false);
  assert.equal(offers[1].pinned, false);
  assert.equal(new Set(offers.map((o) => o.sku)).size, 3, 'nenhum SKU repetido');
  assert.equal(pins.length, 1);
  assert.equal(pins[0].applied, true);
  assert.equal(pins[0].slot, 3);
});

test('a saída identifica de que regra a oferta veio', () => {
  const c = ctx({
    cartTotal: 200,
    pinRules: [rule({ slot: 1, trigger_type: 'always', trigger_key: '', offer_sku: 'FIX' })],
  });
  const { offers } = decide([prod({ sku: 'FIX' }), prod({ sku: 'OUTRO', price: 60, cogs: 12 })], c);
  assert.equal(offers[0].sku, 'FIX');
  assert.equal(offers[0].pin_rule, '1|always|');
  assert.equal(offers[0].slot, 1);
  assert.equal(offers[1].pin_rule, null);
  assert.equal(offers[1].slot, 2);
});

test('pin pedido na vaga 3 com ranking curto relata a vaga real', () => {
  // Só o fixado sobrevive: não há como deixar as vagas 1 e 2 vazias, então o
  // ranking encolhe — e o relatório guarda o que foi PEDIDO.
  const c = ctx({ cartTotal: 200, pinRules: [rule({ slot: 3, offer_sku: 'FIX' })] });
  const { offers, pins } = decide([prod({ sku: 'FIX' })], c);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].slot, 1);
  assert.equal(pins[0].slot, 1, 'a vaga real');
  assert.equal(pins[0].slot_pedido, 3, 'e a pedida, para a diferença não ficar invisível');
});

test('assembleSlots sem regra devolve o ranking intacto', () => {
  const scored = [{ sku: 'A' }, { sku: 'B' }];
  const r = assembleSlots(scored, new Map(), new Map(), 3);
  assert.equal(r.offers, scored, 'a mesma referência: nada foi reconstruído');
  assert.deepEqual(r.pins, []);
  assert.equal('slot' in scored[0], false, 'nem os campos novos aparecem');
});

// ---------------------------------------------------------------------------
// Guarda de regressão
// ---------------------------------------------------------------------------

test('sem curadoria, decide() devolve exatamente o que devolvia antes', () => {
  const pool = [
    prod({ sku: 'A', price: 60, cogs: 12 }),
    prod({ sku: 'B', price: 55, cogs: 13 }),
    prod({ sku: 'C', price: 40, cogs: 10 }),
  ];
  const vazio = decide(pool, ctx({ pinRules: [] }));
  const ausente = decide(pool, ctx({ pinRules: undefined }));

  assert.deepEqual(vazio.offers.map((o) => o.sku), ausente.offers.map((o) => o.sku));
  assert.deepEqual(vazio.pins, []);
  assert.deepEqual(ausente.pins, []);
  for (const o of vazio.offers) {
    assert.equal('slot' in o, false, 'nenhum campo novo no payload sem curadoria');
    assert.equal('pinned' in o, false);
    assert.equal('pin_rule' in o, false);
  }
});

test('regra que não casa com o carrinho é inerte, e o descarte diz por quê', () => {
  const pool = [prod({ sku: 'A', price: 60, cogs: 12 }), prod({ sku: 'FIX' })];
  const sem = decide(pool, ctx({ pinRules: [] }));
  const com = decide(pool, ctx({
    cartSkus: new Set(['NADA']),
    pinRules: [rule({ slot: 1, trigger_type: 'sku', trigger_key: 'AUSENTE', offer_sku: 'FIX' })],
  }));
  assert.deepEqual(com.offers.map((o) => o.sku), sem.offers.map((o) => o.sku));
  assert.deepEqual(com.pins, []);

  const r = resolvePins(
    [rule({ trigger_type: 'sku', trigger_key: 'AUSENTE', offer_sku: 'FIX' })],
    { cartSkus: new Set(['NADA']), cartProds: [], slots: 3, now: AGORA },
  );
  assert.ok(r.discarded.some((d) => d.why === 'gatilho_nao_casou'));
});

test('pinKey é a chave natural sem a marca', () => {
  assert.equal(pinKey({ slot: 2, trigger_type: 'sku', trigger_key: 'RT01008' }), '2|sku|RT01008');
  assert.equal(pinKey({ slot: 1, trigger_type: 'always', trigger_key: '' }), '1|always|');
  assert.equal(pinKey({ slot: 3, trigger_type: 'always' }), '3|always|');
});

// ---------------------------------------------------------------------------
// Correções vindas do code review
// ---------------------------------------------------------------------------

test('escopo de superfície casa sem depender de caixa', () => {
  // A regra é gravada normalizada; `surface` chega cru do request. Comparar sem
  // normalizar faria a regra sumir sem nenhum sinal.
  const base = { cartSkus: new Set(), cartProds: [], slots: 3, now: AGORA, goal: 'aov' };
  const r = rule({ surface: 'pdp', offer_sku: 'P' });

  assert.equal(resolvePins([r], { ...base, surface: 'PDP' }).bySlot.size, 1);
  assert.equal(resolvePins([r], { ...base, surface: ' pdp ' }).bySlot.size, 1);
  assert.equal(resolvePins([r], { ...base, surface: 'cart' }).bySlot.size, 0);
});

test('vaga fora do alcance é descartada COM o n no relatório', () => {
  // O simulador roda com n=10 por padrão e a loja com n bem menor: uma regra na
  // vaga 3 pode agir no simulador e nunca agir em produção. O descarte é o
  // único lugar onde isso aparece.
  const base = { cartSkus: new Set(), cartProds: [], slots: 1, now: AGORA };
  const r = resolvePins([rule({ slot: 3, offer_sku: 'LONGE' })], base);
  assert.equal(r.bySlot.size, 0);
  const d = r.discarded.find((x) => x.why === 'slot_fora_do_alcance');
  assert.ok(d);
  assert.equal(d.detail, 'vaga 3 > n=1');
  assert.equal(d.offer_sku, 'LONGE');
});

test('decide devolve o descarte, com o motivo de cada regra que não agiu', () => {
  const c = ctx({
    cartTotal: 200,
    slots: 3,
    pinRules: [
      rule({ slot: 1, offer_sku: 'A', active: 0 }),
      rule({ slot: 2, offer_sku: 'B', ends_at: '2020-01-01T00:00:00.000Z' }),
      rule({ slot: 3, trigger_type: 'sku', trigger_key: 'NAO_ESTA', offer_sku: 'C' }),
    ],
  });
  const { pins, pinsDiscarded } = decide([prod({ sku: 'Z', price: 60, cogs: 12 })], c);
  assert.deepEqual(pins, []);
  assert.deepEqual(
    pinsDiscarded.map((d) => d.why).sort(),
    ['expirada', 'gatilho_nao_casou', 'pausada'],
  );
});

test('assembleSlots protege contra o mesmo produto em duas vagas', () => {
  // resolvePins já desduplica, então isto guarda quem chama assembleSlots
  // direto. Sem o teste, a guarda vira código morto sem ninguém notar.
  const scored = [{ sku: 'A' }, { sku: 'B' }];
  const bySlot = new Map([
    [1, { slot: 1, trigger_type: 'always', trigger_key: '', offer_sku: 'A' }],
    [2, { slot: 2, trigger_type: 'always', trigger_key: '', offer_sku: 'A' }],
  ]);
  const { offers, pins } = assembleSlots(scored, bySlot, new Map(), 3);
  assert.equal(offers[0].sku, 'A');
  assert.equal(offers[0].pinned, true);
  const duplicada = pins.find((p) => p.slot_pedido === 2);
  assert.equal(duplicada.applied, false);
  assert.equal(duplicada.fallback_reason, 'produto_ja_fixado_em_outra_vaga');
});

test('o motivo mais acionável vence no descarte', () => {
  // Pausada E na vaga 5 com n=3: relatar "fora do alcance" faria o operador
  // aumentar o n do tema e nada acontecer — ela estava pausada o tempo todo.
  const base = { cartSkus: new Set(), cartProds: [], slots: 3, now: AGORA };
  const r = resolvePins([rule({ slot: 5, active: 0, offer_sku: 'X' })], base);
  assert.equal(r.discarded[0].why, 'pausada');

  const expirada = resolvePins(
    [rule({ slot: 5, ends_at: '2020-01-01T00:00:00.000Z', offer_sku: 'X' })], base,
  );
  assert.equal(expirada.discarded[0].why, 'expirada');

  const semGatilho = resolvePins(
    [rule({ slot: 5, trigger_type: 'sku', trigger_key: 'AUSENTE', offer_sku: 'X' })], base,
  );
  assert.equal(semGatilho.discarded[0].why, 'gatilho_nao_casou');

  // Só quando nada mais impede é que a vaga é o motivo de fato.
  const sobra = resolvePins([rule({ slot: 5, offer_sku: 'X' })], base);
  assert.equal(sobra.discarded[0].why, 'slot_fora_do_alcance');
  assert.equal(sobra.discarded[0].detail, 'vaga 5 > n=3');
});

test('sem vaga renderizada, nenhuma regra ganha dispensa de filtro', () => {
  // assembleSlots não coloca nada com n < 1. Se resolvePins continuasse achando
  // a regra elegível, o produto entraria em pinnedSkus e ganharia a dispensa de
  // teto e de preço mínimo — podendo vencer no score — sem nenhum `pinned` ou
  // `pins` explicando de onde veio a exceção.
  const caro = prod({ sku: 'CARO', price: 300, cogs: 60 });
  const comum = prod({ sku: 'OK', price: 45, cogs: 11 });
  const c = ctx({
    cartTotal: 89.90,
    slots: 0,
    pinRules: [rule({ slot: 1, offer_sku: 'CARO' })],
  });
  const { offers, rejected, pins, pinsDiscarded } = decide([caro, comum], c);

  assert.ok(rejected.some((r) => r.sku === 'CARO' && r.code === 'over_price_cap'),
    'sem vaga, o teto volta a valer');
  assert.ok(!offers.some((o) => o.sku === 'CARO'));
  assert.deepEqual(pins, []);
  assert.equal(pinsDiscarded[0].why, 'sem_vagas');
});

test('vice assume a vaga quando a vencedora cai por produto duplicado', () => {
  // Vaga 1 fixa X. Na vaga 3, a regra por SKU também aponta X (e perde por
  // duplicidade) e a regra "sempre" aponta Y. Antes, as duas eram descartadas e
  // a vaga 3 ficava órfã — com o operador lendo "vaga já tomada", que era falso.
  const cartProds = [prod({ sku: 'A' })];
  const base = { cartSkus: new Set(['A']), cartProds, slots: 3, now: AGORA };
  const r = resolvePins([
    rule({ slot: 1, trigger_type: 'always', trigger_key: '', offer_sku: 'X' }),
    rule({ slot: 3, trigger_type: 'sku', trigger_key: 'A', offer_sku: 'X' }),
    rule({ slot: 3, trigger_type: 'always', trigger_key: '', offer_sku: 'Y' }),
  ], base);

  assert.equal(r.bySlot.get(1).offer_sku, 'X');
  assert.equal(r.bySlot.get(3).offer_sku, 'Y', 'a vice assumiu');
  assert.deepEqual([...r.pinnedSkus].sort(), ['X', 'Y']);
  const motivos = r.discarded.map((d) => d.why);
  assert.deepEqual(motivos, ['produto_ja_fixado_em_vaga_menor']);
});

test('quem perde a disputa é relatado como vaga tomada, e só isso', () => {
  const cartProds = [prod({ sku: 'A' })];
  const base = { cartSkus: new Set(['A']), cartProds, slots: 3, now: AGORA };
  const r = resolvePins([
    rule({ slot: 1, trigger_type: 'sku', trigger_key: 'A', offer_sku: 'VENCE' }),
    rule({ slot: 1, trigger_type: 'always', trigger_key: '', offer_sku: 'PERDE' }),
  ], base);
  assert.equal(r.bySlot.get(1).offer_sku, 'VENCE');
  assert.equal(r.discarded[0].why, 'vaga_tomada_por_regra_mais_especifica');
  assert.equal(r.discarded[0].offer_sku, 'PERDE');
});

test('só fixado no pool não relata faixa de gap relaxada', () => {
  // A faixa não derrubou ninguém — não havia candidato comum. Dizer que foi
  // relaxada é relatar no decision_log um afrouxamento que não aconteceu.
  const fixado = prod({ sku: 'PIN', price: 100, cogs: 25 });
  const c = ctx({ cartTotal: 200, gap: 30, pinRules: [rule({ slot: 1, offer_sku: 'PIN' })] });
  const { offers, relaxed } = decide([fixado], c);
  assert.deepEqual(relaxed, []);
  assert.equal(offers[0].sku, 'PIN');
});

test('oferta fixada não promete co-compra que não existe', () => {
  // A curadoria coloca na vitrine justamente o que ninguém comprou junto ainda.
  const lancamento = prod({ sku: 'NOVO', title: 'Lançamento sem histórico', price: 250, cogs: 50 });
  const c = ctx({ cartTotal: 89.90, pinRules: [rule({ slot: 1, offer_sku: 'NOVO' })] });
  const { offers } = decide([lancamento], c);
  assert.equal(offers[0].pinned, true);
  assert.equal(offers[0].copy, 'Leve também Lançamento sem histórico');
  assert.ok(!/Quem levou esse/.test(offers[0].copy));
});

test('escopo exato vence o curinga na mesma vaga', () => {
  // Desde que o escopo entrou na PK, as duas regras coexistem e AMBAS são
  // elegíveis num request de carrinho. Sem escopo no comparador, quem escreveu
  // por último ganhava — uma regra curinga nova tomaria a vaga de uma feita sob
  // medida para o carrinho.
  const base = { cartSkus: new Set(), cartProds: [], slots: 3, now: AGORA, surface: 'cart', goal: 'aov' };
  const curinga = rule({ slot: 1, offer_sku: 'CURINGA', surface: '*', goal: '*', updated_at: '2026-09-18T00:00:00.000Z' });
  const exata = rule({ slot: 1, offer_sku: 'EXATA', surface: 'cart', goal: '*', updated_at: '2026-01-01T00:00:00.000Z' });

  assert.equal(resolvePins([curinga, exata], base).bySlot.get(1).offer_sku, 'EXATA');
  assert.equal(resolvePins([exata, curinga], base).bySlot.get(1).offer_sku, 'EXATA');

  // E amarrar as duas dimensões é mais específico que amarrar uma.
  const duas = rule({ slot: 1, offer_sku: 'DUAS', surface: 'cart', goal: 'aov' });
  assert.equal(resolvePins([exata, duas, curinga], base).bySlot.get(1).offer_sku, 'DUAS');
});

test('pinKey distingue regras que só diferem no escopo', () => {
  // Sem isso, as duas apareceriam com a MESMA chave no pins[] e no log, e não
  // haveria como saber qual agiu.
  assert.equal(pinKey({ slot: 1, trigger_type: 'always', trigger_key: '' }), '1|always|');
  assert.equal(pinKey({ slot: 1, trigger_type: 'always', trigger_key: '', surface: '*', goal: '*' }), '1|always|');
  assert.equal(
    pinKey({ slot: 1, trigger_type: 'always', trigger_key: '', surface: 'cart', goal: '*' }),
    '1|always||cart|*',
  );
  assert.notEqual(
    pinKey({ slot: 1, trigger_type: 'always', trigger_key: '', surface: 'cart' }),
    pinKey({ slot: 1, trigger_type: 'always', trigger_key: '', surface: 'pdp' }),
  );
});

test('empate com mesmo updated_at ainda tem ordem total', () => {
  // Um lote do /curate/pins carimba o MESMO `now` em todas as linhas: sem
  // escopo na chave, o desempate final empatava e o vencedor caía na ordem do
  // group_concat, que não tem ORDER BY.
  const base = { cartSkus: new Set(), cartProds: [], slots: 3, now: AGORA, surface: 'cart', goal: 'aov' };
  const mesmo = '2026-09-19T00:00:00.000Z';
  const a = rule({ slot: 1, offer_sku: 'A', surface: 'cart', updated_at: mesmo });
  const b = rule({ slot: 1, offer_sku: 'B', surface: '*', updated_at: mesmo });
  assert.notEqual(comparePins(a, b), 0, 'não pode empatar');
  assert.equal(resolvePins([a, b], base).bySlot.get(1).offer_sku, 'A');
  assert.equal(resolvePins([b, a], base).bySlot.get(1).offer_sku, 'A');
});

test('assembleSlots relata a vaga além do alcance em vez de engolir a regra', () => {
  const scored = [{ sku: 'A' }, { sku: 'B' }];
  const bySlot = new Map([[5, { slot: 5, trigger_type: 'always', trigger_key: '', offer_sku: 'A' }]]);
  const { offers, pins } = assembleSlots(scored, bySlot, new Map(), 3);
  assert.equal(pins.length, 1, 'a regra não pode sumir sem linha no relatório');
  assert.equal(pins[0].applied, false);
  assert.equal(pins[0].fallback_reason, 'slot_fora_do_alcance');
  assert.equal(pins[0].slot_pedido, 5);
  assert.ok(!offers.some((o) => o.pinned));
});
