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
  low_stock_units REAL, collectible_categories TEXT, line_labels TEXT,
  updated_at TEXT
);
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

export async function ensureSchema(db, key) {
  const k = key || db;
  if (schemaDone.has(k)) return schemaDone.get(k);
  const p = (async () => {
    for (const stmt of splitStatements(SCHEMA)) await db.run(stmt, []);
    await runMigrations(db);
  })().catch((e) => { schemaDone.delete(k); throw e; });
  schemaDone.set(k, p);
  return p;
}
