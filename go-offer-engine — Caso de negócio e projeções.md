# go-offer-engine — Caso de negócio e projeções

2026-09-18 · @Lucas

## O problema em uma página

Hoje cada loja do grupo decide sozinha, e no feeling, o que oferecer no carrinho. O resultado é um upsell que quase ninguém aceita, enquanto R$ 27 M ficam parados em estoque e R$ 11 M por mês saem em desconto uniforme.

| Dor | Número (toolkit GoHacks / Oráculo) | Onde aparece |
| --- | --- | --- |
| Estoque parado | Gocase R$ 21,8 M em slow moving (35% do estoque); Gobeauté R$ 5,1 M (19,2%, meta 15%, piorando há 3 semanas); brindes ficam 190 dias em estoque vs 69 de meta | Tema 4 |
| Incentivo uniforme | Gobeauté dá R$ 5,0 M/mês em desconto (9,2% da receita); Gocase R$ 6,3 M (11,5%); Barbour's e Ápice com \~60% dos pedidos com cupom | Tema 1 |
| Upsell que não converte | Oferta fixa, cara, redundante ou sem incentivo — quatro carrinhos reais analisados abaixo | Tema 6 |
| Conversão em queda | Gocase CR 1,87% (era 1,99%); 68% abandonam após iniciar checkout | Tema 6 |

O ponto em comum: **ninguém decide a oferta com custo, estoque e afinidade juntos**. Cada canal (carrinho, PDP, CRM, afiliado) tem a própria regra, e nenhuma aprende com o resultado.

## A solução em linguagem de negócio

O **go-offer-engine** é um cérebro único de oferta: para cada carrinho, decide qual produto oferecer (upsell, order bump, brinde ou cross-sell) e o menor incentivo que faz o cliente aceitar — olhando ao mesmo tempo para **afinidade** (o que combina com o que está no carrinho), **margem** (quanto dá para descontar sem furar o piso) e **estoque** (o que precisa girar).

| Para quem | O que muda |
| --- | --- |
| Gerente de marca / growth | Para de escolher upsell e brinde no feeling e de descobrir o custo 30 dias depois. Define metas (AOV, giro, margem) e o motor executa |
| Supply | Slow moving ganha um canal de saída que não é liquidação: vira oferta ou brinde onde tem afinidade |
| Cliente | Vê uma oferta que faz sentido com o que está comprando, no preço certo, e que fecha o frete grátis ou benficio quando falta pouco |
| Financeiro | Cada real de incentivo passa a comprar uma venda que não aconteceria; desconto em dinheiro é substituído por estoque que já foi pago |

**Por que só agora:** o Data Mart do grupo já reúne composição de kit (BOM Protheus), custo unitário, inventário Shopify e line items por SKU. Faltava um motor que juntasse isso e aprendesse com o resultado. A IA entra em lote (copy e afinidade) — custo zero por pedido.

**Uma superfície hoje, todas amanhã:** a POC roda no carrinho e na PDP de Barbour's e Rituária. O mesmo motor responde checkout, CRM, brinde e afiliados sem reescrever regra.

## Exemplos práticos: antes → depois

Os quatro carrinhos reais do diagnóstico, e o que o motor faria em cada um.

| Carrinho real | Hoje | Com o go-offer-engine |
| --- | --- | --- |
| **Rituária** — Magnésio Inositol R$ 89,90; faltam R$ 109 para frete grátis | Oferta fixa: Trio de Queridinhos R$ 149,90, kit que **já contém** o Magnésio | Filtra o Trio (sobreposição de kit). Oferece item complementar da linha entre R$ 20 e R$ 60 com copy "complete sua rotina"; se a meta é frete, mostra a combinação que fecha os R$ 109 |
| **Gocase** — Tote Mini R$ 199,90; já ganhou 3x sem juros | Nenhuma oferta | Acessório de afinidade alta (organizador, chaveiro, necessaire) com preço próximo ao gap de frete grátis; slow moving da coleção entra primeiro |
| **Gocase** — Garrafa Fresh R$ 159,90 + brinde Base Fit P | Upsell é a **mesma** Base Fit por R$ 29,90 | Base sai do pool (é o brinde). Oferece tampa, escova ou segunda garrafa com desconto calculado pelo espaço de margem |
| **Ápice** — Kit Cachos R$ 180,41; faltam R$ 9,10 para frete grátis | Segundo kit de R$ 209,90, com itens perto de romper | Oferta entre R$ 9 e R$ 30 da mesma necessidade (leave-in, óleo finalizador) com copy "leve X e ganhe frete grátis"; item em ruptura nunca aparece |

Em todos, o cliente vê **uma** oferta, coerente, com o benefício explícito — e a marca vende um item que tinha margem e estoque para vender.

## Regras de negócio que o motor cumpre sempre

1. **Nunca oferece o que o cliente já tem.** Nem o mesmo produto, nem kit que o contenha, nem componente de kit que já está no carrinho.
2. **Brinde e upsell nunca são o mesmo item.** O que sai de graça não é vendido ao lado.
3. **Faltou pouco para um benefício, a oferta fecha o benefício.** Se faltam até R$ 30 para frete grátis ou parcelamento, o item ofertado custa entre o que falta e três vezes isso, e o texto diz o benefício.
4. **Oferta cabe no bolso do carrinho.** Preço da oferta até 60% do valor do carrinho; kit caro fica para PDP e CRM, não para o carrinho.
5. **Desconto só até o piso de margem.** O incentivo nunca leva o item abaixo do custo + frete + imposto + margem mínima da marca. Slow moving libera espaço extra de desconto.
6. **Estoque em risco não é ofertado.** Item abaixo do estoque de segurança ou perto de vencer sai do pool.
7. **Mesma necessidade primeiro.** Produto da mesma linha ou rotina vem antes de produto de outra categoria.
8. **O menor incentivo que converte.** Escada: sem desconto → frete já coberto → brinde de estoque parado → desconto percentual.
9. **Aprende e se corrige sozinho.** Oferta que ninguém aceita sai; oferta que converte sobe e ganha incentivo menor. Se a conversão do carrinho cair, o motor pausa a si mesmo.
10. **Tudo registrado.** Cada decisão tem motivo legível: por que este produto, por que este preço.

## Base real: pedidos e ticket por marca (últimos 30 dias)

Fonte: `gold.vw_yampi_orders`, pedidos com `payment_status = 'paid'`, captura nos últimos 30 dias até 18/09/2026, via Metabase (Data Mart, db 43). Gocase: toolkit GoHacks, ago/2026.

| Marca | Pedidos pagos / mês | Receita / mês | Ticket médio | % pedidos com order bump (checkout Yampi) |
| --- | --- | --- | --- | --- |
| Kokeshi | 149.051 | R$ 12,17 M | R$ 81,68 | 3,95% |
| Rituária | 118.462 | R$ 16,31 M | R$ 137,71 | 9,83% |
| Ápice | 74.267 | R$ 10,93 M | R$ 147,15 | 12,52% |
| Barbour's | 68.361 | R$ 8,50 M | R$ 124,35 | 7,74% |
| Lescent | 32.074 | R$ 3,57 M | R$ 111,34 | 7,68% |
| **Gobeauté (5 marcas acima)** | **442.215** | **R$ 51,49 M** | R$ 116,44 | — |
| Gocase (toolkit, ago/26) | 259.000 | R$ 49,60 M | R$ 191,00 | — |
| **Grupo (base considerada)** | **701.215** | **R$ 101,09 M** | — | — |

By Samia, Auá, Denavita e Yenzah não entraram na consulta (backend indisponível na segunda chamada); somadas são residuais frente às cinco acima e ficam como upside.

**O que o Oráculo já mede sobre upsell hoje:** o order bump do checkout Yampi está registrado por pedido (`has_order_bump`, `order_bump_types`) — é o benchmark de aceite: 4% a 12,5% conforme a marca. Os campos `has_upsell` e `has_freebie` estão zerados nas cinco marcas, e **não existe evento de exibição ou aceite do upsell de carrinho do tema** em nenhuma fonte: hoje não dá para saber quantas vezes o carrossel apareceu nem quantas vezes foi aceito. Instrumentar isso no Plausible é parte da entrega.

## Projeções conservadoras

Premissa única: bump médio de **R$ 40** aceito em uma fração dos pedidos pagos (take rate). Nada de aumento de conversão, nada de novos clientes — só AOV incremental sobre os pedidos que já acontecem. O benchmark interno (order bump Yampi: 4% a 12,5%) mostra que 2% é piso, 5% é realista, 8% é o que Ápice e Rituária já fazem no checkout.

| Marca | Pedidos / mês | Take rate 2% | Take rate 5% | Take rate 8% |
| --- | --- | --- | --- | --- |
| Kokeshi\* | 149.051 | R$ 119 k | R$ 298 k | R$ 477 k |
| Rituária | 118.462 | R$ 95 k | R$ 237 k | R$ 379 k |
| Ápice | 74.267 | R$ 59 k | R$ 149 k | R$ 238 k |
| Barbour's | 68.361 | R$ 55 k | R$ 137 k | R$ 219 k |
| Lescent | 32.074 | R$ 26 k | R$ 64 k | R$ 103 k |
| **Gobeauté (5)** | 442.215 | **R$ 354 k** | **R$ 884 k** | **R$ 1,42 M** |
| Gocase | 259.000 | R$ 207 k | R$ 518 k | R$ 829 k |
| **Grupo** | 701.215 | **R$ 561 k / mês** | **R$ 1,40 M / mês** | **R$ 2,24 M / mês** |

\*Kokeshi tem ticket de R$ 82; o bump realista ali é R$ 20–25, o que reduz a linha pela metade. Mantida a R$ 40 por simplicidade da tabela; tratar como teto.

**Leitura:** no cenário piso (2%), o grupo adiciona \~R$ 560 k/mês de receita, \~R$ 6,7 M/ano, sem gastar um real de mídia. No cenário realista (5%), \~R$ 1,4 M/mês. Em margem bruta (assumindo 40% no item ofertado), o piso vale \~R$ 225 k/mês de lucro bruto e o realista \~R$ 560 k/mês.

**Piloto Barbour's + Rituária** (186.823 pedidos/mês): 2% = R$ 149 k/mês; 5% = R$ 374 k/mês; 8% = R$ 598 k/mês. É o que o A/B de 14 dias vai medir.

**Efeito no AOV:** take rate de 5% × R$ 40 = **+R$ 2,00 por pedido** em toda a base — em Barbour's, de R$ 124,35 para R$ 126,35 (+1,6%); em Rituária, de R$ 137,71 para R$ 139,71 (+1,5%). Pequeno por pedido, grande no volume.

## Ganhos além do AOV

Não entram na projeção acima por serem mais difíceis de isolar, mas são reais e medíveis:

| Ganho | Mecanismo | Tamanho da oportunidade |
| --- | --- | --- |
| Estoque parado vira venda ou brinde | Slow moving entra no pool com prioridade quando tem afinidade | Gobeauté R$ 5,1 M em slow moving (meta 15%, está em 19,2%); Gocase R$ 21,8 M. Cada 1 pp de redução em Gobeauté libera \~R$ 270 k de caixa |
| Desconto em dinheiro substituído por estoque | Brinde de estoque pago substitui cupom % onde o cliente aceita | Gobeauté dá R$ 5,0 M/mês em desconto; substituir 5% disso = R$ 250 k/mês |
| Order bump do checkout mais coerente | Mesmo motor alimenta o order bump Yampi/Gocheckout na fase 2 | Já converte 4–12,5%; oferta coerente sobe a taxa |

## Como medir e quando começa

**Segunda-feira:** A/B 50/50 no carrinho de Barbour's e Rituária, 14 dias. Controle: upsell atual. Teste: go-offer-engine.

| Métrica | Meta do piloto |
| --- | --- |
| Take rate do upsell (aceites ÷ exibições, via Plausible) | ≥ 5% |
| AOV por braço | ≥ +R$ 2,00 no teste |
| Margem bruta por pedido | ≥ controle |
| Conversão sessão → compra | ≥ controle − 0,3 pp (guardrail; abaixo disso o motor pausa) |
| Giro dos SKUs ofertados | queda de cobertura visível nos slow moving do pool |

**Roadmap:** carrinho + PDP (POC) → order bump do checkout Yampi → brinde automático → CRM (WhatsApp/e-mail) → missões de afiliados. Uma regra, todas as superfícies.

## Consolidação dos documentos

| Documento | Conteúdo | Público |
| --- | --- | --- |
| Este — Caso de negócio e projeções | Problema, exemplos reais, regras em português, base real, projeções, medição | Banca, liderança, pitch |
| Handoff técnico — go-offer-engine | Arquitetura (IA em lote, motor por tabela), agentes, API, score, modelo de dados, plano do dia, riscos, pitch | Dupla do hackathon, agente de desenvolvimento |
| Plano de dados | Fontes confirmadas no Data Mart, colunas, SQL de carga, regras de consistência, checklist | Agente de desenvolvimento, dados |

Os três estão linkados entre si no handoff técnico.
