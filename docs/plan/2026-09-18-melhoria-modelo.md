# Execução do plano de melhoria do modelo

2026-09-18 · segue [plano de melhoria](https://…) e [execução da §12](./2026-09-18-execucao-seed.md)

App no ar: **https://offer-api.devgogroup.com** (GoDeploy `ed10c7cb`)
`npm test` 85 · `node scripts/validate.mjs` 17/17

---

## 1. O que foi medido antes de codar

O plano pedia uma verificação de cinco minutos: conferir se `line`, `subcategory`
e `category` estão preenchidas. Feita — e a resposta é pior que o binário que o
plano supunha ("se estiver vazia, o patch 4 não faz nada").

| | Barbour's | Rituária |
|---|---|---|
| `line` preenchida | 76/145 | 29/96 |
| `subcategory` preenchida | 77/145 | 37/96 |
| `category` preenchida | 77/145 | 75/96 |

**Está meio preenchida, e o que está preenchido não casa consigo mesmo.**
`BODY SPLASH` (26 SKUs) e `Body Splash` (20) são o mesmo grupo e falhavam em
`===`. Idem `PERFUME CAPILAR`/`Perfume Capilar`, `CAPSULA`/`CÁPSULA`, `PÓ`/`Pó`,
`SKIN CARE`/`Skin Care`, `SUPPLEMENT`/`Supplement`.

Efeito medido sobre todos os pares ordenados da Barbour's, com o patch 4:

| | pares em 0,40 (variedade) |
|---|---|
| comparando cru | 5,9% |
| comparando normalizado | **11,6%** |

Sem normalizar, **metade das canibalizações que o patch existe para punir
escapava**. A normalização entrou junto com o patch, não como polimento.

`Não se aplica` (6 SKUs) também virou sentinela de ausência: dois produtos sem
classificação não são "da mesma linha".

## 2. Três achados que mudam o que o plano dizia

### 2.1 `slow_moving_days: 100000` não neutraliza a urgência — concentra

`stockUrgency` devolve 2,0 para `stock_status` `dead`/`discontinued` **antes** de
olhar cobertura. Empurrando `slow_moving_days`, todo o resto cai para 1,0 e
esses SKUs viram **os únicos com vantagem no score** — o oposto do objetivo.

E não são 4 SKUs, são **7**: `KBB99165`, `KRT99025`, `KRT99036`, `KRT99037`,
`KRT99046`, `KRT99050`, `RT99003`. Todos com `coverage_days` nulo e estoque alto
(1.202 a 4.170 unidades).

**Implementado:** `stock_urgency_enabled` (default 1). Com 0, a urgência é
constante 1,0 para todo mundo, inclusive `dead`. Cobre score e copy de uma vez,
e não quebra em silêncio se uma recarga trouxer cobertura acima de 100.000 — a
máxima observada já é 93.474.

### 2.2 O patch de kit no `engine.js` sozinho não funciona

O filtro cruza os componentes do candidato com `ctx.cartKitComponents`. Mas a
query só trazia componentes que intersectam `cartSkus` — com um kit no carrinho,
`kit_hit` é sempre nulo e **não há o que filtrar**. O engine só vê o que a query
traz.

Precisou de subquery nova (`overlap_hit`) na leitura única do `/recommend`.
Custo: zero ida a mais ao banco; p50 ficou em 299 ms.

O teste ponta a ponta pegou isso — com o patch só no engine, ele falhava.

### 2.3 Na Rituária a afinidade fica MENOS discriminante depois do patch 4

Distribuição medida sobre todos os pares:

| | antes | depois |
|---|---|---|
| Barbour's em 0,20 | 86,5% | 84,3% |
| Rituária em 0,20 | 89,6% | **96,1%** |

O plano previa "deve espalhar entre 0,10 e 0,50" e usou isso para retirar a
recomendação de subir o peso do prior ("a afinidade volta a discriminar
sozinha"). **Isso vale para a Barbour's, não para a Rituária**: lá o sorteio
passa a pesar mais, não menos.

Não mexi no prior — é decisão declarada sua, e o plano tem razão que prior
pesado atrasa o aprendizado no piloto. Mas o sintoma visível (a loja mudar de
ideia a cada refresh) está resolvido pelo item 2.9, que entrou.

### 2.4 Correções menores de fato

- O SKU mais barato da Rituária **não** é R$ 40: são **7 SKUs a R$ 0,02**
  (brindes). Já caíam no piso de margem; agora caem antes, em `below_min_price`,
  com motivo legível. O piso de R$ 15 afeta 3 SKUs da Barbour's **e 7 da
  Rituária**, não "nenhum da Rituária".
- `cost_provisional` é **0 em todo o catálogo atual**. O patch 12 entrou, mas
  hoje é inerte: ele existe para quando a Ápice entrar (73 dos 101 SKUs dela têm
  custo provisório). Está no lugar certo, só não "destrava" nada agora.

## 3. O furo que o patch 4 abriria, e que foi fechado junto

O plano registra como "o resíduo que mais me incomoda": a afinidade é calculada
só contra a âncora, então a punição de substituto também valeria só contra ela.
Num carrinho de dois Body Splash, o que canibaliza o **segundo** item não seria
comparado com ele.

Entrou, porque a parte cara é a de co-compra (SQL) e a parte que o patch 4
precisa é a **regra** — 20 linhas de JS puro. A semântica não é o máximo que a
especificação escreve: **substituto manda**. O máximo puro esconderia justamente
o que a punição existe para pegar — bastaria um complemento no carrinho para
apagar a canibalização do outro item.

Carrinho de um item continua idêntico, por construção, e tem teste dizendo isso.

**Continua fora:** a co-compra medida sobre todo o carrinho, que é mudança de
SQL e de denominador. Segue sendo o primeiro item da fila.

## 4. Resultado, medido no seed real

Censo sobre o catálogo inteiro, antes e depois, mesmo dado:

| | Barbour's antes → depois | Rituária antes → depois |
|---|---|---|
| copy de escassez falsa | 69,7% → **0,0%** | 61,0% → **0,0%** |
| jargão interno na tela | 178 → **0** | 53 → **0** |
| `reason` citando cobertura | 848 → **0** | 386 → **0** |
| oferta abaixo de R$ 15 | 194 → **0** | 0 → 0 |
| âncoras sem oferta | 4 → 4 | 17 → **14** |
| preço/carrinho na faixa 15–45% | 50,2% → 48,1% | 37,3% → **47,0%** |

Os aceites do plano, contra o app no ar:

```
KRT99049 -> ('kit_overlaps_cart_kit', 'KRT99049⊃RT01016')
price_target=null -> caf 0     price_target=1 -> caf 0
carrinho 34,90 -> gap=30 relaxed=[]    carrinho 35,10 -> gap=30 relaxed=[]
```

**`fit_preco` fez menos do que o plano esperava na Barbour's** (50,2% → 48,1%).
Ele é um fator multiplicativo competindo com afinidade e take rate, não um
filtro. Na Rituária moveu de verdade (37,3% → 47,0%). Fica registrado como
medição, não como sucesso.

## 5. Config aplicada (Fase 0)

```bash
# urgência desligada nas duas marcas — cobre também o atalho de `dead`
curl -X POST $OFFER_API/config -H "Authorization: Bearer $CURATE_TOKEN" \
  -H 'Content-Type: application/json' -d '{"brand":"barbours","stock_urgency_enabled":0}'
curl -X POST $OFFER_API/config ... -d '{"brand":"rituaria","stock_urgency_enabled":0}'

# fragrância é colecionável na Barbour's: variedade 0,40 em vez de substituto 0,10
curl -X POST $OFFER_API/config ... -d '{"brand":"barbours","collectible_categories":"FRAGRANCES, Fragrancias"}'

# teto da Rituária, DEPOIS do filtro de kit
curl -X POST $OFFER_API/config ... -d '{"brand":"rituaria","price_cap_ratio":0.7}'
```

Campos novos em `brand_config`: `min_price`, `gap_hard_max_ratio`,
`stock_urgency_enabled`, `low_stock_units`, `collectible_categories`,
`line_labels`. Todos com `ALTER TABLE` idempotente em `MIGRATIONS`.

`line_labels` está **vazio de propósito**: sem mapa de rótulos o copy de linha
cai no genérico, que é seguro. Preencher é um `POST /config` com
`{"line_labels":{"tropical glow":"Tropical Glow"}}`.

## 6. Rollback

| Mudança | Como desfazer |
|---|---|
| urgência | `stock_urgency_enabled: 1` |
| colecionável | `collectible_categories: null` (volta a 0,10) |
| teto da Rituária | `price_cap_ratio: 0.6` |
| piso de preço | `min_price: 0` |
| gap | `gap_hard_max` / `gap_hard_max_ratio` |
| **`fit_preco` e pesos §3.2** | **não tem alavanca de runtime — só `git revert` + deploy** |

A última linha é a exceção honesta: é a única mudança de médio risco sem
interruptor. Se o ranking der problema nas primeiras horas e não der para
separar a causa, é ela e a afinidade que se olha primeiro.

## 7. O que não subiu

Tudo da Fase 2 (estoque do Beauty Hub, afinidade de 90 dias, curva ABC): depende
de acesso fora do repositório. **A regra que organiza o resto continua valendo:**
enquanto o `available` vier da fonte que a especificação proíbe, o motor roda por
afinidade e a urgência fica desligada.

E o risco que o plano levanta continua de pé: **o piloto A/B começa em três dias
e não existe guardrail de pausa automática**. O desligamento é um `POST /config`
que já existe; o que não existe é quem olhe. Isso é combinado, não código.
