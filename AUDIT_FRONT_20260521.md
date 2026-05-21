# Auditoria Frontend/UX — CRM Ploomes Analyst
**Data:** 2026-05-21  
**Auditor:** Jarvis (subagent)  
**Escopo:** app.html, dashboard.html, gestor.html, coach.html, ranking.html, admin.html, login.html

---

## Resumo Executivo

| Severidade | Qtd |
|---|---|
| 🔴 Crítico | 4 |
| 🟠 Médio | 5 |
| 🟡 Baixo | 6 |
| **Total bugs** | **15** |

---

## 🔴 BUGS CRÍTICOS

### BUG-01 🔴 — XSS em alertas no `dashboard.html`
**Arquivo:** `dashboard.html` · **Linha:** ~726  
**Descrição:** Alertas vindos da API são inseridos via `innerHTML` sem sanitização:
```js
alerts.map(a => `<div class="item">⚠️ ${a}</div>`)
```
Se o backend retornar texto com `<script>` ou atributos de evento (mesmo que indiretamente via dados do CRM), há execução de código arbitrário. O `app.html` já usa `escapeHtml(a)` na mesma lógica (linha 1152) — inconsistência que indica regra de segurança esquecida no arquivo irmão.  
**Fix:** Substituir por `escapeHtml(a)` ou usar `textContent` em elemento criado via `document.createElement`.

---

### BUG-02 🔴 — Filtro de vendedor no Ranking ignorado pela API
**Arquivo:** `ranking.html` · **Linhas:** 272, 294  
**Descrição:** O seletor de vendedor (`vendorFloat`) altera `selectedUserId` e usa cache diferente (`ranking_<id>`), mas a chamada à API **nunca passa o parâmetro**:
```js
const r = await fetch('/api/ranking');  // sem ?userId=...
```
Resultado: gestor/admin seleciona outro vendedor, vê sempre o mesmo ranking global. O filtro é visualmente funcional mas silenciosamente inoperante.  
**Fix:** Passar `?userId=${selectedUserId}` na fetch quando `selectedUserId` estiver definido.

---

### BUG-03 🔴 — IDs de elemento duplicados no `app.html` (SPA)
**Arquivo:** `app.html` · **Linhas:** 679 (`id="scorecrm"`) e 996 (`id="score"`)  
**Descrição:** A SPA renderiza views diferentes no mesmo `root`. Dois elementos de Score CRM existem com IDs distintos e JS diferente:
- Chat view → `getElementById('scorecrm')` → atualiza via `refreshScore()`
- Dashboard view → `getElementById('score')` → atualiza via `loadDashboard()`

Quando o usuário alterna entre views sem reload completo, `root.innerHTML` é substituído. Qualquer `getElementById` executado referenciando o ID da view anterior retorna `null`, causando erro silencioso (`TypeError: Cannot set properties of null`). O catch vazio (`catch {}`) nas linhas 874 e 930 engole o erro, mas o Score fica perpetuamente em "—" após troca de view.  
**Fix:** Consolidar para um único ID `score-crm` ou verificar existência antes de atualizar: `const el = document.getElementById('score'); if (el) el.textContent = ...`

---

### BUG-04 🔴 — Senha mínima de 4 caracteres no `admin.html`
**Arquivo:** `admin.html` · **Linha:** ~230  
**Descrição:** Campo de nova senha no painel de administração tem placeholder "mínimo 4", o que é extremamente inseguro para uma aplicação com dados comerciais sensíveis. Não há validação de força, complexidade ou comprimento mínimo adequado.  
**Fix:** Exigir mínimo 8 caracteres, idealmente com validação de força (maiúscula + número/símbolo). Adicionar `minlength="8"` no input e validação JS antes do submit.

---

## 🟠 BUGS MÉDIOS

### BUG-05 🟠 — Período "Trimestre" e "Ano" no Ranking são placeholders expostos ao usuário
**Arquivo:** `ranking.html` · **Linhas:** 205–206  
**Descrição:** O seletor de período exibe opções "(placeholder)" para Trimestre e Ano. O parâmetro `period` sequer é enviado para a API em `loadRanking()`. O usuário pode selecionar e não perceber que nada mudou.  
**Fix:** Remover as opções não implementadas até estarem prontas, ou desabilitá-las com `disabled` e `title="Em breve"`.

---

### BUG-06 🟠 — `catch` vazio engole erros em múltiplos lugares
**Arquivos:** `app.html` (linhas 571–574, 874, 930), `coach.html` (linhas 349, 403)  
**Descrição:** Vários blocos `catch {}` ou `catch { return ''; }` descartam exceções silenciosamente. O pré-carregamento do cache em `app.html` (linhas 571–574) engole falhas de rede, e se a API retornar 401/500, o usuário não recebe nenhum aviso.  
**Fix:** Pelo menos `console.warn('[módulo] erro:', e)` em todos os catches. Para erros críticos de carregamento, exibir mensagem de fallback na UI.

---

### BUG-07 🟠 — `gestor.html` faz 3 fetches independentes sem tratamento de falha parcial
**Arquivo:** `gestor.html` · **Linhas:** ~loadAll()  
**Descrição:** `Promise.all([fetch('/api/gestor-dashboard'), fetch('/api/alerts'), fetch('/api/agenda-hoje')])` — se qualquer uma falhar, o `catch (e)` global mostra erro genérico e nenhuma das 3 seções é renderizada, mesmo que 2 tenham respondido OK.  
**Fix:** Usar `Promise.allSettled` e renderizar as seções que tiveram sucesso, mostrando erro apenas nas que falharam.

---

### BUG-08 🟠 — `app.html`: campo `k1` mostra `dealsAbertos` mas sem unidade contextual
**Arquivo:** `app.html` · **Linha:** 1124  
**Descrição:** `document.getElementById('k1').textContent = d.dealsAbertos ?? '—'` — exibe número puro "23" sem sub-label indicando o que significa. O `k2` tem sub-label "ganhos" mas `k1` não tem equivalente para "em aberto".  
Obs: k2 usa `d.ganhosMs?.valor` (com `?`) mas `k1` usa `d.dealsAbertos` sem fallback para zero — se a chave vier como `deals_abertos` (snake_case), mostra "—" mesmo com dados.  
**Fix:** Adicionar sub-label e garantir fallback: `d.dealsAbertos ?? d.deals_abertos ?? '—'`.

---

### BUG-09 🟠 — `ranking.html`: identificação de linha própria por nome (`u.nome === me.displayName`) é frágil
**Arquivo:** `ranking.html` · **Linha:** ~loadRanking()  
**Descrição:** `const isMe = me && (u.nome === me.displayName)` — identifica o usuário logado comparando string de nome. Se houver dois vendedores com mesmo nome, ou diferença de capitalização/acentuação, a linha "eu" será destacada incorretamente ou não será encontrada.  
**Fix:** Comparar por ID (`u.userId === me.userId` ou equivalente).

---

## 🟡 BUGS BAIXOS

### BUG-10 🟡 — Botão `btnRefresh` com `style="display:none"` sem label/aria em múltiplas páginas
**Arquivos:** `app.html` (linhas 509, 1000, 1374), `ranking.html`  
**Descrição:** Vários botões de refresh têm `display:none` e estão vazios ou sem texto, tornados visíveis por JS. Sem `aria-label`, são invisíveis a leitores de tela quando exibidos.  
**Fix:** Adicionar `aria-label="Atualizar dados"` e texto visível (`🔄 Atualizar`).

---

### BUG-11 🟡 — `funnelSection` e `crmHygieneSection` ficam `display:none` por padrão e podem nunca aparecer se JS falhar
**Arquivo:** `app.html` · **Linhas:** 1038, 1043  
**Descrição:** Seções inteiras de funil e higiene CRM iniciam ocultas e dependem de JS para exibição. Se `loadFunnelHealth()` ou `loadCrmHygiene()` lançar exceção silenciosa, o usuário não sabe que existe essa seção.  
**Fix:** Exibir placeholder "Carregando..." visível por padrão; ocultar apenas se o usuário não tiver permissão.

---

### BUG-12 🟡 — `dashboard.html` não tem `escapeHtml` para nomes em `a` (alertas sem source-check)
**Arquivo:** `dashboard.html` · **Linha:** 726  
(Já coberto em BUG-01, mas também afeta o texto de alerta que pode conter `&`, `<`, `>` sem encode.)

---

### BUG-13 🟡 — `gestor.html` usa `me?.displayName` mas `me` pode ser `null` se `/api/me` falhar — sem tratamento
**Arquivo:** `gestor.html` (não tem fetch de `/api/me`; rota é página standalone)  
**Descrição:** `gestor.html` não carrega dados do usuário logado — não há `user-name`/`user-role` preenchidos no rodapé da sidebar (se tiver). Diferente de `ranking.html` e `dashboard.html` que fazem `/api/me` na inicialização.  
**Fix:** Adicionar fetch de `/api/me` na inicialização ou indicar sessão ativa.

---

### BUG-14 🟡 — `coach.html`: erro de conexão mostra "❌ Erro de conexão." sem detalhe, sem retry
**Arquivo:** `coach.html` · **Linha:** ~403  
**Descrição:** `catch { addMessage('assistant', '❌ Erro de conexão.'); }` — sem código de erro HTTP, sem botão de retry, sem distinção entre timeout e 500.  
**Fix:** Capturar `e.message` e exibir. Adicionar botão "Tentar novamente" ou reabilitar input para reenvio.

---

### BUG-15 🟡 — `ranking.html`: `loadVendors` chama `/api/admin/users` (rota admin) para todos roles gestor/admin
**Arquivo:** `ranking.html` · **Linha:** ~loadVendors  
**Descrição:** `fetch('/api/admin/users')` sem tratamento de 403 — se a rota retornar proibido para `gestor` (dependendo da implementação backend), o select de vendedor fica vazio sem aviso.  
**Fix:** Verificar `r.ok` antes de `r.json()` e mostrar mensagem de fallback.

---

## 📐 Inconsistências Entre Páginas

| Item | `app.html` (SPA) | `dashboard.html` | `gestor.html` |
|---|---|---|---|
| Score CRM label | `id="scorecrm"` | `id="score"` | Não exibe |
| Tema visual | Light (sidebar branca) | Light | Dark (bg #0f1117) |
| Meta realizado | `d.metaVsRealizado?.realizado?.ganhosMes` | Mesmo padrão | `t.receitaMes` (diferente) |
| Ganhos mês | `d.ganhosMs?.valor` | `d.ganhosMs?.valor` | `t.receitaMes` (diferente) |
| Alertas | `d.alertas` (array de strings) | `d.alertas` (strings) | `/api/alerts` (objetos `{message, severity, timestamp}`) |
| Higiene do CRM | `hygieneScore >= 80 = Bom` | Mesmo | Não exibido |

**Inconsistência de tema mais impactante:** `gestor.html` é completamente dark enquanto todas as outras páginas são light. Usuário que abre o dashboard de gestão tem quebra visual abrupta de identidade.

---

## 💡 Sugestões de UX (Priorizadas)

### P1 — Feedback de carregamento parcial (impacto alto)
`gestor.html` e `dashboard.html` mostram "Carregando..." estático. Se a API demorar >2s, não há spinner nem indicação de progresso real. Adicionar skeleton loading cards é mais profissional e reduz ansiedade do usuário.

### P2 — Tornar o botão Refresh visível para todos (não só admin/gestor)
Vendedores não conseguem forçar atualização. Limitar apenas a admins esconde funcionalidade útil. Permitir refresh manual com rate-limit (ex: 1x a cada 5 min) para todos.

### P3 — Ranking: breakdown text muito longo
A coluna "Breakdown" no ranking exibe linha longa com todos os pontos (ex: `+10x ganhos: 3 • +1x interações: 45 • ...`). Em telas menores, a tabela quebra. Substituir por tooltip ou modal de detalhe ao clicar.

### P4 — Consistência de tema visual
Padronizar `gestor.html` para o tema light das demais páginas, ou adotar dark mode em todas com toggle. A mistura atual parece erro, não design intencional.

### P5 — Indicar última atualização em todas as páginas
Apenas `gestor.html` tem "Atualizado: [timestamp]". `dashboard.html` e `ranking.html` não informam quando os dados foram carregados, gerando dúvida sobre frescor das informações.

### P6 — Placeholder de dados sem meta
Quando não há meta cadastrada, `dashboard.html` exibe "Sem metas cadastradas para este mês." mas não oferece link/ação para cadastrar. Adicionar CTA para o admin.

---

## 🔒 Observações de Segurança

- **Senha mínima 4 chars** em admin.html (coberto em BUG-04) — risco real
- **XSS potencial** em alerts sem escaping em dashboard.html (BUG-01)
- **Sem token CSRF aparente** em formulários de admin (criar/editar usuário usa fetch com JSON, dependente do cookie de sessão — risco médio dependendo do domínio)
- Não foram encontrados tokens/secrets hardcoded no frontend ✅

---

*Auditoria gerada em 2026-05-21 por análise estática dos arquivos HTML/JS.*
