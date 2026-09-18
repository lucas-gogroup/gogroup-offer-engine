# Arquitetura travada e primeiro seed — go-offer-engine

2026-09-18 · sessão de planejamento (sem código escrito) · dono: Lucas

> **Para a sessão que vai desenvolver.** Leia este documento e o [Handoff técnico](../../Handoff%20—%20Motor%20de%20Oferta%20Inteligente%20(GoHacks%20Podium%202026).md) (score, regras de negócio, copy). O [Plano de dados](../../Plano%20de%20dados%20—%20go-offer-engine%20(Barbour's%20e%20Rituária).md) e o [POC plan](./2026-09-18-poc-plan.md) contêm afirmações que a verificação de hoje derrubou — **onde houver conflito, este documento vence**. A seção 4 lista cada correção.

---

## 1. Decisões travadas

| # | Decisão | Escolha | Motivo |
|---|---|---|---|
| D1 | Topologia | **Um app só**: `offer-api`, público | O `offer-curator` do plano original perdeu a razão de existir (D2). Menos superfície, menos deploy. |
| D2 | Como o dado entra | **Operador via GoRAG `runQuery` → `POST /curate`** (bearer) | O app público não consegue ler o proxy de dados (§2). O GoRAG dá SQL real com CTE; o proxy PostgREST só faz `GET` sem agregação. |
| D3 | Fallback de ingestão | **Metabase API** (§8) | Se o GoRAG falhar ou ficar instável. Já caiu uma vez durante o planejamento. |
| D4 | `PLAUSIBLE_API_KEY` | **Não é dependência** | O bandit se alimenta de `POST /event` first-party, não do Plausible (§9). Remove o bloqueante nº 1 do POC plan §6. |
| D5 | Estoque | **`gold.shopify_inventory_current`** | É literalmente a saída do Cosmos (§3). Integrar o Cosmos direto devolveria o mesmo número por um caminho mais caro. |
| D6 | Aprendizado | **Bandit dentro do app**, prior do histórico de order bump Yampi | Único desenho que continua aprendendo sem operador no circuito. |
| D7 | Escopo de superfície | Carrinho primeiro, PDP depois | Mantido do POC plan §5. |

**Não decidido ainda** (não bloqueia o início do dev): goal default em produção, pisos de margem por marca, se a PDP entra na primeira leva.

---

## 2. A trava que define a arquitetura: o app público não lê as bases

Documentação da plataforma, textual:

> "An app that reads from the proxy MUST have visibility `authenticated` or `restricted`. (...) **There is no API-key fallback for serving anonymous traffic from the proxy.**"

O worker lê o proxy **repassando o cookie de sessão do visitante**. Quem consegue o quê:

| Quem chama | Tem cookie de sessão? | Lê o proxy? |
|---|---|---|
| Navegador do shopper no carrinho | não | **não** — e o `offer-api` tem que ser público pra atender o tema |
| Cron do GoDeploy (`X-Godeploy-Cron`) | não | **não** |
| Requisição com chave `gdk_` | bearer, não cookie | **não testado** — ver pendência P1 |
| Você logado abrindo um app `authenticated` | sim | sim |
| Claude Code via GoRAG `runQuery` | n/a | sim, com SQL completo |

**Consequência:** o dado não é puxado pelo app — é **empurrado** pra dentro dele. O `offer-api` público serve exclusivamente do próprio SQLite (`env.DB`), que já era o design de "zero token por pedido". O que precisa de dono é o empurrão, e o dono é o operador (D2).

Também vale para a chave `gdk_`: em app **público** o bearer é ignorado pelo gateway (login anônimo já é permitido). Ela só faz sentido em app `authenticated`/`restricted`. A autenticação do `/curate` é **nossa**, no código do worker, com um segredo via `setAppSecret` — não é a `gdk_`.

---

## 3. Cosmos: o que é, e por que já estamos consumindo

Procurado nos 6 bancos do GoRAG. **Cosmos não tem tabela de estoque no datamart.** Existe só `staging.cosmos_raw_keys`, `staging.cosmos_tms_keys`, `staging.cosmos_catalog_progress` e `staging.intelipost_cosmos_cost` — tudo logística/TMS, nada de saldo.

Cosmos é o **Middleware V2**: API Ruby on Rails 8.0, repo `goca-se/cosmos-backend`, Hetzner/Coolify. Das regras de negócio documentadas:

- Dono da verdade do estoque = **WMS (Unilog)** → Cosmos → Shopify
- `SyncStockForAllDistributionCentersJob`: Unilog → Cosmos, **a cada 3 h**
- `SyncStockToShopifyForAllOrganizationsJob`: Cosmos → Shopify, **diário às 10 h e 16 h**
- Produto simples: `available_to_sync = max(0, raw_quantity − safety_stock − committed)`, `safety_stock` default **200**
- Kit: quantidade = **mínimo entre todos os componentes**

`gold.shopify_inventory_current.last_updated_at` = **2026-09-18 16:00:37**, batendo exatamente com o job das 16 h. Ou seja: **a tabela do datamart já É o número do Cosmos**, com a semântica certa.

**Três consequências de design, não triviais:**

1. **Não aplicar estoque de segurança de novo.** O `available` já vem líquido de `safety_stock` (default 200) e de `committed`. A regra 5 do README ("nunca oferta SKU com `available` abaixo do estoque de segurança") descontaria duas vezes. O filtro correto é `available > 0`, e ponto.
2. **Frescor máximo é 2×/dia.** Entre 10 h e 16 h o número pode estar até 6 h velho. Declarar no pitch; não prometer estoque em tempo real.
3. **Kit some do pool quando um componente falta.** Como kit = mínimo entre componentes, um componente curto zera o kit inteiro. Isso é desejável (não vende o que não monta), mas explica buracos no pool de ofertas de kit.

---

## 4. Correções ao planejamento anterior

| Onde | Dizia | Realidade verificada | Impacto |
|---|---|---|---|
| Plano de dados, `product_master` | filtro `product_status = 'active'` | Valores são **maiúsculos**: `ACTIVE`, `DRAFT`, `UNLISTED`, `ARCHIVED` | O join volta **zero linhas**. Bug que teria queimado a primeira hora de dev. |
| README, "Estatísticas" | "SKUs ativos no pool: 500+" | **241 ofertáveis** (Barbour's 145, Rituária 96) | Pool 2× menor. Ver §5. |
| POC plan §0 | "Barbour's: 493 SKUs ativos com `codigo_shopify`" | 490 têm `codigo_shopify` no catálogo, mas só **184** estão `ACTIVE` no Shopify com SKU, e **164** casam com o catálogo | O gargalo não é o catálogo, é o conjunto `ACTIVE` no Shopify. |
| POC plan §6 | `PLAUSIBLE_API_KEY` é **bloqueante** | Não é (D4) | Um bloqueante a menos. |
| POC plan §2 | Dois apps (`offer-api` + `offer-curator`) | Um app (D1) | Menos deploy, menos CORS, menos coisa pra quebrar. |
| README, arquitetura | "Plausible: source of truth de eventos" | `/event` first-party é a fonte do bandit; Plausible/ClickHouse é auditoria | §9. |
| README, regra 5 | "estoque de segurança" | Já embutido pelo Cosmos | §3, consequência 1. |
| Plano de dados, estoque | fallback "Protheus via Middleware quando disponível" | Não existe no datamart | §3. |

**Não encontrei contradição** em: composição de kits com BOM Protheus, `properties_data` fechando o loop de compra, escada de incentivo sem desconto % por causa do checkout Yampi, colisão de nomes de evento. Tudo isso se sustenta.

---

## 5. O pool real, medido

Filtro: catálogo ativo **e** `product_status = 'ACTIVE'` **e** `sku IS NOT NULL` **e** `location_active` **e** `available > 0` **e** preço > 0 **e** custo real.

| | Barbour's | Rituária |
|---|---|---|
| Ativos no catálogo (`dim_produto_gobeauty`) | 818 | 714 |
| `ACTIVE` no Shopify com SKU | 184 | 147 |
| Casam catálogo ↔ inventário | 164 | 120 |
| **Ofertáveis** | **145** | **96** |
| Kits no catálogo ativo | 204 | 116 |

**Notícia boa:** 100% dos ofertáveis têm custo real (não provisório). O piso de margem é confiável em todo o pool — o "confidence = low" do plano de dados vira caso raro, não regime.

**Sujeira que o filtro precisa segurar:**

- `available` **negativo**: 173 linhas em Barbour's (mínimo −56.057), 13 delas em `ACTIVE`; 19 negativas em `ACTIVE` na Rituária
- Um SKU **nulo** com `available = 1.000.000`
- `available` nulo em linhas `DRAFT` (some quando se filtra `ACTIVE`)

**Densidade de afinidade (medida, Rituária, 3 dias):** 1.898 pares, **775 com ≥3 co-compras**, **75 âncoras distintas** — 78% do pool ofertável coberto em 3 dias. Volume: 9.605 pedidos pagos em 3 d (Rituária), 7.490 (Barbour's). Densidade não é risco.

---

## 6. Arquitetura

```
Tema Shopify (main)                    GoDeploy
┌────────────────────────┐   POST /recommend   ┌──────────────────────────────┐
│ cart drawer / PDP      │────────────────────▶│ offer-api  (PÚBLICO)         │
│ snippet offer-engine   │◀────────────────────│                              │
│                        │  oferta + offer_id  │ env.DB (SQLite):             │
│                        │                     │  product, kit_components,    │
│                        │   POST /event       │  affinity, offer_stats,      │
│                        │────────────────────▶│  decision_log                │
│ gogroupAnalytics →     │  impression/accept  │                              │
│ Plausible adapter      │                     │ POST /curate  (bearer nosso) │
└───────┬────────────────┘                     └──────────────▲───────────────┘
        │ offer_* (auditoria)                                 │ push
        ▼                                                     │
  plausible.aws.gocase.com.br ──▶ ClickHouse         ┌────────┴─────────┐
        (lido fora de banda, via GoRAG)              │ Claude Code       │
                                                     │ GoRAG runQuery    │
                                                     │ (chunks de 3 d)   │
                                                     └────────┬──────────┘
                                                              │ fallback
                                                     ┌────────┴──────────┐
                                                     │ Metabase API (§8) │
                                                     └───────────────────┘
```

O que **não** existe mais em relação ao POC plan: `offer-curator`, cron `/tasks/plausible`, secret `PLAUSIBLE_API_KEY`.

---

## 7. Modelo de dados do app (`env.DB`, SQLite)

**Proposta de simplificação:** com 241 SKUs ofertáveis, separar `product_master` / `inventory_snapshot` / `product_cost` em três tabelas não compra nada — todas têm o mesmo grão (marca × SKU) e a mesma cadência de carga. Colapsadas em `product`.

Os nomes mudam em relação ao plano original, então a tabela de-para: `product_master` + `inventory_snapshot` + `product_cost` → **`product`**; `affinity_matrix` → **`affinity`** (+ `sku_orders` e `brand_orders`, que carregam os denominadores do lift); `offer_table` + `events_agg` → **`offer_stats`** (uma tabela só, porque o bandit lê e escreve no mesmo grão). `kit_components` e `decision_log` mantêm o nome. `load_log` é nova.

```sql
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

-- co_purchase_count é SOMADO entre chunks; ver §7.1
CREATE TABLE IF NOT EXISTS affinity (
  brand TEXT NOT NULL, anchor_sku TEXT NOT NULL, candidate_sku TEXT NOT NULL,
  co_purchase_count INTEGER NOT NULL DEFAULT 0,
  window_start TEXT, window_end TEXT,
  PRIMARY KEY (brand, anchor_sku, candidate_sku)
);

-- denominadores do lift, também somados entre chunks
CREATE TABLE IF NOT EXISTS sku_orders (
  brand TEXT NOT NULL, sku TEXT NOT NULL, n_orders INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (brand, sku)
);
CREATE TABLE IF NOT EXISTS brand_orders (
  brand TEXT PRIMARY KEY, n_orders INTEGER NOT NULL DEFAULT 0
);

-- contadores do bandit, alimentados por POST /event
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

CREATE TABLE IF NOT EXISTS load_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, chunk TEXT,
  rows INTEGER, window_start TEXT, window_end TEXT, loaded_at TEXT
);
```

### 7.1 Contrato de `/curate` — o detalhe que não pode passar batido

A afinidade é carregada em **chunks de 3 dias** (§7.2), e um par que aparece em vários chunks precisa **somar**. Então:

- `/curate/product`, `/curate/kits`: **replace** (`INSERT OR REPLACE`) — carga inteira de uma vez
- `/curate/affinity`, `/curate/sku_orders`, `/curate/brand_orders`: **acumulam**
  `ON CONFLICT DO UPDATE SET co_purchase_count = co_purchase_count + excluded.co_purchase_count`
- `/curate/reset?table=affinity`: zera antes de uma recarga completa, pra recarga não duplicar

O `lift` **não** é calculado por chunk (o denominador é global). Calcula-se no fim, no app ou na leitura:
`p_b_given_a = co / sku_orders[anchor]` e `lift = p_b_given_a / (sku_orders[cand] / brand_orders)`.

### 7.2 Por que 3 dias

Query de pares em **30 dias derrubou o backend do GoRAG** ("Query execution backend is unavailable"). Em 3 dias roda liso. `gold.shopify_order_items` tem ~7 GB e o timeout é de 10 s. **10 chunks × 2 marcas = 20 queries** para cobrir 30 dias.

---

## 8. Runbook do primeiro seed

> **Antes de rodar qualquer coisa:** `getDataSourceSchema` em `datamart:gold.bridge_kit_componente_gobeauty` e `datamart:gold.shopify_order_items`. As colunas dessas duas **não foram confirmadas nesta sessão** (o GoRAG caiu antes). As de `dim_produto_gobeauty` e `shopify_inventory_current` **foram** — o SQL abaixo rodou de verdade.

Ordem: catálogo → kits → afinidade → prior. O motor já responde com o passo 1+2; afinidade melhora o ranking; prior melhora o arranque do bandit.

### Passo 1 — `product` (uma query, as duas marcas)

```sql
WITH inv AS (
  SELECT brand, sku,
         SUM(available)        AS available,
         MAX(variant_id)       AS variant_id,
         MAX(product_id)       AS product_id,
         MAX(variant_price)    AS variant_price,
         MAX(product_type)     AS product_type,
         MAX(cost)             AS shopify_cost,
         MAX(last_updated_at)  AS synced_at
  FROM gold.shopify_inventory_current
  WHERE brand IN ('barbours','rituaria')
    AND location_active
    AND product_status = 'ACTIVE'   -- MAIÚSCULO. minúsculo devolve zero linhas.
    AND sku IS NOT NULL
  GROUP BY brand, sku
)
SELECT p.marca AS brand, p.sku, i.variant_id, i.product_id,
       p.nome AS title, p.is_kit, p.categoria, p.subcategoria, p.linha,
       i.variant_price AS price, p.custo_unitario AS cogs,
       p.custo_provisorio AS cost_provisional, p.custo_origem,
       p.margem_bruta_ref AS margin_ref, p.imagem_url, p.url_loja,
       i.available, i.shopify_cost, i.synced_at
FROM gold.dim_produto_gobeauty p
JOIN inv i ON i.brand = p.marca AND i.sku = p.sku
WHERE p.marca IN ('barbours','rituaria')
  AND p.ativo
  AND NOT COALESCE(p.marca_conflitante, false)
  AND i.available > 0;           -- corta os negativos e os zerados
```

**Validação:** ~145 linhas Barbour's, ~96 Rituária. Se vier muito diferente, pare — o Cosmos sincronizou outro conjunto ou o filtro mudou. Registrar em `load_log`.

### Passo 2 — `kit_components`

Fonte `gold.bridge_kit_componente_gobeauty`, filtro `kit_marca IN ('barbours','rituaria')`. Colunas esperadas (**confirmar**): `kit_codigo`, `componente_codigo`, `qty_per_kit`, `kit_marca`, `componente_marca`, `kit_no_cadastro_protheus`, `cruza_marca`.

**Validação obrigatória — o caso Rituária:** o kit `KRT99078` (Trio de Queridinhos) tem que conter `RT01008` (Magnésio Inositol). Se carrinho com `RT01008` ainda ofertar `KRT99078`, o filtro duro está quebrado. Este é o caso que justifica o projeto inteiro; não suba sem ele passando.

### Passo 3 — `affinity` + denominadores (20 queries)

Para cada marca × cada chunk de 3 dias (10 chunks cobrem 30 dias), variando `<N>` de 0 a 9:

```sql
WITH pool AS (   -- candidatos: só o que é ofertável (≈241 SKUs). Limita a matriz.
  SELECT DISTINCT brand, sku FROM gold.shopify_inventory_current
  WHERE brand = '<MARCA>' AND location_active
    AND product_status = 'ACTIVE' AND sku IS NOT NULL AND available > 0
),
li AS (
  SELECT order_id, sku
  FROM gold.shopify_order_items
  WHERE brand = '<MARCA>' AND financial_status = 'paid'
    AND created_at >= now() - interval '<N*3+3> days'
    AND created_at <  now() - interval '<N*3> days'
    AND sku IS NOT NULL AND price > 0     -- price > 0 exclui brinde
  GROUP BY order_id, sku                  -- uma linha por SKU por pedido
)
SELECT a.sku AS anchor_sku, b.sku AS candidate_sku, COUNT(*) AS co_purchase_count
FROM li a
JOIN li b ON a.order_id = b.order_id AND a.sku <> b.sku
JOIN pool p ON p.sku = b.sku              -- âncora: qualquer SKU; candidato: só ofertável
GROUP BY 1,2;
```

Mais, por chunk, os denominadores:

```sql
SELECT sku, COUNT(DISTINCT order_id) AS n_orders FROM (...li...) GROUP BY sku;
SELECT COUNT(DISTINCT order_id) AS n_orders FROM (...li...);
```

**Atenção:** `a.sku <> b.sku` (não `<`) porque a matriz é direcional — o par (A→B) e (B→A) têm `p_b_given_a` diferentes. A medição de 1.898 pares usou `<` (não-direcional); direcional dobra, ~3.800 por chunk de 3 d na Rituária.

**Validação:** checar `truncated` em toda resposta. Se vier `true`, o chunk está incompleto — quebre em 1 dia. Nunca usar resultado cortado.

### Passo 4 — prior do bandit (uma query)

`gold.vw_yampi_line_items`, 90 d, `payment_status = 'paid'`, agrupado por marca e `has_order_bump` / `is_upsell` / `order_bump_types`. Taxa histórica de order bump medida antes: Rituária 9,8%, Barbour's 7,7% dos pedidos pagos.

Vira `prior_alpha` / `prior_beta` em `offer_stats`: com take rate esperado `r` e peso `w` (sugerido `w = 20` impressões equivalentes), `prior_alpha = r·w`, `prior_beta = (1−r)·w`. Evita que o Thompson Sampling explore no escuro nas primeiras horas.

### Passo 5 — validações de corte

Antes de ligar o toggle no tema:

- [ ] `product` com ~241 linhas, todas com `variant_id` não nulo
- [ ] nenhum `available <= 0` em `product`
- [ ] `KRT99078` filtrado para carrinho com `RT01008`
- [ ] nenhum SKU do carrinho ofertado a si mesmo
- [ ] toda oferta com `price ≤ 0,6 × valor do carrinho`
- [ ] `expected_margin` ≥ piso da marca em 100% das ofertas emitidas
- [ ] `load_log` com uma linha por chunk, com `window_start/end`
- [ ] `/recommend` p95 abaixo de 300 ms (timeout do tema)

---

## 9. Aprendizado, sem Plausible no caminho crítico

`POST /event` do tema → `offer_stats` no SQLite do próprio app. É **first-party** (domínio da loja → `offer-api`), então não cai em bloqueador de rastreio como o Plausible cairia, e chega em tempo real.

Thompson Sampling amostra `Beta(prior_alpha + accepts, prior_beta + impressions − accepts)` por `(anchor, offer, surface, goal, segment)`. Sem cron, sem janela de 15 min: o contador atualiza no próprio request do evento.

O Plausible continua recebendo os mesmos eventos `offer_*` pela camada `gogroupAnalytics` — mas como **auditoria e BI**, lida fora de banda pelo GoRAG (`clickhouse.plausible_events_db.events_v2`). Se os dois números divergirem muito, é sinal de perda de evento, e aí a investigação tem duas fontes.

**Nomes de evento:** confirmado hoje que a Rituária (`site_id 9`) já dispara `upsell_accept` (734 em 2 dias) e `upsell_click` (645) pela camada existente, com props diferentes. Os eventos do motor **têm** que ser `offer_impression`, `offer_accept`, `offer_reject`, `offer_checkout` — a colisão prevista no POC plan §1.3 é real e está medida.

`site_id`: 7 = `thebarboursbeauty.com.br`, 9 = `rituaria.com.br`. Props ficam em `meta.key` / `meta.value` (arrays), extração com `meta.value[indexOf(meta.key,'anchor_sku')]`. Dialeto ClickHouse (`countIf`, `toDate`, `INTERVAL 30 DAY`), não Postgres.

**Fechamento de compra** (fora do caminho crítico): `gold.shopify_order_items.properties_data` carrega `_offer_id` gravado no `/cart/add.js`. Job diário do operador cruza com pedidos pagos para AOV real. O Yampi preserva as properties — verificado no POC plan §0.

---

## 10. Plano B: Metabase API

Se o GoRAG cair no meio da carga (já aconteceu uma vez hoje), o mesmo SQL roda pela API do Metabase. O que a sessão nova precisa saber:

- Data Mart Gobeauté = **database 43** em `metabase.gobeaute.com.br`
- Endpoint de SQL ad hoc: `POST /api/dataset` com `{"database":43,"type":"native","native":{"query":"<SQL>"}}`
- Questions oficiais já validadas, para reaproveitar joins e definições: **27585** (receita por cupom/dia), **27636** (descontos por tipo, Gobeauté), **27551** (funil Gobeauté por etapa)
- `gold.gobeaute_price_snapshot` = tabela 5931 no db 43 — preço praticado no checkout Yampi por `id_product`, junta ao SKU via `map_produto_codigo_gobeauty`
- Matriz de estoque Supply Intelligence = **card 27242**, mas na instância **Metabase Gocase**, não no Data Mart. Não indexada pelo `searchQuestions` do GoRAG.

O SQL do §8 é o mesmo nos dois caminhos — só muda o transporte. Os limites mudam: o Metabase não tem o timeout de 10 s do proxy, então os chunks podem ser maiores (testar 7–10 dias antes de assumir).

---

## 11. Riscos e pendências

| # | Item | Estado | Dono |
|---|---|---|---|
| P1 | A chave `gdk_` é aceita pelo proxy de dados? | **Não testado.** Se for, o cron do GoDeploy pode ficar autônomo e o operador sai do circuito. ~10 min de teste. | Lucas |
| P2 | Colunas de `bridge_kit_componente_gobeauty` e `shopify_order_items` | Não confirmadas nesta sessão (GoRAG caiu). Rodar `getDataSourceSchema` antes do seed. | sessão de dev |
| P3 | Estabilidade do GoRAG | Caiu uma vez hoje ("backend unavailable") e desconectou outra. Plano B no §10. | — |
| P4 | Validade / `age_days` por SKU | Não existe no Data Mart. Até existir, excluir de brinde SKUs perecíveis por `categoria`. | Supply |
| P5 | Frete marginal e imposto por SKU | Não existem por SKU. Parametrizar constante por marca e marcar como estimativa. | FP&A |
| P6 | Equivalência funcional (brinde ↔ upsell) | Não existe. Derivar de `linha` + `subcategoria` ou metafield Shopify. | Catálogo |
| P7 | Estoque com frescor de 6 h | Consequência do sync 2×/dia do Cosmos (§3). Aceito; declarar no pitch. | — |
| P8 | Exploração do bandit com pool de 241 SKUs | Mitigado pelo prior Yampi (§8, passo 4). Monitorar take rate nas primeiras horas. | — |
| P9 | `webgex_posicao_estoque_gb` | Morta — último snapshot 02–09/09. Não usar. | — |
| P10 | Metade do tráfego da Rituária não vê o componente | Teste de tema 50/50 rodando (`develop` × `main`); o componente vai só no `main`. Aceito. | — |

---

## 12. Arranque da sessão nova

Ordem sugerida, para não explodir contexto:

1. Ler este documento + Handoff técnico (score e regras). **Não** ler o Plano de dados inteiro — §4 e §8 daqui já trazem o que sobreviveu.
2. `getDataSourceSchema` nas duas tabelas de P2.
3. Criar o app `offer-api` (`createApp`), `setAppSlug`, `setAppSecret CURATE_TOKEN`. Deixar **público** — ele não lê o proxy, então não há conflito com §2.
4. Subir o esqueleto: `env.DB` com o DDL do §7, `/health`, `/curate/*`, `/recommend` devolvendo do `product` sem score ainda.
5. Rodar o passo 1 do seed e provar que `/recommend` devolve SKU real das duas marcas.
6. Kits + o teste `KRT99078` / `RT01008`. **Portão:** não avança sem isso passando.
7. Afinidade (20 chunks), prior, score, bandit.
8. Só então o tema.

O que **não** fazer: criar `offer-curator`, pedir `PLAUSIBLE_API_KEY`, configurar cron `/tasks/plausible`, aplicar estoque de segurança sobre o `available`, filtrar `product_status` em minúsculo.
