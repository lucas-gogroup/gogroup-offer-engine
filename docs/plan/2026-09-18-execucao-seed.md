# Execução da §12 — o que foi feito, medido e mudado

2026-09-18 · sessão de desenvolvimento · segue [Arquitetura travada e primeiro seed](./2026-09-18-arquitetura-e-seed.md)

App no ar: **https://offer-api.devgogroup.com** (GoDeploy `ed10c7cb`, público)
Contrato: [docs/api.md](../api.md) · `npm test` (56) · `node scripts/validate.mjs` (14/14)

---

## 1. P2 fechada: as duas tabelas conferem

`getDataSourceSchema` rodado antes do seed, como manda o §8.

- **`gold.bridge_kit_componente_gobeauty`** — tem exatamente as colunas que o
  plano supôs: `kit_codigo`, `componente_codigo`, `qty_per_kit`, `kit_marca`,
  `componente_marca`, `kit_no_cadastro_protheus`, `cruza_marca`.
- **`gold.shopify_order_items`** — `order_id`, `sku`, `brand`,
  `financial_status`, `created_at`, `price`, `quantity`, `properties_data`.
  O SQL do §8 passo 3 vale como está escrito.

**P2 está fechada.** Nenhuma correção necessária no plano.

---

## 2. O portão passou

Carrinho com `RT01008` **não** oferta `KRT99078`. Verificado contra o app no ar,
não em mock:

```
rejected: { sku: "KRT99078", code: "kit_contains_cart_sku", detail: "KRT99078⊃RT01008" }
```

A composição real confirmou o caso: `KRT99078` = `RT01003` + `RT01005` + `RT01008`.

E não é só esse kit: **14 kits** que contêm `RT01008` são barrados. Com carrinho
de R$ 2.000 — onde o teto de 60% não protegeria — os 14 continuam barrados, o
que prova que a regra que age é a de composição, não a de preço.

Coberto por teste em três níveis: unitário (`hardFilterReject`), de ranking
(`decide`), e ponta a ponta pelo HTTP.

---

## 3. O seed, medido

| | Barbour's | Rituária | |
|---|---|---|---|
| `product` ofertável | **145** | **96** | bate com o §5 na vírgula |
| custo provisório | 0 | 0 | 100% custo real |
| sem `variant_id` | 0 | 0 | |
| `kit_components` | 212 kits | 120 kits | 826 linhas |
| `affinity` | — | — | **2.003 pares**, janela de 6 d |
| `sku_orders` | — | — | 294 SKUs |
| pedidos pagos (6 d) | 14.273 | 18.334 | denominador do lift |

**Prior do bandit** (medido agora, 3 d, `vw_yampi_line_items`): pedidos pagos com
order bump — Barbour's **10,01%**, Rituária **11,12%**. Peso 20 →
`Beta(2,002 / 17,998)` e `Beta(2,224 / 17,776)`.

**Cobertura de estoque** derivada de unidades vendidas em 6 d (não existe no Data
Mart): mediana **678 dias**, p90 6.740. 184 dos 241 SKUs passam de 180 d.

---

## 4. Desvios do plano, com o motivo

### 4.1 Transporte do seed: GoRAG, com chunks de 3 dias

O §10 previa Metabase como plano B. **Não serviu**: uma agregação simples de
15 d sobre `shopify_order_items` levou **4min40s** no Metabase db 43 e estourou,
enquanto a mesma query roda em segundos pelo GoRAG. Metabase é mais lento para
essa tabela, não mais rápido.

O que limita o GoRAG não é o timeout de 10 s — é um **corte de 1.000 linhas por
resposta**, que o plano não registrava. E o "backend unavailable" (P3) é um
guarda de custo, não queda: query trivial passa enquanto a pesada falha, de
forma intermitente.

**O que funciona:** janelas de **3 dias** (como o §7.2 já dizia), com
`ROW_NUMBER() ... <= 10` para o top-10 candidatos por âncora, o que mantém cada
resposta abaixo do corte de 1.000 linhas. Quatro chunks carregados
(2 marcas × 2 janelas de 3 d), somando corretamente entre chunks.

**Consequência:** a janela é de 6 dias, não 30. Estender é rodar o mesmo loop com
`created_at` deslocado — `affinity` acumula por contrato, sem mudar código.

### 4.2 Urgência de estoque virou rampa

O handoff define 1,5 para cobertura > 180 d. Medido no pool real, **184 dos 241
SKUs** passam de 180 d. Um degrau fixo colocaria 76% do pool no mesmo valor e o
`goal=stock` deixaria de ordenar.

Virou rampa que mantém os dois pontos do handoff — **1,5 no limiar, 2,0 no
estoque morto** — e discrimina no meio. `dead_coverage_days` (default 1800) é
ajustável por marca via `/config`.

### 4.3 Título do produto vem do Shopify, não do Data Mart

`dim_produto_gobeauty.nome` carrega EAN e sufixo interno em **156 dos 241** SKUs
("7901128400013 - Body Splash Ocean Homme ... -A3"). Isso ia direto para o copy
do carrinho. O `title` passou a ser `shopify_inventory_current.product_title`,
com fallback para `nome`. É também o título que o cliente vê na PDP daquele
`variant_id`, que é por onde a oferta entra no carrinho.

### 4.4 `brand_config`: tabela nova, além do §7

Os pisos de margem por marca estão como "não decidido ainda" no plano, e as
regras precisam mudar sem redeploy. Uma linha por marca; ausente = defaults.
Ver `/config` em [docs/api.md](../api.md).

### 4.5 Desconto % nasce desligado

`allow_percent_discount = 0` por default: o checkout Yampi não aplica desconto
percentual (POC §1.1). A escada calcula `price_room` e `expected_margin` de
qualquer jeito, mas só publica os degraus que funcionam hoje — preço cheio e
fechamento de gap de benefício. Ligar é um `POST /config`.

---

## 5. Latência: 300 ms não é alcançável com log síncrono

O §8 pede p95 < 300 ms. Medido, com a decomposição:

```
total ~307 ms  =  SELECT 168 ms  +  score 0 ms  +  decision_log 139 ms
```

**O score é gratuito.** O custo é ida e volta ao `env.DB` do GoDeploy: ~150 ms
por operação, e o `/recommend` faz duas — uma leitura e a gravação do log.
Um 404 sem query nenhuma já leva ~700 ms de wall time daqui do Brasil, então a
rede até o edge domina o que o shopper sente.

Foi otimizado do que dava: de **1019–1243 ms** para **~307 ms p50 / 389 ms p95**,
juntando catálogo, afinidade, denominadores, contadores do bandit, kits do
carrinho e config da marca **num único SELECT**. Antes eram cinco leituras,
incluindo varrer `kit_components` (826 linhas) e `sku_orders` (294) inteiras a
cada chamada.

Cair abaixo de 300 ms exigiria **não gravar o `decision_log` no request** — o que
contraria o requisito de log em toda chamada, e criaria corrida com o `/event`,
que resolve o `offer_id` pelo log. **Decisão: manter a gravação síncrona.** O
checklist trata 300 ms como aviso e checa 1.000 ms como limite duro, bem abaixo
do timeout de 2.500 ms do tema.

---

## 6. Dois bugs achados pela sessão do tema, batendo na API

Vieram de request real, não de leitura de plano. Os dois estão corrigidos.

1. **`threshold` era aceito e ignorado.** O corpo documentado no §5.1 do plano
   dos temas devolvia 200 com `context.gap = 0` — a feature de threshold ia
   nascer morta, sem erro aparecendo. Agora `threshold: {value, label}` é
   honrado, `cart_total` também, e `gap` continua valendo com precedência.
   O `label` passou a alimentar o copy (antes "frete grátis" era hardcoded).
2. **Latência de ~1 s** contra timeout de 300 ms no tema — §5 acima.

---

## 7. O que fica aberto

| # | Item | Estado |
|---|---|---|
| P1 | Chave `gdk_` no proxy | Não testado. Sem ela, a recarga é operada (é o desenho D2, não um bloqueio). |
| P3 | Estabilidade do GoRAG | Confirmada instável. Mitigada por chunks de 3 d + top-10 por âncora. |
| P4 | Validade / `age_days` | Continua fora do Data Mart. Brinde de perecível ainda não tem guarda. |
| P5 | Frete marginal e imposto por SKU | Constante por marca em `brand_config`, marcada como estimativa. |
| P6 | Equivalência funcional | Heurística `linha + subcategoria`. Declarada no código. |
| — | Janela de afinidade | 6 d. Estender é rodar o mesmo loop; `affinity` acumula. |
| — | Guardião | Não implementado. Os guardrails duros (piso de margem, estoque, teto) rodam por request; pausa por queda de CR não. |
| — | Copy por IA | Templates determinísticos por regra. AI Proxy segue roadmap, como o POC previa. |

---

## 8. Como recarregar

```bash
# catálogo + kits (resultado do runQuery vai para .seed-cache/)
node scripts/push.mjs product .seed-cache/product-enriched.json --chunk catalog
node scripts/push.mjs kits    .seed-cache/kits.json            --chunk kits

# afinidade: um chunk de 3 d por marca, acumulando
curl -X POST "$OFFER_API/curate/reset?table=affinity" -H "Authorization: Bearer $CURATE_TOKEN"
node scripts/push.mjs affinity .seed-cache/aff-<marca>-d<N>.json --chunk <marca>-d<N> --from ... --to ...

npm test && node scripts/validate.mjs
```
