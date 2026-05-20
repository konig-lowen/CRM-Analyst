# AUDIT PHASE 4 — Frontend
> Auditoria realizada em: 2026-05-20
> Arquivos analisados: app.html, dashboard.html, coach.html

---

## Resumo Executivo

O frontend é uma SPA (Single Page Application) em `app.html` que unifica Chat, Dashboard, Coach, Ranking, Reports e Admin via roteamento hash. Também existem pages standalone legadas (`dashboard.html`, `coach.html`) ainda servidas pelo servidor. O código é funcional mas apresenta problemas de performance (múltiplas chamadas redundantes no load), inconsistência de cache entre páginas, e riscos de XSS moderados.

---

## Problemas Identificados

---

**[🔴] Coach.html não cacheia dados de vendedores — fetch duplo ao carregar**
- **Descrição:** `coach.html` (versão standalone) chama `fetch('/api/ploomes-users')` diretamente na `loadVendors()` sem nenhum cache. A versão SPA (`app.html`) usa `appCache` com TTL de 4h. As duas versões coexistem; a standalone está desatualizada e nunca usa cache.
- **Impacto real:** Toda vez que um gestor abre `/coach` diretamente (não via SPA), faz uma chamada desnecessária à API. Em uso normal, duplica chamadas de carregamento.
- **Risco futuro:** Com mais vendedores, a lista pode crescer. Sem cache, toda sessão recomeça do zero.
- **Solução técnica:** Unificar fluxo: `/coach` deve redirecionar para `/app#coach`. Ou adicionar sessionStorage cache à versão standalone igual ao feito em `dashboard.html`.

---

**[🔴] dashboard.html — coaching summary carregado fora do cache (fetch não-cacheado no loadDashboard)**
- **Descrição:** Em `dashboard.html`, linha ~710: `const r2 = await fetch('/api/coaching-summaries/${uid}')` é chamado diretamente, sem passar por `cachedFetch`. Toda vez que `loadDashboard()` executa (inclusive ao trocar filtro de vendedor/pipeline), essa chamada é refeita.
- **Impacto real:** Cada mudança de filtro no dashboard dispara nova chamada ao SQLite desnecessariamente. Em telas do admin trocando vendedores rapidamente, são dezenas de chamadas.
- **Risco futuro:** Escalabilidade ruim; risco de rate-limit se o endpoint for movido para API externa.
- **Solução técnica:** Envolver `coaching-summaries` no `cachedFetch` com TTL curto (5 min) ou incluir o summary no payload de `/api/dashboard`.

---

**[🔴] Duplicação de código entre dashboard.html standalone e renderDashboard() em app.html**
- **Descrição:** Toda a lógica de Dashboard existe duas vezes: em `dashboard.html` (standalone) e em `renderDashboard()` dentro de `app.html`. Qualquer bug corrigido em um lugar não reflete no outro.
- **Impacto real:** Bugs de produção já foram provavelmente corrigidos só na SPA, deixando a versão standalone desatualizada. Ex.: `escapeHtml` é usado na SPA mas não está presente em `dashboard.html` — alguns `innerHTML` em `dashboard.html` rendem XSS diretamente (ver item abaixo).
- **Risco futuro:** Alto. Quanto mais a SPA avançar, mais difícil manter sync.
- **Solução técnica:** Deprecar as páginas standalone ou fazê-las renderizar apenas um redirect para `/app#<view>`. Manter código real apenas em `app.html`.

---

**[🟠] XSS potencial em dashboard.html — alertas e interações sem escapeHtml**
- **Descrição:** Em `dashboard.html` (versão standalone), linhas:
  ```js
  alerts.map(a => `<div class="item">⚠️ ${a}</div>`)
  iby.map(([k,v]) => `<div class="item">${k}: <strong>${v}</strong></div>`)
  ```
  Os valores `a` (alertas) e `k` (tipo de interação) vêm da API do servidor e são inseridos via `innerHTML` sem sanitização. Na SPA (`app.html`) o `escapeHtml()` é chamado corretamente.
- **Impacto real:** Se um dado do CRM contiver HTML (ex.: nome de tipo de interação com `<script>` ou `<img onerror=...>`), executará JavaScript no browser do usuário.
- **Risco futuro:** Escalável com os dados vindo do Ploomes (nome de deals, etapas, etc.) — qualquer campo que retorne ao frontend pode ser vetor.
- **Solução técnica:** Usar `escapeHtml()` ou `textContent` em todos os pontos que inserem dados via `innerHTML`. Já está correto na SPA — replicar para versão standalone ou eliminá-la.

---

**[🟠] XSS potencial em loadCrmHygiene (dashboard.html) — ownerName sem escape**
- **Descrição:** No grid de higiene do CRM (dashboard.html standalone), o `ownerName` é inserido via template literal em `innerHTML` sem `escapeHtml`. Ex.:
  ```js
  `<span class="funnel-name">${v.ownerName}</span>`
  ```
- **Impacto real:** Nome de vendedor do Ploomes contendo `<` ou `>` quebra o HTML. Com `<script>` seria XSS completo.
- **Risco futuro:** Nomes de usuário no Ploomes podem ser controlados pelo próprio usuário (ou admin), tornando isso um vetor interno.
- **Solução técnica:** Aplicar `escapeHtml()` em todos os campos dinâmicos. A SPA já faz isso; a versão standalone não.

---

**[🟠] appCache TTL de 4h — dados obsoletos garantidos em uso operacional**
- **Descrição:** O `appCache` em `app.html` tem TTL hardcoded de `4 * 60 * 60 * 1000` (4 horas) para dashboard, funnel-health, crm-health, vendors e pipelines. Um gestor que abre o sistema pela manhã e trabalha até o fim do dia vê os mesmos dados de 4h atrás.
- **Impacto real:** Alertas de deals críticos podem não aparecer até 4h depois do evento. Score CRM exibido no Chat também usa esse dado e pode estar desatualizado.
- **Risco futuro:** Com mais usuários simultâneos, o TTL longo pode mascarar problemas sérios por horas.
- **Solução técnica:** Reduzir TTL para 30-60 min no máximo. Adicionar botão "Atualizar" visível com indicador de "última atualização: X min atrás". O botão já existe mas está oculto para vendedores.

---

**[🟠] dashboard.html usa sessionStorage; app.html usa in-memory appCache — inconsistência de cache**
- **Descrição:** Duas implementações de cache frontend completamente independentes:
  - `dashboard.html`: `sessionStorage` com TTL de 4h (persiste durante a sessão do browser tab)
  - `app.html`: objeto `appCache` in-memory (perdido ao trocar de view ou recarregar)
  O usuário que navega entre as views na SPA perde o cache ao recarregar. O usuário que usa standalone mantém o cache entre navegações dentro da mesma tab.
- **Impacto real:** Comportamento inconsistente e difícil de debugar. Um "atualizar" na SPA não limpa o sessionStorage do standalone.
- **Risco futuro:** Aumenta confusão ao debugar problemas de dado desatualizado.
- **Solução técnica:** Unificar em uma estratégia: `sessionStorage` com wrapper (como `dashboard.html`) ou eliminar as páginas standalone.

---

**[🟠] Carregamento paralelo no bootstrapApp não é aguardado — race condition em primeiro render**
- **Descrição:** Em `bootstrapApp()`:
  ```js
  appCache.get('dashboard', () => fetch('/api/dashboard').then(r => r.json())).catch(()=>{});
  appCache.get('crmHealth', ...).catch(()=>{});
  appCache.get('pipelines', ...).catch(()=>{});
  appCache.get('vendors', ...).catch(()=>{});
  ```
  Essas chamadas são disparadas mas não aguardadas. Se o router renderiza a view antes de uma dessas promises resolver, a view inicia seu próprio fetch (cache miss) em paralelo.
- **Impacto real:** Na prática, ambas as chamadas chegam ao servidor: a do preload e a da view. Duplica chamadas à API no carregamento inicial.
- **Risco futuro:** Com múltiplos usuários simultâneos, dobra a carga no servidor no momento do login.
- **Solução técnica:** Tornar o preload opcional mas garantir que as views aguardem o preload via `await Promise.allSettled([...])` antes de renderizar, ou simplesmente remover o preload e deixar as views gerenciarem o cache.

---

**[🟠] Coach standalone (coach.html) — vendor bar só aparece para admin/gestor, não para supervisor**
- **Descrição:** Em `coach.html` standalone, linha:
  ```js
  if (me.role === 'admin' || me.role === 'gestor') {
    document.getElementById('vendorBar').style.display = 'flex';
    await loadVendors();
  }
  ```
  Na SPA (`app.html`), a condição inclui `supervisor`:
  ```js
  if (!me || !['admin','gestor','supervisor'].includes(me.role))
  ```
- **Impacto real:** Supervisors que acessam `/coach` diretamente não conseguem selecionar vendedores para coachear. Feature incompleta na versão standalone.
- **Risco futuro:** Supervisors ficam sem acesso a funcionalidade disponível na SPA.
- **Solução técnica:** Corrigir a condição no standalone, ou deprecar e redirecionar para a SPA.

---

**[🟡] Bibliotecas externas pesadas carregadas sempre (html2canvas + jsPDF + Chart.js)**
- **Descrição:** `app.html` carrega no `<head>`:
  - `html2canvas` (1.4.1) — ~700KB minificado
  - `jsPDF` (2.5.1) — ~500KB minificado
  - `Chart.js` (4.4.1) — ~200KB minificado
  Essas libs são carregadas em TODOS os usuários, mesmo que nunca gerem um PDF ou usem gráficos. O Chart.js é carregado mas não há uso evidente de gráficos na SPA atual.
- **Impacto real:** +1.4MB de JS bloqueante no carregamento inicial. Em conexões móveis ou lentas, atrasa o primeiro render.
- **Risco futuro:** Mais libs significam mais superficie de vulnerabilidade em dependências de CDN externas.
- **Solução técnica:** Lazy-load html2canvas e jsPDF apenas ao acionar o botão "📥 PDF". Chart.js só ao renderizar a view que use gráficos. Exemplo:
  ```js
  async function downloadPdf() {
    if (!window.jspdf) await loadScript('https://...');
    // ...
  }
  ```

---

**[🟡] Sem tratamento de erro de autenticação (401) nas chamadas fetch**
- **Descrição:** Nenhum dos `fetch()` no frontend trata `401 Unauthorized`. Se a sessão expirar durante o uso, o servidor retorna 401 mas o frontend trata como dado válido (ou exibe dados corrompidos).
- **Impacto real:** Usuário fica "preso" com tela mostrando dados quebrados/vazios sem saber que a sessão expirou.
- **Risco futuro:** Confusão de suporte. Usuário acha que há bug quando na verdade está deslogado.
- **Solução técnica:** Adicionar wrapper global para fetch que cheque `res.status === 401` e faça `window.location.href = '/login'`.

---

**[🟡] Re-renders desnecessários ao trocar filtro de pipeline no dashboard**
- **Descrição:** Ao mudar o filtro de pipeline em `dashboard.html`, a função `loadAll()` reexecuta `loadDashboard()`, `loadFunnelHealth()` e `loadCrmHygiene()` em sequência. `loadCrmHygiene()` não usa `pipelineId` (a API `/api/crm-health` não aceita esse parâmetro), mas é re-executado igualmente.
- **Impacto real:** Chamada desnecessária ao endpoint `/api/crm-health` a cada troca de funil, mesmo que o resultado seja idêntico.
- **Risco futuro:** À medida que mais seções são adicionadas, o problema se amplifica.
- **Solução técnica:** Separar os listeners: mudança de pipeline só refaz `loadDashboard()` e `loadFunnelHealth()`. Mudança de vendedor refaz tudo.

---

**[🟡] Prefill via sessionStorage no Coach — dados não são limpos em caso de erro**
- **Descrição:** Ao clicar "Cobrar vendedor" no dashboard, a mensagem é salva em `sessionStorage`:
  ```js
  sessionStorage.setItem('coach_prefill', msg);
  sessionStorage.setItem('coach_ploomesId', String(ownerId));
  ```
  Se a navegação para `#coach` falhar (ex.: erro de JS), os dados ficam no `sessionStorage` e serão carregados na próxima abertura do Coach, mesmo que irrelevante.
- **Impacto real:** Usuário pode ver mensagem descontextualizada de uma ação anterior.
- **Risco futuro:** Pequeno, mas pode causar confusão.
- **Solução técnica:** Limpar o sessionStorage imediatamente após leitura (já feito para `coach_prefill` e `coach_to`, mas `coach_ploomesId` só é limpo junto — verificar se é sempre limpo mesmo em caso de erro).

---

**[🟡] Gerenciamento de estado entre navegações — scroll position não é restaurado**
- **Descrição:** O `router.render()` faz `root.innerHTML = ''` e re-renderiza tudo do zero. Posição de scroll, estado de acordeons/modais abertos, e campos de formulário preenchidos são perdidos ao navegar para outra view e voltar.
- **Impacto real:** Gestor que estava no meio de revisar a lista de higiene do CRM (scrollado), vai para o Chat e volta, começa do topo novamente.
- **Risco futuro:** UX ruim em telas longas. Difícil de perceber com poucos dados, mas evidente com lista grande de vendedores.
- **Solução técnica:** Salvar `scrollTop` por view no `appState` e restaurar após render. Para listas longas, considerar virtualização ou paginação.

---

**[🟡] Sem loading skeleton / feedback visual durante carregamento de views**
- **Descrição:** Ao navegar entre views, o conteúdo some (root.innerHTML = '') e reaparecer só depois que todas as chamadas terminam. Não há skeleton, spinner ou indicação de progresso.
- **Impacto real:** Para o usuário parece que a navegação "travou" por 1-3 segundos dependendo da conexão.
- **Risco futuro:** Percepção de lentidão do sistema aumenta com o crescimento dos dados.
- **Solução técnica:** Adicionar skeleton HTML mínimo em cada `renderX()` antes de iniciar os fetches.

---

## Resumo de Prioridades

| Severidade | Quantidade | Itens principais |
|------------|-----------|------------------|
| 🔴 Crítico | 3 | Código duplicado, fetch sem cache, feature diferente entre versões |
| 🟠 Alto | 5 | XSS em standalone, TTL longo, race condition no preload, cache inconsistente |
| 🟡 Médio | 5 | Libs pesadas, sem trat. 401, re-renders, scroll, loading states |

**Ação imediata recomendada:** Deprecar/redirecionar as páginas standalone (`dashboard.html`, `coach.html`) para a SPA. Isso elimina 5 dos 13 problemas de uma vez.
