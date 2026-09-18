# Plano de dados — go-offer-engine (Barbour's e Rituária)

2026-09-18 · @Lucas

## Objetivo e escopo

Este plano diz, tabela por tabela, **de onde o go-offer-engine puxa cada dado, com qual filtro e qual validação**, para que a recomendação nunca saia de dado inconsistente. Vale para a POC: Shopify, superfícies PDP e carrinho, marcas **Barbour's** e **Rituária** (grupo Gobeauté, checkout Yampi).

Fonte de verdade por tipo de dado (definido pelo Oráculo):

| Dado | Fonte canônica | Via |
| --- | --- | --- |
| Vendas, pedidos, line items das marcas Gobeauté | Yampi no Data Mart (`runQuery(source:"datamart")`) | GoRag |
| Catálogo e variantes (IDs para publicar oferta) | Shopify Admin da loja | Shopify MCP |
| Estoque e custo | Data Mart / Protheus (via Middleware) quando disponível; senão Shopify `inventoryLevels` + `unitCost` | GoRag → fallback Shopify MCP |
| Funil e telemetria de upsell | ClickHouse (`plausible_events_db`, `analytics`) | GoRag |
| SQL já validado | Questions oficiais do Metabase (`searchQuestions` / `getQuestion`) | GoRag |

Valores de `brand` no datamart para estas marcas: `barbours` e `rituaria` (lowercase). Não existe `brand = 'gobeaute'`.

O agente que executar deve **confirmar colunas em runtime com `getDataSourceSchema`** antes de fixar qualquer nome — esta seção e as seguintes mapeiam o que existe hoje, e o schema pode mudar.

## Mapa de fontes (verificado no GoRag em 18/09/2026)

O Data Mart já tem quase tudo pronto para Barbour's e Rituária, inclusive composição de kit com BOM do Protheus, custo unitário e inventário Shopify. O fallback direto no Shopify MCP só é necessário se o `runQuery` falhar.

| Fonte (`runQuery source`) | Schema | Tabelas relevantes | Para quê |
| --- | --- | --- | --- |
| `datamart` | `gold` | `dim_produto_gobeauty` | Catálogo mestre Gobeauté: sku, `codigo_shopify`, `is_kit`, categoria/linha, `custo_unitario`, `custo_provisorio`, `preco_loja_ref`, `margem_bruta_ref`, imagem, URL |
| `datamart` | `gold` | `bridge_kit_componente_gobeauty` | Composição de kits (kit × componente × `qty_per_kit`), com flags de cadastro Protheus e `cruza_marca` |
| `datamart` | `gold` | `map_produto_codigo_gobeauty` | De-para código (Shopify/Yampi/Tiny/Protheus) → `produto_sk`, com flag `ambiguo` |
| `datamart` | `gold` | `shopify_inventory_current` / `shopify_inventory_snapshot` | Estoque atual por `brand`, `sku`, `variant_id`, `location`: `available`, `on_hand`, `committed`, `cost`, `is_stockout` |
| `datamart` | `gold` | `shopify_order_items` | Line items Shopify com `sku`, `variant_id`, `financial_status`, `price`, `total_discount`, `utm_*`, `discount_code` — base da co-compra por SKU |
| `datamart` | `gold` | `shopify_order_items_exploded_priced_enriched` | Kits explodidos pela BOM Protheus com `unit_cost` e `allocated_revenue` por componente — margem real de kit |
| `datamart` | `gold` | `vw_yampi_orders` / `vw_yampi_line_items` | Fonte de verdade de pedidos pagos (`payment_status`, `value_products`, `value_discount`, `promocode_*`, `has_order_bump`, `has_upsell`, `is_upsell`, `has_freebie`) — receita oficial e histórico de adoção de upsell |
| `datamart` | `gold` | `gobeaute_price_snapshot`, `okr_precos_sku_daily` | Histórico de preço por SKU/dia (validar colunas) |
| `datamart` | `gold` | `gobeaute_order_bump_alerted`, `cmv_por_pedido`, `vw_base_composition` | Contexto auxiliar: alertas de order bump, CMV por pedido, composição de base (validar antes de usar) |
| `datamart` | `gold` | `analytics_metrics`, `cro_daily_funnel`, `vw_cro_daily_funnel_rates` | Funil por marca/dia para guardrail de CR do A/B |
| `clickhouse` | `plausible_events_db` | `events_v2`, `sessions_v2`, `purchases_deduplicated` | Eventos custom `upsell_*` com props; aprendizado do Otimizador |
| `clickhouse` | `analytics` | `sessions`, `purchases_dedup_lm_v2` | Base das questions oficiais de funil/CRM da Gocase (referência de padrão) |

**Questions oficiais do Metabase para reaproveitar SQL:** 27585 (receita por cupom/dia), 27587 (1ª compra por cupom), 27662 (recompra × cupom), 27636 (descontos por tipo, Gobeaute), 27551 (funil Gobeaute por etapa), 27599/27597 (progressivo e cupom em % da receita). Ler com `getQuestion(id)` antes de escrever SQL do zero.

**Fora do escopo desta POC:** `site`/`factory` (só Gocase), `nexus` (AZ), `goconnect`.

### Referências Metabase indicadas pelo PM

| Referência | O que é | Como usar |
| --- | --- | --- |
| [Supply Intelligence — Matriz de Estoques Gogroup (card 27242, Metabase Gocase)](https://metabase.gocase.com.br/question/27242-supply-intelligence-matriz-estoques-gogroup) | Matriz oficial de estoque do grupo: classificação slow moving / descontinuado / dead, cobertura por SKU | Fonte canônica do `stock_status` e da `urgência_de_estoque`. Está na instância **Metabase Gocase**, não no Data Mart do GoRag: ler via Metabase MCP (`export card_id=27242`) ou reproduzir a lógica de classificação (cobertura > 180 d = slow) sobre `shopify_inventory_current` + vendas. Não indexada pelo `searchQuestions` do GoRag |
| [`gold.gobeaute_price_snapshot` (tabela 5931, Data Mart db 43)](https://metabase.gobeaute.com.br/question#eyJkYXRhc2V0X3F1ZXJ5Ijp7ImRhdGFiYXNlIjo0MywidHlwZSI6InF1ZXJ5IiwicXVlcnkiOnsic291cmNlLXRhYmxlIjo1OTMxfX0sImRpc3BsYXkiOiJ0YWJsZSIsInZpc3VhbGl6YXRpb25fc2V0dGluZ3MiOnt9fQ==) | Snapshot de preço por produto Yampi: `brand`, `id_product`, `name_product`, `item_price`, `last_seen`, `updated_at` | Preço praticado no checkout por `id_product` Yampi; juntar ao SKU via `map_produto_codigo_gobeauty`. Complementa `variant_price` do Shopify para detectar divergência de preço entre vitrine e checkout |

**Dados de upsell já existentes no Oráculo (confirmado em 18/09):** `vw_yampi_orders` traz `has_order_bump` e `order_bump_types` por pedido (order bump do checkout Yampi: Rituária 9,8%, Ápice 12,5%, Barbour's 7,7%, Lescent 7,7%, Kokeshi 4,0% dos pedidos pagos em 30 d). `has_upsell` e `has_freebie` estão zerados. **Não há evento de exibição/aceite do upsell de carrinho do tema** em nenhuma fonte — o Plausible passa a ser essa fonte a partir da POC.

## Tabela a tabela: fonte, colunas, filtros e fallback

Cada tabela do motor com sua fonte canônica, as colunas confirmadas no schema e o fallback. Filtro de marca sempre `brand IN ('barbours','rituaria')` (ou `marca`, conforme a tabela).

### `product_master`

| Item | Definição |
| --- | --- |
| Fonte canônica | `gold.dim_produto_gobeauty` + `gold.shopify_inventory_current` (para `variant_id`/`product_id`) |
| Colunas | `sku`, `codigo_shopify`, `nome`, `is_kit`, `ativo`, `categoria`, `subcategoria`, `linha`, `imagem_url`, `url_loja`, `preco_loja_ref`; do inventário: `variant_id`, `product_id`, `product_type`, `variant_price`, `product_status` |
| Filtros | `marca IN (...)`, `ativo = true`, `marca_conflitante = false`, `product_status = 'active'` |
| Join | `dim_produto_gobeauty.sku = shopify_inventory_current.sku` (mesma marca); órfãos vão para lista de exceção |
| Fallback | Shopify MCP `search_products` / `get-product` |

### `kit_components`

| Item | Definição |
| --- | --- |
| Fonte canônica | `gold.bridge_kit_componente_gobeauty` |
| Colunas | `kit_codigo`, `componente_codigo`, `qty_per_kit`, `kit_marca`, `componente_marca`, `kit_no_cadastro_protheus`, `componente_no_cadastro_protheus`, `cruza_marca` |
| Filtros | `kit_marca IN (...)`; sinalizar kits com `kit_no_cadastro_protheus = false` (composição não confiável) |
| Custo por componente | `gold.shopify_order_items_exploded_priced_enriched.unit_cost` (média ponderada Protheus, as-of) ou `dim_produto_gobeauty.custo_unitario` do componente |
| Equivalência funcional | não existe no Data Mart — derivar de `linha` + `subcategoria` ou metafield Shopify; obrigatório para a regra brinde ↔ upsell |
| Fallback | Shopify Bundles (`productVariantComponents`) ou metafield; mapear à mão os kits ativos das duas marcas se necessário |

### `inventory_snapshot`

| Item | Definição |
| --- | --- |
| Fonte canônica | `gold.shopify_inventory_current` (atual) e `gold.shopify_inventory_snapshot` (histórico) |
| Colunas | `brand`, `sku`, `variant_id`, `location_id`, `location_active`, `available`, `on_hand`, `committed`, `reserved`, `incoming`, `is_stockout`, `last_updated_at` |
| Filtros | `location_active = true`; somar `available` por `sku` quando há mais de uma location |
| Cobertura | `avg_daily_sales_30d/90d` derivada de `gold.shopify_order_items` (paid) por `sku`; `coverage_days = SUM(available) / avg_daily_sales_90d` |
| Validade (`age_days`) | não está no Data Mart — abrir como pendência com Supply; até lá, excluir de brinde SKUs marcados como perecíveis por `categoria` |
| Fallback | Shopify MCP `get-inventory-levels` |

Classificação de `stock_status`: preferir a matriz Supply Intelligence (card 27242) quando acessível; senão, derivar: `normal` (< 90 d), `slow` (≥ 180 d), `discontinued` (flag de catálogo), `dead` (sem venda em 180 d e `available` > 0).

### `product_cost`

| Item | Definição |
| --- | --- |
| Fonte canônica | `gold.dim_produto_gobeauty.custo_unitario` (com `custo_provisorio`, `custo_origem`) |
| Cruzamento | `gold.shopify_inventory_current.cost` (custo cadastrado no Shopify) para detectar divergência > 15% |
| Preço | `shopify_inventory_current.variant_price` (atual) e `preco_loja_ref`; histórico em `gobeaute_price_snapshot` |
| Margem de referência | `dim_produto_gobeauty.margem_bruta_ref` como sanity check do `price_room` |
| Frete marginal e imposto | não estão por SKU no Data Mart — parametrizar por marca (constante) na POC e marcar como estimativa |
| Regra | `custo_provisorio = true` → `confidence = 'low'` e peso de margem reduzido no score |

### `affinity_matrix`

| Item | Definição |
| --- | --- |
| Fonte canônica | `gold.shopify_order_items` (tem `sku` e `variant_id`; Yampi expõe `id_product`/`slug`, não SKU) |
| Filtros | `brand IN (...)`, `financial_status = 'paid'`, `created_at >= now() - 90 days`, `gift_card = false`, excluir linhas com `price = 0` (brindes) |
| Cálculo | pares `(sku_a, sku_b)` no mesmo `order_id`; `co_purchase_count`, \`lift = P(B |
| Reconciliação | contagem de pedidos pagos por dia vs `vw_yampi_orders` (`payment_status = 'paid'`) — divergência > 3% bloqueia a carga |
| Sinal histórico de upsell | `vw_yampi_line_items`: `is_upsell`, `has_order_bump`, `order_bump_types`, `has_freebie` — prior do `take_rate` por par antes de o Plausible acumular dados |
| Fallback | Shopify MCP `list-orders` / `graphql_query` 60–90 d |

### `price_room`

Derivada 100% das tabelas acima: `floor_price = (custo_unitario + frete_marginal + picking) / (1 − tax − piso_margem)`; `room_pct = 1 − floor_price / variant_price`; para kits, `min_bundle_price = SUM(floor_price dos componentes × qty_per_kit)`. Comparar `room_pct` com `margem_bruta_ref` e alertar se o piso implicar desconto acima do que a marca já pratica.

### `offer_events`

| Item | Definição |
| --- | --- |
| Fonte | `clickhouse.plausible_events_db.events_v2` (eventos custom com props) |
| Filtro | `name IN ('upsell_impression','upsell_accept','upsell_reject','upsell_purchase')`, `site_id` das lojas Barbour's e Rituária |
| Props | `offer_id`, `anchor_sku`, `offer_sku`, `surface`, `goal`, `segment`, `incentive_type`, `incentive_value`, `brand`, `offer_price`, `order_id` |
| Dialeto | ClickHouse (`countIf`, `toDate`) — não é Postgres |
| Fechamento do loop | `upsell_purchase` cruzado com `vw_yampi_orders.order_number` para AOV real |

## Queries de carga (SQL base)

SQL de partida para o agente, em Postgres (`runQuery(source:"datamart")`) salvo onde indicado. Nomes de coluna confirmados no schema em 18/09; ainda assim, rodar `getDataSourceSchema` antes de executar. Atenção ao flag `truncated` do `runQuery`: agregue ou use `LIMIT`.

### product\_master

```sql
SELECT p.marca AS brand, p.sku, p.codigo_shopify, p.nome, p.is_kit, p.categoria, p.subcategoria, p.linha,
       p.imagem_url, p.url_loja, p.preco_loja_ref,
       i.variant_id, i.product_id, i.product_type, i.variant_price, i.product_status
FROM gold.dim_produto_gobeauty p
LEFT JOIN (
  SELECT brand, sku, MAX(variant_id) variant_id, MAX(product_id) product_id,
         MAX(product_type) product_type, MAX(variant_price) variant_price, MAX(product_status) product_status
  FROM gold.shopify_inventory_current
  WHERE brand IN ('barbours','rituaria') AND location_active
  GROUP BY brand, sku
) i ON i.brand = p.marca AND i.sku = p.sku
WHERE p.marca IN ('barbours','rituaria') AND p.ativo AND NOT p.marca_conflitante;
```

### kit\_components

```sql
SELECT kit_marca AS brand, kit_codigo AS kit_sku, componente_codigo AS component_sku, qty_per_kit,
       kit_no_cadastro_protheus, componente_no_cadastro_protheus, cruza_marca,
       c.custo_unitario AS component_cogs, c.preco_loja_ref AS component_list_price
FROM gold.bridge_kit_componente_gobeauty b
LEFT JOIN gold.dim_produto_gobeauty c ON c.sku = b.componente_codigo AND c.marca = b.componente_marca
WHERE kit_marca IN ('barbours','rituaria');
```

### inventory\_snapshot + cobertura

```sql
WITH stock AS (
  SELECT brand, sku, SUM(available) available, SUM(on_hand) on_hand, SUM(committed) committed,
         BOOL_OR(is_stockout) is_stockout, MAX(last_updated_at) snapshot_at
  FROM gold.shopify_inventory_current
  WHERE brand IN ('barbours','rituaria') AND location_active
  GROUP BY brand, sku
), sales AS (
  SELECT brand, sku,
         SUM(quantity) FILTER (WHERE created_at >= now() - interval '30 days') / 30.0 AS avg_daily_30d,
         SUM(quantity) / 90.0 AS avg_daily_90d
  FROM gold.shopify_order_items
  WHERE brand IN ('barbours','rituaria') AND financial_status = 'paid'
    AND created_at >= now() - interval '90 days'
  GROUP BY brand, sku
)
SELECT s.*, COALESCE(v.avg_daily_30d,0) avg_daily_30d, COALESCE(v.avg_daily_90d,0) avg_daily_90d,
       CASE WHEN COALESCE(v.avg_daily_90d,0) > 0 THEN s.available / v.avg_daily_90d END AS coverage_days
FROM stock s LEFT JOIN sales v USING (brand, sku);
```

### product\_cost

```sql
SELECT p.marca AS brand, p.sku, p.custo_unitario AS cogs, p.custo_provisorio, p.custo_origem,
       i.cost AS shopify_cost, i.variant_price AS current_price, p.preco_loja_ref AS list_price, p.margem_bruta_ref,
       CASE WHEN i.cost IS NOT NULL AND p.custo_unitario IS NOT NULL
            AND ABS(i.cost - p.custo_unitario) / NULLIF(p.custo_unitario,0) > 0.15 THEN true ELSE false END AS cost_divergent
FROM gold.dim_produto_gobeauty p
LEFT JOIN (SELECT brand, sku, MAX(cost) cost, MAX(variant_price) variant_price
           FROM gold.shopify_inventory_current WHERE location_active GROUP BY brand, sku) i
  ON i.brand = p.marca AND i.sku = p.sku
WHERE p.marca IN ('barbours','rituaria') AND p.ativo;
```

### affinity\_matrix (co-compra 90 d)

```sql
WITH li AS (
  SELECT brand, order_id, sku
  FROM gold.shopify_order_items
  WHERE brand IN ('barbours','rituaria') AND financial_status = 'paid'
    AND created_at >= now() - interval '90 days' AND NOT gift_card AND price > 0
  GROUP BY brand, order_id, sku
), tot AS (SELECT brand, COUNT(DISTINCT order_id) n_orders FROM li GROUP BY brand),
sku_n AS (SELECT brand, sku, COUNT(DISTINCT order_id) n_sku FROM li GROUP BY brand, sku),
pairs AS (
  SELECT a.brand, a.sku anchor_sku, b.sku candidate_sku, COUNT(DISTINCT a.order_id) co_purchase_count
  FROM li a JOIN li b ON a.brand = b.brand AND a.order_id = b.order_id AND a.sku <> b.sku
  GROUP BY a.brand, a.sku, b.sku
)
SELECT p.brand, p.anchor_sku, p.candidate_sku, p.co_purchase_count,
       p.co_purchase_count::numeric / na.n_sku AS p_b_given_a,
       (p.co_purchase_count::numeric / na.n_sku) / (nb.n_sku::numeric / t.n_orders) AS lift
FROM pairs p
JOIN sku_n na ON na.brand = p.brand AND na.sku = p.anchor_sku
JOIN sku_n nb ON nb.brand = p.brand AND nb.sku = p.candidate_sku
JOIN tot t ON t.brand = p.brand
WHERE p.co_purchase_count >= 3;
```

### prior de take rate (histórico de upsell no Yampi)

```sql
SELECT brand, is_upsell, has_order_bump, order_bump_types, has_freebie,
       COUNT(DISTINCT order_id) orders, SUM(item_quantity) units
FROM gold.vw_yampi_line_items
WHERE brand IN ('barbours','rituaria') AND payment_status = 'paid'
  AND created_at_date >= now() - interval '90 days'
GROUP BY 1,2,3,4,5;
```

### offer\_events (ClickHouse)

```sql
SELECT toDate(timestamp) d, brand, anchor_sku, offer_sku, surface, segment,
       countIf(name = 'upsell_impression') impressions,
       countIf(name = 'upsell_accept') accepts,
       countIf(name = 'upsell_purchase') purchases
FROM plausible_events_db.events_v2
WHERE name IN ('upsell_impression','upsell_accept','upsell_reject','upsell_purchase')
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY d, brand, anchor_sku, offer_sku, surface, segment;
```

As props no `events_v2` ficam em colunas de array (`meta.key` / `meta.value`); o agente deve confirmar a forma exata no schema (`getDataSourceSchema("clickhouse:plausible_events_db.events_v2")`) e extrair com `meta.value[indexOf(meta.key, 'anchor_sku')]` ou equivalente.

## Regras de consistência

O motor só recomenda o que passou por estas regras. Cada uma existe porque um dos quatro casos do diagnóstico (Rituária, Tote Mini, Base Fit, Ápice) nasce de dado inconsistente.

| Regra | Como aplicar | Por quê |
| --- | --- | --- |
| Identidade de SKU 1:1 | `dim_produto_gobeauty.sku` = `shopify_inventory_current.sku` = `shopify_order_items.sku`; usar `map_produto_codigo_gobeauty` para códigos Yampi/Tiny e descartar `ambiguo = true` | Oferta publicada com `variant_id` errado quebra o add-to-cart |
| Pedido pago, não criado | Shopify: `financial_status = 'paid'`; Yampi: `payment_status = 'paid'`; nunca `created_at` sem status | Co-compra e cobertura inflam com pedidos não pagos |
| Uma linha por SKU por pedido na co-compra | `GROUP BY order_id, sku` antes de parear | Quantidade > 1 duplica pares |
| Kits explodidos para afinidade | usar `exploded_priced_enriched.effective_sku` quando o objetivo é afinidade de componente; kit inteiro quando é oferta de kit | Sem explodir, o Trio e o Magnésio parecem não relacionados |
| Brinde fora da afinidade | excluir `price = 0` e linhas com `has_freebie`/`is_upsell` do histórico quando calcular co-compra orgânica | Brinde não é escolha do cliente |
| Estoque somado por SKU e só location ativa | `SUM(available)` com `location_active`; `is_stockout` bloqueia | Location inativa mostra estoque fantasma |
| Custo com confiança | `custo_provisorio = true` ou divergência > 15% vs `shopify_inventory_current.cost` → `confidence = 'low'` | Piso de margem errado = desconto que destrói margem |
| Janela fixa e declarada | 90 d para afinidade e cobertura, 30 d para eventos; guardar `window_start/end` em toda tabela derivada | Comparabilidade entre cargas |
| Reconciliação Shopify ↔ Yampi | pedidos pagos por dia devem bater dentro de 3%; fora disso, bloquear carga e alertar | Yampi é a fonte oficial de receita |
| Dialeto por fonte | Postgres em `datamart`; ClickHouse em `clickhouse` (`countIf`, `toDate`, `INTERVAL 30 DAY`) | Query errada falha silenciosamente com outro nome |
| `truncated` do `runQuery` | se true, agregar ou paginar; nunca usar resultado cortado | Matriz incompleta gera ranking enviesado |
| Proveniência | toda tabela derivada carrega `source`, `loaded_at`, `confidence` | Guardião e pitch precisam saber o que é estimado |

## Checklist de validação do agente

Antes de ligar o motor no carrinho ou na PDP, o agente prova cada item abaixo e registra o resultado (número ou lista) no log de carga.

- [ ] `getDataSourceSchema` rodado para as 7 tabelas do Data Mart usadas; nenhuma coluna assumida
- [ ] Contagem de SKUs ativos em `product_master` por marca, e % com `variant_id` resolvido (meta ≥ 95%)
- [ ] Lista de SKUs órfãos (sem match Shopify ↔ dim\_produto) salva em exceção, não no pool
- [ ] Todos os kits ativos das duas marcas têm composição em `kit_components`; os sem `kit_no_cadastro_protheus` estão marcados
- [ ] Teste do caso Rituária: para carrinho com Magnésio Inositol, o Trio de Queridinhos é filtrado
- [ ] Teste do caso brinde: SKU marcado como brinde do principal não aparece como upsell
- [ ] % de SKUs com `cogs` não provisório (meta ≥ 80%); os demais com `confidence = 'low'`
- [ ] Divergência de custo Shopify vs Data Mart listada; nenhum SKU divergente com `confidence = 'high'`
- [ ] Cobertura calculada; SKUs com `is_stockout` ou `available` < segurança fora do pool
- [ ] Reconciliação de pedidos pagos Shopify vs Yampi nos últimos 30 dias dentro de 3%
- [ ] `affinity_matrix` com ≥ 3 co-compras por par; nº de pares por marca registrado
- [ ] Para cada kit ofertável, `kit_price × (1 − incentivo) ≥ min_bundle_price`
- [ ] Eventos `upsell_*` disparados em staging chegam ao `events_v2` com todas as props (validar com uma query)
- [ ] Todas as tabelas derivadas com `source`, `loaded_at`, `confidence`, `window_start/end`
- [ ] Pendências abertas com dono: `age_days`/validade (Supply), frete marginal e imposto por SKU (FP&A), equivalência funcional de brinde (Catálogo)
