# Handoff — plugar a Ápice no offer-api sem quebrar Barbour's e Rituária

2026-09-18 · sessão paralela · alvo: `https://offer-api.devgogroup.com`

> Leia [docs/api.md](../api.md) e a §4.1 de
> [execucao-seed.md](./2026-09-18-execucao-seed.md) antes de rodar qualquer query.

---

## 1. De onde o dado sai e para onde vai

**A API não lê o Data Mart.** Em tempo real ela consulta **só o SQLite do próprio
app** (`env.DB`). O Data Mart é lido **uma vez, por você, na carga** — read-only —
e o resultado é *empurrado* por HTTP. Nada em produção é escrito, nunca.

```
Data Mart (datamart, schema gold)        você, via GoRAG runQuery (SELECT)
├─ dim_produto_gobeauty ─────────┐
├─ shopify_inventory_current ────┼──► POST /curate/product     ──► env.DB.product
├─ bridge_kit_componente_gobeauty ──► POST /curate/kits        ──► env.DB.kit_components
├─ shopify_order_items ──────────┬──► POST /curate/affinity    ──► env.DB.affinity
│                                ├──► POST /curate/sku_orders  ──► env.DB.sku_orders
│                                └──► POST /curate/brand_orders──► env.DB.brand_orders
└─ vw_yampi_line_items ─────────────► POST /curate/prior       ──► env.DB.brand_config

                    tema Shopify ──► POST /event ──► env.DB.offer_stats
                    toda chamada ─────────────────► env.DB.decision_log, load_log
```

### Tabelas de origem (produção, só leitura)

| Tabela | O que sai dela | Vira |
|---|---|---|
| `gold.dim_produto_gobeauty` | `sku`/`codigo_shopify`, `nome`, `is_kit`, `categoria`, `subcategoria`, `linha`, `custo_unitario`, `custo_provisorio`, `margem_bruta_ref`, `imagem_url`, `url_loja`, `ativo`, `marca_conflitante` | `product` |
| `gold.shopify_inventory_current` | `variant_id`, `product_id`, `variant_price`, `product_title`, `available`, `product_status`, `location_active` | `product` |
| `gold.bridge_kit_componente_gobeauty` | `kit_codigo`, `componente_codigo`, `qty_per_kit`, `kit_marca`, `kit_no_cadastro_protheus`, `cruza_marca` | `kit_components` |
| `gold.shopify_order_items` | `order_id`, `sku`, `quantity`, `financial_status`, `created_at`, `price` | `affinity`, `sku_orders`, `brand_orders`, e a cobertura de estoque |
| `gold.vw_yampi_line_items` | `order_id`, `has_order_bump`, `payment_status` | prior do bandit em `brand_config` |

### Tabelas de destino (SQLite do app)

`product` · `kit_components` · `affinity` · `sku_orders` · `brand_orders` ·
`offer_stats` · `decision_log` · `load_log` · `brand_config`

**O que o `/recommend` lê em produção: nada.** Ele faz **um SELECT** sobre
`product` + `affinity` + `sku_orders` + `offer_stats` + `brand_orders` +
`brand_config`, todas locais. Nenhuma dependência de prod no caminho do shopper —
se o Data Mart cair, a loja continua recebendo oferta.

---

## 2. A Ápice é diferente em dois pontos. Medido, não suposto.

### 2.1 O join é por `codigo_shopify`, não por `sku`

```
join por p.sku              →  13 SKUs
join por p.codigo_shopify   → 101 SKUs   ← é este
join por p.codigo_protheus  →   0
join por p.ean              →   0
```

Barbour's e Rituária casam por `p.sku = i.sku`. **A Ápice não.** Usar o SQL do
§8 sem trocar isso entrega um pool de 13 e parece que "a Ápice não tem produto".

### 2.2 Custo real cobre só 28 dos 101

| | casam | com preço | com custo | **com custo REAL** | kits |
|---|---|---|---|---|---|
| Ápice | 101 | 101 | 101 | **28** | 61 |

Os outros 73 são `custo_provisorio = true`. O motor **não filtra custo
provisório hoje** — ele só rejeita `cogs` nulo. Carregar os 73 faria o motor
calcular piso de margem sobre custo que ninguém garante, e publicar oferta com
margem que talvez não exista. O piso de margem é o único campo inegociável do
handoff.

**Decisão desta carga: só os 28 com custo real.** É o que o POC §8 já resolveu
("pool de margem só com custo real"). Os 73 entram quando o FP&A/Catálogo
fechar o custo — e o `decision_log` vai medir quanto isso custou.

Volume não é o problema: **13.070 pedidos pagos em 6 dias**, na faixa da
Barbour's (14.273).

---

## 3. O único jeito de quebrar as outras marcas

`POST /curate/reset?table=affinity` **sem** `&brand=` apaga **todas as marcas**.

```bash
# ERRADO — leva Barbour's e Rituária junto
curl -X POST "$OFFER_API/curate/reset?table=affinity" -H "Authorization: Bearer $T"

# CERTO
curl -X POST "$OFFER_API/curate/reset?table=affinity&brand=apice" -H "Authorization: Bearer $T"
```

Fora isso, **carregar marca nova é seguro por construção**: `product` e
`kit_components` são `INSERT OR REPLACE` com PK `(brand, sku)` / `(brand,
kit_sku, component_sku)`, então escrever `apice` não toca em linha de outra
marca. O `/recommend` filtra `WHERE p.brand = ?`, então o pool de uma marca não
vaza na outra. Os três comportamentos têm teste (`test/worker.test.js`,
"isolamento por marca").

**Não rode `reset` em `product`, `kits` ou `offer_stats`.** Não precisa: a carga
é replace.

---

## 4. O que fazer

### Passo 0 — linha de base, para provar que nada quebrou

```bash
curl -s $OFFER_API/health | tee /tmp/health-antes.json
node scripts/validate.mjs > /tmp/validate-antes.txt
```

Guarde os dois. No fim, Barbour's tem que continuar com **145** e Rituária com
**96**, e o checklist tem que continuar 14/14.

### Passo 1 — catálogo da Ápice (28 SKUs)

Mesmo SQL do §8 passo 1, com **três** mudanças: `marca = 'apice'`, join por
`p.codigo_shopify = i.sku`, e o corte de custo provisório.

```sql
WITH inv AS (
  SELECT brand, sku,
         SUM(available)     AS available,
         MAX(variant_id)    AS variant_id,
         MAX(product_id)    AS product_id,
         MAX(variant_price) AS variant_price,
         MAX(product_type)  AS product_type,
         MAX(product_title) AS product_title
  FROM gold.shopify_inventory_current
  WHERE brand = 'apice'
    AND location_active
    AND product_status = 'ACTIVE'      -- MAIÚSCULO
    AND sku IS NOT NULL
  GROUP BY brand, sku
)
SELECT 'apice'                      AS brand,
       i.sku                        AS sku,          -- a chave é a do Shopify
       i.variant_id::text           AS variant_id,
       i.product_id::text           AS product_id,
       COALESCE(NULLIF(TRIM(i.product_title), ''), p.nome) AS title,
       p.is_kit                     AS is_kit,
       COALESCE(p.categoria, i.product_type) AS category,
       p.subcategoria               AS subcategory,
       p.linha                      AS line,
       i.variant_price              AS price,
       p.custo_unitario             AS cogs,
       p.custo_provisorio           AS cost_provisional,
       p.margem_bruta_ref           AS margin_ref,
       p.imagem_url                 AS image_url,
       p.url_loja                   AS url,
       i.available                  AS available,
       'datamart'                   AS source,
       'high'                       AS confidence
FROM gold.dim_produto_gobeauty p
JOIN inv i ON i.sku = p.codigo_shopify     -- <<< a diferença da Ápice
WHERE p.marca = 'apice'
  AND p.ativo
  AND NOT COALESCE(p.marca_conflitante, false)
  AND i.available > 0
  AND i.variant_price > 0
  AND p.custo_unitario IS NOT NULL
  AND NOT COALESCE(p.custo_provisorio, false)   -- <<< só custo real
ORDER BY i.sku;
```

**Valide antes de empurrar: ~28 linhas, todas com `variant_id`.** Se vier 101,
o corte de custo provisório caiu. Se vier 13, o join voltou para `p.sku`.

```bash
./scripts/take.sh apice-product
node scripts/push.mjs product .seed-cache/apice-product.json --chunk apice-catalog
```

> **Atenção à chave.** O `sku` gravado é o do Shopify (`i.sku`), porque é por ele
> que o tema manda o carrinho e é por ele que `shopify_order_items` fala. Não
> grave `p.sku` — a afinidade não casaria com o catálogo.

### Passo 2 — kits

`kit_marca = 'apice'`. A Ápice tem **685 kits / 2.214 linhas**, muito mais que as
outras. Se a resposta vier `truncated: true`, quebre por faixa de `kit_codigo`;
`kit_components` é replace, então carregar em partes é seguro.

```sql
SELECT kit_marca AS brand, kit_codigo AS kit_sku, componente_codigo AS component_sku,
       qty_per_kit, kit_no_cadastro_protheus AS protheus_ok, cruza_marca AS cross_brand
FROM gold.bridge_kit_componente_gobeauty
WHERE kit_marca = 'apice'
  AND kit_codigo IS NOT NULL AND componente_codigo IS NOT NULL
ORDER BY kit_codigo, componente_codigo;
```

**Confirme que `kit_codigo`/`componente_codigo` da Ápice falam a mesma língua do
`sku` que você gravou no passo 1.** Se o bridge usa código Protheus e o
`product` usa código Shopify, o filtro de kit não pega nada — e aí a Ápice
repete o erro da Rituária. Cheque assim:

```sql
SELECT COUNT(*) AS componentes_que_casam
FROM gold.bridge_kit_componente_gobeauty b
JOIN gold.shopify_inventory_current i
  ON i.brand = 'apice' AND i.sku = b.componente_codigo
WHERE b.kit_marca = 'apice';
```

**Se der 0, pare e reporte.** Sem kit resolvido não existe portão, e o portão é
o que justifica o projeto.

### Passo 3 — afinidade, em chunks de 3 dias

Mesmo SQL da §4.1 do execucao-seed, com `brand = 'apice'` e o top-10 por âncora
(`ROW_NUMBER() ... <= 10`) que segura a resposta abaixo do corte de 1.000 linhas
do GoRAG.

```bash
curl -X POST "$OFFER_API/curate/reset?table=affinity&brand=apice" -H "Authorization: Bearer $T"
# chunk 0: created_at >= now() - interval '3 days'
# chunk 1: entre 6 e 3 dias
node scripts/push.mjs affinity .seed-cache/apice-d0.json --chunk apice-d0 --from ... --to ...
```

Mais os denominadores (`sku_orders`, `brand_orders`) e as unidades vendidas para
derivar `coverage_days`, exatamente como em `docs/plan/2026-09-18-execucao-seed.md` §8.

### Passo 4 — prior do bandit

```sql
SELECT COUNT(DISTINCT order_id) AS pedidos_pagos,
       COUNT(DISTINCT order_id) FILTER (WHERE has_order_bump) AS com_bump
FROM gold.vw_yampi_line_items
WHERE brand = 'apice' AND payment_status = 'paid'
  AND created_at_date >= now() - interval '3 days';
```

`take_rate = com_bump / pedidos_pagos`, peso 20, via `/curate/prior`.

### Passo 5 — CORS

O domínio da Ápice ainda não está na allowlist. Peça para a sessão do motor
incluir, ou defina a env `ALLOWED_ORIGINS`. **Sem isso o tema da Ápice não
chama a API pelo navegador** (curl funciona, o que engana).

---

## 5. Portão da Ápice

A Rituária tinha o caso `RT01008 → KRT99078`. **Ache o equivalente na Ápice**:
um kit ofertável que contenha um SKU que o cliente costuma ter no carrinho.

```sql
SELECT b.kit_codigo, b.componente_codigo, b.kit_nome, b.componente_nome
FROM gold.bridge_kit_componente_gobeauty b
JOIN gold.shopify_inventory_current k
  ON k.brand='apice' AND k.sku = b.kit_codigo AND k.product_status='ACTIVE' AND k.available > 0
WHERE b.kit_marca = 'apice'
LIMIT 20;
```

Com o par em mãos:

```bash
curl -s -X POST $OFFER_API/recommend -H 'Content-Type: application/json' \
  -d '{"brand":"apice","cart":[{"sku":"<COMPONENTE>","qty":1,"price":<PRECO>}],"debug":true,"n":10}'
```

O kit **não** pode aparecer em `offers`, e tem que estar em `rejected` com
`code: "kit_contains_cart_sku"`. Repita com um carrinho caro (ex.: R$ 2.000),
para provar que quem barrou foi a composição e não o teto de preço.

**Não declare a Ápice pronta sem esse teste passando.**

---

## 6. Fechamento

```bash
curl -s $OFFER_API/health            # apice aparece; barbours 145 e rituaria 96 INTACTAS
node scripts/validate.mjs            # tem que continuar 14/14
```

Reporte: quantos SKUs entraram, qual o par do portão e a prova de que foi
barrado, quantos SKUs ficaram de fora por custo provisório (é o número que
destrava orçamento no Catálogo/FP&A), e se o bridge de kits da Ápice fala a
mesma chave do catálogo.

**Não faça:** não rode `reset` sem `&brand=apice`; não carregue SKU com
`custo_provisorio`; não use `p.sku` no join; não toque em `/config` das outras
marcas; não abra PR de tema.
