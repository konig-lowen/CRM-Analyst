# TAREFA: Auditoria completa e correção do SPA (app.html)

## Contexto
O sistema CRM Analyst em /opt/ploomes-analyst tem um SPA único: app.html
Servidor Node.js rodando na porta 3001 (http://localhost:3001)
Login: paulovictor@vetorv.com.br / Paulo@2025

## O que precisa ser feito

### 1. ABRIR O BROWSER e testar cada view do SPA visualmente
Use playwright/puppeteer ou curl para simular o browser. Acesse:
- http://localhost:3001/app (login primeiro)
- Testar: Chat, Coach AI, Dashboard, Gestão, Ranking, Relatórios, Usuários

Para cada view, verificar:
- Carregou corretamente? (sem erro)
- Filtro de Funil aparece e está populado?
- Filtro de Vendedor aparece e está populado?
- Dados estão sendo exibidos?
- Console do browser tem erros JS?

### 2. VERIFICAR no app.html se estas correções estão presentes
(foram feitas nos HTMLs separados mas podem não ter ido para o SPA)

**Dashboard view (renderDashboard em app.html):**
- [ ] Filtro de funil (pipelineSelect) passa pipelineId para /api/dashboard
- [ ] Filtro de vendedor passa ploomesId para /api/dashboard
- [ ] /api/funnel-health recebe pipelineId E ploomesId
- [ ] /api/crm-health recebe pipelineId E ploomesId
- [ ] loadPipelines() roda independente de loadVendors() (não encadeado)
- [ ] Catches de erro com console.error (não catches vazios)
- [ ] XSS: alertas usam textContent ou escapeHtml, não innerHTML com dados da API

**Ranking view (renderRanking em app.html):**
- [ ] Filtro de funil passa pipelineId para /api/ranking
- [ ] Filtro de vendedor passa userId para /api/ranking
- [ ] Período Trimestre/Ano funcionam (não desabilitados)
- [ ] Dados aparecem (ranking agora busca usuários Ploomes ativos, não só app_users)

**Coach view (renderCoach em app.html):**
- [ ] Filtro de vendedor popula corretamente
- [ ] Seleção de vendedor atualiza o resumo do dashboard do vendedor selecionado

**Gestão view (renderGestor em app.html):**
- [ ] Menu "Gestão" aparece no nav para admin/gestor
- [ ] View carrega sem erro JS (foi integrado nativamente)
- [ ] Filtro de funil funciona
- [ ] Tabela de vendedores popula

**Filtros de Vendedor e Funil (REGRA GERAL):**
- [ ] Vendedor inativo (app_users.active=0 ou Suspended no Ploomes) → some do menu
- [ ] Novo vendedor adicionado → aparece sem precisar dar F5
- [ ] Funil arquivado → some do menu
- [ ] Funil novo → aparece sem F5
- TTL dos caches de vendor/pipeline: máximo 2 minutos

### 3. APLICAR CORREÇÕES no app.html para tudo que estiver errado

Arquivo: /opt/ploomes-analyst/app.html
Servidor reinicia com: systemctl restart ploomes-analyst

### 4. VERIFICAR APÓS CADA CORREÇÃO
Depois de cada fix importante, testar novamente via curl ou node para confirmar.

### 5. RELATÓRIO FINAL
Listar o que foi encontrado e o que foi corrigido.

## Importante
- Não mexer em server.js a menos que seja absolutamente necessário
- Foco total no app.html (SPA)
- Testar como admin (tem acesso a tudo)
- A senha pode ser mudada em: sqlite3 /opt/ploomes-analyst/history.db "SELECT username, role FROM app_users"
