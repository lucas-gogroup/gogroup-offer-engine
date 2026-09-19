// db.js — DDL do env.DB e adaptador de driver.
//
// O mesmo código roda em dois lugares:
//   • GoDeploy (Cloudflare Worker): env.DB no dialeto D1 (prepare().bind().all()/run())
//   • node:sqlite nos testes (DatabaseSync, síncrono)
// O adaptador normaliza os dois para { all, run, exec } async.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS product (
  brand TEXT NOT NULL, sku TEXT NOT NULL,
  variant_id TEXT, product_id TEXT, title TEXT,
  is_kit INTEGER NOT NULL DEFAULT 0,
  category TEXT, subcategory TEXT, line TEXT,
  price REAL, cogs REAL, cost_provisional INTEGER DEFAULT 0,
  margin_ref REAL, image_url TEXT, url TEXT,
  available INTEGER, coverage_days REAL, stock_status TEXT,
  source TEXT, loaded_at TEXT, confidence TEXT,
  PRIMARY KEY (brand, sku)
);

CREATE TABLE IF NOT EXISTS kit_components (
  brand TEXT NOT NULL, kit_sku TEXT NOT NULL, component_sku TEXT NOT NULL,
  qty_per_kit REAL, protheus_ok INTEGER, cross_brand INTEGER,
  PRIMARY KEY (brand, kit_sku, component_sku)
);
CREATE INDEX IF NOT EXISTS idx_kit_by_component ON kit_components(brand, component_sku);

CREATE TABLE IF NOT EXISTS affinity (
  brand TEXT NOT NULL, anchor_sku TEXT NOT NULL, candidate_sku TEXT NOT NULL,
  co_purchase_count INTEGER NOT NULL DEFAULT 0,
  window_start TEXT, window_end TEXT,
  PRIMARY KEY (brand, anchor_sku, candidate_sku)
);

CREATE TABLE IF NOT EXISTS sku_orders (
  brand TEXT NOT NULL, sku TEXT NOT NULL, n_orders INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (brand, sku)
);

CREATE TABLE IF NOT EXISTS brand_orders (
  brand TEXT PRIMARY KEY, n_orders INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS offer_stats (
  brand TEXT NOT NULL, anchor_sku TEXT NOT NULL, offer_sku TEXT NOT NULL,
  surface TEXT NOT NULL, goal TEXT NOT NULL, segment TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  accepts INTEGER NOT NULL DEFAULT 0,
  prior_alpha REAL NOT NULL DEFAULT 1, prior_beta REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (brand, anchor_sku, offer_sku, surface, goal, segment)
);

CREATE TABLE IF NOT EXISTS decision_log (
  offer_id TEXT PRIMARY KEY, ts TEXT, brand TEXT, agent TEXT,
  context_json TEXT, decision_json TEXT, reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_decision_ts ON decision_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_decision_brand_ts ON decision_log(brand, ts DESC);

CREATE TABLE IF NOT EXISTS load_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, chunk TEXT,
  rows INTEGER, window_start TEXT, window_end TEXT, loaded_at TEXT
);

-- Adição ao §7: os pisos e tetos são "não decidido ainda" no plano e precisam
-- ser ajustáveis sem redeploy. Uma linha por marca; ausente = DEFAULT_CONFIG.
CREATE TABLE IF NOT EXISTS brand_config (
  brand TEXT PRIMARY KEY,
  margin_floor REAL, max_discount REAL, allow_percent_discount INTEGER,
  free_shipping_threshold REAL, gap_hard_max REAL, price_cap_ratio REAL,
  marginal_shipping REAL, tax_rate REAL,
  prior_alpha REAL, prior_beta REAL, slow_moving_days REAL, dead_coverage_days REAL,
  min_price REAL, gap_hard_max_ratio REAL, stock_urgency_enabled INTEGER,
  price_cap_abs REAL, gap_overshoot_max REAL, price_cap_uplift_max REAL,
  low_stock_units REAL, collectible_categories TEXT, line_labels TEXT,
  updated_at TEXT
);

-- Curadoria manual: fixa um produto numa VAGA do carrinho (o /recommend devolve
-- N ofertas; a vaga é a posição). Uma tabela para os três gatilhos, porque eles
-- diferem só em QUAIS colunas estão preenchidas — slot, produto, validade e
-- precedência são idênticos — e a precedência é justamente ENTRE tipos de
-- gatilho, o que duas tabelas obrigariam a resolver por UNION.
--
-- trigger_type é discriminador EXPLÍCITO, não "os campos de gatilho estão
-- NULL": um NULL acidental num gatilho de SKU viraria, em silêncio, um pin
-- incondicional para a marca inteira — o pior erro possível nesta feature.
--
-- trigger_key é a parte do gatilho que entra na chave primária:
--   always   -> string vazia
--   sku      -> o SKU do gatilho
--   taxonomy -> campo=valor normalizado
-- Materializada no mapper, não GENERATED: o repo roda em dois drivers e coluna
-- gerada exige SQLite 3.31+.
--
-- surface e goal entram na PK porque são ESCOPO, e escopo é parte da identidade:
-- sem eles, "vaga 1 = A no carrinho" e "vaga 1 = B na PDP" colidiriam, o segundo
-- INSERT OR REPLACE apagaria o primeiro, e a resposta ainda diria applied: 2.
-- Ambos usam '*' como "vale para todos", nunca NULL, para a PK não ter buraco.
CREATE TABLE IF NOT EXISTS pin_rule (
  brand TEXT NOT NULL,
  slot INTEGER NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_key TEXT NOT NULL,
  offer_sku TEXT NOT NULL,
  trigger_field TEXT,
  trigger_value TEXT,
  surface TEXT NOT NULL DEFAULT '*',
  goal TEXT NOT NULL DEFAULT '*',
  priority INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  starts_at TEXT,
  ends_at TEXT,
  note TEXT,
  created_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (brand, slot, trigger_type, trigger_key, surface, goal)
);
CREATE INDEX IF NOT EXISTS idx_pin_rule_brand ON pin_rule(brand, active);
`;

/**
 * Normaliza os drivers para { all, run } async.
 *
 * GoDeploy: env.DB.query(sql, params) -> { columns, rows, rowsRead }
 *           env.DB.exec(sql, params)  -> { rowsWritten }
 *           `rows` pode vir como array de arrays (posicional, alinhado a
 *           `columns`) ou como array de objetos — os dois são tratados.
 * Testes:   node:sqlite DatabaseSync, síncrono.
 */
export function adaptDb(raw) {
  if (!raw) throw new Error('env.DB ausente');

  // node:sqlite — tem .prepare(); o env.DB do GoDeploy não tem.
  if (typeof raw.prepare === 'function' && typeof raw.query !== 'function') {
    return {
      kind: 'node-sqlite',
      async all(sql, params = []) { return raw.prepare(sql).all(...params); },
      async run(sql, params = []) { return raw.prepare(sql).run(...params); },
    };
  }

  if (typeof raw.query !== 'function' || typeof raw.exec !== 'function') {
    throw new Error('driver de banco desconhecido: falta query()/exec()');
  }

  return {
    kind: 'godeploy',
    async all(sql, params = []) {
      const r = await raw.query(sql, params);
      return toObjects(r);
    },
    async run(sql, params = []) {
      return raw.exec(sql, params);
    },
  };
}

/** `{columns, rows}` posicional ou já em objetos → sempre array de objetos. */
export function toObjects(r) {
  if (!r) return [];
  const rows = Array.isArray(r) ? r : (r.rows || []);
  if (!rows.length) return [];
  if (!Array.isArray(rows[0])) return rows;
  const cols = (r && r.columns) || [];
  return rows.map((row) => {
    const o = {};
    for (let i = 0; i < cols.length; i++) o[cols[i]] = row[i];
    return o;
  });
}

/**
 * Colunas acrescentadas depois que o banco já existia.
 *
 * `CREATE TABLE IF NOT EXISTS` não altera tabela existente: acrescentar uma
 * coluna no DDL acima é invisível para um env.DB que já foi criado, e a falha
 * só aparece no INSERT ("has no column named ..."). Toda coluna nova entra
 * aqui também. Rodar de novo é inofensivo — "duplicate column" é ignorado.
 */
export const MIGRATIONS = [
  'ALTER TABLE brand_config ADD COLUMN dead_coverage_days REAL',
  'ALTER TABLE brand_config ADD COLUMN min_price REAL',
  'ALTER TABLE brand_config ADD COLUMN gap_hard_max_ratio REAL',
  'ALTER TABLE brand_config ADD COLUMN stock_urgency_enabled INTEGER',
  'ALTER TABLE brand_config ADD COLUMN low_stock_units REAL',
  'ALTER TABLE brand_config ADD COLUMN collectible_categories TEXT',
  'ALTER TABLE brand_config ADD COLUMN line_labels TEXT',
  'ALTER TABLE brand_config ADD COLUMN price_cap_abs REAL',
  'ALTER TABLE brand_config ADD COLUMN gap_overshoot_max REAL',
  'ALTER TABLE brand_config ADD COLUMN price_cap_uplift_max REAL',
];

async function runMigrations(db) {
  for (const sql of MIGRATIONS) {
    try {
      await db.run(sql, []);
    } catch (e) {
      const msg = String(e && e.message || e).toLowerCase();
      if (!msg.includes('duplicate column')) throw e;
    }
  }
}

/** Tira os comentários ANTES de quebrar: um `;` dentro de `--` partiria o DDL. */
export function splitStatements(sql) {
  return sql
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Uma conexão, um DDL: o isolate do Worker sobrevive entre requests e o DDL
// não precisa rodar de novo. WeakMap por banco para os testes não vazarem entre si.
const schemaDone = new WeakMap();

/** Tabelas declaradas no DDL, lidas do próprio texto — não dá para desalinhar. */
const SCHEMA_TABLES = [...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);

/**
 * Colunas esperadas numa tabela: as do DDL mais as que as migrações acrescentam.
 * Derivado, porque um número cravado aqui envelheceria em silêncio e o motor
 * voltaria a rodar o DDL inteiro a cada request sem ninguém notar.
 *
 * A PK composta é descartada antes de contar: `PRIMARY KEY (brand, slot, ...)`
 * quebrada por vírgula produziria "PRIMARY", "slot", "trigger_key)" e a
 * contagem sairia errada — bastando isso para o motor pagar o DDL inteiro em
 * toda requisição, que é exatamente o que derrubou o app antes.
 */
export function colsEsperadas(tabela) {
  const bloco = SCHEMA.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${tabela} \\(([\\s\\S]*?)\\n\\);`),
  );
  const corpo = bloco
    ? bloco[1]
      .replace(/^\s*--.*$/gm, '')
      .replace(/,?\s*PRIMARY KEY\s*\([^)]*\)/gi, '')
    : '';
  const doDdl = corpo.split(',')
    .map((c) => c.trim().split(/\s+/)[0])
    .filter((c) => /^\w+$/.test(c));
  const deMigracao = MIGRATIONS
    .map((m) => m.match(new RegExp(`ALTER TABLE ${tabela} ADD COLUMN (\\w+)`)))
    .filter(Boolean).map((m) => m[1]);
  return new Set([...doDdl, ...deMigracao]).size;
}

const CFG_COLS_ESPERADAS = colsEsperadas('brand_config');
const PIN_COLS_ESPERADAS = colsEsperadas('pin_rule');

/**
 * O banco já está no formato atual?
 *
 * Uma pergunta, uma ida ao banco. Sem isto, TODA requisição pagava 9 CREATE
 * TABLE, 2 CREATE INDEX e 9 ALTER TABLE — vinte idas ao `env.DB` a ~150 ms cada
 * — sempre que o isolate fosse novo. Foi o que derrubou o app quando a lista de
 * migrações cresceu de 1 para 9: o `/health`, que não decide nada, passou a dar
 * timeout junto com o resto.
 */
async function schemaAtual(db) {
  try {
    const r = await db.all(
      `SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN (${
        SCHEMA_TABLES.map(() => '?').join(',')})) AS tabelas,
              (SELECT COUNT(*) FROM pragma_table_info('brand_config')) AS colunas,
              (SELECT COUNT(*) FROM pragma_table_info('pin_rule'))     AS colunas_pin`,
      SCHEMA_TABLES,
    );
    const row = r && r[0];
    return !!row && Number(row.tabelas) >= SCHEMA_TABLES.length
        && Number(row.colunas) >= CFG_COLS_ESPERADAS
        && Number(row.colunas_pin) >= PIN_COLS_ESPERADAS;
  } catch {
    return false; // banco novo, ou driver sem pragma: cai no caminho completo
  }
}

export async function ensureSchema(db, key) {
  const k = key || db;
  if (schemaDone.has(k)) return schemaDone.get(k);
  const p = (async () => {
    if (await schemaAtual(db)) return;
    for (const stmt of splitStatements(SCHEMA)) await db.run(stmt, []);
    await runMigrations(db);
  })().catch((e) => { schemaDone.delete(k); throw e; });
  schemaDone.set(k, p);
  return p;
}
