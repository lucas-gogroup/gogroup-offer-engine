# Benchmarks de mercado — Upsell, order bump e CRO (go-offer-engine)

2026-09-18 · @Lucas · pesquisa de mercado global (6 frentes, buscas na web com fonte citada)

## Objetivo e método

Este documento cruza o desenho já definido do **go-offer-engine** (ver [Handoff técnico](Handoff%20—%20Motor%20de%20Oferta%20Inteligente%20(GoHacks%20Podium%202026).md) e [Caso de negócio](go-offer-engine%20—%20Caso%20de%20negócio%20e%20projeções.md)) com benchmarks, cases e estudos do mercado global de e-commerce/CRO sobre upsell e order bump. Seis frentes de pesquisa rodaram em paralelo: (1) order bump pré-compra (carrinho/PDP), (2) upsell pós-compra (thank-you page), (3) frete grátis e gamificação de threshold, (4) motores de recomendação e cross-sell, (5) cultura de experimentação/bandits/guardrails, (6) incentivo dinâmico e uso de estoque como alavanca promocional.

**Regra de leitura:** toda métrica abaixo vem marcada por qualidade de fonte — **verificada** (paper acadêmico, blog oficial de engenharia, ou case com metodologia de teste A/B publicada), **vaga/vendor** (dado de fornecedor de ferramenta, sem metodologia auditável, tratar como direcional) ou **folclore** (número amplamente repetido no mercado sem origem confirmada). Isso segue a própria regra do toolkit do GoHacks: *"ganho simulado não vale"* — o mesmo princípio se aplica a citar benchmark externo como fato.

## Síntese executiva: o que isso muda no motor

| # | Oportunidade | Onde mexe no projeto | Força da evidência |
| --- | --- | --- | --- |
| 1 | Mostrar o motivo da oferta ("porque combina com o que você levou") na vitrine, não só no `decision_log` | `copy`/`reason` da API já existem — passam a aparecer no card do carrinho, não só no log interno | Verificada (Herlocker et al. 2000, Tintarev 2007) |
| 2 | No degrau de brinde, explicitar o valor monetário ("brinde no valor de R$X") em vez de só "produto grátis" | Copy do Curador (AI Proxy) — novo padrão de template | Verificada (zero-price effect, Ariely et al. 2007) + vaga (combinação com ancoragem é hipótese, não testada) |
| 3 | Adicionar guardrail de integridade de dado (Sample Ratio Mismatch) e de falha técnica de entrega da oferta ao Guardião | Agente Guardião — novo guardrail além de CR/margem/estoque/take rate | Verificada (Booking.com, Microsoft ExP, caso Bing 404) |
| 4 | Trocar janela fixa de "2h" do guardrail de CR por monitoramento contínuo com controle de falso positivo | Agente Guardião — lógica de decisão | Verificada (Netflix — testes sequenciais) |
| 5 | Avaliar pós-compra (thank-you page) como próxima superfície do roadmap, com `surface=post_purchase` | Roadmap (hoje só cita checkout/CRM/brinde/afiliados) — depende de validar se a Yampi permite extensão pós-checkout | Vaga/vendor (consistente entre 5 fontes concorrentes, mas nenhuma auditável) |
| 6 | Instrumentar taxa de cancelamento/reembolso como guardrail próprio de qualquer superfície nova de upsell | Guardião — nova métrica de guarda-rail | Fraca (lacuna de evidência confirmada — ninguém no mercado publica esse dado) |
| 7 | Manter a disciplina de 1 oferta por vez (não carrossel de 3+) e considerar teto de preço por faixa de AOV da marca, não só 60% fixo | Regra dura do score / `max_discount` por contexto | Vaga/vendor, mas convergente entre múltiplas fontes |
| 8 | Priorizar oferta que **depende** do que já está no carrinho (não só evitar redundância) | `affinity_matrix` / `kit_components` — refinar `functional_group` para afinidade condicional | Verificada (case VWO/Bear Mattress) |
| 9 | Citar a arquitetura de co-compra em lote (item-to-item) como escolha alinhada ao paper fundador da Amazon (2003), não como limitação | Pitch/sabatina da banca | Verificada (Linden, Smith & York 2003 — IEEE) |
| 10 | Usar o achado Kumar & Hosanagar (efeito líquido real de recomendação ≈ 11%, não os "35% da Amazon") como âncora de expectativa, não o folclore de mercado | Pitch — projeções conservadoras já seguem essa lógica, reforça a narrativa | Verificada (Information Systems Research, peer-reviewed) |
| 11 | Validar Thompson Sampling como escolha correta para o Otimizador (não A/B fixo) dado o tamanho do pool de ofertas | Nenhuma mudança de código — reforço de defesa técnica na sabatina | Verificada (KDD 2022 — Xiang & West) |
| 12 | Explicitar threshold de frete grátis calibrado por margem da marca, não só "%do AOV" uniforme | `price_room` / parametrização por marca | Vaga (heurística de mercado, mas com ressalva de margem pertinente) |

## 1. Order bump pré-compra (carrinho e PDP)

**Baymard Institute** (verificada) — em auditoria de usabilidade, **52% dos sites desktop** mostram recomendações irrelevantes ou baseadas só em "outros clientes também compraram"; um item fora de contexto contamina a confiança do usuário na seção inteira. Recomenda: quantidade variável de sugestões, priorizar complementares sobre alternativos, rotular o motivo, agrupar por uso/tema. — [baymard.com/blog/product-recommendations-cart](https://baymard.com/blog/product-recommendations-cart)

**VWO/Wingify — case Bear Mattress** (verificada, teste A/B com metodologia publicada) — redesenharam "Frequently bought with mattress" na PDP: mostraram o "frame" só para quem já tinha colchão+base no carrinho (afinidade condicional ao conteúdo do carrinho). Resultado: **+24,18% em compras, +16,21% em receita**; add-to-cart de protetor +51,75%, de base +73%. — [wingify.com](https://wingify.com/conversion-rate-optimization/conversion-rate-optimization-case-studies/)

**VWO/Wingify — cases anônimos com metodologia rigorosa** (verificada quanto ao método, marca não revelada) — upsell one-click no carrinho de loja de móveis: 41 dias, 4.000+ transações, 92% de significância, **AOV +US$55**. Cross-sell com desconto em loja de barras nutricionais: **+13,4% em conversão**, 95% de significância. — [growthrock.co](https://growthrock.co/ecommerce-upsell-cross-selling/)

**Benchmarks agregados de "Frequently Bought Together"** (vaga/vendor, Oxify) — take rate médio 1-3% (top performers 8%+); desconto de 5-10% ~dobra o take rate; 3 itens supera 5 itens em ~40%; add-on de US$8-25 converte 2,4x mais que US$40+; beleza/cosméticos tem take rate médio 4-6% (top 9%). — [oxify.app/blog](https://oxify.app/blog/frequently-bought-together-conversion-rate)

**Estatística "Amazon: 35% das vendas vêm de recomendações"** (folclore) — amplamente citada mas sem fonte primária confirmada; tratar como não verificada (ver seção 4).

**Oportunidade concreta:** o achado da Baymard valida diretamente a arquitetura de score por afinidade do motor — melhor não ofertar do que ofertar mal (já é a lógica do fallback "sem oferta válida → esconde o bloco"). O padrão do Bear Mattress reforça evoluir `functional_group`/`kit_components` para também *priorizar* item que depende do que já está no carrinho, não só filtrar sobreposição.

## 2. Upsell pós-compra (thank-you page)

**ReConvert/Upsell.com — agregado de 40.000+ lojas Shopify** (vaga/vendor) — take rate médio **4,7%**, uplift em AOV **5,6%**, top 5% convertendo a 28,3%. — [upsell.com/blog](https://upsell.com/blog/shopify-post-purchase-upsell)

**Zipify OneClickUpsell — case Marnie Massie (cosméticos)** (vaga/vendor, caso nomeado) — oferta pós-compra ativa desde 2022: **+15% em AOV, 14,5% de conversão da oferta**. — [zipify.com](https://zipify.com/blog-zipify-case-study-marnie-massie/)

**Fricção zero — por que pós-compra converte mais** — consenso qualitativo entre fornecedores concorrentes (Zipchat, Checkout Champ, Cart X): pedido já capturado antes da oferta, sem risco de abandono de carrinho, sem redigitar pagamento. Magnitude do "quanto converte mais" varia muito entre fontes (2x a 10x) — sem estudo controlado por trás.

**Riscos** (fraca) — nenhuma fonte de mercado publica dado confiável ligando upsell pós-compra a cancelamento/reembolso. Lacuna de evidência confirmada.

**Oportunidade concreta:** o padrão é consistente entre 5 fornecedores concorrentes de que take rate pós-compra (~5-15%, top performers 20-28%) supera o baseline interno do checkout (4-12,5%). Como o motor já é `POST /recommend` parametrizado por `surface`, `surface=post_purchase` é extensão natural — mas depende de validar se a Yampi (checkout do grupo) tem extensibilidade pós-checkout equivalente ao que o Shopify oferece nativamente. Dado que a literatura de risco é fraca, instrumentar cancelamento/reembolso como guardrail próprio desde o primeiro dia dessa superfície, sem depender de benchmark externo.

## 3. Frete grátis e gamificação de threshold

**Baymard Institute** (verificada) — custos extras inesperados (frete/impostos) são a causa nº1 de abandono de carrinho, citada por ~40-48% dos respondentes; mensagem de frete grátis deve ser **dinâmica e perto do botão de compra** ("faltam R$X"), não banner estático — banner-only é visto por só 73% dos usuários ("banner blindness"). — [baymard.com/blog/avoid-banners-only-free-shipping](https://baymard.com/blog/avoid-banners-only-free-shipping), [baymard.com/lists/cart-abandonment-rate](https://baymard.com/lists/cart-abandonment-rate)

**VWO/Wingify — case NuFace** (verificada) — mensagem dinâmica de frete grátis acima do botão de compra: **+90% em pedidos, +7,32% em AOV, 96% de confiança**. — [wingify.com](https://wingify.com/resources/case-studies/ab-testing-vwo-helped-nuface-increase-website-orders/)

**Kivetz, Urminsky & Zheng (2006), JMR** (verificada, paper acadêmico) — "goal-gradient hypothesis": progresso ilusório acelera comportamento perto da meta (cartão de fidelidade com 2 de 12 carimbos já preenchidos completa mais rápido que cartão vazio de 10). Base teórica direta de por que "faltam R$X" funciona. — [home.uchicago.edu/ourminsky](https://home.uchicago.edu/ourminsky/Goal-Gradient_Illusionary_Goal_Progress.pdf)

**UPS — Pulse of the Online Shopper** (verificada, pesquisa de mercado real) — 58% dos compradores já adicionaram item ao carrinho especificamente para atingir o threshold de frete grátis.

**Heurística de dimensionamento** (vaga/consenso de agência) — threshold = AOV atual + 20-30%; ressalva pertinente do 2Point Agency: a regra ignora margem — o mesmo +30% de threshold é lucro ou prejuízo dependendo da margem do produto.

**Nenhum case documentado combina progress bar + recomendação automática do produto que fecha o gap** — exatamente o padrão do go-offer-engine. Isso é uma lacuna de mercado, não uma limitação do projeto.

**Oportunidade concreta:** a regra dura já implementada ("gap ≤ R$30 → oferta entre gap e 3× gap, copy nomeia o benefício") está alinhada com Baymard + Kivetz — o caso Ápice do diagnóstico (R$9,10 de faltar) é o cenário ideal desse gatilho. Vale considerar threshold dinâmico calibrado por margem por marca em vez de um "+20-30%" uniforme, dado que não existe estudo controlado validando esse número — e o próprio go-offer-engine, ao combinar progress bar com oferta automática, pode virar o case a documentar internamente.

## 4. Motores de recomendação e cross-sell

**McKinsey (2013) — origem do "35% da Amazon"** (folclore) — relatório de 2013 atribuiu 35% das vendas da Amazon a recomendações; a Amazon nunca confirmou esse número oficialmente.

**Kumar & Hosanagar (Information Systems Research, peer-reviewed)** (verificada) — análise de 2M+ visualizações de página de produto em grande varejista de moda, com grupo de controle real: recomendações aumentam venda do produto recomendado em ~9%, mas canibalizam o produto focal em ~1,9% — **efeito líquido real de ~11%**, bem abaixo do folclore de 35%. — [pubsonline.informs.org](https://pubsonline.informs.org/doi/10.1287/isre.2018.0833)

**Linden, Smith & York — "Amazon.com Recommendations: Item-to-Item Collaborative Filtering" (IEEE, 2003)** (verificada, paper fundador) — desenho de trocar CF usuário-a-usuário (caro) por item-a-item (tabela recalculada em lote) — **exatamente a arquitetura que o go-offer-engine usa hoje**. Eleito em 2017 o paper que melhor resistiu ao teste do tempo em 20 anos. — [amazon.science](https://www.amazon.science/the-history-of-amazons-recommendation-algorithm)

**Amazon Prime Video (re:MARS 2019)** (verificada) — autoencoder profundo com sequência temporal superou CF item-a-item em proporção de **2 para 1** — um dos poucos casos públicos com número concreto de ganho de complexidade adicional.

**Netflix — Gomez-Uribe & Hunt (ACM TMIS, 2015)** (verificada, paper oficial) — personalização + recomendação economizam **mais de US$1 bilhão/ano** e influenciam ~80% das horas assistidas.

**Herlocker, Konstan & Riedl (CSCW 2000) e Tintarev (2007)** (verificada, papers acadêmicos canônicos) — explicar o motivo da recomendação ("clientes que compraram X também compraram Y") aumenta significativamente a aceitação.

**Cold start** — padrão convergente (Amazon/Netflix/Spotify): metadados/conteúdo, popularidade como fallback, abordagem híbrida — é essencialmente o que o motor já faz com afinidade fria via IA para SKUs slow moving.

**Oportunidade concreta:** a arquitetura do go-offer-engine (co-compra em lote + regra + IA fria só para cold start) é defensável frente ao estado da arte — reproduz o desenho que resistiu duas décadas na Amazon. O maior risco identificado não é a sofisticação do modelo, e sim inflar expectativa de ganho: usar o número real (~11%, Kumar & Hosanagar) como âncora de expectativa em vez do folclore de 35% é consistente com a própria regra do toolkit contra "ganho simulado". Ganho de baixo custo e alta evidência: exibir o `reason` da oferta na UI, não só no log.

## 5. Experimentação, bandits e guardrails

**Booking.com** (verificada, mas limiares numéricos exatos não publicados) — roda 1.000+ testes A/B simultâneos; guardrails cobrem cancelamento, contato com atendimento, falha de pagamento, tempo de carregamento; checagem automática de Sample Ratio Mismatch (SRM); ~90% dos testes falham e isso é tratado como parte do processo, não fracasso.

**Netflix — testes sequenciais** (verificada, blog oficial de engenharia) — monitoramento contínuo de rollout com controle de falso positivo, em vez de janela fixa de avaliação; guardrail central é tempo de carregamento de vídeo, monitorado em todos os quantis, não só na média.

**Microsoft ExP** (verificada) — guardrails "não precisam melhorar, mas não podem piorar"; **auto-shutdown automático** documentado: bug em teste A/B do Bing gerou páginas 404 e o teste foi desligado automaticamente antes de intervenção manual. Alertas por severidade P0/P1/P2; SRM tratado como alerta prioritário porque invalida o teste inteiro.

**Airbnb — Experimentation Guardrails** (moderadamente vaga em detalhe numérico, fetch direto bloqueado) — guardrail disparado entra em processo de escalonamento com discussão entre stakeholders antes de decidir lançar — gate de governança humana sobre o sinal estatístico, não kill automático puro.

**Xiang & West (KDD 2022)** (verificada, paper acadêmico) — para até 3 variações, A/B clássico é mais rápido e simples; para mais de 3, bandits (Thompson Sampling, especialmente) superam A/B em eficiência. Thompson Sampling supera Adaptive Allocation na quase totalidade dos cenários simulados e tolera atualizações atrasadas — relevante para o ciclo de 15 min do Otimizador.

**Oportunidade concreta:** o Guardião já reproduz o padrão Booking/Microsoft/Airbnb de guardrail com limiar pré-definido e o hábito Netflix/Microsoft de auto-shutdown sem esperar intervenção manual — a prática mais madura da literatura. Duas lacunas frente ao estado da arte: (1) falta guardrail de integridade de dado (SRM) — um desbalanceamento de amostra invalida qualquer leitura de conversão/margem antes mesmo de olhar o resultado; (2) falta guardrail de falha técnica na entrega da oferta em si (padrão do caso Bing 404). Também vale trocar o gatilho fixo de "2h" por monitoramento contínuo com controle de falso positivo (Netflix), já que 2h reage tarde em tráfego alto e pausa por ruído em tráfego baixo. A escolha de Thompson Sampling para o Otimizador é diretamente validada pelo paper KDD 2022 — bom argumento de defesa técnica na sabatina.

## 6. Incentivo dinâmico e estoque como alavanca promocional

**Shampanier, Mazar & Ariely — "Zero as a Special Price" (Marketing Science, 2007)** (verificada, paper MIT) — experimento de campo: trufa a 15¢ vs. Kiss a 1¢ → 73% escolhem a trufa (racional). Baixando 1¢ cada, Kiss fica **grátis** → 69% escolhem o Kiss. Mesma diferença relativa de preço, só "grátis" inverte o comportamento — zero-price effect. — [web.mit.edu/ariely](https://web.mit.edu/ariely/www/MIT/Papers/zero.pdf)

**Raghubir (2004), Journal of Consumer Psychology** (verificada, mas texto completo pago) — brinde grátis preserva percepção de qualidade da marca; desconto em dinheiro tende a gerar inferência negativa de qualidade ("por que está barato?").

**MathCo — case de retailer europeu de grocery** (vaga/vendor) — precificação dinâmica por loja/produto substituindo markdown rígido: ~3x mais receita recuperada no clearance, ~8% de aumento de margem.

**Universidade Ovidius (2025)** (verificada, paper acadêmico) — 44,6% dos respondentes perceberam produto como mais valioso quando preço de referência riscado era exibido antes do desconto — confirma ancoragem em contexto de e-commerce.

**Talon.One/Voucherify — lacuna de plataformas de cupom** (vaga/vendor, mas sinal estruturalmente relevante) — plataformas de promoção validam elegibilidade de cupom mas não têm acesso a dado de custo; dois cupons válidos empilhados podem gerar margem negativa aprovada por ambos os sistemas.

**Oportunidade concreta:** a literatura sustenta a tese central "estoque parado paga o desconto" com razoável consistência — zero-price effect e Raghubir validam por que "brinde de slow moving" deveria vir antes de desconto percentual na escada (já é a ordem definida). O achado mais relevante estrategicamente é a lacuna do Talon.One/Voucherify: plataformas de cupom de mercado não enxergam custo, e por isso aprovam pedidos com margem negativa — é exatamente o problema que o `price_room`/piso de margem do Guardião resolve estruturalmente, o que é evidência indireta de diferencial real de mercado, não só teórico. Refinamento de baixo custo e alta evidência combinada: no degrau de brinde, explicitar o valor monetário ("brinde no valor de R$X") em vez de só "grátis" — ativa zero-price effect e ancoragem ao mesmo tempo (hipótese a validar em teste A/B, nenhuma fonte testou esse combo diretamente).

## Ressalvas de qualidade de fonte

Boa parte dos números de mercado citados em blogs de CRO e apps de e-commerce (Amazon 35%, "order bump converte 30-40%", "barra de progresso reduz abandono em 3%") vem de fornecedores de ferramenta sem metodologia publicada, ou é repetição de folclore sem origem confirmada — em alguns casos (McKinsey/Amazon) a origem existe mas o número nunca foi confirmado pela própria empresa citada, e um paper peer-reviewed (Kumar & Hosanagar) mede o efeito real bem abaixo do citado popularmente. A recomendação, consistente com a regra do toolkit GoHacks contra "ganho simulado", é: usar o baseline interno real do grupo (order bump Yampi: 4% a 12,5% por marca) como âncora principal de meta, e tratar todo benchmark externo — mesmo os mais verificados — como direcional de padrão de mercado, não como parâmetro de calibração direta do score.

## Consolidação dos documentos

| Documento | Conteúdo | Público |
| --- | --- | --- |
| [Caso de negócio e projeções](go-offer-engine%20—%20Caso%20de%20negócio%20e%20projeções.md) | Problema, exemplos reais, regras em português, base real, projeções, medição | Banca, liderança, pitch |
| [Handoff técnico](Handoff%20—%20Motor%20de%20Oferta%20Inteligente%20(GoHacks%20Podium%202026).md) | Arquitetura, agentes, API, score, modelo de dados, plano do dia, riscos, pitch | Dupla do hackathon, agente de desenvolvimento |
| [Plano de dados](Plano%20de%20dados%20—%20go-offer-engine%20(Barbour's%20e%20Rituária).md) | Fontes confirmadas no Data Mart, colunas, SQL de carga, checklist | Agente de desenvolvimento, dados |
| Este — Benchmarks de mercado | Cases globais de CRO/upsell/order bump, com qualidade de fonte marcada, e oportunidades concretas de ajuste no motor | Dupla do hackathon, banca (defesa técnica), roadmap pós-POC |
