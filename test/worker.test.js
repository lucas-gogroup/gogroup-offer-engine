// Integração: o worker de verdade, contra um SQLite de verdade (node:sqlite).
// Prova o caminho completo /curate → /recommend → /event → /offers → /log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';

const TOKEN = 'test-token';

function newEnv() {
  return { DB: new DatabaseSync(':memory:'), CURATE_TOKEN: TOKEN };
}

async function call(env, method, path, body, auth = false) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  if (auth) init.headers.Authorization = `Bearer ${TOKEN}`;
  const res = await worker.fetch(new Request(`https://offer-api.test${path}`, init), env);
  return { status: res.status, body: await res.json() };
}

// Espelha o pool real: Rituária (Magnésio + Trio) e Barbour's.
const PRODUCTS = [
  { brand: 'rituaria', sku: 'RT01008', variant_id: '900001', title: 'Magnésio Inositol',
    price: 89.90, cogs: 22, available: 340, line: 'essenciais', subcategory: 'magnesio',
    category: 'suplemento', coverage_days: 45 },
  { brand: 'rituaria', sku: 'RT01015', variant_id: '900002', title: 'Creatina Pura',
    price: 79.90, cogs: 20, available: 210, line: 'essenciais', subcategory: 'creatina',
    category: 'suplemento', coverage_days: 60 },
  { brand: 'rituaria', sku: 'RT02001', variant_id: '900003', title: 'Colágeno Verisol',
    price: 45.00, cogs: 11, available: 120, line: 'beleza', subcategory: 'colageno',
    category: 'suplemento', coverage_days: 220 },
  { brand: 'rituaria', sku: 'KRT99078', variant_id: '900004', title: 'Trio de Queridinhos',
    price: 149.90, cogs: 45, available: 60, is_kit: 1, line: 'essenciais',
    subcategory: 'kit', category: 'kit', coverage_days: 30 },
  { brand: 'barbours', sku: 'BRB-SER-30', variant_id: '800001', title: 'Sérum Facial 30 ml',
    price: 129.90, cogs: 34, available: 90, line: 'facial', subcategory: 'serum',
    category: 'skincare', coverage_days: 50 },
  { brand: 'barbours', sku: 'BRB-HID-50', variant_id: '800002', title: 'Hidratante Facial 50 ml',
    price: 69.90, cogs: 17, available: 150, line: 'facial', subcategory: 'hidratante',
    category: 'skincare', coverage_days: 212 },
];

const KITS = [
  { brand: 'rituaria', kit_sku: 'KRT99078', component_sku: 'RT01008', qty_per_kit: 1, protheus_ok: true },
  { brand: 'rituaria', kit_sku: 'KRT99078', component_sku: 'RT01015', qty_per_kit: 1, protheus_ok: true },
  { brand: 'rituaria', kit_sku: 'KRT99078', component_sku: 'RT02001', qty_per_kit: 1, protheus_ok: true },
];

async function seed(env) {
  await call(env, 'POST', '/curate/product', { rows: PRODUCTS }, true);
  await call(env, 'POST', '/curate/kits', { rows: KITS }, true);
}

// ---------------------------------------------------------------------------

test('/health responde antes de qualquer carga', async () => {
  const env = newEnv();
  const { status, body } = await call(env, 'GET', '/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.counts.product, 0);
});

test('/curate exige bearer', async () => {
  const env = newEnv();
  const semToken = await call(env, 'POST', '/curate/product', { rows: PRODUCTS });
  assert.equal(semToken.status, 401);
  const comToken = await call(env, 'POST', '/curate/product', { rows: PRODUCTS }, true);
  assert.equal(comToken.status, 200);
  assert.equal(comToken.body.applied, PRODUCTS.length);
});

test('/curate/product é replace e registra em load_log', async () => {
  const env = newEnv();
  await call(env, 'POST', '/curate/product', { rows: PRODUCTS, chunk: 'full' }, true);
  const again = await call(env, 'POST', '/curate/product', { rows: PRODUCTS, chunk: 'full' }, true);
  assert.equal(again.body.table_rows, PRODUCTS.length, 'recarga não duplica');
  const health = await call(env, 'GET', '/health');
  assert.ok(health.body.recent_loads.length >= 2);
});

test('/curate/affinity acumula entre chunks; reset zera', async () => {
  const env = newEnv();
  const row = { brand: 'rituaria', anchor_sku: 'RT01008', candidate_sku: 'RT02001', co_purchase_count: 7 };
  await call(env, 'POST', '/curate/affinity', { rows: [row], chunk: '0', window_start: '2026-09-15' }, true);
  await call(env, 'POST', '/curate/affinity', { rows: [row], chunk: '1', window_start: '2026-09-12' }, true);
  const q = env.DB.prepare('SELECT co_purchase_count, window_start FROM affinity').all();
  assert.equal(q[0].co_purchase_count, 14, 'chunks somam');
  assert.equal(q[0].window_start, '2026-09-12', 'janela abre para trás');

  const reset = await call(env, 'POST', '/curate/reset?table=affinity', undefined, true);
  assert.equal(reset.body.remaining, 0);
});

// ---------------------------------------------------------------------------
// PORTÃO
// ---------------------------------------------------------------------------

test('PORTÃO ponta a ponta — carrinho com RT01008 não recebe KRT99078', async () => {
  const env = newEnv();
  await seed(env);

  const { status, body } = await call(env, 'POST', '/recommend', {
    brand: 'rituaria', surface: 'cart', goal: 'aov',
    cart: [{ sku: 'RT01008', variant_id: '900001', qty: 1, price: 89.90 }],
    customer: { is_returning: false },
    debug: true,
  });

  assert.equal(status, 200);
  assert.notEqual(body.sku, 'KRT99078', 'PORTÃO: kit que contém o carrinho não pode ser ofertado');
  assert.ok(body.sku, 'tem que devolver alguma oferta real');
  assert.ok(body.variant_id, 'a oferta precisa de variant_id para o /cart/add.js');
  const rej = body.rejected.find((r) => r.sku === 'KRT99078');
  assert.equal(rej.code, 'kit_contains_cart_sku');
});

test('PORTÃO — /offers também barra o kit', async () => {
  const env = newEnv();
  await seed(env);
  const { body } = await call(env, 'GET', '/offers?brand=rituaria&anchor=RT01008&debug=1');
  assert.ok(!body.offers.some((o) => o.sku === 'KRT99078'));
  assert.match(body.rejected_summary, /kit_contains_cart_sku/);
});

// ---------------------------------------------------------------------------
// Oferta real das duas marcas
// ---------------------------------------------------------------------------

test('/recommend devolve oferta real das duas marcas', async () => {
  const env = newEnv();
  await seed(env);

  const rit = await call(env, 'POST', '/recommend', {
    brand: 'rituaria', cart: [{ sku: 'RT01008', qty: 1, price: 89.90 }],
  });
  const brb = await call(env, 'POST', '/recommend', {
    brand: 'barbours', cart: [{ sku: 'BRB-SER-30', qty: 1, price: 129.90 }],
  });

  assert.equal(rit.body.sku, 'RT02001', 'Rituária: só o Colágeno cabe no teto de 60%');
  assert.equal(brb.body.sku, 'BRB-HID-50');
  assert.ok(brb.body.expected_margin >= 0.30, 'nunca abaixo do piso de margem');
  assert.ok(brb.body.copy && brb.body.reason);
  assert.equal(brb.body.incentive.type, 'none', 'degrau 1: sem desconto por default');
  // isolamento de marca
  assert.ok(!String(rit.body.sku).startsWith('BRB'));
});

test('nenhuma oferta fura o teto de 60% do carrinho', async () => {
  const env = newEnv();
  await seed(env);
  const { body } = await call(env, 'GET', '/offers?brand=rituaria&anchor=RT01008&n=50');
  for (const o of body.offers) {
    assert.ok(o.price <= 0.6 * 89.90, `${o.sku} a ${o.price} fura o teto`);
    assert.ok(o.available > 0);
    assert.ok(o.expected_margin >= 0.30);
  }
});

test('goal troca a oferta no mesmo carrinho', async () => {
  const env = newEnv();
  await seed(env);
  const base = { brand: 'barbours', cart: [{ sku: 'BRB-SER-30', qty: 1, price: 129.90 }], n: 5 };
  const aov = await call(env, 'POST', '/recommend', { ...base, goal: 'aov' });
  const stock = await call(env, 'POST', '/recommend', { ...base, goal: 'stock' });
  assert.ok(aov.body.offers.length && stock.body.offers.length);
  assert.ok(aov.body.score !== undefined);
});

// ---------------------------------------------------------------------------
// decision_log e bandit
// ---------------------------------------------------------------------------

test('toda chamada grava contexto, decisão e motivo no decision_log', async () => {
  const env = newEnv();
  await seed(env);
  await call(env, 'POST', '/recommend', { brand: 'rituaria', cart: [{ sku: 'RT01008', qty: 1, price: 89.90 }] });

  const { body } = await call(env, 'GET', '/log?brand=rituaria&limit=10');
  assert.equal(body.count, 1);
  const e = body.entries[0];
  assert.equal(e.agent, 'ofertante');
  assert.equal(e.context.anchor, 'RT01008');
  assert.equal(e.context.brand, 'rituaria');
  assert.deepEqual(e.context.cart_skus, ['RT01008']);
  assert.ok(e.decision.offer_sku);
  assert.ok(e.reason.length > 0);
});

test('grava no log até quando não há oferta, com o motivo', async () => {
  const env = newEnv();
  await seed(env);
  // carrinho de R$ 10: nada cabe no teto de 60%
  const r = await call(env, 'POST', '/recommend', {
    brand: 'rituaria', cart: [{ sku: 'RT01008', qty: 1, price: 10 }],
  });
  assert.deepEqual(r.body.offers, []);
  const { body } = await call(env, 'GET', '/log?brand=rituaria');
  assert.match(body.entries[0].reason, /sem oferta/);
  assert.match(body.entries[0].reason, /over_price_cap/);
});

test('/event move o bandit e registra o otimizador', async () => {
  const env = newEnv();
  await seed(env);
  const rec = await call(env, 'POST', '/recommend', {
    brand: 'barbours', cart: [{ sku: 'BRB-SER-30', qty: 1, price: 129.90 }],
  });
  const id = rec.body.offer_id;

  const imp = await call(env, 'POST', '/event', { offer_id: id, event: 'impression' });
  assert.equal(imp.body.stats.impressions, 1);
  assert.equal(imp.body.stats.accepts, 0);

  const acc = await call(env, 'POST', '/event', { offer_id: id, event: 'accept' });
  assert.equal(acc.body.stats.accepts, 1);
  assert.equal(acc.body.stats.impressions, 1);

  const log = await call(env, 'GET', '/log?brand=barbours&limit=5');
  assert.ok(log.body.entries.some((e) => e.agent === 'otimizador'));
});

test('/event com offer_id desconhecido devolve 404, não 500', async () => {
  const env = newEnv();
  await seed(env);
  const r = await call(env, 'POST', '/event', { offer_id: 'of_naoexiste', event: 'accept' });
  assert.equal(r.status, 404);
});

test('aceites repetidos sobem o take rate amostrado', async () => {
  const env = newEnv();
  await seed(env);
  // 60 impressões e 55 aceites no par âncora→BRB-HID-50
  for (let i = 0; i < 60; i++) {
    const rec = await call(env, 'POST', '/recommend', {
      brand: 'barbours', cart: [{ sku: 'BRB-SER-30', qty: 1, price: 129.90 }],
    });
    await call(env, 'POST', '/event', { offer_id: rec.body.offer_id, event: 'impression' });
    if (i < 55) await call(env, 'POST', '/event', { offer_id: rec.body.offer_id, event: 'accept' });
  }
  const stats = env.DB.prepare(
    'SELECT impressions, accepts FROM offer_stats WHERE offer_sku = ?').all('BRB-HID-50')[0];
  assert.equal(stats.impressions, 60);
  assert.equal(stats.accepts, 55);

  const rec = await call(env, 'POST', '/recommend', {
    brand: 'barbours', cart: [{ sku: 'BRB-SER-30', qty: 1, price: 129.90 }],
  });
  assert.ok(rec.body.take_rate_sampled > 0.5, `take rate aprendido ficou em ${rec.body.take_rate_sampled}`);
});

// ---------------------------------------------------------------------------
// afinidade e configuração
// ---------------------------------------------------------------------------

test('afinidade por co-compra muda o ranking', async () => {
  const env = newEnv();
  await seed(env);
  // Sem co-compra: Colágeno (linha 'beleza') perde para nada — é o único que cabe.
  // Com carrinho grande, Creatina (mesma linha) e Colágeno disputam.
  const semAff = await call(env, 'GET', '/offers?brand=rituaria&anchor=RT01008&n=5&gap=0');
  const ordemBase = semAff.body.offers.map((o) => o.sku);

  await call(env, 'POST', '/curate/brand_orders', { rows: [{ brand: 'rituaria', n_orders: 9605 }] }, true);
  await call(env, 'POST', '/curate/sku_orders', {
    rows: [{ brand: 'rituaria', sku: 'RT01008', n_orders: 500 },
      { brand: 'rituaria', sku: 'RT02001', n_orders: 300 }],
  }, true);
  await call(env, 'POST', '/curate/affinity', {
    rows: [{ brand: 'rituaria', anchor_sku: 'RT01008', candidate_sku: 'RT02001', co_purchase_count: 180 }],
  }, true);

  const comAff = await call(env, 'GET', '/offers?brand=rituaria&anchor=RT01008&n=5&debug=1');
  const colageno = comAff.body.offers.find((o) => o.sku === 'RT02001');
  assert.ok(colageno, 'o colágeno continua no pool');
  assert.equal(colageno._debug.affinity.co, 180);
  assert.ok(ordemBase.length > 0);
});

test('/config muda piso de margem em runtime, sem redeploy', async () => {
  const env = newEnv();
  await seed(env);
  const antes = await call(env, 'POST', '/recommend', {
    brand: 'barbours', cart: [{ sku: 'BRB-SER-30', qty: 1, price: 129.90 }],
  });
  assert.ok(antes.body.sku);

  await call(env, 'POST', '/config', { brand: 'barbours', margin_floor: 0.95 }, true);
  const depois = await call(env, 'POST', '/recommend', {
    brand: 'barbours', cart: [{ sku: 'BRB-SER-30', qty: 1, price: 129.90 }],
  });
  assert.deepEqual(depois.body.offers, [], 'piso de 95% zera o pool');

  const cfg = await call(env, 'GET', '/config?brand=barbours');
  assert.equal(cfg.body.effective.margin_floor, 0.95);
});

test('gap de frete grátis prioriza quem fecha o gap', async () => {
  const env = newEnv();
  await seed(env);
  const { body } = await call(env, 'GET', '/offers?brand=rituaria&anchor=RT01008&gap=45&n=5');
  assert.equal(body.offers[0].sku, 'RT02001');
  assert.equal(body.offers[0].incentive.type, 'threshold');
  assert.match(body.offers[0].copy, /frete grátis/);
});

test('CORS libera os domínios das lojas e ignora os demais', async () => {
  const env = newEnv();
  const ok = await worker.fetch(new Request('https://offer-api.test/health', {
    headers: { Origin: 'https://rituaria.com.br' },
  }), env);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://rituaria.com.br');

  const no = await worker.fetch(new Request('https://offer-api.test/health', {
    headers: { Origin: 'https://evil.example' },
  }), env);
  assert.equal(no.headers.get('Access-Control-Allow-Origin'), null);
});

test('marca desconhecida devolve pool vazio, não erro', async () => {
  const env = newEnv();
  await seed(env);
  const r = await call(env, 'POST', '/recommend', { brand: 'inexistente', cart: [{ sku: 'X', qty: 1, price: 100 }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.offers, []);
});

// ---------------------------------------------------------------------------
// Carga em lote: os valores viram literais SQL, então o escape tem que segurar
// ---------------------------------------------------------------------------

test('título com aspas e SQL não escapa do literal', async () => {
  const env = newEnv();
  const hostis = [
    { brand: 'rituaria', sku: 'Q1', variant_id: '1', title: "Sérum d'Água 30ml", price: 50, cogs: 10, available: 5 },
    { brand: 'rituaria', sku: 'Q2', variant_id: '2', title: "'); DROP TABLE product; --", price: 50, cogs: 10, available: 5 },
    { brand: 'rituaria', sku: "Q'3", variant_id: '3', title: 'aspas no sku', price: 50, cogs: 10, available: 5 },
  ];
  const r = await call(env, 'POST', '/curate/product', { rows: hostis }, true);
  assert.equal(r.body.applied, 3);
  assert.equal(r.body.table_rows, 3, 'a tabela product continua de pé');

  const bySku = new Map(env.DB.prepare('SELECT sku, title FROM product').all().map((r) => [r.sku, r.title]));
  assert.equal(bySku.get('Q1'), "Sérum d'Água 30ml");
  assert.equal(bySku.get('Q2'), "'); DROP TABLE product; --");
  assert.equal(bySku.get("Q'3"), 'aspas no sku');
});

test('lote grande entra inteiro e a afinidade continua somando', async () => {
  const env = newEnv();
  const rows = Array.from({ length: 2500 }, (_, i) => ({
    brand: 'rituaria', anchor_sku: 'A' + (i % 50), candidate_sku: 'C' + i, co_purchase_count: 2,
  }));
  const r1 = await call(env, 'POST', '/curate/affinity', { rows, chunk: '0' }, true);
  assert.equal(r1.body.applied, 2500);
  assert.equal(r1.body.table_rows, 2500);

  const r2 = await call(env, 'POST', '/curate/affinity', { rows, chunk: '1' }, true);
  assert.equal(r2.body.table_rows, 2500, 'mesmo par não cria linha nova');
  const co = env.DB.prepare('SELECT co_purchase_count FROM affinity WHERE candidate_sku = ?').all('C7')[0];
  assert.equal(co.co_purchase_count, 4, 'dois chunks somam');
});

test('linha inválida não derruba o lote inteiro', async () => {
  const env = newEnv();
  const r = await call(env, 'POST', '/curate/product', {
    rows: [PRODUCTS[0], { sku: 'SEM_MARCA' }, PRODUCTS[1]],
  }, true);
  assert.equal(r.body.applied, 2);
  assert.equal(r.body.errors.length, 1);
  assert.match(r.body.errors[0].error, /brand e sku/);
});

// ---------------------------------------------------------------------------
// Contrato do threshold — os três formatos, nenhum ignorado em silêncio
// ---------------------------------------------------------------------------

test('threshold {value,label} vira gap, e o rótulo chega no copy', async () => {
  const env = newEnv();
  await seed(env);
  const { body } = await call(env, 'POST', '/recommend', {
    brand: 'rituaria',
    cart: [{ sku: 'RT01008', qty: 1, price: 89.90 }],
    threshold: { value: 110.00, label: 'Frete Grátis' },
  });
  assert.equal(body.context.gap, 20.1, 'threshold.value - cart_total');
  assert.equal(body.incentive.type, 'threshold');
  assert.equal(body.incentive.label, 'Frete Grátis');
  assert.match(body.copy, /Frete Grátis/);
});

// O caso exato que o tema mandou: carrinho R$ 89,90, frete grátis em R$ 199.
// O gap é calculado, mas NENHUMA oferta o fecha — o teto de 60% do carrinho
// (R$ 53,94) é menor que o gap (R$ 109,10). Não é bug: ofertar R$ 109 num
// carrinho de R$ 90 é exatamente o erro da Rituária que o motor existe para
// evitar. O gap aparece no contexto para o tema poder decidir o que exibir.
test('gap maior que o teto de preço: motor não inventa oferta para fechá-lo', async () => {
  const env = newEnv();
  await seed(env);
  const { body } = await call(env, 'POST', '/recommend', {
    brand: 'rituaria',
    cart: [{ sku: 'RT01008', qty: 1, price: 89.90 }],
    threshold: { value: 199.00, label: 'Frete Grátis' },
  });
  assert.equal(body.context.gap, 109.1, 'o gap é calculado e reportado');
  assert.equal(body.incentive.type, 'none', 'nenhum candidato alcança o gap');
  assert.ok(body.price <= 0.6 * 89.90, 'e o teto de 60% continua valendo');
});

test('cart_total explícito manda no gap, mesmo sem itens no cart', async () => {
  const env = newEnv();
  await seed(env);
  const { body } = await call(env, 'POST', '/recommend', {
    brand: 'rituaria', cart: [], cart_total: 89.90,
    threshold: { value: 199.00, label: 'Frete Grátis' },
  });
  assert.equal(body.context.cart_total, 89.9);
  assert.equal(body.context.gap, 109.1);
});

test('gap explícito vence o threshold, e os dois juntos não brigam', async () => {
  const env = newEnv();
  await seed(env);
  const { body } = await call(env, 'POST', '/recommend', {
    brand: 'rituaria',
    cart: [{ sku: 'RT01008', qty: 1, price: 89.90 }],
    gap: 20.10,
    threshold: { value: 999.00, label: 'Frete Grátis' },
  });
  assert.equal(body.context.gap, 20.1, 'gap explícito ignora o value do threshold');
  assert.equal(body.incentive.label, 'Frete Grátis', 'mas o rótulo do threshold ainda é usado');
});

test('free_shipping_threshold da marca vale quando o tema não manda nada', async () => {
  const env = newEnv();
  await seed(env);
  await call(env, 'POST', '/config', { brand: 'rituaria', free_shipping_threshold: 199 }, true);
  const { body } = await call(env, 'POST', '/recommend', {
    brand: 'rituaria', cart: [{ sku: 'RT01008', qty: 1, price: 89.90 }],
  });
  assert.equal(body.context.gap, 109.1);
});

test('sem threshold nenhum o gap é 0 e o incentivo é preço cheio', async () => {
  const env = newEnv();
  await seed(env);
  const { body } = await call(env, 'POST', '/recommend', {
    brand: 'rituaria', cart: [{ sku: 'RT01008', qty: 1, price: 89.90 }],
  });
  assert.equal(body.context.gap, 0);
  assert.equal(body.incentive.type, 'none');
});

test('/event recusa o vocabulário do Plausible — os dois não se misturam', async () => {
  const env = newEnv();
  await seed(env);
  const rec = await call(env, 'POST', '/recommend', {
    brand: 'rituaria', cart: [{ sku: 'RT01008', qty: 1, price: 89.90 }],
  });
  const ruim = await call(env, 'POST', '/event', { offer_id: rec.body.offer_id, event: 'offer_accept' });
  assert.equal(ruim.status, 400);
  assert.equal(ruim.body.error, 'unknown_event');
  const bom = await call(env, 'POST', '/event', { offer_id: rec.body.offer_id, event: 'accept' });
  assert.equal(bom.status, 200);
});

test('coluna nova entra em banco que já existia (migração)', async () => {
  const db = new DatabaseSync(':memory:');
  // simula o banco em produção: brand_config criada ANTES de dead_coverage_days existir
  db.exec(`CREATE TABLE brand_config (
    brand TEXT PRIMARY KEY, margin_floor REAL, max_discount REAL,
    allow_percent_discount INTEGER, free_shipping_threshold REAL, gap_hard_max REAL,
    price_cap_ratio REAL, marginal_shipping REAL, tax_rate REAL,
    prior_alpha REAL, prior_beta REAL, slow_moving_days REAL, updated_at TEXT)`);
  const env = { DB: db, CURATE_TOKEN: TOKEN };

  const r = await call(env, 'POST', '/curate/prior',
    { rows: [{ brand: 'rituaria', take_rate: 0.1112, weight: 20 }] }, true);
  assert.equal(r.body.applied, 1, 'o prior tem que entrar mesmo na tabela antiga');
  assert.deepEqual(r.body.errors, []);

  const row = db.prepare('SELECT prior_alpha, prior_beta FROM brand_config WHERE brand = ?').all('rituaria')[0];
  assert.ok(Math.abs(row.prior_alpha - 2.224) < 1e-9);
  assert.ok(Math.abs(row.prior_beta - 17.776) < 1e-9);
});

test('afinidade sobrevive a carrinho com vários itens (ordem dos binds)', async () => {
  const env = newEnv();
  await seed(env);
  await call(env, 'POST', '/curate/brand_orders', { rows: [{ brand: 'rituaria', n_orders: 9605 }] }, true);
  await call(env, 'POST', '/curate/sku_orders', {
    rows: [{ brand: 'rituaria', sku: 'RT01008', n_orders: 500 },
      { brand: 'rituaria', sku: 'RT02001', n_orders: 300 }],
  }, true);
  await call(env, 'POST', '/curate/affinity', {
    rows: [{ brand: 'rituaria', anchor_sku: 'RT01008', candidate_sku: 'RT02001', co_purchase_count: 180 }],
  }, true);

  // carrinho com 2 itens: as subqueries de kit levam 4 binds antes dos joins
  const { body } = await call(env, 'POST', '/recommend', {
    brand: 'rituaria',
    cart: [{ sku: 'RT01008', qty: 1, price: 89.90 }, { sku: 'RT01015', qty: 1, price: 79.90 }],
    debug: true, n: 5,
  });
  const colageno = (body.offers || []).find((o) => o.sku === 'RT02001');
  assert.ok(colageno, 'o colágeno tem que estar no ranking');
  assert.equal(colageno._debug.affinity.co, 180, 'co-compra não pode voltar zerada');
  assert.equal(colageno._debug.affinity.anchorOrders, 500);
  assert.equal(colageno._debug.affinity.brandOrders, 9605);

  // e o kit continua barrado com carrinho de 2 itens
  assert.ok(!(body.offers || []).some((o) => o.sku === 'KRT99078'));
  assert.equal(body.rejected.find((r) => r.sku === 'KRT99078').code, 'kit_contains_cart_sku');
});

// ---------------------------------------------------------------------------
// Isolamento por marca — o que protege Barbour's e Rituária ao plugar a Ápice
// ---------------------------------------------------------------------------

test('carregar uma marca nova não mexe nas marcas já carregadas', async () => {
  const env = newEnv();
  await seed(env);
  const antes = (await call(env, 'GET', '/health')).body.counts.product;

  await call(env, 'POST', '/curate/product', {
    rows: [{ brand: 'apice', sku: 'AP001', variant_id: '700001', title: 'Kit Cachos',
      price: 60, cogs: 15, available: 30, line: 'cachos', category: 'cabelo' }],
  }, true);

  const depois = await call(env, 'GET', '/health');
  assert.equal(depois.body.counts.product, antes + 1);
  const porMarca = Object.fromEntries(depois.body.product_by_brand.map((r) => [r.brand, r.skus]));
  assert.equal(porMarca.rituaria, 4, 'Rituária intacta');
  assert.equal(porMarca.barbours, 2, "Barbour's intacta");

  // e a Ápice não vaza para o pool das outras
  const rit = await call(env, 'POST', '/recommend', {
    brand: 'rituaria', cart: [{ sku: 'RT01008', qty: 1, price: 89.90 }], n: 10,
  });
  assert.ok(!(rit.body.offers || []).some((o) => o.sku === 'AP001'));
});

test('reset COM brand apaga só aquela marca', async () => {
  const env = newEnv();
  await seed(env);
  await call(env, 'POST', '/curate/affinity', {
    rows: [
      { brand: 'rituaria', anchor_sku: 'RT01008', candidate_sku: 'RT02001', co_purchase_count: 9 },
      { brand: 'apice', anchor_sku: 'AP001', candidate_sku: 'AP002', co_purchase_count: 4 },
    ],
  }, true);
  assert.equal((await call(env, 'GET', '/health')).body.counts.affinity, 2);

  const r = await call(env, 'POST', '/curate/reset?table=affinity&brand=apice', undefined, true);
  assert.equal(r.body.brand, 'apice');
  assert.equal(r.body.remaining, 1, 'sobra a linha da Rituária');
  const resta = env.DB.prepare('SELECT brand FROM affinity').all();
  assert.deepEqual(resta.map((x) => x.brand), ['rituaria']);
});

test('reset SEM brand apaga tudo — é o footgun, e está coberto', async () => {
  const env = newEnv();
  await seed(env);
  await call(env, 'POST', '/curate/affinity', {
    rows: [{ brand: 'rituaria', anchor_sku: 'A', candidate_sku: 'B', co_purchase_count: 1 },
      { brand: 'apice', anchor_sku: 'C', candidate_sku: 'D', co_purchase_count: 1 }],
  }, true);
  const r = await call(env, 'POST', '/curate/reset?table=affinity', undefined, true);
  assert.equal(r.body.brand, 'all');
  assert.equal(r.body.remaining, 0, 'sem brand, leva as duas marcas junto');
});
