# go-offer-engine

Um motor de oferta inteligente para e-commerce do Gogroup que decide, para cada carrinho, o produto certo para ofertar (upsell, order bump, brinde ou cross-sell) e o menor incentivo que faz o cliente aceitar — olhando ao mesmo tempo para **afinidade**, **margem** e **estoque**.

## O Problema

Hoje cada loja do grupo decide sozinha, e no feeling, o que oferecer no carrinho. O resultado:
- **Upsell que não converte**: ofertas fixas, caras, redundantes ou sem incentivo
- **R$ 27 M parados em estoque** (slow moving)
- **R$ 11 M/mês em desconto uniforme** que não diferencia cliente nem contexto
- **Cada canal decide sozinho**: carrinho, PDP, CRM, checkout — nenhum aprende com o resultado

## A Solução

Um cérebro único de oferta que:
1. **Nunca oferece o que o cliente já tem** — nem o mesmo produto, nem kit que o contenha
2. **Fecha o gap de benefício** — se faltam R$ 30 para frete grátis, oferece item entre R$ 30 e R$ 90 com copy "leve X e ganhe frete grátis"
3. **Respeita o piso de margem** — nunca oferece desconto que destrói rentabilidade
4. **Prioriza o que precisa girar** — slow moving ganha canal de saída com afinidade real
5. **Aprende e se corrige** — aceita/recusa realimenta o ranking a cada 15 min

### Impacto esperado

**Conservador (5% de aceite × R$ 40 de bump médio):**
- Gobeauté: +R$ 884 k/mês de AOV
- Gocase: +R$ 518 k/mês de AOV
- **Grupo: +R$ 1,4 M/mês**

Em margem bruta (40%): ~R$ 560 k/mês de lucro incremental.

## Arquitetura

### Alta nível

```
Tema Shopify (cart, PDP)
    ↓ POST /recommend
Godeploy: offer-api (lookup + score)
    ↓ lookup
SQLite: product_master, kits, inventory, cost, affinity, offer_table
    ↓ eventos
Plausible ClickHouse (aprendizado)
    ↓ cron 15 min
Thompson Sampling: recalcula ranking
```

### Stack

- **Godeploy** (Cloudflare Worker): API de lookup + jobs agendados
- **SQLite**: tabelas de decisão pré-calculadas (custo zero por requisição)
- **IA em lote**: copy e afinidade fria geram uma vez por SKU/par, à noite
- **Thompson Sampling**: bandit simples por oferta × contexto × segmento
- **Plausible**: source of truth de eventos (impressão, aceite, compra)

### Por quê zero tokens por pedido?

A IA não roda em tempo real. Roda **uma vez por SKU de madrugada**:
- Curador: gera pool de candidatos, afinidades, copy
- Ofertante: lookup + score determinístico (~10 ms)
- Tema: renderiza a oferta

A requisição do carrinho nunca chama um modelo.

## Começar

### Requisitos

- Acesso ao Godeploy (`godeploy.app`)
- Data Mart do Gogroup (schema `gold`)
- Plausible API key (mesma do Airflow / Ápice)
- Acesso aos temas Shopify (Barbour's e Rituária)

### Instalação

1. **Clonar e instalar**
   ```bash
   git clone https://github.com/lucas-gogroup/gogroup-offer-engine.git
   cd gogroup-offer-engine
   ```

2. **Deploy dos apps** (Godeploy)
   - `offer-api`: API pública de lookup + cron
   - `offer-curator`: carrega tabelas das bases do grupo

3. **Integrar nos temas** (Shopify)
   - Snippet no carrinho (`gobeautex-offer-engine.liquid`)
   - Evento `offer_*` ao Plausible
   - PDP block (opcional para MVP)

4. **Carga inicial** (operador ou curador)
   ```
   product_master → kit_components → inventory_snapshot → 
   product_cost → affinity_matrix → offer_table
   ```

## Documentação

| Documento | Conteúdo | Público |
|-----------|----------|---------|
| [Caso de negócio](./go-offer-engine%20—%20Caso%20de%20negócio%20e%20projeções.md) | Problema, exemplos reais, regras em português, base real, projeções, medição | Banca, liderança, pitch |
| [Handoff técnico](./Handoff%20—%20Motor%20de%20Oferta%20Inteligente%20(GoHacks%20Podium%202026).md) | Arquitetura (IA em lote, motor por tabela), agentes, API, score, modelo de dados | Dupla do hackathon, dev |
| [Plano de dados](./Plano%20de%20dados%20—%20go-offer-engine%20(Barbour%27s%20e%20Rituária).md) | Fontes, SQL, colunas, checklist | Dev, dados |
| [POC — Execução](./docs/plan/2026-09-18-poc-plan.md) | Timeline, arquitetura POC, riscos, cronograma | Executor |

## Regras de negócio inegociáveis

1. Nunca oferece SKU já no carrinho, nem kit que contenha qualquer SKU do carrinho
2. Nunca oferece como upsell o item (ou equivalente funcional) que está como brinde
3. Se existe gap para threshold (frete grátis, parcelamento), o candidato prioritário tem preço entre `gap` e `3 × gap`
4. Preço da oferta ≤ 60% do valor do carrinho, salvo meta explícita de margem
5. Nunca oferta SKU com `available` abaixo do estoque de segurança
6. Prefere mesma linha/necessidade a produto de outra categoria
7. Desconto só até o piso de margem (configurável: 30% beauty, 25% acessórios)
8. Sempre o menor incentivo que converte (escada: sem desconto → frete coberto → brinde → desconto %)

## API

### `POST /recommend`

```bash
curl -X POST https://offer-api.godeploy.app/recommend \
  -H "Content-Type: application/json" \
  -d '{
    "brand": "barbours",
    "surface": "cart",
    "goal": "aov",
    "cart": [{"sku": "BRB-SER-30", "variant_id": 4411, "qty": 1, "price": 129.90}],
    "customer": {"is_returning": false},
    "max_discount": 0.15
  }'
```

Resposta:
```json
{
  "offer_id": "of_8f2a",
  "sku": "BRB-HID-50",
  "variant_id": 4420,
  "title": "Hidratante Facial 50 ml",
  "price": 89.90,
  "incentive": {"type": "none"},
  "expected_margin": 0.41,
  "affinity_score": 0.78,
  "copy": "Completa a rotina do sérum",
  "reason": "co-compra alta; estoque com 212 dias de cobertura"
}
```

### `POST /event` (feedback imediato)

```bash
curl -X POST https://offer-api.godeploy.app/event \
  -H "Content-Type: application/json" \
  -d '{
    "offer_id": "of_8f2a",
    "event": "accept",
    "timestamp": "2026-09-18T14:30:00Z"
  }'
```

### `POST /curate` (carga, requer Bearer token)

```bash
curl -X POST https://offer-api.godeploy.app/curate \
  -H "Authorization: Bearer CURATE_TOKEN" \
  -d '{"brand": "barbours"}'
```

## Modelo de dados

| Tabela | Grão | Refresh | Origem |
|--------|------|---------|--------|
| `product_master` | SKU/variante | diário | `gold.dim_produto_gobeauty` + Shopify |
| `kit_components` | componente do kit | diário | `gold.bridge_kit_componente_gobeauty` |
| `inventory_snapshot` | SKU | diário | `gold.shopify_inventory_current` |
| `product_cost` | SKU | semanal | `gold.dim_produto_gobeauty.custo_unitario` |
| `affinity_matrix` | par (SKU A, SKU B) | semanal | `gold.shopify_order_items` (últimos 30 d) |
| `offer_table` | contexto (anchor, goal, surface, segment) | diário | Curador; incremental Otimizador |
| `events_agg` | par + contexto | 15 min | Plausible ClickHouse |

**Mais detalhes**: [Handoff técnico § Modelo de dados](./Handoff%20—%20Motor%20de%20Oferta%20Inteligente%20(GoHacks%20Podium%202026).md#modelo-de-dados)

## Agentes

| Agente | Responsabilidade | Cadência | Autônomo |
|--------|------------------|----------|----------|
| **Curador** | Pool de candidatos, afinidades, copy | diário | IA fria + SQL |
| **Ofertante** | Lookup + score determinístico | tempo real | Score aritmético |
| **Otimizador** | Thompson Sampling por par × contexto | 15 min | Bandit simples |
| **Guardião** | Pausa/reduz incentivo se CR/margem caem | 15 min | Regras |

Cada decisão fica em `decision_log` com agente, contexto, decisão e motivo.

## Medição (A/B)

**Piloto:** Barbour's + Rituária, 14 dias, 50/50 split

| Métrica | Tipo | Meta |
|---------|------|------|
| Take rate | processo | ≥ 5% (aceites ÷ exibições) |
| AOV | negócio | + R$ 2–3 por pedido |
| Margem bruta/pedido | guardrail | ≥ controle |
| Conversão (guardrail) | processo | ≥ controle − 0,3 pp |

## Roadmap (após POC)

- Checkout Yampi (order bump integrado)
- CRM automático (WhatsApp, e-mail)
- Brinde automático
- Missões de afiliados
- Desconto % via cupom validado
- Guardião completo (CR por braço)
- Airflow para automação diária

## Suporte

- **Docs técnicas**: confira os documentos `.md` neste repo
- **Contato**: lucas.braide@gocase.com
- **Issues**: abra uma issue no GitHub

---

**Estatísticas do projeto**
- Lojas pilotos: Barbour's, Rituária
- SKUs ativos no pool: 500+
- Pares de afinidade: 2.500+
- Contextos únicos: 1.200+
- Latência p95 da API: ~10 ms
