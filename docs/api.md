# Contrato do offer-api

**Base:** `https://offer-api.devgogroup.com` · app GoDeploy `ed10c7cb`, público
**Sem bearer:** `POST /recommend`, `POST /event`, `GET /health` — o que a loja usa.
Todo o resto, inclusive `/offers`, `/log`, `/pins` e `/config`, exige `CURATE_TOKEN`.
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
  "slot": 1,                     // só quando há curadoria — ver GET /pins
  "pinned": false,               // true = esta oferta veio de regra humana
  "pin_rule": null,              // "1|sku|RT01008" quando pinned
  "context": { "anchor": "RT01008", "cart_total": 89.9, "gap": 0, "threshold_label": null, ... },
  "latency_ms": 307
}
```

**Sem nenhuma regra de curadoria ativa, `slot`, `pinned`, `pin_rule` e `pins` não
aparecem** — o payload é byte a byte o de sempre. É o que torna o deploy desta
feature inerte enquanto ninguém cria regra.

`pins` no `/recommend` traz **só as regras que de fato ocuparam uma vaga**. As que
não colaram carregam o SKU que a marca queria empurrar e o código interno que o
barrou — e esta rota é pública. Isso reduz o que a curadoria acrescenta de
exposição, mas **não** torna o `/recommend` discreto: o objeto de cada oferta já
publicava `expected_margin`, `score` e `available` antes desta feature, e segue
publicando. Fechar isso mexe no contrato que o tema consome e está anotado como
decisão separada. Para diagnóstico use `debug: true`, o `/offers`
ou o `/log`; o tema não precisa, porque cada oferta já diz `pinned`, `slot` e
`pin_rule`.

> **`/offers`, `/log` e `/pins` passaram a exigir bearer.** Eram abertas, e não
> dava para sustentar: `/log` devolvia a margem esperada por produto, o preço, o
> score e o carrinho de shoppers reais para qualquer um na internet, e as três
> passaram a carregar o relatório de curadoria. Filtrar o `/recommend` com
> cuidado era teatro enquanto um GET vizinho entregava tudo.
>
> A loja **não** é afetada: o tema chama só `POST /recommend` e `POST /event`,
> que seguem públicos, e o `/health` também. Quem lê diagnóstico é você pelo
> terminal e o painel, que proxia com o token no servidor.

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

### Oferta curada vai para um braço separado

Evento sobre uma oferta que saiu por curadoria é contabilizado em
`offer_stats` com `segment` igual a `<segmento>|pin`. O `/recommend` liga o
`segment` cru do request, então **essas linhas nunca voltam para o amostrador**.

Não é higiene. O pin injeta exposição forçada, quase sempre na vaga 1, que
converte melhor por **posição** e não por mérito. Misturado, um pin de 30 dias
deixaria a posterior daquele braço tão dominante que o bandit continuaria
escolhendo o mesmo SKU depois de a regra expirar — o pin sobreviveria à própria
expiração, e desligar a curadoria não mudaria nada.

O braço `|pin` continua sendo gravado porque é o que permite defender ou matar
uma regra com número: *"este pin converte a 4,2% em 1.800 impressões; o orgânico
da mesma âncora roda a 11,1%"*.

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
| `cart` | — | SKUs separados por vírgula: monta carrinho de teste com vários itens |
| `no_pins` | 0 | `1` ignora a curadoria — o ranking do motor puro |
| `debug` | 0 | `1` traz a lista de rejeitados com motivo |

`debug` no `POST /recommend` **só é honrado com o bearer**. O campo vem do corpo
numa rota pública: aceitá-lo de qualquer um devolveria pela porta da frente a
lista de rejeitados e o relatório de curadoria que fechar `/offers` e `/log`
tirou da porta dos fundos. Sem token ele é ignorado, e a loja não sente nada.

O carrinho simulado é a própria âncora pelo preço real do catálogo — então o
teto de 60% se aplica sobre ele. Com `cart`, os SKUs extras entram pelo preço do
catálogo; SKU desconhecido entra a zero e não distorce o total.

Como a âncora é o item de maior valor, `cart` pode trocá-la — a resposta traz
`anchor_effective` além do `anchor` pedido.

Rodar a mesma chamada com e sem `no_pins=1` mostra lado a lado o que a curadoria
mudou. É a base do simulador do painel.

---

## `GET /pins?brand=` · `POST /pins` (bearer) · `POST /pins/delete` (bearer)

Curadoria manual: fixa um produto numa **vaga** do carrinho. Vaga é a posição na
lista que o `/recommend` devolve — com `n=3`, o carrinho tem as vagas 1, 2 e 3.

### O que o pin pode e não pode

O pin dispensa **apenas as travas econômicas**: teto de preço, faixa de gap e
preço mínimo. Ele **não** dispensa, em hipótese nenhuma:

`sku_in_cart` · `kit_contains_cart_sku` · `kit_overlaps_cart_kit` ·
`component_of_cart_kit` · `sku_is_gift` · `gift_functional_equivalent` ·
`out_of_stock` · `no_price` · `no_cogs` · `no_variant_id` · `below_margin_floor`

Quando a regra casa mas o produto bate numa dessas, a vaga cai no ranking normal
e o `pins[]` da resposta diz qual código barrou. Sem isso, quem criou a regra
veria a oferta "errada" no carrinho sem nenhuma forma de descobrir o motivo.

### Forma da regra

```jsonc
{
  "brand": "rituaria",
  "slot": 1,                       // 1..10
  "trigger_type": "always | sku | taxonomy",
  "trigger_sku": "RT01008",        // quando trigger_type=sku
  "trigger_field": "category | subcategory | line",  // quando taxonomy
  "trigger_value": "Fórmulas",     // gravado normalizado (acento/caixa)
  "offer_sku": "KRT99078",         // o produto que ocupa a vaga
  "surface": "*", "goal": "*",     // escopo; "*" vale para todos
  "priority": 0,
  "active": 1,
  "starts_at": null,
  "ends_at": "2026-12-31",         // data pura vira o FIM do dia em BRT
  "note": "campanha de fim de ano"
}
```

**Fuso das datas.** `2026-12-31` vira o fim do dia em BRT; `2026-12-31T23:59`
(o que um `datetime-local` manda) também é lido como BRT, e não no fuso da
máquina que gravou — senão o mesmo texto viraria instantes diferentes vindo do
Worker ou do computador de quem opera. Com `Z` ou `±HH:MM` explícito, o fuso
informado é respeitado.

O gatilho `taxonomy` casa contra o **carrinho inteiro**, não só a âncora.

### Precedência, quando duas regras disputam a mesma vaga

Quanto mais específico o "se", mais forte a regra:

1. `sku` > `taxonomy` > `always`
2. dentro de `taxonomy`: `subcategory` > `line` > `category`
3. escopo amarrado > curinga (`surface`/`goal` exatos vencem `*`)
4. `priority` maior
5. `updated_at` mais recente
6. chave da regra (garante ordem total — o ranking nunca muda sozinho)

`priority` **não** atravessa especificidade: um `always` com prioridade 99
continua perdendo de um gatilho por SKU. Para inverter, pause a regra mais
específica. O mesmo produto vencendo em duas vagas ocupa a **menor**.

### Chamadas

`GET /pins?brand=&slot=&active=&surface=&goal=` (bearer) — é o plano de
merchandising da marca mais o estado do estoque, então não é aberto. Devolve as
regras mais o estado calculado: `expired`, `not_started`, `effective`,
`offer_in_catalog` (avisa regra apontando para SKU que não existe) e
`performance`, que lê o braço `|pin` do bandit — `impressions`, `accepts` e um
`take_rate` que só vem preenchido a partir de 300 impressões, porque abaixo
disso a taxa mente e é na cauda que ela aparece. Dentro de
cada vaga a lista vem **na ordem da disputa**, usando o mesmo comparador do
motor — a primeira é a que venceria.

`POST /pins` (bearer) — grava **uma** regra, com **edição parcial**. A identidade
é `brand` + `slot` + `trigger_type` + o gatilho (`trigger_sku`, ou
`trigger_field` + `trigger_value`) + `surface` + `goal`. O escopo faz parte da
identidade de propósito: é o que permite "vaga 1 = A no carrinho" e "vaga 1 = B
na PDP" coexistirem. Regra criada com escopo explícito precisa ser identificada
com ele; quem não usa escopo cai em `*` nos dois e não percebe diferença. Se a regra já existe, só os campos enviados
mudam, num `UPDATE` das colunas informadas — então duas edições simultâneas de
campos diferentes não se atropelam. Por isso pausar é só `{"active": 0}` junto da
identidade, sem perder vigência, escopo, prioridade nem nota.

Editáveis desta forma: `offer_sku`, `priority`, `active`, `starts_at`,
`ends_at`, `note`. **Vaga, gatilho e escopo não**, porque são a identidade —
mudá-los é criar outra regra e apagar a antiga.

`active`, `priority`, `starts_at` e `ends_at` recusam string vazia: é o que um
formulário manda no campo não tocado, e aceitá-la despausaria a regra, zeraria o
desempate ou tornaria eterna uma campanha com data de fim, sempre em silêncio.
Para limpar uma data, mande `null` explícito.

A resposta traz `created` dizendo se foi criação ou edição, e `warnings` quando
`offer_sku` ou `trigger_sku` não estão no catálogo da marca. O casamento por SKU
é **exato**: um código com a grafia errada nunca dispara e aparece só como
`gatilho_nao_casou`, indistinguível de um carrinho que legitimamente não bate —
por isso o aviso na escrita. Regra inválida volta `400 invalid_rule` com um
`detail` legível; um corpo só com a identidade volta `400 nothing_to_update`.

`POST /pins/delete` (bearer) — `{brand, slot, trigger_type, trigger_sku}` remove
uma regra; `{brand, slot}` limpa a vaga inteira, e aceita `surface`/`goal` para
recortar por escopo. A resposta lista o que apagou: num delete por vaga,
"apagou 3" não diz se levou junto a regra de outra superfície. **Devolve `404 rule_not_found`
quando nada casou** — apagar nada e responder ok faria o operador acreditar que
removeu enquanto a regra segue decidindo o carrinho. É POST porque o CORS do app
só libera `GET, POST, OPTIONS`.

`POST /curate/pins` (bearer) — carga em lote, no formato dos outros `/curate`.
Diferente do `POST /pins`, aqui é **substituição total** da linha: campo que não
vier volta ao default. A exceção é `created_at`, preservado no re-push — não é
campo que alguém digita, e carimbá-lo a cada "salvar tudo" apagaria o instante
real de criação de todas as regras. Erros saem por
linha em `errors[]` sem derrubar o lote. E
`POST /curate/reset?table=pins&brand=` zera antes de recarregar.

`active` aceita o que uma exportação de planilha produz — `1/0`, `true/false`,
`sim/não`, `yes/no`, `y/n`, `t/f`, `on/off`, em qualquer caixa — e **recusa** o
que não reconhece, em vez de assumir "pausada" em silêncio.

### Por que uma regra não apareceu

Regra **pausada não viaja no `/recommend`**: campanha desligada não decide nada,
e o carrinho não pode carregar a cada request toda regra que a marca já
aposentou. O simulador recebe todas, porque é lá que "por que minha regra não
apareceu?" é a pergunta.

`GET /offers` devolve sempre `pins_discarded`, com o motivo de cada regra que
existe e não agiu, em ordem de precedência da checagem: `slot_invalido`,
`sem_vagas`, `pausada`, `expirada`, `ainda_nao_comecou`, `outra_superficie`,
`outro_goal`, `sem_offer_sku`, `gatilho_nao_casou`, `slot_fora_do_alcance`,
`vaga_tomada_por_regra_mais_especifica`, `produto_ja_fixado_em_vaga_menor`.
A vaga é a **última** checagem de propósito: uma regra pausada na vaga 5 relatada
como "fora do alcance" faria o operador aumentar o `n` do tema para nada. No `/recommend` isso só sai com `debug: true` —
no carrinho seria uma lista por regra pausada em toda requisição.

> **Simule com o mesmo `n` da loja.** O `/offers` usa `n=10` por padrão e o tema
> pede bem menos. Uma regra na vaga 3 age no simulador e **não** age num
> `/recommend` com `n: 1` — o descarte `slot_fora_do_alcance` traz o `n` no
> `detail` justamente para isso não passar batido.

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

## `GET /config?brand=` (bearer) · `POST /config` (bearer)

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
