#!/usr/bin/env node
// push.mjs — empurra o resultado de uma query do GoRAG para o offer-api.
//
//   node scripts/push.mjs <tabela> <arquivo.json> [--chunk N --from DATA --to DATA]
//
// O arquivo é a resposta crua do runQuery ({ rows, rowCount, truncated }) ou um
// array de linhas. Recusa carga truncada: resultado cortado vira matriz errada.

import { readFileSync } from 'node:fs';

const [, , table, file, ...rest] = process.argv;
if (!table || !file) {
  console.error('uso: node scripts/push.mjs <product|kits|affinity|sku_orders|brand_orders|prior> <arquivo> [--chunk N] [--from D] [--to D] [--brand B]');
  process.exit(1);
}

const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

const API = process.env.OFFER_API || readEnv('OFFER_API') || 'https://offer-api.devgogroup.com';
const TOKEN = process.env.CURATE_TOKEN || readEnv('CURATE_TOKEN');
if (!TOKEN) { console.error('CURATE_TOKEN ausente (env ou .env.local)'); process.exit(1); }

function readEnv(key) {
  try {
    const txt = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
    const m = txt.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : undefined;
  } catch { return undefined; }
}

const raw = JSON.parse(readFileSync(file, 'utf8'));
const rows = Array.isArray(raw) ? raw : (raw.rows || []);

if (raw && raw.truncated) {
  console.error(`RECUSADO: ${file} veio truncado (rowCount=${raw.rowCount}). Quebre a janela e rode de novo.`);
  process.exit(2);
}
if (!rows.length) { console.error(`RECUSADO: ${file} não tem linhas.`); process.exit(2); }

const body = {
  rows,
  chunk: flag('chunk') ?? null,
  window_start: flag('from') ?? null,
  window_end: flag('to') ?? null,
  brand: flag('brand') ?? null,
};

const BATCH = Number(process.env.PUSH_BATCH || 500);
let applied = 0, received = 0;
const allErrors = [];

for (let i = 0; i < rows.length; i += BATCH) {
  const slice = rows.slice(i, i + BATCH);
  const res = await fetch(`${API}/curate/${table}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ ...body, rows: slice }),
  });
  const out = await res.json();
  if (!res.ok) { console.error('ERRO', res.status, JSON.stringify(out).slice(0, 500)); process.exit(3); }
  applied += out.applied; received += out.received;
  if (out.errors?.length) allErrors.push(...out.errors);
  process.stdout.write(`  lote ${i / BATCH + 1}: ${out.applied}/${out.received} → tabela com ${out.table_rows}\n`);
}

console.log(`${table}: ${applied}/${received} linhas aplicadas`);
if (allErrors.length) {
  console.log(`erros (${allErrors.length}, mostrando 5):`);
  for (const e of allErrors.slice(0, 5)) console.log('  ', e.error, JSON.stringify(e.row).slice(0, 160));
  process.exit(4);
}
