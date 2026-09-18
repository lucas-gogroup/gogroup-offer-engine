# Contrato do offer-api

**Base:** `https://offer-api.devgogroup.com` · app GoDeploy `ed10c7cb`, público
**Marcas:** `barbours`, `rituaria`

O app não lê as bases do grupo. O dado é **empurrado** para ele via `/curate/*`
com bearer; em tempo real ele só consulta o próprio SQLite. Zero chamada de
modelo por requisição.

---

## `POST /recommend`

O endpoint do carrinho. Devolve **uma** oferta (ou uma lista, com `n`).

```jsonc
{
  "brand": "rituaria",           // obrigatório
  "surface": "cart",             // cart | pdp | checkout | crm   (default: cart)
  "goal": "aov",                 // aov | stock | margin          (default: aov)
  "cart": [                      // itens do carrinho
    { "sku": "RT01008", "variant_id": "900001", "qty": 1, "price": 89.90 }
  ],
  "cart_total": 89.90,           // opcional; vence a soma de `cart`
  "gifts": [{ "sku": "RT99001" }],// SKUs que já estão como BRINDE no carrinho
  "gap": 25.00,                  // R$ que faltam para o benefício
  "threshold": { "value": 199.00, "label": "Frete Grátis" },
  "customer": { "is_returning": false },
  "max_discount": 0.15,
  "price_target": null,
  "n": 1,                        // 1–10; >1 devolve `offers[]` ordenado
  "debug": false                 // true traz `rejected[]` e `timings`
}
```

### Como o benefício (frete grátis / 3x) é informado

Três formas, **nesta ordem de precedência**. Nenhuma vai ser removida.

| Campo | Efeito |
|---|---|
| `gap` | R$ que faltam, já calculado pelo tema. Vence se vier. |
| `threshold: {value, label}` | O motor calcula `gap = value − cart_total`. |
| `free_shipping_threshold` (brand_config) | Usado se o tema não mandar nada. |

O `label` é usado no copy: com `"Frete Grátis"` sai *"Leve X e ganhe Frete
Grátis"*. Mandar `gap` **e** `threshold` juntos é o recomendado — o `gap` manda
no número e o `label` no texto.

> **`gap` maior que o teto de preço — mudou.** O teto deixou de vetar quem fecha
> o benefício. Carrinho de R$ 49,90 com frete grátis em R$ 199 dá gap de
> R$ 149,10, e o motor **oferta** um item de R$ 149,90 a R$ 223,65 — a faixa que
> leva o carrinho ao frete sem passar longe. Quem chega com o carrinho de
> entrada é justamente quem tem o maior gap, e era quem nunca recebia nada.
>
> O limite continua existindo em dois lugares: a oferta não passa de
> `gap_overshoot_max` × gap (1,5 por default), e fora do caso de benefício
> vale o teto ordinário — `max(60% do carrinho, price_cap_abs)`, ele mesmo
> limitado a `price_cap_uplift_max` × carrinho.

### Resposta

```jsonc
{
  "offer_id": "of_8f2a...",      // guarde: é a chave do POST /event
  "sku": "RT02015",
  "variant_id": "53529470566691",// use no /cart/add.js
  "title": "Óleo de Rosa Mosqueta 30ml - 100% Puro",
  "image_url": "...", "url": "...",
  "price": 49.90,
  "final_price": 49.90,
  "incentive": { "type": "none|threshold|percent", "value": 0, "label": "..." },
  "closes_benefit": true,        // esta oferta leva o carrinho ao benefício
  "benefit_label": "Frete Grátis",
  "benefit_threshold": 199.00,   // o valor que passa a ser alcançado
  "cart_total_after": 199.80,    // carrinho + esta oferta
  "expected_margin": 0.72,
  "stock_coverage_days": 62.7,
  "affinity_score": 0.40,
  "stock_urgency": 1.0,
  "take_rate_sampled": 0.11,
  "score": 0.0421,
  "copy": "Quem levou esse também levou ...",
  "reason": "preço cheio; margem 73%",
  "ttl_seconds": 900,
  "context": { "anchor": "RT01008", "cart_total": 89.9, "gap": 0, "threshold_label": null, ... },
  "latency_ms": 307
}
```

**Sem oferta válida:** HTTP 200 com `offers: []` e `reason` explicando
(ex.: `"sem oferta: over_price_cap=73, kit_contains_cart_sku=14"`).
Nesse caso **esconda o bloco** — nunca renderize card vazio.

### A bandeira de benefício

Quando `closes_benefit` é `true`, **adicionar esta oferta garante o benefício** —
`benefit_label` traz o nome dele e `cart_total_after` o total resultante. É o
gancho para o selo no card ("Ganha Frete Grátis"), sem precisar interpretar o
texto do `copy`.

O `copy` nesse caso já vem com o número: *"Faltam R$ 149,10 para Frete Grátis —
leve X e garanta"*. Se o tema quiser escrever o próprio texto, os quatro campos
acima dão tudo: quanto falta (`context.gap`), o rótulo, o teto e o total final.

`closes_benefit: false` com `incentive.type: "none"` é a oferta comum, sem
promessa — renderize sem selo.

### Cabe ao tema

- `properties: {_offer_id, _offer_sku}` no `/cart/add.js`. O Yampi preserva as
  properties e é assim que o loop de compra fecha depois no Data Mart.
- Timeout: use ~2500 ms. O servidor responde em ~300 ms (p50), mas a rede até o
  edge domina o wall time.
- Render assíncrono, bloco escondido até ter resposta.

---

## `POST /event`

Realimenta o bandit **no próprio request** — sem cron, sem janela de 15 min.

```json
{ "offer_id": "of_8f2a...", "event": "impression", "order_id": null }
```

`event` ∈ `impression` | `accept` | `reject` | `checkout` | `purchase`.

> **Dois vocabulários, de propósito.** Para o Plausible o tema dispara
> `offer_impression`, `offer_accept`, `offer_reject`, `offer_checkout`. Para
> **esta API** os nomes são curtos. Mandar `offer_accept` aqui devolve
> `400 unknown_event`, e isso é intencional.
>
> Nunca use `upsell_*` no Plausible: a Rituária já dispara `upsell_accept`
> (734 em 2 dias) e `upsell_click` (645) pela camada existente, com props
> diferentes. A colisão contamina o aprendizado.

`reject` é registrado no log mas não mexe em contador: recusa já está implícita
em `impressions − accepts`, e contar de novo seria contar duas vezes.

---

## `GET /offers?brand=&anchor=`

Simulação: o ranking de uma âncora sem montar carrinho.

| Parâmetro | Default | |
|---|---|---|
| `brand`, `anchor` | — | obrigatórios |
| `goal`, `surface`, `segment` | aov, cart, new | |
| `n` | 10 | até 50 |
| `gap`, `max_discount` | — | |
| `gifts` | — | SKUs separados por vírgula |
| `debug` | 0 | `1` traz a lista de rejeitados com motivo |

O carrinho simulado é a própria âncora pelo preço real do catálogo — então o
teto de 60% se aplica sobre ele.

---

## `GET /log?brand=&limit=`

O `decision_log`. Toda chamada de `/recommend`, `/offers` e `/event` grava uma
linha com **contexto, decisão e motivo** — inclusive quando não há oferta.

```jsonc
{ "entries": [{
  "offer_id": "of_...", "ts": "...", "brand": "rituaria",
  "agent": "ofertante|simulacao|otimizador",
  "context": { "anchor": "RT01008", "cart_skus": [...], "gap": 0,
               "pool_size": 96, "candidates_after_filters": 1 },
  "decision": { "offer_sku": "RT99002", "score": 0.0029, "alternatives": [...] },
  "reason": "preço cheio; margem 72%"
}]}
```

---

## `GET /config?brand=` · `POST /config` (bearer)

Pisos e tetos por marca, **em runtime, sem redeploy**.

| Campo | Default | |
|---|---|---|
| `margin_floor` | 0.30 | piso de margem pós-incentivo |
| `price_cap_ratio` | 0.6 | teto da oferta sobre o carrinho |
| `price_cap_abs` | 60 | **piso absoluto do teto** — sem ele, 60% de R$ 49,90 é R$ 29,94 e a Rituária fica muda no carrinho de entrada |
| `price_cap_uplift_max` | 1.5 | trava do piso: ele nunca eleva o teto acima disso × carrinho |
| `gap_overshoot_max` | 1.5 | quanto quem fecha o benefício pode passar do gap |
| `max_discount` | 0.15 | teto do degrau 4 |
| `allow_percent_discount` | 0 | **desligado**: o checkout Yampi não aplica % |
| `free_shipping_threshold` | null | usado se o tema não mandar gap/threshold |
| `gap_hard_max` | 30 | até este gap, a faixa [gap, 3×gap] é filtro duro |
| `marginal_shipping`, `tax_rate` | 0, 0.10 | estimativa por marca (P5) |
| `prior_alpha`, `prior_beta` | Yampi | prior do bandit |
| `slow_moving_days` | 180 | limiar de slow moving |
| `dead_coverage_days` | 1800 | cobertura em que a urgência satura em 2,0 |

```bash
curl -X POST $OFFER_API/config -H "Authorization: Bearer $CURATE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"brand":"rituaria","margin_floor":0.35}'
```

---

## `POST /curate/<tabela>` (bearer)

`product` · `kits` · `affinity` · `sku_orders` · `brand_orders` · `prior`

```json
{ "rows": [...], "chunk": "rituaria-d0", "window_start": "2026-09-15", "window_end": "2026-09-18" }
```

| Tabela | Semântica |
|---|---|
| `product`, `kits` | **replace** (`INSERT OR REPLACE`) |
| `affinity`, `sku_orders`, `brand_orders` | **acumulam** — o mesmo par em vários chunks soma |
| `prior` | `{brand, take_rate, weight}` → Beta da marca; com `anchor_sku`+`offer_sku`, um par |

`POST /curate/reset?table=affinity[&brand=]` zera antes de uma recarga completa,
para a recarga não duplicar.

---

## `GET /health`

Contadores por tabela, SKUs por marca e as últimas cargas com janela declarada.

---

## CORS

Liberado para `thebarboursbeauty.com.br`, `rituaria.com.br` (com e sem `www`) e
`*.myshopify.com`. Outros domínios: ajustar `ALLOWED_ORIGINS`.
