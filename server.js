const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const https = require('https');
const fs = require('fs');
const { spawn } = require('child_process');
const rateLimit = require('express-rate-limit');
const chatRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => String(req.session?.userId || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown'),
  handler: (req, res) => res.status(429).json({ error: 'Muitas requisições. Aguarde 1 minuto.' }),
  standardHeaders: true,
  legacyHeaders: false,
});

// Anthropic (Claude)
let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const app = express();
const PORT = 3001;

// IMPORTANT: Ploomes API is READ-ONLY. Never POST/PATCH/DELETE on Ploomes.
const PLOOMES_API_KEY = process.env.PLOOMES_API_KEY;
if (!PLOOMES_API_KEY) { console.error('[FATAL] PLOOMES_API_KEY não definida'); process.exit(1); }
const PLOOMES_BASE = 'https://api2.ploomes.com';

// Usuários excluídos de TODAS as análises de performance
// Paulo Victor (ID: 10001176) é o dono da empresa e NÃO atua como vendedor
// Sarah Baliana (ID: 60023650) é gestor — não é vendedora
// FATURAMENTO (ID: 10025857) é usuário de integração/financeiro — não é vendedor
const EXCLUDED_FROM_ANALYSIS = [10001176, 60023650, 10025857];

// Funis inativos/de teste — NUNCA incluir em análises
// 60009328 = [Cópia] - Manutenção da Carteira (funil de teste/cópia)
// Funis arquivados (Archived=true na API Ploomes) — excluídos de todas as análises
// Pré-Vendas MG, Pré-Vendas GO, Novos Clientes, [Cópia] Manutenção da Carteira, VENDA DIRETA - CTS
const INACTIVE_PIPELINE_IDS = [10013804, 10016564, 60000288, 60009328, 60011853];

// Categorias de funil — definem como cada funil é analisado
const PIPELINE_CATEGORIES = {
  // Funis de VENDA REAL (usados em análises de receita, conversão, ticket)
  // OBS: 10013559 é "Manutenção da Carteira" (CARTEIRA) — não incluir em SALES
  SALES: [60000286, 60000239, 60000405, 60000407, 60000638, 10014103, 60000081],
  // Funil de MANUTENÇÃO DE CARTEIRA (relacionamento, não venda nova)
  // Motivo único "Não Possui Necessidade" é CORRETO e esperado — não alertar como anomalia
  CARTEIRA: [10013559],
  // Funil de PROSPECÇÃO (qualificação apenas — deals ganhos são erro histórico, ignorar)
  PROSPECCAO: [60000238],
  // Funis ARQUIVADOS (nunca usar) — mesmos que INACTIVE_PIPELINE_IDS
  ARCHIVED: [10013804, 10016564, 60000288, 60009328, 60011853]
};

// Contexto de negócio por funil — usado para regras de análise
function getPipelineContext(pipelineId) {
  const id = Number(pipelineId);
  if (PIPELINE_CATEGORIES.ARCHIVED.includes(id)) {
    return { category: 'ARCHIVED', includeInRevenue: false, includeInConversion: false,
      note: 'Funil arquivado — nunca usar em análises' };
  }
  if (PIPELINE_CATEGORIES.CARTEIRA.includes(id)) {
    return { category: 'CARTEIRA', includeInRevenue: false, includeInConversion: false,
      expectedLossReasons: ['Não Possui Necessidade no Momento', 'Não Possui Necessidade'],
      staleSLA: { attention: 45, critical: 90 },
      note: 'Funil de relacionamento — único motivo de perda esperado é "Não Possui Necessidade". NÃO alertar como anomalia.' };
  }
  if (PIPELINE_CATEGORIES.PROSPECCAO.includes(id)) {
    return { category: 'PROSPECCAO', includeInRevenue: false, includeInConversion: false,
      note: 'Funil de qualificação — deals ganhos são erro histórico, ignorar em análises de receita e conversão' };
  }
  if (PIPELINE_CATEGORIES.SALES.includes(id)) {
    return { category: 'SALES', includeInRevenue: true, includeInConversion: true };
  }
  return { category: 'OTHER', includeInRevenue: true, includeInConversion: true };
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// --- DB ---
const db = new Database('/opt/ploomes-analyst/history.db');
db.pragma('foreign_keys = ON');

// --- Warehouse (read-mostly local DB fed by incremental ETL) ---
const WAREHOUSE_DB_PATH = process.env.WAREHOUSE_DB_PATH || '/opt/ploomes-analyst/warehouse.db';
let warehouseDb = null;
let warehouseSyncInFlightAt = 0;

function getWarehouseDb() {
  if (warehouseDb) return warehouseDb;
  try {
    warehouseDb = new Database(WAREHOUSE_DB_PATH);
    warehouseDb.pragma('journal_mode = WAL');
    warehouseDb.pragma('synchronous = NORMAL');
    return warehouseDb;
  } catch (e) {
    warehouseDb = null;
    return null;
  }
}

function getWarehouseLastRun() {
  const wdb = getWarehouseDb();
  if (!wdb) return null;
  try {
    return wdb.prepare('SELECT id, started_at, finished_at, ok, error FROM etl_runs ORDER BY id DESC LIMIT 1').get();
  } catch {
    return null;
  }
}

function isWarehouseFresh(maxAgeMs = 60 * 60 * 1000) {
  const last = getWarehouseLastRun();
  if (!last || !last.ok || !last.finished_at) return false;
  const t = new Date(last.finished_at).getTime();
  if (!Number.isFinite(t)) return false;
  return (Date.now() - t) <= maxAgeMs;
}

/**
 * inferDateRangeFromMessage
 * Tenta extrair o intervalo de datas da mensagem do usuário.
 * Retorna { startDate, endDate, explicit: boolean } ou null se não houver data específica.
 * explicit=false indica pedido de "estado atual" sem data → deve puxar recente.
 */
function inferDateRangeFromMessage(message) {
  const txt = message.toLowerCase();
  const now = new Date();
  const y = now.getUTCFullYear();

  // Q1/Q2/Q3/Q4 [YYYY]
  const qMatch = txt.match(/q([1-4])\s*(?:de\s*)?(\d{4})?/);
  if (qMatch) {
    const q = parseInt(qMatch[1]);
    const year = qMatch[2] ? parseInt(qMatch[2]) : y;
    const startMonth = (q - 1) * 3;
    return {
      startDate: new Date(Date.UTC(year, startMonth, 1)),
      endDate: new Date(Date.UTC(year, startMonth + 3, 0, 23, 59, 59)),
      explicit: true,
    };
  }

  // "últimos X dias"
  const daysMatch = txt.match(/[úu]ltimos?\s+(\d+)\s+dias?/);
  if (daysMatch) {
    const days = parseInt(daysMatch[1]);
    return {
      startDate: new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
      endDate: now,
      explicit: true,
    };
  }

  // "últimas X semanas"
  const weeksMatch = txt.match(/[úu]ltimas?\s+(\d+)\s+semanas?/);
  if (weeksMatch) {
    const weeks = parseInt(weeksMatch[1]);
    return {
      startDate: new Date(now.getTime() - weeks * 7 * 24 * 60 * 60 * 1000),
      endDate: now,
      explicit: true,
    };
  }

  // Nome de mês [de YYYY] — ex: "março 2026", "em janeiro"
  const monthNames = ['janeiro','fevereiro','mar(?:[çc]o)?','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  for (let mi = 0; mi < monthNames.length; mi++) {
    const mMatch = txt.match(new RegExp(monthNames[mi] + '(?:\\s*(?:de\\s*)?(\\d{4}))?'));
    if (mMatch) {
      const year = mMatch[1] ? parseInt(mMatch[1]) : y;
      return {
        startDate: new Date(Date.UTC(year, mi, 1)),
        endDate: new Date(Date.UTC(year, mi + 1, 0, 23, 59, 59)),
        explicit: true,
      };
    }
  }

  // Ano específico — ex: "em 2025", "de 2025"
  const yearMatch = txt.match(/\b(202[0-9])\b/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1]);
    if (year !== y) { // só se não for o ano corrente (evitar falso positivo)
      return {
        startDate: new Date(Date.UTC(year, 0, 1)),
        endDate: new Date(Date.UTC(year, 11, 31, 23, 59, 59)),
        explicit: true,
      };
    }
  }

  // Sem data especificada → retorna null (caller trata como "estado atual")
  return null;
}

/**
 * isRefreshRequest — detecta pedido explícito de atualização
 * Gatilha: "me atualiza", "atualiza o warehouse", "atualiza os dados", "sync", "sincroniza"
 */
function isRefreshRequest(message) {
  return /\bme atualiza\b|\batualiza(?:r)?\b.*\b(dados?|warehouse|crm|base)|\bsync\b|\bsincroniza/i.test(message);
}

/**
 * isCurrentStateQuery — detecta pedidos de "estado atual" sem data especificada.
 * Ex: "quantos cards parados", "como está o pipeline", "quem tem mais tarefas vencidas"
 */
function isCurrentStateQuery(message) {
  const txt = message.toLowerCase();
  // Indicadores de estado atual
  const currentStatePatterns = [
    /\bestá\b|\bestão\b|\bstatus\b/,
    /\bpipeline\b/,
    /\bcards?\s*parad/,
    /\babandona/,
    /\bvencid/,
    /\bbacklog\b/,
    /\boverdue\b/,
    /\batual\b|\bme atualiza\b|\batuali[sz]/,
    /\bhoje\b|\bagora\b/,
    /\bquantos?\b.*\b(aberto|em aberto|parado|vencido)/,
    /\bquem tem mais\b/,
    /\bpreciso saber\b.*\b(atual|hoje)/,
    /\bsituação\b/,
    /\boverview\b|\bpanorama\b/,
  ];
  return currentStatePatterns.some(p => p.test(txt));
}

/**
 * resolveDataSource — lógica de 3 datas (versão final Paulo v3)
 *
 * WATERMARK = D-1 (ontem à meia-noite, 2026-05-10T23:59:59Z)
 * O warehouse NUNCA contém dados do dia corrente (parciais, mudam o dia todo).
 *
 * Regras:
 *  0) Clamp: end_date efetivo = min(end_date_pedida, D-1 23:59:59)
 *  1) Período histórico fechado (end_efetivo <= D-1 E warehouse cobre) → warehouse puro, zero API
 *  2) Sem data OU estado atual (pipeline, cards, vencidos, etc.) → warehouse até D-1, sem extração
 *  3) Pedido EXPLÍCITO de 'me atualiza' / 'atualizar' → extrai last_extraction até D-1 (upsert)
 *  4) Warehouse não cobre → api direta
 *
 * @param {Date|null} startDate      null = sem data especificada
 * @param {Date|null} endDate        null = sem data especificada
 * @param {boolean}   isCurrentState true = query de estado atual (sem data)
 * @param {boolean}   isRefreshReq   true = pedido explícito de 'me atualiza'
 * @returns {{
 *   source: 'warehouse'|'recent'|'api',
 *   reason: string,
 *   lastExtractionISO: string|null,
 *   recentSinceISO: string|null,
 *   effectiveEndDate: string,       // D-1 23:59:59 ou endDate original se < D-1
 * }}
 */
function resolveDataSource(startDate, endDate, isCurrentState = false, isRefreshReq = false) {
  const now = new Date();

  // Watermark: D-1 23:59:59 UTC — limite superior absoluto do warehouse
  const todayMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const yesterdayEOD  = new Date(todayMidnight.getTime() - 1000); // D-1 23:59:59.999

  // Get last successful extraction from warehouse
  const wdb = getWarehouseDb();
  let lastExtractionDate = null;
  if (wdb) {
    try {
      const lastOk = wdb.prepare("SELECT finished_at FROM etl_runs WHERE ok=1 ORDER BY id DESC LIMIT 1").get();
      if (lastOk && lastOk.finished_at) lastExtractionDate = new Date(lastOk.finished_at);
    } catch {}
  }

  const lastExtractionISO = lastExtractionDate ? lastExtractionDate.toISOString() : null;

  // recentSinceISO: a partir de quando puxar da API para incremental
  // NUNCA deve incluir dados do dia corrente (sempre < todayMidnight)
  const recentSinceISO = lastExtractionDate
    ? new Date(Math.min(lastExtractionDate.getTime() - 2 * 60 * 60 * 1000, yesterdayEOD.getTime())).toISOString()
    : new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  // Cutoff para a extração: exclusive hoje
  const extractUntilISO = yesterdayEOD.toISOString();

  // --- REGRA 3: pedido explícito de atualização ---
  if (isRefreshReq) {
    return {
      source: 'recent',
      reason: `atualização explícita — extrai last_extraction até D-1 (${extractUntilISO.slice(0,10)}) e faz upsert`,
      lastExtractionISO,
      recentSinceISO,
      effectiveEndDate: extractUntilISO,
    };
  }

  // --- REGRA 2: sem data OU estado atual → warehouse até D-1, sem nova extração ---
  if (!endDate || isCurrentState) {
    if (!lastExtractionDate) {
      return {
        source: 'api',
        reason: 'warehouse sem run OK — usando API direta',
        lastExtractionISO: null,
        recentSinceISO: null,
        effectiveEndDate: yesterdayEOD.toISOString(),
      };
    }
    return {
      source: 'warehouse',
      reason: isCurrentState
        ? `estado atual — warehouse cobre até D-1 (${yesterdayEOD.toISOString().slice(0,10)}), sem extração do dia corrente`
        : `sem data especificada — usando warehouse até D-1 (${yesterdayEOD.toISOString().slice(0,10)})`,
      lastExtractionISO,
      recentSinceISO: null,
      effectiveEndDate: yesterdayEOD.toISOString(),
    };
  }

  // --- REGRA 0: clamp endDate a D-1 ---
  const rawEnd = endDate instanceof Date ? endDate : new Date(endDate);
  const effectiveEnd = rawEnd > yesterdayEOD ? yesterdayEOD : rawEnd;
  const effectiveEndDate = effectiveEnd.toISOString();

  // --- REGRA 1: histórico fechado ---
  if (!lastExtractionDate) {
    return { source: 'api', reason: 'warehouse sem run OK — usando API direta', lastExtractionISO: null, recentSinceISO: null, effectiveEndDate };
  }

  if (lastExtractionDate >= effectiveEnd) {
    return {
      source: 'warehouse',
      reason: `período histórico fechado e já extraído — zero chamada API (end_efetivo: ${effectiveEndDate.slice(0,10)})`,
      lastExtractionISO,
      recentSinceISO: null,
      effectiveEndDate,
    };
  }

  // --- REGRA 4: warehouse não cobre ---
  return {
    source: 'api',
    reason: `warehouse não cobre o período — API direta (warehouse até ${lastExtractionISO ? lastExtractionISO.slice(0,10) : 'N/A'}, pedido até ${effectiveEndDate.slice(0,10)})`,
    lastExtractionISO,
    recentSinceISO: null,
    effectiveEndDate,
  };
}

function kickWarehouseSyncBackground(reason = 'stale') {
  // Avoid stampede: at most one spawn per 5 minutes.
  if (warehouseSyncInFlightAt && (Date.now() - warehouseSyncInFlightAt) < 5 * 60 * 1000) return false;
  warehouseSyncInFlightAt = Date.now();
  try {
    const child = spawn(process.execPath, ['/opt/ploomes-analyst/scripts/sync_warehouse.js'], {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, WAREHOUSE_DB_PATH },
    });
    child.unref();
    console.log(`[warehouse] kicked background sync (${reason}) pid=${child.pid}`);
    return true;
  } catch (e) {
    console.warn('[warehouse] failed to spawn sync:', e.message);
    return false;
  }
}

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_session ON messages(session_id);

  CREATE TABLE IF NOT EXISTS app_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    active INTEGER DEFAULT 1,
    role TEXT DEFAULT 'vendedor',
    ploomes_user_id INTEGER,
    display_name TEXT
  );

  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    supervisor_user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS team_members (
    team_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    UNIQUE(team_id, user_id)
  );

  -- PHASE 1 tables
  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    year INTEGER NOT NULL,
    month INTEGER,
    valor_mensal REAL DEFAULT 0,
    valor_semanal REAL DEFAULT 0,
    interacoes_dia INTEGER DEFAULT 0,
    interacoes_semana INTEGER DEFAULT 0,
    funil_id INTEGER,
    funil_mensal REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);

  CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    predicted_revenue REAL DEFAULT 0,
    predicted_deals INTEGER DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS coaching_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    summary TEXT NOT NULL,
    score_delta INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_coaching_user ON coaching_summaries(user_id);
`);

// fetch_cache table for session-scoped persistent cache (TTL 7 days)
db.exec(`
  CREATE TABLE IF NOT EXISTS fetch_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    chat_session_id INTEGER NOT NULL,
    url_hash TEXT NOT NULL,
    url_path TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fetch_cache_key ON fetch_cache(user_id, chat_session_id, url_hash);
  CREATE INDEX IF NOT EXISTS idx_fetch_cache_expires ON fetch_cache(expires_at);
`);

// ─── Tabela anomaly_alerts ────────────────────────────────────────────
db.prepare(`
  CREATE TABLE IF NOT EXISTS anomaly_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    owner_ploomes_id INTEGER,
    message TEXT NOT NULL,
    data_json TEXT,
    detected_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT,
    notified INTEGER DEFAULT 0
  )
`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_anomaly_owner ON anomaly_alerts(owner_ploomes_id, resolved_at)`).run();

// migrate messages to add user_id (needed for /api/chat-history/:userId)
const msgCols = db.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
if (!msgCols.includes('user_id')) {
  try {
    db.exec('ALTER TABLE messages ADD COLUMN user_id INTEGER;');
    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);');
    console.log('[db] migrated messages: added user_id');
  } catch (e) {
    console.error('[db] migration messages.user_id failed:', e.message);
  }
}

// --- Session fetch cache helpers ---
function urlHash(urlPath) {
  return crypto.createHash('sha256').update(urlPath).digest('hex').substring(0, 64);
}

function getCachedFetch(userId, chatSessionId, urlPath) {
  if (!chatSessionId) return null;
  try {
    const row = db.prepare(
      'SELECT result_json FROM fetch_cache WHERE user_id=? AND chat_session_id=? AND url_hash=? AND expires_at > CURRENT_TIMESTAMP'
    ).get(userId, chatSessionId, urlHash(urlPath));
    if (!row) return null;
    return JSON.parse(row.result_json);
  } catch { return null; }
}

function setCachedFetch(userId, chatSessionId, urlPath, data) {
  if (!chatSessionId) return;
  try {
    db.prepare('DELETE FROM fetch_cache WHERE expires_at <= CURRENT_TIMESTAMP').run();
    const count = db.prepare('SELECT COUNT(*) as c FROM fetch_cache WHERE user_id=? AND chat_session_id=?').get(userId, chatSessionId);
    if (count && count.c >= 200) {
      db.prepare('DELETE FROM fetch_cache WHERE id IN (SELECT id FROM fetch_cache WHERE user_id=? AND chat_session_id=? ORDER BY created_at ASC LIMIT 20)').run(userId, chatSessionId);
    }
    const hash = urlHash(urlPath);
    const json = JSON.stringify(data);
    db.prepare(`
      INSERT INTO fetch_cache (user_id, chat_session_id, url_hash, url_path, result_json, expires_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', '+7 days'))
      ON CONFLICT(user_id, chat_session_id, url_hash) DO UPDATE SET result_json=excluded.result_json, expires_at=excluded.expires_at, created_at=CURRENT_TIMESTAMP
    `).run(userId, chatSessionId, hash, urlPath, json);
  } catch (e) {
    console.error('[cache set error]', e.message);
  }
}

function getSessionCacheContext(userId, chatSessionId) {
  if (!chatSessionId) return '';
  try {
    const rows = db.prepare(
      'SELECT url_path, result_json, created_at FROM fetch_cache WHERE user_id=? AND chat_session_id=? AND expires_at > CURRENT_TIMESTAMP ORDER BY created_at ASC LIMIT 50'
    ).all(userId, chatSessionId);
    if (!rows.length) return '';
    const items = rows.map(r => {
      let total = '?';
      try { const d = JSON.parse(r.result_json); total = d.total ?? '?'; } catch {}
      return `- ${r.url_path} | total=${total} | cached em ${r.created_at}`;
    }).join('\n');
    return `\n\n## Dados ja disponiveis nesta sessao (nao refaca esses fetches se os dados ainda forem validos):\n${items}`;
  } catch { return ''; }
}

// --- Auth helpers ---
function hashPassword(p) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(p, salt, 100000, 64, 'sha512').toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(p, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const h = crypto.pbkdf2Sync(p, salt, 100000, 64, 'sha512').toString('hex');
    return h === hash;
  } catch { return false; }
}

// Ensure admin exists (legacy bootstrap)
const userCount = db.prepare('SELECT COUNT(*) as c FROM app_users').get();
if (userCount.c === 0) {
  db.prepare('INSERT INTO app_users (username, password_hash, role, display_name, active) VALUES (?, ?, ?, ?, 1)')
    .run('paulo', hashPassword(process.env.ADMIN_INITIAL_PASSWORD || 'vetorv2024'), 'admin', 'Paulo');
  console.log('[auth] Usuário padrão paulo criado. Altere a senha no primeiro acesso.');
}

// --- Dicionário (cache 30 min) ---
let dictionary = null;
let dictionaryLoadedAt = 0;

// Resolve a Ploomes user by e-mail (case-insensitive).
// Only considers active CRM users (not Suspended and not Integration).
async function resolvePloomesUserByEmail(email) {
  const e = (email || '').trim().toLowerCase();
  if (!e) return null;
  const dict = await loadDictionary();
  const users = (dict.users || []).filter(u => !!u && !u.Suspended && !u.Integration);
  const match = users.find(u => (u.Email || '').trim().toLowerCase() === e);
  if (!match) return null;
  return { id: Number(match.Id), name: match.Name || null, email: match.Email || null };
}


function _ploomesGetOnceSingle(urlPath) {
  // Server-side concurrency limiter to avoid: "Too many request concurrently, max is 6"
  // Keep a conservative cap here.
  const MAX = 4;
  if (!global.__ploomesSem) {
    global.__ploomesSem = { active: 0, q: [] };
  }
  const sem = global.__ploomesSem;
  const withSem = (fn) => new Promise((resolve, reject) => {
    const run = () => {
      sem.active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          sem.active--;
          const next = sem.q.shift();
          if (next) next();
        });
    };
    if (sem.active < MAX) run();
    else sem.q.push(run);
  });

  return withSem(() => new Promise((resolve, reject) => {
    const urlObj = new URL(PLOOMES_BASE + urlPath);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: { 'User-Key': PLOOMES_API_KEY },
      timeout: 30000,
    };
    https.get(options, (res) => {
      if (res.statusCode === 429) {
        const retryAfter = res.headers['retry-after'];
        reject(new Error(`429 rate-limit${retryAfter ? ` retry-after=${retryAfter}s` : ''}`));
        res.resume();
        return;
      }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (typeof parsed === 'string') return reject(new Error('API retornou string: ' + parsed.substring(0, 100)));
          if (parsed.value && typeof parsed.value === 'string') return reject(new Error('API error: ' + parsed.value));
          resolve(parsed);
        } catch(e) { reject(new Error('JSON parse: ' + data.substring(0, 200))); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
  }));
}

async function ploomesGetOnce(urlPath) {
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await _ploomesGetOnceSingle(urlPath);
    } catch (e) {
      const isRetryable = e.message?.includes('429') || e.message?.includes('5') || e.message?.includes('timeout') || e.message?.includes('ECONNRESET');
      if (attempt < maxRetries - 1 && isRetryable) {
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(`[ploomes retry] tentativa ${attempt + 1} falhou, aguardando ${delay}ms:`, e.message);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw e;
      }
    }
  }
}

// --- Simple in-memory cache (60s) to reduce latency and rate-limit pressure ---
// Keyed by full urlPath string (including querystring).
const _ploomesCache = new Map();
function cacheGet(key, ttlMs = 60 * 1000) {
  const hit = _ploomesCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > ttlMs) {
    _ploomesCache.delete(key);
    return null;
  }
  return hit.v;
}
const PLOOMES_CACHE_MAX = 500;
function cacheSet(key, value) {
  if (_ploomesCache.size >= PLOOMES_CACHE_MAX) {
    _ploomesCache.delete(_ploomesCache.keys().next().value);
  }
  _ploomesCache.set(key, { t: Date.now(), v: value });
}

function endpointNeedsDateFilter(urlPath) {
  return /^(\/(Deals|Tasks|InteractionRecords))(\?|$)/i.test(urlPath);
}

// Campos que causam 403 na API Ploomes quando usados em /Deals $select
const DEALS_FORBIDDEN_FIELDS_GLOBAL = ['Name', 'Subject', 'Description', 'StageName', 'ReasonId'];
function sanitizeDealSelectGlobal(url) {
  if (!/\/Deals/i.test(url)) return url;
  try {
    const u = new URL('https://dummy.local' + url);
    const sel = u.searchParams.get('$select');
    if (!sel) return url;
    const fields = sel.split(',').map(f => f.trim()).filter(f => !DEALS_FORBIDDEN_FIELDS_GLOBAL.includes(f));
    u.searchParams.set('$select', fields.join(','));
    const sanitized = u.pathname + (u.search || '');
    if (sanitized !== url) console.log(`[sanitize] Removed forbidden Deals fields: ${url}`);
    return sanitized;
  } catch { return url; }
}

function hasMandatoryDateFilter(urlPath) {
  try {
    const u = new URL('https://dummy.local' + urlPath);
    const filter = (u.searchParams.get('$filter') || '').toLowerCase();
    if (!filter) return false;
    if (/^\/deals/i.test(urlPath)) {
      // Pipeline snapshot (StatusId eq 1) não precisa de filtro de data — é consulta de estado atual
      if (filter.includes('statusid eq 1') || filter.includes('statusid%20eq%201')) return true;
      return filter.includes('finishdate') || filter.includes('lastupdatedate');
    }
    if (/^\/tasks/i.test(urlPath)) return filter.includes('datetime') || filter.includes('finishdate');
    if (/^\/interactionrecords/i.test(urlPath)) return filter.includes('date');
    return true;
  } catch {
    return false;
  }
}

function enforceDateFilterOrThrow(urlPath) {
  if (endpointNeedsDateFilter(urlPath) && !hasMandatoryDateFilter(urlPath)) {
    const ep = urlPath.split('?')[0];
    throw new Error(`Filtro de data obrigatório para ${ep}. Inclua $filter com Date/DateTime/FinishDate (ou LastUpdateDate no caso de Deals).`);
  }
}

function upsertQueryParam(urlPath, key, value) {
  const u = new URL('https://dummy.local' + urlPath);
  u.searchParams.set(key, value);
  return u.pathname + (u.search ? u.search : '');
}

async function ploomesGetOnceCached(urlPath) {
  const cached = cacheGet(urlPath);
  if (cached) return cached;
  const val = await ploomesGetOnce(urlPath);
  cacheSet(urlPath, val);
  return val;
}

// Fetch strategy for the LLM:
// - Return sample (<=20) and totalCount (via $count=true)
// - For Deals, also compute sum(Amount) when feasible (client-side sum on Amount only)
async function ploomesFetchForModel(urlPath) {
  // Esta função busca dados da Ploomes e calcula agregados úteis para o modelo
  enforceDateFilterOrThrow(urlPath);

  // Excluir usuários fora de análise (ex.: dono) quando for Deals
  // IMPORTANTE: deve ser aplicado ANTES do fetch para garantir exclusão no sample, totalCount e sumAmount
  if (/^\/deals/i.test(urlPath) && Array.isArray(EXCLUDED_FROM_ANALYSIS) && EXCLUDED_FROM_ANALYSIS.length) {
    try {
      const u0 = new URL('https://dummy.local' + urlPath);
      const f0 = u0.searchParams.get('$filter') || '';
      const excl = EXCLUDED_FROM_ANALYSIS.map(id => `OwnerId ne ${id}`).join(' and ');
      if (!f0.toLowerCase().includes('ownerid ne')) {
        const newFilter = f0 ? `(${f0}) and (${excl})` : excl;
        u0.searchParams.set('$filter', newFilter);
        urlPath = u0.pathname + '?' + u0.searchParams.toString();
      }
    } catch {}
  }

  // Excluir funis inativos/arquivados de qualquer fetch de Deals
  if (/^\/deals/i.test(urlPath) && Array.isArray(INACTIVE_PIPELINE_IDS) && INACTIVE_PIPELINE_IDS.length) {
    try {
      const u1 = new URL('https://dummy.local' + urlPath);
      const f1 = u1.searchParams.get('$filter') || '';
      const pipeExcl = INACTIVE_PIPELINE_IDS.map(id => `PipelineId ne ${id}`).join(' and ');
      const alreadyHasFilter = INACTIVE_PIPELINE_IDS.some(id => f1.includes(`PipelineId ne ${id}`));
      if (!alreadyHasFilter) {
        const newFilter = f1 ? `(${f1}) and (${pipeExcl})` : pipeExcl;
        u1.searchParams.set('$filter', newFilter);
        urlPath = u1.pathname + '?' + u1.searchParams.toString();
      }
    } catch {}
  }

  // Lightweight sample + count
  let sampleUrl = urlPath;
  sampleUrl = upsertQueryParam(sampleUrl, '$top', '20');
  sampleUrl = upsertQueryParam(sampleUrl, '$skip', '0');
  sampleUrl = upsertQueryParam(sampleUrl, '$count', 'true');

  const page = await ploomesGetOnceCached(sampleUrl);
  const sample = page.value || [];
  const totalCount = (typeof page['@odata.count'] === 'number') ? page['@odata.count'] : sample.length;

  const aggregates = { count: totalCount };

  // Deals sum(Amount)
  if (/^\/deals/i.test(urlPath)) {
    if (totalCount <= 5000) {
      const u = new URL('https://dummy.local' + urlPath);
      const filter = u.searchParams.get('$filter');
      let sumUrl = '/Deals?';
      if (filter) sumUrl += `$filter=${encodeURIComponent(filter)}&`;
      sumUrl += `$select=Amount`;

      const cacheKey = sumUrl + '::__SUM_AMOUNT__';
      const cachedSum = cacheGet(cacheKey);
      if (cachedSum != null) {
        aggregates.sumAmount = cachedSum;
      } else {
        const recs = await ploomesGetAll(sumUrl, 100000); // safety cap
        const sum = (recs || []).reduce((acc, r) => acc + (Number(r.Amount) || 0), 0);
        aggregates.sumAmount = sum;
        cacheSet(cacheKey, sum);
      }
    } else {
      aggregates.sumAmount = null;
      aggregates.sumAmountNote = 'sum(Amount) omitida por volume alto; refine o filtro.';
    }
  }

  return { total: totalCount, sample, aggregates };
}

// For InteractionRecords: fetch all records (up to 2000) and compute per-creator counts
async function ploomesGetInteractionAggregates(urlPath) {
  try {
    const u = new URL('https://dummy.local' + urlPath);
    const filter = u.searchParams.get('$filter') || '';
    let allUrl = '/InteractionRecords?';
    if (filter) allUrl += `$filter=${encodeURIComponent(filter)}&`;
    allUrl += '$select=CreatorId,TypeId';
    const recs = await ploomesGetAll(allUrl, 2000);
    const byCreator = {};
    for (const r of (recs || [])) {
      const cid = r.CreatorId;
      if (!cid) continue;
      byCreator[cid] = (byCreator[cid] || 0) + 1;
    }
    return { byCreator, totalProcessed: (recs || []).length };
  } catch(e) {
    return { error: e.message };
  }
}

// Agrega Tasks por OwnerId: count total por owner (resolve nomes via userNameById)
async function ploomesGetTasksOwnerAggregates(urlPath, userNameById) {
  try {
    const u = new URL('https://dummy.local' + urlPath);
    const filter = u.searchParams.get('$filter') || '';
    // Excluir PV
    const pvExcl = EXCLUDED_FROM_ANALYSIS.map(id => `OwnerId ne ${id}`).join(' and ');
    const alreadyHasPV = EXCLUDED_FROM_ANALYSIS.some(id => filter.includes(`OwnerId ne ${id}`));
    const finalFilter = (!alreadyHasPV && pvExcl) ? (filter ? `(${filter}) and (${pvExcl})` : pvExcl) : filter;
    let allUrl = '/Tasks?';
    if (finalFilter) allUrl += `$filter=${encodeURIComponent(finalFilter)}&`;
    allUrl += '$select=OwnerId';
    const recs = await ploomesGetAll(allUrl, 5000);
    const byOwner = {};
    for (const r of (recs || [])) {
      const oid = r.OwnerId;
      if (!oid) continue;
      if (!byOwner[oid]) byOwner[oid] = { name: (userNameById && userNameById[oid]) || `ID:${oid}`, count: 0 };
      byOwner[oid].count++;
    }
    const ranked = Object.values(byOwner).sort((a,b) => b.count - a.count);
    return { byOwnerCount: ranked, totalProcessed: recs.length };
  } catch(e) {
    return { error: e.message };
  }
}

// Agrega deals perdidos por LossReasonId — segmentado por funil (resolve nomes via dicionário)
async function ploomesGetLossReasonAggregates(urlPath, lossReasonById, pipelineById) {
  try {
    const u = new URL('https://dummy.local' + urlPath);
    let filter = u.searchParams.get('$filter') || '';
    // Garantir que funis arquivados estão excluídos (mesmo que ploomesFetchForModel já tenha injetado)
    const pipeExcl = INACTIVE_PIPELINE_IDS.map(id => `PipelineId ne ${id}`).join(' and ');
    const alreadyHasPipeFilter = INACTIVE_PIPELINE_IDS.some(id => filter.includes(`PipelineId ne ${id}`));
    if (!alreadyHasPipeFilter && pipeExcl) {
      filter = filter ? `(${filter}) and (${pipeExcl})` : pipeExcl;
    }
    let allUrl = '/Deals?';
    if (filter) allUrl += `$filter=${encodeURIComponent(filter)}&`;
    allUrl += '$select=LossReasonId,OwnerId,PipelineId';
    const recs = await ploomesGetAll(allUrl, 5000);

    // Agrupamento global (APENAS para referência, não usar como percentual final)
    const byReason = {};
    // Agrupamento por funil → motivo
    const byPipeline = {};
    // Agrupamento por owner
    const byOwnerReason = {};

    for (const r of (recs || [])) {
      const rid = r.LossReasonId;
      const rname = (lossReasonById && lossReasonById[rid]) || `ID:${rid}`;
      const pid = r.PipelineId;
      const pname = (pipelineById && pipelineById[pid]) || `Funil ${pid}`;
      byReason[rname] = (byReason[rname] || 0) + 1;
      // Por funil
      if (!byPipeline[pname]) byPipeline[pname] = {};
      byPipeline[pname][rname] = (byPipeline[pname][rname] || 0) + 1;
      // Por owner
      const oid = r.OwnerId;
      if (oid) {
        if (!byOwnerReason[oid]) byOwnerReason[oid] = {};
        byOwnerReason[oid][rname] = (byOwnerReason[oid][rname] || 0) + 1;
      }
    }

    const total = recs.length;
    const byReasonPct = Object.entries(byReason)
      .sort((a,b) => b[1]-a[1])
      .map(([name,cnt]) => ({ motivo: name, count: cnt, pct: total > 0 ? +(cnt/total*100).toFixed(1) : 0 }));

    // Converter byPipeline para formato com percentuais
    const byPipelineBreakdown = {};
    for (const [pname, reasons] of Object.entries(byPipeline)) {
      const pTotal = Object.values(reasons).reduce((a,b) => a+b, 0);
      byPipelineBreakdown[pname] = Object.entries(reasons)
        .sort((a,b) => b[1]-a[1])
        .map(([motivo, cnt]) => ({ motivo, count: cnt, pct: +(cnt/pTotal*100).toFixed(1) }));
    }

    return { byReason: byReasonPct, byPipeline: byPipelineBreakdown, byOwnerReason, totalProcessed: total };
  } catch(e) {
    return { error: e.message };
  }
}

// Helper: calcula mediana de um array numérico
function calcMedian(arr) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Agrega deals (ganhos ou abertos) por OwnerId: count e sum(Amount)
// Também calcula: taxa de conversão individual por owner, ciclo médio, ticket mediana, por funil
async function ploomesGetDealsOwnerAggregates(urlPath, userNameById) {
  try {
    const u = new URL('https://dummy.local' + urlPath);
    let filter = u.searchParams.get('$filter') || '';
    // Garantir exclusão de funis arquivados
    const pipeExcl = INACTIVE_PIPELINE_IDS.map(id => `PipelineId ne ${id}`).join(' and ');
    const alreadyHasPipe = INACTIVE_PIPELINE_IDS.some(id => filter.includes(`PipelineId ne ${id}`));
    if (!alreadyHasPipe && pipeExcl) filter = filter ? `(${filter}) and (${pipeExcl})` : pipeExcl;
    let allUrl = '/Deals?';
    if (filter) allUrl += `$filter=${encodeURIComponent(filter)}&`;
    allUrl += '$select=OwnerId,Amount,StatusId,PipelineId,FinishDate,CreateDate';
    const recs = await ploomesGetAll(allUrl, 5000);
    const byOwner = {};
    const byPipeline = {};
    const allAmountsWon = [];
    const inconsistencias = [];

    for (const r of (recs || [])) {
      const oid = r.OwnerId;
      if (!oid) continue;
      if (!byOwner[oid]) byOwner[oid] = { name: (userNameById && userNameById[oid]) || `ID:${oid}`, count: 0, totalAmount: 0, won: 0, lost: 0, amounts: [], ciclos: [] };
      byOwner[oid].count++;
      byOwner[oid].totalAmount += (Number(r.Amount) || 0);
      if (r.StatusId === 2) {
        byOwner[oid].won++;
        if (r.Amount && r.Amount > 0) byOwner[oid].amounts.push(Number(r.Amount));
        // Ciclo de venda
        if (r.FinishDate && r.CreateDate) {
          try {
            const fd = new Date(r.FinishDate), cd = new Date(r.CreateDate);
            const days = Math.round((fd - cd) / (1000 * 86400));
            if (days >= 0) byOwner[oid].ciclos.push(days);
          } catch {}
        }
        allAmountsWon.push(Number(r.Amount) || 0);
      }
      if (r.StatusId === 3) byOwner[oid].lost++;

      // Por funil
      const pid = r.PipelineId;
      if (pid) {
        if (!byPipeline[pid]) byPipeline[pid] = { count: 0, won: 0, lost: 0, amounts: [], ciclos: [] };
        byPipeline[pid].count++;
        if (r.StatusId === 2) {
          byPipeline[pid].won++;
          if (r.Amount && r.Amount > 0) byPipeline[pid].amounts.push(Number(r.Amount));
          if (r.FinishDate && r.CreateDate) {
            try {
              const fd = new Date(r.FinishDate), cd = new Date(r.CreateDate);
              const days = Math.round((fd - cd) / (1000 * 86400));
              if (days >= 0) byPipeline[pid].ciclos.push(days);
            } catch {}
          }
        }
        if (r.StatusId === 3) byPipeline[pid].lost++;
      }

      // Inconsistências: ganho com valor=0
      if (r.StatusId === 2 && (!r.Amount || r.Amount === 0)) {
        inconsistencias.push({ tipo: 'ganho_sem_valor', pipelineId: pid, ownerId: oid });
      }
    }

    // Calcular taxa de conversão e métricas por owner
    const ranked = Object.entries(byOwner).map(([oid, d]) => {
      const total = d.won + d.lost;
      const winRate = total > 0 ? +(d.won / total * 100).toFixed(1) : null;
      const ticketMedia = d.amounts.length > 0 ? +(d.amounts.reduce((a, b) => a + b, 0) / d.amounts.length).toFixed(0) : 0;
      const ticketMediana = calcMedian(d.amounts) != null ? +calcMedian(d.amounts).toFixed(0) : 0;
      const cicloMedio = d.ciclos.length > 0 ? +(d.ciclos.reduce((a, b) => a + b, 0) / d.ciclos.length).toFixed(0) : null;
      return { ...d, ownerId: Number(oid), winRate, ticketMedia, ticketMediana, cicloMedio, amounts: undefined, ciclos: undefined };
    }).sort((a, b) => b.totalAmount - a.totalAmount);

    // Métricas por funil com ciclo, ticket média/mediana, win rate
    const pipelineMetrics = {};
    for (const [pid, pd] of Object.entries(byPipeline)) {
      const total = pd.won + pd.lost;
      const winRate = total > 0 ? +(pd.won / total * 100).toFixed(1) : null;
      const ticketMedia = pd.amounts.length > 0 ? +(pd.amounts.reduce((a, b) => a + b, 0) / pd.amounts.length).toFixed(0) : 0;
      const ticketMediana = calcMedian(pd.amounts) != null ? +calcMedian(pd.amounts).toFixed(0) : 0;
      const cicloMedio = pd.ciclos.length > 0 ? +(pd.ciclos.reduce((a, b) => a + b, 0) / pd.ciclos.length).toFixed(0) : null;
      // Pipeline Velocity = won * ticket_médio / ciclo_médio  (fórmula correta: won já incorpora o win rate)
      let pipelineVelocity = null;
      if (pd.won > 0 && ticketMedia > 0 && cicloMedio != null && cicloMedio > 0) {
        pipelineVelocity = +((pd.won * ticketMedia) / cicloMedio).toFixed(0);
      }
      pipelineMetrics[pid] = { won: pd.won, lost: pd.lost, winRate, ticketMedia, ticketMediana, cicloMedio, dealCount: pd.count, pipelineVelocity };
    }

    // Mediana geral de ticket (ganhos)
    const globalMedianTicket = calcMedian(allAmountsWon) != null ? +calcMedian(allAmountsWon).toFixed(0) : 0;
    const globalAvgTicket = allAmountsWon.length > 0 ? +(allAmountsWon.reduce((a, b) => a + b, 0) / allAmountsWon.length).toFixed(0) : 0;

    return {
      byOwnerAmount: ranked,
      pipelineMetrics,
      globalTicketMedia: globalAvgTicket,
      globalTicketMediana: globalMedianTicket,
      inconsistencias: inconsistencias.slice(0, 20),
      totalProcessed: recs.length
    };
  } catch(e) {
    return { error: e.message };
  }
}


// ─── DIAGNÓSTICO DE QUALIDADE DE DADOS DO CRM ──────────────────────────────
// Calcula métricas de qualidade: deals sem motivo, sem valor, abandonados, etc.

// ─── Warehouse helpers for indicators ─────────────────────────────────────
function getWarehouseDictionary() {
  const wdb = getWarehouseDb();
  if (!wdb) return null;
  try {
    const userById = Object.fromEntries(wdb.prepare('SELECT id, name FROM ploomes_users').all().map(r => [r.id, r.name]));
    const pipelineById = Object.fromEntries(wdb.prepare('SELECT id, name FROM pipelines').all().map(r => [r.id, r.name]));
    const lossReasonById = Object.fromEntries(wdb.prepare('SELECT id, name FROM loss_reasons').all().map(r => [r.id, r.name]));
    return { userById, pipelineById, lossReasonById };
  } catch {
    return null;
  }
}

function computeMedian(values) {
  const v = (values || []).filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 0 ? (v[mid - 1] + v[mid]) / 2 : v[mid];
}

function computeSalesIndicatorsWarehouse(ploomesIds, periodDays) {
  const wdb = getWarehouseDb();
  const dict = getWarehouseDictionary();
  if (!wdb || !dict) return { error: 'warehouse indisponível' };

  periodDays = periodDays || 30;
  const now = new Date();
  const nowMs = now.getTime();
  const dateCutoff = new Date(nowMs - periodDays * 24 * 60 * 60 * 1000).toISOString();

  // Prefer warehouse when fresh; kick sync in background if stale.
  try {
    if (!isWarehouseFresh()) {
      kickWarehouseSyncBackground('computeSalesIndicators');
    }
  } catch (e) {
    console.warn('[warehouse] computeSalesIndicators fallback to API:', e.message);
  }

  const ownerFilterSql = (ploomesIds && ploomesIds.length)
    ? ` AND owner_id IN (${ploomesIds.map(() => '?').join(',')})`
    : '';
  const ownerParams = (ploomesIds && ploomesIds.length) ? ploomesIds.map(Number) : [];

  const wonDeals = wdb.prepare(
    `SELECT owner_id as OwnerId, pipeline_id as PipelineId, amount as Amount\n` +
    `FROM deals WHERE status_id = 2 AND finish_date >= ? ${ownerFilterSql}`
  ).all(dateCutoff, ...ownerParams);

  const lostDeals = wdb.prepare(
    `SELECT owner_id as OwnerId, pipeline_id as PipelineId, amount as Amount, loss_reason_id as LossReasonId\n` +
    `FROM deals WHERE status_id = 3 AND finish_date >= ? ${ownerFilterSql}`
  ).all(dateCutoff, ...ownerParams);

  const openDeals = wdb.prepare(
    `SELECT owner_id as OwnerId, pipeline_id as PipelineId, amount as Amount, last_update_date as LastUpdateDate\n` +
    `FROM deals WHERE status_id = 1 ${ownerFilterSql}`
  ).all(...ownerParams);

  const interactions = wdb.prepare(
    `SELECT creator_id as CreatorId FROM interactions WHERE date >= ? ` +
    ((ploomesIds && ploomesIds.length) ? ` AND creator_id IN (${ploomesIds.map(() => '?').join(',')})` : '')
  ).all(dateCutoff, ...ownerParams);

  // Conversion by pipeline
  const convByPipe = {};
  for (const d of wonDeals) {
    const ctx = getPipelineContext(d.PipelineId);
    if (!ctx.includeInConversion) continue;
    const pid = d.PipelineId;
    if (!convByPipe[pid]) convByPipe[pid] = { name: dict.pipelineById[pid] || `Pipeline ${pid}`, won: 0, lost: 0 };
    convByPipe[pid].won++;
  }
  for (const d of lostDeals) {
    const ctx = getPipelineContext(d.PipelineId);
    if (!ctx.includeInConversion) continue;
    const pid = d.PipelineId;
    if (!convByPipe[pid]) convByPipe[pid] = { name: dict.pipelineById[pid] || `Pipeline ${pid}`, won: 0, lost: 0 };
    convByPipe[pid].lost++;
  }
  for (const pid of Object.keys(convByPipe)) {
    const v = convByPipe[pid];
    const total = v.won + v.lost;
    v.winRate = total > 0 ? (v.won / total * 100).toFixed(2) + '%' : 'N/A';
  }

  // Ticket by pipeline (won deals only)
  const ticketTemp = {};
  for (const d of wonDeals) {
    const ctx = getPipelineContext(d.PipelineId);
    if (!ctx.includeInRevenue) continue;
    const pid = d.PipelineId;
    if (!ticketTemp[pid]) ticketTemp[pid] = { name: dict.pipelineById[pid] || `Pipeline ${pid}`, values: [] };
    ticketTemp[pid].values.push(Number(d.Amount) || 0);
  }
  const ticketByPipeline = {};
  for (const [pid, t] of Object.entries(ticketTemp)) {
    const vals = t.values.filter(v => v > 0).sort((a, b) => a - b);
    const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    const median = computeMedian(vals);
    ticketByPipeline[pid] = { name: t.name, mean: +mean.toFixed(2), median: +median.toFixed(2), count: t.values.length };
  }

  // Abandoned deals by owner (open >90d)
  const abandonedByOwner = {};
  for (const d of openDeals) {
    if (!d.OwnerId) continue;
    const lastUpdate = d.LastUpdateDate ? new Date(d.LastUpdateDate) : null;
    const daysStale = lastUpdate ? Math.floor((nowMs - lastUpdate.getTime()) / (1000*60*60*24)) : 9999;
    if (daysStale <= 90) continue;
    const oid = d.OwnerId;
    if (!abandonedByOwner[oid]) abandonedByOwner[oid] = { name: dict.userById[oid] || `Owner ${oid}`, count: 0, valueAtRisk: 0, maxDays: 0 };
    abandonedByOwner[oid].count++;
    abandonedByOwner[oid].valueAtRisk += Number(d.Amount) || 0;
    if (daysStale > abandonedByOwner[oid].maxDays) abandonedByOwner[oid].maxDays = daysStale;
  }
  for (const v of Object.values(abandonedByOwner)) {
    v.worst = v.maxDays + ' dias';
    v.valueAtRisk = +v.valueAtRisk.toFixed(2);
  }

  // Fill rate by owner
  const fillRateByOwner = {};
  for (const d of lostDeals) {
    if (!d.OwnerId) continue;
    const oid = d.OwnerId;
    if (!fillRateByOwner[oid]) fillRateByOwner[oid] = { name: dict.userById[oid] || `Owner ${oid}`, lossWithReason: 0, lossTotal: 0 };
    fillRateByOwner[oid].lossTotal++;
    if (d.LossReasonId) fillRateByOwner[oid].lossWithReason++;
  }
  for (const v of Object.values(fillRateByOwner)) {
    v.pct = v.lossTotal > 0 ? (v.lossWithReason / v.lossTotal * 100).toFixed(0) + '%' : 'N/A';
  }

  // Interactions by owner
  const interactionsByOwner = {};
  for (const i of interactions) {
    const oid = i.CreatorId;
    if (!oid) continue;
    if (EXCLUDED_FROM_ANALYSIS.includes(oid)) continue;
    if (!interactionsByOwner[oid]) interactionsByOwner[oid] = { name: dict.userById[oid] || `Owner ${oid}`, count: 0 };
    interactionsByOwner[oid].count++;
  }

  // Hygiene scores
  const hygieneScores = {};
  try {
    const last = getWarehouseLastRun();
    if (last && last.ok) {
      const rows = wdb.prepare('SELECT owner_id, score FROM mv_hygiene WHERE run_id = ?').all(last.id);
      for (const r of rows) {
        const score = Number(r.score) || 0;
        hygieneScores[r.owner_id] = {
          name: dict.userById[r.owner_id] || `Owner ${r.owner_id}`,
          score,
          badge: score >= 80 ? '🟢' : score >= 60 ? '🟡' : '🔴'
        };
      }
    }
  } catch {}

  const dataQualityAlerts = [];
  const wonNoValue = wonDeals.filter(d => !d.Amount || d.Amount === 0).length;
  if (wonNoValue > 0) dataQualityAlerts.push(`${wonNoValue} deals ganhos com Amount=0 — ticket médio comprometido`);
  const openNoValue = openDeals.filter(d => !d.Amount || d.Amount === 0).length;
  const pctOpenNoValue = openDeals.length > 0 ? (openNoValue / openDeals.length * 100).toFixed(0) : 0;
  if (pctOpenNoValue > 10) dataQualityAlerts.push(`${pctOpenNoValue}% do pipeline em aberto sem valor`);

  const prospWon = wonDeals.filter(d => PIPELINE_CATEGORIES.PROSPECCAO.includes(d.PipelineId));
  if (prospWon.length > 0) dataQualityAlerts.push(`Funil Prospecção: ${prospWon.length} ganhos históricos (ignorados nas análises de conversão e receita)`);
  const carteiraLost = lostDeals.filter(d => PIPELINE_CATEGORIES.CARTEIRA.includes(d.PipelineId));
  if (carteiraLost.length > 0) {
    dataQualityAlerts.push(`Funil Manutenção da Carteira: ${carteiraLost.length} perdas — motivo "Não Possui Necessidade" é esperado por design, não é anomalia`);
  }

  return {
    period: periodDays,
    conversionByPipeline: convByPipe,
    ticketByPipeline,
    abandonedByOwner,
    fillRateByOwner,
    interactionsByOwner,
    hygieneScores,
    dataQualityAlerts,
    source: 'warehouse'
  };
}

function computeCrmHealthWarehouse() {
  const wdb = getWarehouseDb();
  const dict = getWarehouseDictionary();
  if (!wdb || !dict) return { error: 'warehouse indisponível' };
  const last = getWarehouseLastRun();
  if (!last || !last.ok) return { error: 'warehouse sem run OK' };

  const vendorsRaw = wdb.prepare('SELECT owner_id, score, abandoned_90d, open_no_amount, lost_no_reason_pct FROM mv_hygiene WHERE run_id = ?').all(last.id);
  const vendors = vendorsRaw.map(r => ({
    ownerId: r.owner_id,
    ownerName: dict.userById[r.owner_id] || `Owner ${r.owner_id}`,
    hygieneScore: Number(r.score) || 0,
    abandoned90: Number(r.abandoned_90d) || 0,
    openNoAmount: Number(r.open_no_amount) || 0,
    pctLostNoReason: r.lost_no_reason_pct == null ? null : +(Number(r.lost_no_reason_pct) * 100).toFixed(1),
  })).sort((a, b) => a.hygieneScore - b.hygieneScore);

  const totalOpenDeals = wdb.prepare(`
    SELECT COUNT(*) as c FROM deals
    WHERE status_id = 1
      AND (owner_id IS NULL OR owner_id NOT IN (${EXCLUDED_FROM_ANALYSIS.join(',')}))
      AND (pipeline_id IS NULL OR pipeline_id NOT IN (${INACTIVE_PIPELINE_IDS.join(',')}))
  `).get().c;

  const nowIso = new Date().toISOString();
  const totalAbandonedDeals = wdb.prepare(`
    SELECT COUNT(*) as c FROM deals
    WHERE status_id = 1
      AND (last_update_date IS NULL OR (julianday(?) - julianday(last_update_date)) > 90)
      AND (owner_id IS NULL OR owner_id NOT IN (${EXCLUDED_FROM_ANALYSIS.join(',')}))
      AND (pipeline_id IS NULL OR pipeline_id NOT IN (${INACTIVE_PIPELINE_IDS.join(',')}))
  `).get(nowIso).c;

  const date180 = new Date(Date.now() - 180*24*60*60*1000).toISOString();
  const lostDeals180 = wdb.prepare(`
    SELECT pipeline_id as PipelineId, loss_reason_id as LossReasonId
    FROM deals
    WHERE status_id = 3
      AND finish_date >= ?
      AND (owner_id IS NULL OR owner_id NOT IN (${EXCLUDED_FROM_ANALYSIS.join(',')}))
      AND (pipeline_id IS NULL OR pipeline_id NOT IN (${INACTIVE_PIPELINE_IDS.join(',')}))
  `).all(date180);

  const lostDeals180ForStats = [];
  for (const d of lostDeals180) {
    const ctx = getPipelineContext(d.PipelineId);
    if (ctx.category === 'CARTEIRA' || ctx.category === 'PROSPECCAO') continue;
    lostDeals180ForStats.push(d);
  }
  const totalLostDeals180d = lostDeals180ForStats.length;
  const totalLostNoReason = lostDeals180ForStats.filter(d => !d.LossReasonId).length;
  const pctLostNoReason = totalLostDeals180d > 0 ? +(totalLostNoReason / totalLostDeals180d * 100).toFixed(1) : 0;

  return {
    timestamp: new Date().toISOString(),
    cachedAt: Date.now(),
    summary: {
      totalOpenDeals,
      totalAbandonedDeals,
      totalLostDeals180d,
      totalLostNoReason,
      pctLostNoReason,
    },
    vendors,
    source: 'warehouse'
  };
}

// ─── computeSalesIndicators ─────────────────────────────────────────────────
// Calcula todos os indicadores de vendas no servidor, sem depender do LLM calcular.
async function computeSalesIndicators(ploomesIds, periodDays) {
  periodDays = periodDays || 30;
  const now = new Date();
  const nowMs = now.getTime();
  const dateCutoff = new Date(nowMs - periodDays * 24 * 60 * 60 * 1000).toISOString();

  // Prefer warehouse when fresh; kick sync in background if stale.
  try {
    if (isWarehouseFresh()) {
      const wh = computeSalesIndicatorsWarehouse(ploomesIds, periodDays);
      if (wh && !wh.error) return wh;
    } else {
      kickWarehouseSyncBackground('computeSalesIndicators');
    }
  } catch (e) {
    console.warn('[warehouse] computeSalesIndicators fallback to API:', e.message);
  }

  try {
    const dict = await loadDictionary();
    const pipeExcl = INACTIVE_PIPELINE_IDS.map(id => `PipelineId ne ${id}`).join(' and ');
    const pvExcl = EXCLUDED_FROM_ANALYSIS.map(id => `OwnerId ne ${id}`).join(' and ');
    let baseExcl = `(${pipeExcl}) and (${pvExcl})`;
    if (ploomesIds && ploomesIds.length > 0) {
      const ownerFilter = ploomesIds.map(id => `OwnerId eq ${id}`).join(' or ');
      baseExcl += ` and (${ownerFilter})`;
    }

    // Fetch won + lost deals in period (sales funnels only)
    const [wonDeals, lostDeals, openDeals, interactions] = await Promise.all([
      ploomesGetAll(`/Deals?$filter=StatusId eq 2 and FinishDate ge ${dateCutoff} and ${baseExcl}&$select=Id,OwnerId,PipelineId,Amount,FinishDate,CreateDate`, 5000),
      ploomesGetAll(`/Deals?$filter=StatusId eq 3 and FinishDate ge ${dateCutoff} and ${baseExcl}&$select=Id,OwnerId,PipelineId,Amount,LossReasonId,FinishDate`, 5000),
      ploomesGetAll(`/Deals?$filter=StatusId eq 1 and ${baseExcl}&$select=Id,OwnerId,PipelineId,Amount,LastUpdateDate,StageId`, 5000),
      ploomesGetAll(`/InteractionRecords?$filter=Date ge ${dateCutoff}&$select=Id,CreatorId,TypeId,Date`, 3000)
    ]);

    // Conversion by pipeline (only SALES funnels)
    const conversionByPipeline = {};
    for (const d of [...wonDeals, ...lostDeals]) {
      const ctx = getPipelineContext(d.PipelineId);
      if (!ctx.includeInConversion) continue;
      if (!conversionByPipeline[d.PipelineId]) {
        conversionByPipeline[d.PipelineId] = { name: dict.pipelineById[d.PipelineId] || `Pipeline ${d.PipelineId}`, won: 0, lost: 0 };
      }
      if (d.StatusId === 2 || wonDeals.includes(d)) conversionByPipeline[d.PipelineId].won++;
      else conversionByPipeline[d.PipelineId].lost++;
    }
    // Fix: separate won/lost properly
    const convByPipe = {};
    for (const d of wonDeals) {
      const ctx = getPipelineContext(d.PipelineId);
      if (!ctx.includeInConversion) continue;
      if (!convByPipe[d.PipelineId]) convByPipe[d.PipelineId] = { name: dict.pipelineById[d.PipelineId] || `Pipeline ${d.PipelineId}`, won: 0, lost: 0 };
      convByPipe[d.PipelineId].won++;
    }
    for (const d of lostDeals) {
      const ctx = getPipelineContext(d.PipelineId);
      if (!ctx.includeInConversion) continue;
      if (!convByPipe[d.PipelineId]) convByPipe[d.PipelineId] = { name: dict.pipelineById[d.PipelineId] || `Pipeline ${d.PipelineId}`, won: 0, lost: 0 };
      convByPipe[d.PipelineId].lost++;
    }
    for (const [pid, v] of Object.entries(convByPipe)) {
      const total = v.won + v.lost;
      v.winRate = total > 0 ? (v.won / total * 100).toFixed(2) + '%' : 'N/A';
    }

    // Ticket by pipeline (won deals only)
    const ticketByPipeline = {};
    const ticketTemp = {};
    for (const d of wonDeals) {
      const ctx = getPipelineContext(d.PipelineId);
      if (!ctx.includeInRevenue) continue;
      if (!ticketTemp[d.PipelineId]) ticketTemp[d.PipelineId] = { name: dict.pipelineById[d.PipelineId] || `Pipeline ${d.PipelineId}`, values: [] };
      ticketTemp[d.PipelineId].values.push(Number(d.Amount) || 0);
    }
    for (const [pid, t] of Object.entries(ticketTemp)) {
      const vals = t.values.filter(v => v > 0).sort((a, b) => a - b);
      const mean = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      const mid = Math.floor(vals.length / 2);
      const median = vals.length > 0 ? (vals.length % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid]) : 0;
      ticketByPipeline[pid] = { name: t.name, mean: +mean.toFixed(2), median: +median.toFixed(2), count: t.values.length };
    }

    // Abandoned deals by owner (open >90d)
    const abandonedByOwner = {};
    for (const d of openDeals) {
      if (!d.OwnerId) continue;
      const lastUpdate = d.LastUpdateDate ? new Date(d.LastUpdateDate) : null;
      const daysStale = lastUpdate ? Math.floor((nowMs - lastUpdate.getTime()) / (1000*60*60*24)) : 9999;
      if (daysStale <= 90) continue;
      const oid = d.OwnerId;
      if (!abandonedByOwner[oid]) abandonedByOwner[oid] = { name: dict.userById[oid] || `Owner ${oid}`, count: 0, valueAtRisk: 0, maxDays: 0 };
      abandonedByOwner[oid].count++;
      abandonedByOwner[oid].valueAtRisk += Number(d.Amount) || 0;
      if (daysStale > abandonedByOwner[oid].maxDays) abandonedByOwner[oid].maxDays = daysStale;
    }
    for (const v of Object.values(abandonedByOwner)) {
      v.worst = v.maxDays + ' dias';
      v.valueAtRisk = +v.valueAtRisk.toFixed(2);
    }

    // Fill rate by owner (% lost deals with reason)
    const fillRateByOwner = {};
    for (const d of lostDeals) {
      if (!d.OwnerId) continue;
      const oid = d.OwnerId;
      if (!fillRateByOwner[oid]) fillRateByOwner[oid] = { name: dict.userById[oid] || `Owner ${oid}`, lossWithReason: 0, lossTotal: 0 };
      fillRateByOwner[oid].lossTotal++;
      if (d.LossReasonId) fillRateByOwner[oid].lossWithReason++;
    }
    for (const v of Object.values(fillRateByOwner)) {
      v.pct = v.lossTotal > 0 ? (v.lossWithReason / v.lossTotal * 100).toFixed(0) + '%' : 'N/A';
    }

    // Interactions by owner
    const interactionsByOwner = {};
    for (const i of interactions) {
      const oid = i.CreatorId;
      if (!oid) continue;
      if (EXCLUDED_FROM_ANALYSIS.includes(oid)) continue;
      if (!interactionsByOwner[oid]) interactionsByOwner[oid] = { name: dict.userById[oid] || `Owner ${oid}`, count: 0 };
      interactionsByOwner[oid].count++;
    }

    // Hygiene scores (from computeCrmHealth)
    const hygieneScores = {};
    try {
      const health = await computeCrmHealth();
      if (!health.error && health.vendors) {
        for (const v of health.vendors) {
          hygieneScores[v.ownerId] = { name: v.ownerName, score: v.hygieneScore,
            badge: v.hygieneScore >= 80 ? '🟢' : v.hygieneScore >= 60 ? '🟡' : '🔴' };
        }
      }
    } catch {}

    // Data quality alerts
    const dataQualityAlerts = [];
    const wonNoValue = wonDeals.filter(d => !d.Amount || d.Amount === 0).length;
    if (wonNoValue > 0) dataQualityAlerts.push(`${wonNoValue} deals ganhos com Amount=0 — ticket médio comprometido`);
    const openNoValue = openDeals.filter(d => !d.Amount || d.Amount === 0).length;
    const pctOpenNoValue = openDeals.length > 0 ? (openNoValue / openDeals.length * 100).toFixed(0) : 0;
    if (pctOpenNoValue > 10) dataQualityAlerts.push(`${pctOpenNoValue}% do pipeline em aberto sem valor`);
    // Won deals in PROSPECCAO (historical error)
    const prospWon = wonDeals.filter(d => PIPELINE_CATEGORIES.PROSPECCAO.includes(d.PipelineId));
    if (prospWon.length > 0) dataQualityAlerts.push(`Funil Prospecção: ${prospWon.length} ganhos históricos (ignorados nas análises de conversão e receita)`);
    // Carteira loss reasons
    const carteiraLost = lostDeals.filter(d => PIPELINE_CATEGORIES.CARTEIRA.includes(d.PipelineId));
    if (carteiraLost.length > 0) {
      dataQualityAlerts.push(`Funil Manutenção da Carteira: ${carteiraLost.length} perdas — motivo "Não Possui Necessidade" é esperado por design, não é anomalia`);
    }

    return {
      period: periodDays,
      conversionByPipeline: convByPipe,
      ticketByPipeline,
      abandonedByOwner,
      fillRateByOwner,
      interactionsByOwner,
      hygieneScores,
      dataQualityAlerts
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function computeDataQualityDiagnostic() {
  try {
    const now = new Date();
    const date90dAgo = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
    const pipeExcl = INACTIVE_PIPELINE_IDS.map(id => `PipelineId ne ${id}`).join(' and ');
    const pvExcl = EXCLUDED_FROM_ANALYSIS.map(id => `OwnerId ne ${id}`).join(' and ');
    const baseExcl = `(${pipeExcl}) and (${pvExcl})`;

    // 1. Deals perdidos nos últimos 180 dias — checar motivo de perda
    const date180dAgo = new Date(now - 180 * 24 * 60 * 60 * 1000).toISOString();
    const lostDeals = await ploomesGetAll(
      `/Deals?$filter=StatusId eq 3 and FinishDate ge ${date180dAgo} and ${baseExcl}&$select=Id,OwnerId,PipelineId,LossReasonId,Amount,FinishDate`, 3000);
    const totalLost = lostDeals.length;
    const lostSemMotivo = lostDeals.filter(d => !d.LossReasonId).length;
    const pctSemMotivo = totalLost > 0 ? +(lostSemMotivo / totalLost * 100).toFixed(1) : 0;

    // 2. Deals ganhos nos últimos 180 dias — checar valor
    const wonDeals = await ploomesGetAll(
      `/Deals?$filter=StatusId eq 2 and FinishDate ge ${date180dAgo} and ${baseExcl}&$select=Id,OwnerId,PipelineId,Amount,FinishDate,CreateDate`, 2000);
    const totalWon = wonDeals.length;
    const wonSemValor = wonDeals.filter(d => !d.Amount || d.Amount === 0).length;
    const pctWonSemValor = totalWon > 0 ? +(wonSemValor / totalWon * 100).toFixed(1) : 0;

    // 3. Deals em aberto — verificar abandonados (sem update há >90 dias)
    const openDeals = await ploomesGetAll(
      `/Deals?$filter=StatusId eq 1 and ${baseExcl}&$select=Id,OwnerId,PipelineId,Amount,LastUpdateDate,CreateDate`, 5000);
    const totalOpen = openDeals.length;
    const openAbandoned90 = openDeals.filter(d => {
      if (!d.LastUpdateDate) return true;
      const updated = new Date(d.LastUpdateDate);
      return (now - updated) > 90 * 24 * 60 * 60 * 1000;
    }).length;
    const pctAbandoned90 = totalOpen > 0 ? +(openAbandoned90 / totalOpen * 100).toFixed(1) : 0;
    const openAbandoned180 = openDeals.filter(d => {
      if (!d.LastUpdateDate) return true;
      const updated = new Date(d.LastUpdateDate);
      return (now - updated) > 180 * 24 * 60 * 60 * 1000;
    }).length;
    const openSemValor = openDeals.filter(d => !d.Amount || d.Amount === 0).length;
    const pctOpenSemValor = totalOpen > 0 ? +(openSemValor / totalOpen * 100).toFixed(1) : 0;
    const totalOpenValue = openDeals.reduce((a, b) => a + (Number(b.Amount) || 0), 0);
    const abandonedOpenValue = openDeals.filter(d => {
      if (!d.LastUpdateDate) return true;
      return (now - new Date(d.LastUpdateDate)) > 90 * 24 * 60 * 60 * 1000;
    }).reduce((a, b) => a + (Number(b.Amount) || 0), 0);

    // 4. Análise de motivos de perda concentrados por funil (180d)
    const lossMotivConcentration = {};
    for (const d of lostDeals) {
      const pid = d.PipelineId;
      const rid = d.LossReasonId || '__SEM_MOTIVO__';
      if (!lossMotivConcentration[pid]) lossMotivConcentration[pid] = {};
      lossMotivConcentration[pid][rid] = (lossMotivConcentration[pid][rid] || 0) + 1;
    }
    const alertConcentration = [];
    for (const [pid, reasons] of Object.entries(lossMotivConcentration)) {
      // Funil Manutenção da Carteira: motivo único é ESPERADO, não é anomalia
      const pCtx = getPipelineContext(Number(pid));
      if (pCtx.category === 'CARTEIRA') continue;
      // Funil Prospecção: não analisar conversão/motivos
      if (pCtx.category === 'PROSPECCAO') continue;
      const total = Object.values(reasons).reduce((a, b) => a + b, 0);
      for (const [rid, cnt] of Object.entries(reasons)) {
        const pct = +(cnt / total * 100).toFixed(1);
        if (pct >= 80 && total >= 5) {
          alertConcentration.push({ pipelineId: Number(pid), lossReasonId: rid === '__SEM_MOTIVO__' ? null : Number(rid), count: cnt, total, pct });
        }
      }
    }

    // 5. Interações registradas vs tarefas concluídas (últimos 90 dias)
    const [interactions, tasks] = await Promise.all([
      ploomesGetAll(`/InteractionRecords?$filter=Date ge ${date90dAgo}&$select=Id,CreatorId`, 3000),
      ploomesGetAll(`/Tasks?$filter=Finished eq true and FinishDate ge ${date90dAgo}&$select=Id,OwnerId`, 3000)
    ]);
    const totalInteractions = interactions.length;
    const totalTasksDone = tasks.length;
    const interactionsPerTask = totalTasksDone > 0 ? +(totalInteractions / totalTasksDone).toFixed(2) : null;

    // Score geral de qualidade (0-100, quanto menor pior)
    let qualityScore = 100;
    if (pctSemMotivo > 20) qualityScore -= 15;
    else if (pctSemMotivo > 10) qualityScore -= 8;
    if (pctWonSemValor > 10) qualityScore -= 15;
    else if (pctWonSemValor > 5) qualityScore -= 8;
    if (pctAbandoned90 > 30) qualityScore -= 20;
    else if (pctAbandoned90 > 15) qualityScore -= 10;
    if (alertConcentration.length > 0) qualityScore -= 10 * alertConcentration.length;
    qualityScore = Math.max(0, Math.min(100, qualityScore));
    const qualityLabel = qualityScore >= 80 ? 'BOM' : qualityScore >= 60 ? 'ATENÇÃO' : qualityScore >= 40 ? 'RUIM' : 'CRÍTICO';

    return {
      timestamp: now.toISOString(),
      // Deals perdidos
      lostDeals: { total: totalLost, semMotivo: lostSemMotivo, pctSemMotivo, period: '180d' },
      // Deals ganhos
      wonDeals: { total: totalWon, semValor: wonSemValor, pctSemValor: pctWonSemValor, period: '180d' },
      // Pipeline aberto
      openDeals: {
        total: totalOpen,
        totalValue: +totalOpenValue.toFixed(0),
        abandonados90d: openAbandoned90,
        pctAbandoned90,
        abandonados180d: openAbandoned180,
        semValor: openSemValor,
        pctSemValor: pctOpenSemValor,
        valorAbandonado90d: +abandonedOpenValue.toFixed(0)
      },
      // Concentração de motivos
      alertConcentration,
      // Interações vs tarefas
      activity: { interactions90d: totalInteractions, tasksDone90d: totalTasksDone, ratio: interactionsPerTask },
      // Score geral
      qualityScore,
      qualityLabel
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ─── CRM Health Cache (1h) ────────────────────────────────────────────────
const crmHealthCacheMap = new Map(); // key: JSON.stringify(sortedIds) -> { data, ts }

async function computeCrmHealth(ids) {
  // Prefer warehouse when fresh; kick sync in background if stale.
  try {
    if (isWarehouseFresh()) {
      const wh = computeCrmHealthWarehouse();
      if (wh && !wh.error) return wh;
    } else {
      kickWarehouseSyncBackground('computeCrmHealth');
    }
  } catch (e) {
    console.warn('[warehouse] computeCrmHealth fallback to API:', e.message);
  }

  const now = new Date();
  const nowMs = now.getTime();

  // Return cached if fresh (4h)
  const cacheKey = ids ? JSON.stringify([...ids].sort()) : '__all__';
  const cached = crmHealthCacheMap.get(cacheKey);
  if (cached && nowMs - cached.ts < 4 * 60 * 60 * 1000) {
    return cached.data;
  }

  try {
    const dict = await loadDictionary();
    const pipeExcl = INACTIVE_PIPELINE_IDS.map(id => `PipelineId ne ${id}`).join(' and ');
    const pvExcl = EXCLUDED_FROM_ANALYSIS.map(id => `OwnerId ne ${id}`).join(' and ');
    const baseExcl = `(${pipeExcl}) and (${pvExcl})`;

    const date90dAgo = new Date(nowMs - 90 * 24 * 60 * 60 * 1000).toISOString();
    const date180dAgo = new Date(nowMs - 180 * 24 * 60 * 60 * 1000).toISOString();
    const date30dAgo = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();

    // A. Deals abandonados (abertos sem atualização >90d)
    const openDeals = await ploomesGetAll(
      `/Deals?$filter=StatusId eq 1 and ${baseExcl}&$select=Id,OwnerId,PipelineId,Amount,LastUpdateDate,StageId`, 10000);

    // B. Deals perdidos últimos 180d
    const lostDeals180 = await ploomesGetAll(
      `/Deals?$filter=StatusId eq 3 and FinishDate ge ${date180dAgo} and ${baseExcl}&$select=Id,OwnerId,PipelineId,LossReasonId,FinishDate`, 5000);

    // Aggregate by owner
    const ownerStats = {};
    function ensureOwner(id) {
      if (!ownerStats[id]) {
        ownerStats[id] = {
          ownerId: id,
          ownerName: dict.userById[id] || `Vendedor ${id}`,
          // A. Abandonados
          abandonedDeals: [],
          // B. Sem valor
          noValueDeals: [],
          // C+E. Perdas
          lostTotal: 0,
          lostNoReason: 0,
          lostNoReasonDeals: [],
          // D. SLA violations
          slaAtencao: [],
          slaCritico: [],
          // For score calc
          openDeals: [],
          recentlyUpdatedOpen: 0,
        };
      }
      return ownerStats[id];
    }

    // SLA map by pipeline name keywords
    function getSLA(pipelineId) {
      const name = (dict.pipelineById[pipelineId] || '').toLowerCase();
      if (/peças|serviços|prospecção|prospecao/.test(name)) return { atencao: 30, critico: 60 };
      if (/manutenção.*carteira|manutencao.*carteira|controle.*venda|venda.*direta|contratos(?!.*manu)/.test(name)) return { atencao: 45, critico: 90 };
      if (/máquinas|maquinas|locme|locados|contratos.*manu/.test(name)) return { atencao: 60, critico: 120 };
      // Default
      return { atencao: 45, critico: 90 };
    }

    // Process open deals
    for (const d of openDeals) {
      if (!d.OwnerId) continue;
      const owner = ensureOwner(d.OwnerId);
      owner.openDeals.push(d);

      const lastUpdate = d.LastUpdateDate ? new Date(d.LastUpdateDate) : null;
      const daysStale = lastUpdate ? Math.floor((nowMs - lastUpdate.getTime()) / (1000*60*60*24)) : 9999;

      // A. Abandonados >90d
      if (daysStale > 90) {
        owner.abandonedDeals.push({ id: d.Id, pipelineId: d.PipelineId, amount: d.Amount || 0, daysStale,
          pipeline: dict.pipelineById[d.PipelineId] || `Pipeline ${d.PipelineId}` });
      }

      // B. Sem valor
      if (!d.Amount || d.Amount === 0) {
        owner.noValueDeals.push({ id: d.Id, pipelineId: d.PipelineId,
          pipeline: dict.pipelineById[d.PipelineId] || `Pipeline ${d.PipelineId}` });
      }

      // D. SLA violations
      const sla = getSLA(d.PipelineId);
      if (daysStale > sla.critico) {
        owner.slaCritico.push({ id: d.Id, pipelineId: d.PipelineId, daysStale,
          pipeline: dict.pipelineById[d.PipelineId] || `Pipeline ${d.PipelineId}`, sla });
      } else if (daysStale > sla.atencao) {
        owner.slaAtencao.push({ id: d.Id, pipelineId: d.PipelineId, daysStale,
          pipeline: dict.pipelineById[d.PipelineId] || `Pipeline ${d.PipelineId}`, sla });
      }

      // For score: recently updated open
      if (lastUpdate && (nowMs - lastUpdate.getTime()) <= 30*24*60*60*1000) {
        owner.recentlyUpdatedOpen++;
      }
    }

    // Process lost deals
    for (const d of lostDeals180) {
      if (!d.OwnerId) continue;
      const owner = ensureOwner(d.OwnerId);
      // Funil Manutenção da Carteira: perda sem motivo é ESPERADA — não penalizar higiene
      const lostPCtx = getPipelineContext(d.PipelineId);
      if (lostPCtx.category === 'CARTEIRA' || lostPCtx.category === 'PROSPECCAO') continue;
      owner.lostTotal++;
      if (!d.LossReasonId) {
        owner.lostNoReason++;
        owner.lostNoReasonDeals.push({ id: d.Id, pipelineId: d.PipelineId,
          pipeline: dict.pipelineById[d.PipelineId] || `Pipeline ${d.PipelineId}`,
          finishDate: d.FinishDate });
      }
    }

    // Build per-owner results with scores
    const vendorResults = [];
    for (const [ownerIdStr, s] of Object.entries(ownerStats)) {
      const ownerId = Number(ownerIdStr);

      // E. Taxa motivo de perda
      const lossReasonRate = s.lostTotal > 0 ? +(s.lostTotal > 0 ? (s.lostTotal - s.lostNoReason) / s.lostTotal * 100 : 0).toFixed(1) : null;
      const lossReasonAlert = s.lostTotal >= 3 && lossReasonRate !== null && lossReasonRate < 70;

      // F. Score de higiene
      // 40pts: % perdidos COM motivo
      const pts_motivo = s.lostTotal > 0 ? +((s.lostTotal - s.lostNoReason) / s.lostTotal * 40).toFixed(1) : 40; // sem perdas = ok
      // 30pts: % deals abertos COM valor
      const totalOpen = s.openDeals.length;
      const withValue = s.openDeals.filter(d => d.Amount && d.Amount > 0).length;
      const pts_valor = totalOpen > 0 ? +(withValue / totalOpen * 30).toFixed(1) : 30;
      // 30pts: % deals abertos atualizados nos últimos 30d
      const pts_atualiz = totalOpen > 0 ? +(s.recentlyUpdatedOpen / totalOpen * 30).toFixed(1) : 30;
      const hygieneScore = Math.round(pts_motivo + pts_valor + pts_atualiz);
      const hygieneLabel = hygieneScore >= 80 ? 'bom' : hygieneScore >= 60 ? 'regular' : 'sujo';

      // A. Classificação vendedor por abandonados
      const abandonedCount = s.abandonedDeals.length;
      const abandonedClass = abandonedCount > 5 ? 'critico' : abandonedCount >= 2 ? 'atencao' : 'ok';

      vendorResults.push({
        ownerId,
        ownerName: s.ownerName,
        hygieneScore,
        hygieneLabel,
        abandoned: {
          count: abandonedCount,
          classification: abandonedClass,
          sumAmount: s.abandonedDeals.reduce((a, b) => a + b.amount, 0),
          maxDays: s.abandonedDeals.length > 0 ? Math.max(...s.abandonedDeals.map(d => d.daysStale)) : 0,
          deals: s.abandonedDeals,
        },
        noValue: {
          count: s.noValueDeals.length,
          deals: s.noValueDeals,
        },
        lostNoReason: {
          total: s.lostTotal,
          noReason: s.lostNoReason,
          pct: lossReasonRate !== null ? +(100 - lossReasonRate).toFixed(1) : null,
          alert: lossReasonAlert,
          deals: s.lostNoReasonDeals,
        },
        sla: {
          atencao: s.slaAtencao.length,
          critico: s.slaCritico.length,
          atencaoDeals: s.slaAtencao,
          criticoDeals: s.slaCritico,
        },
        scoreBreakdown: { pts_motivo, pts_valor, pts_atualiz, openDealsTotal: totalOpen },
      });
    }

    vendorResults.sort((a, b) => a.hygieneScore - b.hygieneScore);

    // Summary totals — excluding Carteira and Prospeccao from loss reason stats
    const totalAbandoned = openDeals.filter(d => {
      const lu = d.LastUpdateDate ? new Date(d.LastUpdateDate) : null;
      return !lu || (nowMs - lu.getTime()) > 90*24*60*60*1000;
    }).length;
    const lostDeals180ForStats = lostDeals180.filter(d => {
      const ctx = getPipelineContext(d.PipelineId);
      return ctx.category !== 'CARTEIRA' && ctx.category !== 'PROSPECCAO';
    });
    const totalLostNoReason = lostDeals180ForStats.filter(d => !d.LossReasonId).length;
    const pctLostNoReason = lostDeals180ForStats.length > 0 ? +(totalLostNoReason / lostDeals180ForStats.length * 100).toFixed(1) : 0;

    crmHealthCacheMap.set(cacheKey, { data: {
      timestamp: now.toISOString(),
      cachedAt: nowMs,
      summary: {
        totalOpenDeals: openDeals.length,
        totalAbandonedDeals: totalAbandoned,
        totalLostDeals180d: lostDeals180ForStats.length,
        totalLostNoReason,
        pctLostNoReason,
      },
      vendors: vendorResults,
    }, ts: nowMs });
    return crmHealthCacheMap.get(cacheKey).data;
  } catch (e) {
    console.error('[crm-health]', e);
    return { error: e.message };
  }
}

// Pagina automaticamente — max 10000 para segurança
async function ploomesGetAll(urlPath, maxRecords = 10000) {
  const results = [];
  let skip = 0;
  const top = 100;
  const clean = urlPath.replace(/[&?]\$top=\d+/gi, '').replace(/[&?]\$skip=\d+/gi, '');
  const sep = clean.includes('?') ? '&' : '?';
  while (results.length < maxRecords) {
    const page = await ploomesGetOnce(`${clean}${sep}$top=${top}&$skip=${skip}`);
    const items = page.value || [];
    results.push(...items);
    if (items.length < top) break;
    skip += top;
  }
  return results;
}

// Multi-turn Claude (substitui askOpenAI no fluxo de fetches)
async function askClaudeMessages(messages, systemPrompt) {
  // Try Anthropic first, fall back to OpenAI if credits exhausted
  if (Anthropic && ANTHROPIC_API_KEY) {
    try {
      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
      const anthropicMsgs = messages.filter(m => m.role !== 'system');
      const cleaned = [];
      let lastRole = null;
      for (const m of anthropicMsgs) {
        if (m.role === lastRole) {
          cleaned[cleaned.length - 1].content += '\n' + m.content;
        } else {
          cleaned.push({ role: m.role, content: m.content });
          lastRole = m.role;
        }
      }
      if (!cleaned.length || cleaned[0].role !== 'user') {
        cleaned.unshift({ role: 'user', content: '(início da conversa)' });
      }
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 4000,
        temperature: 0,
        system: systemPrompt,
        messages: cleaned,
      });
      return (resp.content || []).map(b => b.type === 'text' ? b.text : '').join('');
    } catch (err) {
      if (err.message && (err.message.includes('credit') || err.message.includes('balance') || err.message.includes('quota'))) {
        console.warn('[askClaudeMessages] Anthropic sem crédito, fallback OpenAI');
      } else {
        throw err;
      }
    }
  }
  // Fallback: OpenAI
  const openaiMessages = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages.filter(m => m.role !== 'system')] : messages;
  return askOpenAI(openaiMessages);
}

let dictionaryInFlight = null;
async function loadDictionary() {
  const now = Date.now();
  if (dictionary && now - dictionaryLoadedAt < 30 * 60 * 1000) return dictionary;
  if (dictionaryInFlight) return dictionaryInFlight;
  dictionaryInFlight = (async () => {
    try {
  console.log('[dict] Carregando dicionário...');

  const users        = await ploomesGetOnce('/Users?$select=Id,Name,Email,Suspended,Integration');
  const pipelines    = await ploomesGetOnce('/Deals@Pipelines?$select=Id,Name');
  const stages       = await ploomesGetOnce('/Deals@Stages?$select=Id,Name,PipelineId');
  const teams        = await ploomesGetOnce('/Teams?$select=Id,Name');
  const tags         = await ploomesGetOnce('/Tags?$select=Id,Name');
  const dealsStatus  = await ploomesGetOnce('/Deals@Status');
  const contactStat  = await ploomesGetOnce('/Contacts@Status');
  const taskTypes    = await ploomesGetOnce('/Tasks@Types');
  const lossReasons  = await ploomesGetOnce('/Deals@LossReasons?$select=Id,Name');

  const pipelineMap = Object.fromEntries((pipelines.value||[]).map(p => [p.Id, p.Name]));

  dictionary = {
    users: users.value || [],
    pipelines: pipelines.value || [],
    stages: stages.value || [],
    teams: teams.value || [],
    tags: tags.value || [],
    dealsStatus: dealsStatus.value || [],
    contactStatus: contactStat.value || [],
    taskTypes: taskTypes.value || [],
    lossReasons: lossReasons.value || [],
    // Lookup maps
    userById: Object.fromEntries((users.value||[]).map(u => [u.Id, u.Name])),
    pipelineById: pipelineMap,
    stageById: Object.fromEntries((stages.value||[]).map(s => [s.Id, s.Name])),
    taskTypeById: Object.fromEntries((taskTypes.value||[]).map(t => [t.Id, t.Name])),
    lossReasonById: Object.fromEntries((lossReasons.value||[]).map(r => [r.Id, r.Name])),
    contactStatusById: Object.fromEntries((contactStat.value||[]).map(s => [s.Id, s.Name])),
  };
  dictionaryLoadedAt = now;
  console.log('[dict] OK:', { users: dictionary.users.length, pipelines: dictionary.pipelines.length, stages: dictionary.stages.length, lossReasons: dictionary.lossReasons.length });
  return dictionary;
    } finally {
      dictionaryInFlight = null;
    }
  })();
  return dictionaryInFlight;
}

// --- OpenAI (GPT-4o) ---
function askOpenAI(messages) {
  return new Promise((resolve, reject) => {
    if (!OPENAI_API_KEY) return reject(new Error('OPENAI_API_KEY não configurada'));
    const body = JSON.stringify({ model: 'gpt-4o', messages, temperature: 0, max_tokens: 4000 });
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.choices?.[0]?.message?.content || 'Sem resposta');
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function askClaude({ system, user, model = 'claude-haiku-4-5' }) {
  if (Anthropic && ANTHROPIC_API_KEY) {
    try {
      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
      const resp = await client.messages.create({
        model,
        max_tokens: 4000,
        temperature: 0.2,
        system,
        messages: [{ role: 'user', content: user }],
      });
      const txt = (resp.content || []).map(b => (b.type === 'text' ? b.text : '')).join('');
      return txt || '';
    } catch (err) {
      if (err.message && (err.message.includes('credit') || err.message.includes('balance') || err.message.includes('quota'))) {
        console.warn('[askClaude] Anthropic sem crédito, fallback OpenAI');
      } else {
        throw err;
      }
    }
  }
  // Fallback: OpenAI
  return askOpenAI([
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]);
}

// --- Middleware ---
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Session/cookie hardening + persistence
// - 30d maxAge
// - rolling sessions (extend expiry on activity)
// - sameSite=lax
// - secure cookie only when request is HTTPS (auto; honors X-Forwarded-Proto when behind proxy)
app.set('trust proxy', 1);
const SqliteStore = require('better-sqlite3-session-store')(session);
const sessionDb = new Database('/opt/ploomes-analyst/sessions.db');
const sessionStore = new SqliteStore({
  client: sessionDb,
  expired: {
    clear: true,
    intervalMs: 15 * 60 * 1000
  }
});

app.use(session({
  name: 'ploomes.sid',
  store: sessionStore,
  secret: process.env.SESSION_SECRET || require('crypto').randomBytes(64).toString('hex'),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: true,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    secure: 'auto'
  }
}));

function requireAuth(req, res, next) {
  if (req.session.userId) return next();
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  // admin OR gestor
  if (req.session.userId && (req.session.role === 'admin' || req.session.role === 'gestor')) return next();
  res.status(403).json({ error: 'Acesso negado' });
}

function requireAdminOrGestor(req, res, next) {
  if (req.session.userId && (req.session.role === 'admin' || req.session.role === 'gestor')) return next();
  res.status(403).json({ error: 'Acesso negado' });
}

function isAdminOrGestor(req) {
  return req.session.role === 'admin' || req.session.role === 'gestor';
}

function canAccessUserId(req, targetAppUserId) {
  const role = req.session.role || 'vendedor';
  if (role === 'admin' || role === 'gestor') return true;
  if (targetAppUserId === req.session.userId) return true;
  if (role === 'supervisor') {
    const rows = db.prepare(`
      SELECT tm.user_id
      FROM team_members tm
      JOIN teams t ON t.id = tm.team_id
      WHERE t.supervisor_user_id = ?
    `).all(req.session.userId);
    const ids = new Set(rows.map(r => r.user_id));
    return ids.has(Number(targetAppUserId));
  }
  return false;
}

function getAllowedPloomesIds(req) {
  const role = req.session.role || 'vendedor';
  if (role === 'admin' || role === 'gestor') return null; // null = todos

  // Supervisor: pegar equipe
  if (role === 'supervisor') {
    const team = db.prepare(`
      SELECT tm.user_id FROM team_members tm
      JOIN teams t ON t.id = tm.team_id
      WHERE t.supervisor_user_id = ?
    `).all(req.session.userId);
    const memberIds = team.map(t => {
      const u = db.prepare('SELECT ploomes_user_id FROM app_users WHERE id=?').get(t.user_id);
      return u && u.ploomes_user_id;
    }).filter(Boolean);

    if (req.session.ploomesUserId) memberIds.push(req.session.ploomesUserId);
    return memberIds.length ? [...new Set(memberIds)] : [req.session.ploomesUserId || 0];
  }

  // Vendedor: só o próprio
  return req.session.ploomesUserId ? [req.session.ploomesUserId] : [0];
}

function ploomesOwnerFilter(ownerIds) {
  if (!ownerIds || ownerIds === null) return ''; // no restriction
  const ids = [...new Set(ownerIds)].filter(Boolean);
  if (ids.length === 0) return 'OwnerId%20eq%200';
  if (ids.length === 1) return `OwnerId%20eq%20${ids[0]}`;
  return ids.map(id => `OwnerId%20eq%20${id}`).join('%20or%20');
}

function ploomesCreatorFilter(creatorIds) {
  if (!creatorIds || creatorIds === null) return '';
  const ids = [...new Set(creatorIds)].filter(Boolean);
  if (ids.length === 0) return 'CreatorId%20eq%200';
  if (ids.length === 1) return `CreatorId%20eq%20${ids[0]}`;
  return ids.map(id => `CreatorId%20eq%20${id}`).join('%20or%20');
}

function isoNoZ(d) {
  // Ploomes examples used -03:00; but API accepts ISO. We'll keep Z for simplicity.
  return d.toISOString();
}

function monthStartISO(date = new Date()) {
  const d = new Date(date);
  d.setUTCDate(1);
  d.setUTCHours(0,0,0,0);
  return isoNoZ(d);
}

// --- Aggregation helpers (lightweight for dashboards/ranking) ---
function countBy(arr, keyFn) {
  const out = {};
  for (const it of arr) {
    const k = keyFn(it);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function sumBy(arr, valFn) {
  let s = 0;
  for (const it of arr) s += (valFn(it) || 0);
  return s;
}

async function computeDashboard({ dict, allowedOwnerIds, allowedCreatorIds, targetAppUserId, pipelineId }) {
  const now = new Date();
  const startMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
  const startMonthIso = isoNoZ(startMonth);
  const cutoff30 = new Date(Date.now() - 30*24*60*60*1000);
  const cutoff30Iso = isoNoZ(cutoff30);
  const start30d = cutoff30;
  const start30dIso = isoNoZ(start30d);

  const ownerFilter = ploomesOwnerFilter(allowedOwnerIds);
  const creatorFilter = ploomesCreatorFilter(allowedCreatorIds);

  // Pipeline filter for Deals queries
  const pipeFilter = pipelineId ? `%20and%20PipelineId%20eq%20${pipelineId}` : '';

  // Deals open
  const dealsOpen = await ploomesGetAll(`/Deals?$select=Id,OwnerId,StatusId,Amount,LastUpdateDate&$filter=StatusId%20eq%201${ownerFilter ? `%20and%20(${ownerFilter})` : ''}${pipeFilter}`);

  // Won/Lost in month by FinishDate
  const dealsWon = await ploomesGetAll(`/Deals?$select=Id,OwnerId,StatusId,Amount,FinishDate&$filter=StatusId%20eq%202%20and%20FinishDate%20ge%20${encodeURIComponent(startMonthIso)}${ownerFilter ? `%20and%20(${ownerFilter})` : ''}${pipeFilter}`);
  const dealsLost = await ploomesGetAll(`/Deals?$select=Id,OwnerId,StatusId,Amount,FinishDate&$filter=StatusId%20eq%203%20and%20FinishDate%20ge%20${encodeURIComponent(startMonthIso)}${ownerFilter ? `%20and%20(${ownerFilter})` : ''}${pipeFilter}`);

  // Interactions 30d
  const interactions30 = await ploomesGetAll(`/InteractionRecords?$select=Id,CreatorId,Date,TypeId,ContactId&$filter=Date%20ge%20${encodeURIComponent(start30dIso)}${creatorFilter ? `%20and%20(${creatorFilter})` : ''}`);
  const interByType = countBy(interactions30, r => dict.taskTypeById[r.TypeId] || `Tipo ${r.TypeId}`);

  // Tasks open
  const tasksOpen = await ploomesGetAll(`/Tasks?$select=Id,OwnerId,DateTime,Finished&$filter=Finished%20eq%20false${ownerFilter ? `%20and%20(${ownerFilter})` : ''}`);
  const tarefasVencidas = tasksOpen.filter(t => !t.DateTime || new Date(t.DateTime) <= now).length;

  // ScoreCRM (month)
  const wonCount = dealsWon.length;
  const interCount = interactions30.filter(i => new Date(i.Date) >= startMonth).length;
  const visitMeetingCount = interactions30.filter(i => {
    const tp = i.TypeId;
    return (tp === 2 || tp === 5) && new Date(i.Date) >= startMonth;
  }).length;

  // On-time tasks finished this month
  const tasksFinishedMonth = await ploomesGetAll(`/Tasks?$select=Id,OwnerId,DateTime,Finished,FinishDate&$filter=Finished%20eq%20true%20and%20FinishDate%20ge%20${encodeURIComponent(startMonthIso)}${ownerFilter ? `%20and%20(${ownerFilter})` : ''}`);
  const onTimeFinished = tasksFinishedMonth.filter(t => t.DateTime && t.FinishDate && new Date(t.FinishDate) <= new Date(t.DateTime)).length;

  // Overdue tasks open with DateTime in month
  const overdueThisMonth = tasksOpen.filter(t => t.DateTime && new Date(t.DateTime) >= startMonth && new Date(t.DateTime) <= now).length;

  // Stale deals >30d no update (cap penalty)
  const staleDeals = dealsOpen.filter(d => d.LastUpdateDate && new Date(d.LastUpdateDate) <= cutoff30);
  const stalePenalty = Math.max(-20, -1 * staleDeals.length);

  // Coach usage weekly (+2/week) from DB
  const coachWeeks = db.prepare(`
    SELECT COUNT(DISTINCT strftime('%Y-%W', created_at)) as w
    FROM coaching_summaries
    WHERE user_id = ? AND created_at >= ?
  `).get(targetAppUserId, startMonthIso);
  const coachBonus = (coachWeeks?.w || 0) * 2;

  // Goals vs realized
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const goal = db.prepare('SELECT * FROM goals WHERE user_id = ? AND year = ? AND month = ? ORDER BY updated_at DESC LIMIT 1').get(targetAppUserId, year, month);
  const ganhosValor = sumBy(dealsWon, d => d.Amount || 0);

  // Score balanceado: receita tem peso maior que volume puro
  const revenueScore = goal?.valor_mensal > 0
    ? Math.round(Math.min(50, (ganhosValor / goal.valor_mensal) * 50))  // até 50pts por % de meta
    : Math.round(Math.min(30, ganhosValor / 5000));                      // sem meta: 1pt a cada R$5k (max 30)

  const activityScore = Math.round(
    (wonCount * 8) +            // deals ganhos (peso alto)
    (visitMeetingCount * 3) +   // visitas/reuniões (qualidade)
    (interCount * 0.5) +        // interações gerais (volume, peso menor)
    (onTimeFinished * 2)        // tarefas no prazo
  );

  const penaltyScore = Math.round(
    (overdueThisMonth * -3) +   // tarefas vencidas (mais pesado)
    stalePenalty                 // deals parados
  );

  const scorecrm = revenueScore + activityScore + penaltyScore + coachBonus;
  const metaVsRealizado = goal ? {
    goal,
    realizado: {
      ganhosMes: ganhosValor,
      dealsGanhosMes: dealsWon.length,
      interacoes30d: interactions30.length,
      tarefasVencidas,
      scorecrm,
    },
    progresso: {
      valor_mensal: goal.valor_mensal ? Math.min(1, ganhosValor / goal.valor_mensal) : null,
      interacoes_semana: goal.interacoes_semana ? null : null,
    }
  } : null;

  const alertas = [];
  if (tarefasVencidas > 0) alertas.push(`Você tem ${tarefasVencidas} tarefa(s) vencida(s) (prioridade alta).`);
  if (staleDeals.length > 0) alertas.push(`${staleDeals.length} deal(s) sem atualização há >30 dias (risco de perda).`);
  if (dealsOpen.length === 0) alertas.push('Nenhum deal em aberto no escopo atual.');
  if (interactions30.length === 0) alertas.push('Nenhuma interação nos últimos 30 dias no escopo atual.');

  return {
    dealsAbertos: dealsOpen.length,
    ganhosMs: { count: dealsWon.length, valor: ganhosValor },
    perdidosMs: { count: dealsLost.length, valor: sumBy(dealsLost, d => d.Amount || 0) },
    interacoes30d: interByType,
    tarefasAbertas: tasksOpen.length,
    tarefasVencidas,
    scorecrm,
    metaVsRealizado,
    alertas,
  };
}

async function computeRanking({ dict, scopeOwnerIds, scopeCreatorIds, scopeAppUserIds, year, month, periodStart }) {
  const now = new Date();
  const start = periodStart || new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const startIso = isoNoZ(start);
  const cutoff30 = new Date(Date.now() - 30*24*60*60*1000);

  const ownerFilter = ploomesOwnerFilter(scopeOwnerIds);
  const creatorFilter = ploomesCreatorFilter(scopeCreatorIds);

  const dealsWon = await ploomesGetAll(`/Deals?$select=Id,OwnerId,Amount,FinishDate,StatusId&$filter=StatusId%20eq%202%20and%20FinishDate%20ge%20${encodeURIComponent(startIso)}${ownerFilter ? `%20and%20(${ownerFilter})` : ''}`);
  const interactions = await ploomesGetAll(`/InteractionRecords?$select=Id,CreatorId,Date,TypeId&$filter=Date%20ge%20${encodeURIComponent(startIso)}${creatorFilter ? `%20and%20(${creatorFilter})` : ''}`);
  const tasksFinished = await ploomesGetAll(`/Tasks?$select=Id,OwnerId,DateTime,FinishDate,Finished&$filter=Finished%20eq%20true%20and%20FinishDate%20ge%20${encodeURIComponent(startIso)}${ownerFilter ? `%20and%20(${ownerFilter})` : ''}`);
  const tasksOpen = await ploomesGetAll(`/Tasks?$select=Id,OwnerId,DateTime,Finished&$filter=Finished%20eq%20false${ownerFilter ? `%20and%20(${ownerFilter})` : ''}`);
  const dealsOpen = await ploomesGetAll(`/Deals?$select=Id,OwnerId,StatusId,LastUpdateDate&$filter=StatusId%20eq%201${ownerFilter ? `%20and%20(${ownerFilter})` : ''}`);

  const byPloomesId = {};
  function ensure(pid) {
    if (!byPloomesId[pid]) byPloomesId[pid] = {
      pontuacao: 0,
      breakdown: { dealsGanhos: 0, interacoes: 0, visitasReunioes: 0, tarefasNoPrazo: 0, tarefasVencidas: 0, dealsSemAtualizacao30d: 0, semanasCoach: 0 },
    };
    return byPloomesId[pid];
  }

  for (const d of dealsWon) {
    const row = ensure(d.OwnerId);
    row.pontuacao += 8;                                    // deal ganho (base)
    row.pontuacao += Math.min(20, Math.round((d.Amount || 0) / 5000)); // até +20 pts por receita (R$5k = 1pt)
    row.breakdown.dealsGanhos += 1;
    row.breakdown.receitaGanha = (row.breakdown.receitaGanha || 0) + (d.Amount || 0);
  }

  for (const i of interactions) {
    const row = ensure(i.CreatorId);
    row.pontuacao += 0.5;
    row.breakdown.interacoes += 1;
    if (i.TypeId === 2 || i.TypeId === 5) {
      row.pontuacao += 2;    // visitas/reuniões valem mais
      row.breakdown.visitasReunioes += 1;
    }
  }

  for (const t of tasksFinished) {
    const row = ensure(t.OwnerId);
    if (t.DateTime && t.FinishDate && new Date(t.FinishDate) <= new Date(t.DateTime)) {
      row.pontuacao += 3;
      row.breakdown.tarefasNoPrazo += 1;
    }
  }

  for (const t of tasksOpen) {
    if (t.DateTime && new Date(t.DateTime) <= now && new Date(t.DateTime) >= start) {
      const row = ensure(t.OwnerId);
      row.pontuacao -= 2;
      row.breakdown.tarefasVencidas += 1;
    }
  }

  for (const d of dealsOpen) {
    if (d.LastUpdateDate && new Date(d.LastUpdateDate) <= cutoff30) {
      const row = ensure(d.OwnerId);
      // cap at -20 total per user
      if (row.breakdown.dealsSemAtualizacao30d < 20) {
        row.pontuacao -= 1;
        row.breakdown.dealsSemAtualizacao30d += 1;
      }
    }
  }

  // coach weekly bonus from DB (map app_user -> ploomes_user_id)
  const users = db.prepare('SELECT id, ploomes_user_id, display_name, username, role, active FROM app_users WHERE active = 1').all();
  const pidByAppId = Object.fromEntries(users.filter(u => u.ploomes_user_id).map(u => [u.id, u.ploomes_user_id]));
  for (const appId of scopeAppUserIds) {
    const pid = pidByAppId[appId];
    if (!pid) continue;
    const w = db.prepare(`
      SELECT COUNT(DISTINCT strftime('%Y-%W', created_at)) as w
      FROM coaching_summaries
      WHERE user_id = ? AND created_at >= ?
    `).get(appId, startIso)?.w || 0;
    const row = ensure(pid);
    row.pontuacao += w * 2;
    row.breakdown.semanasCoach = w;
  }

  // Build leaderboard list from scopeAppUserIds, but score by their Ploomes id
  const leaderboard = [];
  for (const u of users) {
    if (!scopeAppUserIds.includes(u.id)) continue;
    const pid = u.ploomes_user_id;
    if (!pid) continue;
    // Excluir usuários que não são vendedores ativos (ex: dono da empresa)
    if (EXCLUDED_FROM_ANALYSIS.includes(pid)) continue;
    const row = byPloomesId[pid] || { pontuacao: 0, breakdown: { dealsGanhos:0, interacoes:0, visitasReunioes:0, tarefasNoPrazo:0, tarefasVencidas:0, dealsSemAtualizacao30d:0, semanasCoach:0 } };
    leaderboard.push({
      userId: u.id,
      ploomesUserId: pid,
      nome: u.display_name || u.username,
      pontuacao: row.pontuacao,
      breakdown: row.breakdown,
    });
  }
  leaderboard.sort((a,b) => b.pontuacao - a.pontuacao);
  leaderboard.forEach((r, idx) => r.posicao = idx + 1);

  return { year, month, leaderboard };
}

// ─── Auth routes ───────────────────────────────────────────────
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const uname = username?.trim().toLowerCase();
  const user = db.prepare('SELECT * FROM app_users WHERE username = ? AND active = 1').get(uname);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.redirect('/login?error=1');
  }

  // Auto-vincular Ploomes user_id por e-mail, se ainda não estiver salvo
  let ploomesUserId = user.ploomes_user_id || null;
  if (!ploomesUserId) {
    try {
      const resolved = await resolvePloomesUserByEmail(user.username);
      if (resolved?.id) {
        ploomesUserId = resolved.id;
        db.prepare('UPDATE app_users SET ploomes_user_id = ? WHERE id = ?').run(ploomesUserId, user.id);
        console.log('[auth] ploomes_user_id resolvido por e-mail no login:', { username: user.username, ploomesUserId });
      }
    } catch (e) {
      console.warn('[auth] falha ao resolver ploomes_user_id por e-mail:', e.message);
    }
  }

  db.prepare('UPDATE app_users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role || 'vendedor';
  req.session.isAdmin = (user.role === 'admin' || user.role === 'gestor');
  req.session.displayName = user.display_name || user.username;
  req.session.ploomesUserId = ploomesUserId;
  res.redirect('/');
});

app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/login')); });

// ─── Main app ──────────────────────────────────────────────────
app.get('/', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/coach', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'coach.html')));
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/ranking', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'ranking.html')));
app.get('/gestor', requireAuth, requireAdminOrGestor, (req, res) =>
  res.sendFile(path.join(__dirname, 'gestor.html')));
app.get('/app', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'app.html'));
});
app.get('/admin', requireAuth, requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/reports', requireAuth, (req, res) => {
  const role = req.session.role || 'vendedor';
  if (role === 'vendedor') return res.redirect('/');
  res.sendFile(path.join(__dirname, 'reports.html'));
});

// ─── Self info ─────────────────────────────────────────────────
app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    userId: req.session.userId,
    username: req.session.username,
    displayName: req.session.displayName || req.session.username,
    role: req.session.role || 'vendedor',
    isAdmin: isAdminOrGestor(req),
    ploomesUserId: req.session.ploomesUserId
  });
});


// ─── Warehouse status (debug/observability) ───────────────────
app.get('/api/warehouse/status', requireAuth, requireAdmin, (req, res) => {
  try {
    const last = getWarehouseLastRun();
    const wdb = getWarehouseDb();
    if (!wdb) return res.json({ ok: false, error: 'warehouse.db não disponível', path: WAREHOUSE_DB_PATH });
    if (!last) return res.json({ ok: false, error: 'Sem runs no warehouse', path: WAREHOUSE_DB_PATH });

    const counts = {};
    for (const t of ['ploomes_users','pipelines','stages','loss_reasons','deals','interactions','tasks']) {
      try { counts[t] = wdb.prepare(`SELECT COUNT(*) as c FROM ${t}`).get().c; } catch { counts[t] = null; }
    }

    res.json({
      ok: true,
      path: WAREHOUSE_DB_PATH,
      fresh: isWarehouseFresh(),
      lastRun: last,
      counts,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Erro interno. Tente novamente.' });
  }
});


// ─── Executive report (HTML) ──────────────────────────────────────────────
const REPORTS_DIR = path.join('/opt/ploomes-analyst/backups');

function buildExecReportHtml(wdb, last, dict) {
  const runId = last.id;
  const rows30 = wdb.prepare('SELECT pipeline_id, won_count, lost_count, win_rate FROM mv_conversion WHERE run_id=? AND period_days=30 ORDER BY (won_count+lost_count) DESC').all(runId);
  const rows90 = wdb.prepare('SELECT pipeline_id, won_count, lost_count, win_rate FROM mv_conversion WHERE run_id=? AND period_days=90 ORDER BY (won_count+lost_count) DESC').all(runId);
  const snap = wdb.prepare('SELECT pipeline_id, owner_id, open_count, open_sum, stale_90_count FROM mv_pipeline_snapshot WHERE run_id=? ORDER BY open_sum DESC LIMIT 50').all(runId);
  const hygiene = wdb.prepare('SELECT owner_id, score, abandoned_90d, open_no_amount, lost_no_reason_pct FROM mv_hygiene WHERE run_id=? ORDER BY score ASC').all(runId);
  function esc(x){return String(x??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function pct(x){ if (x==null) return '—'; return (Number(x)*100).toFixed(1)+'%'; }
  const generatedAt = new Date().toISOString();
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Relatório Executivo CRM</title><style>body{font-family:Arial,Helvetica,sans-serif;margin:24px;color:#111}small{color:#555}h1{margin:0 0 8px 0}h2{margin-top:24px}table{border-collapse:collapse;width:100%;margin-top:8px}th,td{border:1px solid #ddd;padding:8px;font-size:13px}th{background:#f5f5f5;text-align:left}.bad{color:#b00020;font-weight:700}.warn{color:#b26a00;font-weight:700}.good{color:#0a7a2a;font-weight:700}</style></head><body>
<h1>Relatório Executivo — CRM</h1><small>Gerado em: ${esc(generatedAt)} | Warehouse run #${esc(runId)} (${esc(last.finished_at)})</small>
<h2>Conversão por Funil (30d)</h2><table><tr><th>Funil</th><th>Ganhos</th><th>Perdas</th><th>Win rate</th></tr>${rows30.map(r=>`<tr><td>${esc(dict.pipelineById[r.pipeline_id]||'Pipeline '+r.pipeline_id)}</td><td>${esc(r.won_count)}</td><td>${esc(r.lost_count)}</td><td>${esc(pct(r.win_rate))}</td></tr>`).join('')}</table>
<h2>Conversão por Funil (90d)</h2><table><tr><th>Funil</th><th>Ganhos</th><th>Perdas</th><th>Win rate</th></tr>${rows90.map(r=>`<tr><td>${esc(dict.pipelineById[r.pipeline_id]||'Pipeline '+r.pipeline_id)}</td><td>${esc(r.won_count)}</td><td>${esc(r.lost_count)}</td><td>${esc(pct(r.win_rate))}</td></tr>`).join('')}</table>
<h2>Pipeline em Aberto (top 50 por valor)</h2><table><tr><th>Funil</th><th>Dono</th><th>Qtd</th><th>R$ total</th><th>Stale &gt;90d</th></tr>${snap.map(r=>`<tr><td>${esc(dict.pipelineById[r.pipeline_id]||'Pipeline '+r.pipeline_id)}</td><td>${esc(dict.userById[r.owner_id]||'Owner '+r.owner_id)}</td><td>${esc(r.open_count)}</td><td>${esc((Number(r.open_sum)||0).toFixed(0))}</td><td>${esc(r.stale_90_count)}</td></tr>`).join('')}</table>
<h2>Higiene por Vendedor</h2><table><tr><th>Vendedor</th><th>Score</th><th>Abandonados (&gt;90d)</th><th>Abertos sem valor</th><th>% perdas sem motivo (180d)</th></tr>${hygiene.map(r=>{const score=Number(r.score)||0;const cls=score>=80?'good':score>=60?'warn':'bad';return `<tr><td>${esc(dict.userById[r.owner_id]||'Owner '+r.owner_id)}</td><td class="${cls}">${esc(score)}</td><td>${esc(r.abandoned_90d)}</td><td>${esc(r.open_no_amount)}</td><td>${esc(r.lost_no_reason_pct==null?'—':(Number(r.lost_no_reason_pct)*100).toFixed(1)+'%')}</td></tr>`;}).join('')}</table>
</body></html>`;
}

// POST /api/admin/generate-report — gera HTML e salva em backups/
app.post('/api/admin/generate-report', requireAuth, requireAdminOrGestor, async (req, res) => {
  try {
    const wdb = getWarehouseDb();
    const last = getWarehouseLastRun();
    const dict = getWarehouseDictionary();
    if (!wdb || !last || !last.ok || !dict) {
      return res.status(400).json({ error: 'Warehouse não disponível/atualizado. Rode o sync antes.' });
    }
    const html = buildExecReportHtml(wdb, last, dict);
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const filename = `exec-report-${new Date().toISOString().slice(0,10)}-run${last.id}-${Date.now()}.html`;
    const outPath = path.join(REPORTS_DIR, filename);
    fs.writeFileSync(outPath, html, 'utf-8');
    return res.json({ ok: true, filename, outPath });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// Rota legada — SMTP removido
app.post('/api/admin/send-exec-report', requireAuth, requireAdmin, (req, res) => {
  res.status(410).json({ error: 'SMTP foi removido. Use POST /api/admin/generate-report.' });
});

// GET /api/admin/reports — lista relatórios gerados
app.get('/api/admin/reports', requireAuth, requireAdminOrGestor, (req, res) => {
  try {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const files = fs.readdirSync(REPORTS_DIR)
      .filter(f => f.endsWith('.html'))
      .map(f => {
        const stat = fs.statSync(path.join(REPORTS_DIR, f));
        return { filename: f, sizeBytes: stat.size, createdAt: (stat.birthtime || stat.ctime).toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ ok: true, reports: files });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// GET /api/admin/reports/:filename — baixa um relatório específico
app.get('/api/admin/reports/:filename', requireAuth, requireAdminOrGestor, (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    if (!filename.endsWith('.html')) return res.status(400).json({ error: 'Somente arquivos .html' });
    const filePath = path.join(REPORTS_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Relatório não encontrado' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.sendFile(filePath);
  } catch (e) {
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ─── Ploomes users (admin) ─────────────────────────────────────
app.get('/api/ploomes-users', requireAuth, async (req, res) => {
  const role = req.session.role || 'vendedor';
  if (!['admin','gestor','supervisor'].includes(role)) return res.status(403).json({ error: 'Acesso negado' });
  try {
    const dict = await loadDictionary();
    const users = (dict.users || []).filter(u =>
      !u.Suspended &&
      !u.Integration &&
      !EXCLUDED_FROM_ANALYSIS.includes(u.Id)
    ).map(u => ({ id: u.Id, name: u.Name, email: u.Email }));
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ─── Active Pipelines ───────────────────────────────────────
app.get('/api/pipelines-active', requireAuth, async (req, res) => {
  const role = req.session.role || 'vendedor';
  if (!['admin','gestor','supervisor'].includes(role)) return res.status(403).json({ error: 'Acesso negado' });
  try {
    // Fetch pipelines from Ploomes API with Archived field
    const raw = await ploomesGetOnce('/Deals@Pipelines?$select=Id,Name,Archived');
    const all = raw.value || [];
    const pipelines = all
      .filter(p => !p.Archived && !INACTIVE_PIPELINE_IDS.includes(Number(p.Id)))
      .map(p => ({ id: Number(p.Id), name: p.Name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    res.json(pipelines);
  } catch (e) {
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ─── Dashboard ────────────────────────────────────────────────
const dashboardCache = new Map(); // key -> {data, ts}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of dashboardCache) {
    if (now - v.ts > DASHBOARD_CACHE_TTL * 2) dashboardCache.delete(k);
  }
}, 10 * 60 * 1000);
const DASHBOARD_CACHE_TTL = 4 * 60 * 60 * 1000;
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    let allowedOwnerIds;
    let allowedCreatorIds;
    const dict = await loadDictionary();

    if (req.query.ploomesId) {
      // Admin/gestor selecionou um vendedor específico pelo Ploomes ID
      if (!isAdminOrGestor(req) && req.session.role !== 'supervisor') {
        return res.status(403).json({ error: 'Sem permissão para filtrar por vendedor' });
      }
      const pid = Number(req.query.ploomesId);
      if (EXCLUDED_FROM_ANALYSIS.includes(pid)) return res.status(403).json({ error: 'Usuário excluído de análises' });
      allowedOwnerIds = [pid];
      allowedCreatorIds = [pid];
    } else if (req.query.userId) {
      const targetUserId = Number(req.query.userId);
      if (!canAccessUserId(req, targetUserId)) return res.status(403).json({ error: 'Sem permissão para este usuário' });
      const target = db.prepare('SELECT id, ploomes_user_id FROM app_users WHERE id = ?').get(targetUserId);
      if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
      if (isAdminOrGestor(req) && targetUserId !== req.session.userId) {
        allowedOwnerIds = target.ploomes_user_id ? [target.ploomes_user_id] : [0];
        allowedCreatorIds = allowedOwnerIds;
      } else {
        const allowed = getAllowedPloomesIds(req);
        allowedOwnerIds = allowed;
        allowedCreatorIds = allowed;
      }
    } else {
      // Sem filtro: admin/gestor vê tudo (todos os vendedores), outros veem seu escopo
      if (isAdminOrGestor(req)) {
        // Todos os vendedores (sem filtro de owner) — null indica sem restrição
        allowedOwnerIds = null;
        allowedCreatorIds = null;
      } else {
        const allowed = getAllowedPloomesIds(req);
        allowedOwnerIds = allowed;
        allowedCreatorIds = allowed;
      }
    }

    const pipelineId = req.query.pipelineId ? Number(req.query.pipelineId) : null;
    const cacheKey = `dash_${req.session.userId}_${req.query.ploomesId||''}_${req.query.userId||''}_${pipelineId||''}`;
    const cached = dashboardCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < DASHBOARD_CACHE_TTL) return res.json(cached.data);
    const data = await computeDashboard({ dict, allowedOwnerIds, allowedCreatorIds, targetAppUserId: typeof targetUserId !== 'undefined' ? targetUserId : req.session.userId, pipelineId });
    dashboardCache.set(cacheKey, { data, ts: Date.now() });
    res.json(data);
  } catch (e) {
    console.error('[dashboard]', e);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ─── Ranking ──────────────────────────────────────────────────
// ─── GET /api/agenda-hoje ─────────────────────────────────────
app.get('/api/agenda-hoje', requireAuth, async (req, res) => {
  try {
    const ploomesId = req.session.ploomesUserId;
    const role = req.session.role;
    const isGestor = role === 'admin' || role === 'gestor' || role === 'supervisor';

    const dict = await loadDictionary();
    const EXCL = EXCLUDED_FROM_ANALYSIS || [];
    const ARCHIVED_PIPELINES = INACTIVE_PIPELINE_IDS || [];

    let scopeIds;
    if (isGestor) {
      scopeIds = Object.keys(dict.userById || {}).map(Number).filter(id => !EXCL.includes(id));
    } else {
      scopeIds = ploomesId ? [ploomesId] : [];
    }
    if (scopeIds.length === 0) return res.json([]);

    const ownerFilter = scopeIds.map(id => `OwnerId eq ${id}`).join(' or ');
    const now = new Date();
    const cutoff21 = new Date(Date.now() - 21*24*60*60*1000);
    const cutoff7  = new Date(Date.now() - 7*24*60*60*1000);

    const [dealsOpen, tasksOpen, interactionsWeek] = await Promise.all([
      ploomesGetAll(`/Deals?$select=Id,OwnerId,Title,Amount,LastUpdateDate,StatusId,PipelineId,StageId&$filter=StatusId%20eq%201%20and%20(${ownerFilter})`),
      ploomesGetAll(`/Tasks?$select=Id,OwnerId,DateTime,Finished,Title,DealId&$filter=Finished%20eq%20false%20and%20(${ownerFilter})`),
      ploomesGetAll(`/InteractionRecords?$select=Id,CreatorId,Date,DealId&$filter=Date%20ge%20${encodeURIComponent(isoNoZ(cutoff7))}%20and%20(${ownerFilter.replace(/OwnerId/g,'CreatorId')})`),
    ]);

    const activeDeals = dealsOpen.filter(d => !ARCHIVED_PIPELINES.includes(d.PipelineId));
    const agenda = [];

    const overdueTasks = tasksOpen.filter(t => t.DateTime && new Date(t.DateTime) <= now);
    for (const t of overdueTasks.slice(0, 10)) {
      const ownerName = dict.userById?.[t.OwnerId]?.Name || '';
      agenda.push({
        priority: 1, type: 'task_overdue', icon: '🔴', label: 'Tarefa vencida',
        action: `${t.Title || 'Tarefa'} — venceu ${formatDateBR(t.DateTime)}${isGestor && ownerName ? ` (${ownerName})` : ''}`,
        taskId: t.Id, dealId: t.DealId, ownerId: t.OwnerId,
      });
    }

    const staleDealsSorted = activeDeals
      .filter(d => d.LastUpdateDate && new Date(d.LastUpdateDate) < cutoff21)
      .sort((a,b) => (b.Amount||0) - (a.Amount||0));
    for (const d of staleDealsSorted.slice(0, 8)) {
      const days = Math.floor((now - new Date(d.LastUpdateDate)) / 86400000);
      const ownerName = dict.userById?.[d.OwnerId]?.Name || '';
      agenda.push({
        priority: 2, type: 'deal_stalled', icon: '🟡', label: 'Deal parado',
        action: `"${d.Title || d.Id}" parado há ${days} dias${d.Amount ? ` — R$ ${Number(d.Amount).toLocaleString('pt-BR',{minimumFractionDigits:2})}` : ''}${isGestor && ownerName ? ` (${ownerName})` : ''}`,
        dealId: d.Id, ownerId: d.OwnerId, amount: d.Amount, daysSinceUpdate: days,
      });
    }

    const interByDeal = {};
    for (const i of interactionsWeek) {
      if (i.DealId) interByDeal[i.DealId] = (interByDeal[i.DealId] || 0) + 1;
    }
    const hotDeals = activeDeals
      .filter(d => (interByDeal[d.Id] || 0) >= 3)
      .sort((a,b) => (interByDeal[b.Id]||0) - (interByDeal[a.Id]||0));
    for (const d of hotDeals.slice(0, 5)) {
      const ownerName = dict.userById?.[d.OwnerId]?.Name || '';
      agenda.push({
        priority: 3, type: 'deal_hot', icon: '🔥', label: 'Deal aquecido',
        action: `"${d.Title || d.Id}" teve ${interByDeal[d.Id]} interações essa semana — momento de avançar${isGestor && ownerName ? ` (${ownerName})` : ''}`,
        dealId: d.Id, ownerId: d.OwnerId, amount: d.Amount,
      });
    }

    const criticalAlerts = db.prepare(`
      SELECT * FROM anomaly_alerts
      WHERE severity = 'critical' AND resolved_at IS NULL
        AND detected_at >= datetime('now', '-2 days')
        ${isGestor ? '' : `AND owner_ploomes_id = ${ploomesId}`}
      ORDER BY detected_at DESC LIMIT 5
    `).all();
    for (const a of criticalAlerts) {
      agenda.push({
        priority: 0, type: 'critical_alert', icon: '🚨', label: 'Alerta crítico',
        action: a.message, alertId: a.id, ownerId: a.owner_ploomes_id,
      });
    }

    agenda.sort((a,b) => a.priority - b.priority);
    res.json(agenda.slice(0, 15));
  } catch (e) {
    console.error('[agenda-hoje]', e.message);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

function formatDateBR(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

// ─── GET /api/alerts ──────────────────────────────────────────
app.get('/api/alerts', requireAuth, (req, res) => {
  try {
    const ploomesId = req.session.ploomesUserId;
    const role = req.session.role;
    const isGestor = role === 'admin' || role === 'gestor' || role === 'supervisor';
    const alerts = db.prepare(`
      SELECT * FROM anomaly_alerts
      WHERE resolved_at IS NULL
        AND detected_at >= datetime('now', '-7 days')
        ${isGestor ? '' : `AND owner_ploomes_id = ?`}
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
        detected_at DESC
      LIMIT 20
    `).all(...(isGestor ? [] : [ploomesId]));
    res.json(alerts);
  } catch (e) {
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ─── GET /api/gestor-dashboard ────────────────────────────────
app.get('/api/gestor-dashboard', requireAuth, requireAdminOrGestor, async (req, res) => {
  try {
    const pipelineId = req.query.pipelineId ? Number(req.query.pipelineId) : null;
    const pipelineFilter = pipelineId ? `%20and%20PipelineId%20eq%20${pipelineId}` : '';
    const dict = await loadDictionary();
    const now = new Date();
    const startMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const startMonthIso = isoNoZ(startMonth);
    const cutoff30 = new Date(Date.now() - 30*24*60*60*1000);
    const cutoff7  = new Date(Date.now() - 7*24*60*60*1000);

    const EXCL = EXCLUDED_FROM_ANALYSIS || [];
    const ARCHIVED = INACTIVE_PIPELINE_IDS || [];
    const ownerIds = Object.keys(dict.userById || {}).map(Number).filter(id => !EXCL.includes(id));
    const ownerFilter = ownerIds.map(id => `OwnerId eq ${id}`).join(' or ');
    const creatorFilter = ownerIds.map(id => `CreatorId eq ${id}`).join(' or ');

    const [dealsOpen, dealsWonMonth, dealsLostMonth, interactionsWeek, tasksOpen] = await Promise.all([
      ploomesGetAll(`/Deals?$select=Id,OwnerId,Title,Amount,LastUpdateDate,StatusId,PipelineId&$filter=StatusId%20eq%201${pipelineFilter}%20and%20(${ownerFilter})`),
      ploomesGetAll(`/Deals?$select=Id,OwnerId,Amount,FinishDate&$filter=StatusId%20eq%202%20and%20FinishDate%20ge%20${encodeURIComponent(startMonthIso)}${pipelineFilter}%20and%20(${ownerFilter})`),
      ploomesGetAll(`/Deals?$select=Id,OwnerId,Amount,FinishDate,LossReasonId&$filter=StatusId%20eq%203%20and%20FinishDate%20ge%20${encodeURIComponent(startMonthIso)}${pipelineFilter}%20and%20(${ownerFilter})`),
      ploomesGetAll(`/InteractionRecords?$select=Id,CreatorId,Date,TypeId&$filter=Date%20ge%20${encodeURIComponent(isoNoZ(cutoff7))}%20and%20(${creatorFilter})`),
      ploomesGetAll(`/Tasks?$select=Id,OwnerId,DateTime,Finished&$filter=Finished%20eq%20false%20and%20(${ownerFilter})`),
    ]);

    const activeDeals = pipelineId ? dealsOpen : dealsOpen.filter(d => !ARCHIVED.includes(d.PipelineId));

    const byOwner = {};
    function ensureOwner(pid) {
      if (!byOwner[pid]) byOwner[pid] = {
        name: dict.userById?.[pid]?.Name || `ID ${pid}`,
        ploomesId: pid, dealsAbertos: 0, receitaAberta: 0,
        dealsGanhosMes: 0, receitaGanhaMes: 0, dealsPerdidosMes: 0, receitaPerdidaMes: 0,
        interacoes7d: 0, visitasReunioes7d: 0, tarefasVencidas: 0, dealsPardos30d: 0,
        riskScore: 0, actions: [],
      };
      return byOwner[pid];
    }

    for (const d of activeDeals) { const r = ensureOwner(d.OwnerId); r.dealsAbertos++; r.receitaAberta += d.Amount || 0; if (d.LastUpdateDate && new Date(d.LastUpdateDate) < cutoff30) r.dealsPardos30d++; }
    for (const d of dealsWonMonth) { const r = ensureOwner(d.OwnerId); r.dealsGanhosMes++; r.receitaGanhaMes += d.Amount || 0; }
    for (const d of dealsLostMonth) { const r = ensureOwner(d.OwnerId); r.dealsPerdidosMes++; r.receitaPerdidaMes += d.Amount || 0; }
    for (const i of interactionsWeek) {
      if (!ownerIds.includes(i.CreatorId)) continue;
      const r = ensureOwner(i.CreatorId); r.interacoes7d++;
      if (i.TypeId === 2 || i.TypeId === 5) r.visitasReunioes7d++;
    }
    for (const t of tasksOpen) {
      if (t.DateTime && new Date(t.DateTime) <= now) ensureOwner(t.OwnerId).tarefasVencidas++;
    }

    const goalsList = db.prepare(`SELECT * FROM goals WHERE year = ? AND month = ?`).all(now.getUTCFullYear(), now.getUTCMonth() + 1);
    const goalsByUserId = Object.fromEntries(goalsList.map(g => [g.user_id, g]));
    const usersList = db.prepare(`SELECT id, ploomes_user_id, display_name FROM app_users WHERE active = 1`).all();
    const appUserByPloomesId = Object.fromEntries(usersList.filter(u => u.ploomes_user_id).map(u => [u.ploomes_user_id, u]));

    for (const [pid, r] of Object.entries(byOwner)) {
      let risk = 0;
      if (r.interacoes7d === 0 && r.dealsAbertos > 0) { risk += 30; r.actions.push('⚠️ Sem interações há 7 dias — verificar motivação'); }
      if (r.tarefasVencidas >= 5) { risk += 20; r.actions.push(`🔴 ${r.tarefasVencidas} tarefas vencidas — cobrar regularização`); }
      if (r.dealsPardos30d >= 10) { risk += 20; r.actions.push(`🟡 ${r.dealsPardos30d} deals parados >30 dias — revisar pipeline`); }
      const appUser = appUserByPloomesId[pid];
      if (appUser) {
        const goal = goalsByUserId[appUser.id];
        if (goal?.valor_mensal > 0) {
          const progress = r.receitaGanhaMes / goal.valor_mensal;
          const monthProgress = now.getUTCDate() / new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
          r.metaProgress = progress; r.metaValor = goal.valor_mensal;
          if (monthProgress > 0.6 && progress < 0.3) { risk += 25; r.actions.push(`🚨 ${Math.round(monthProgress*100)}% do mês passado, ${Math.round(progress*100)}% da meta — intervenção necessária`); }
          else if (monthProgress > 0.4 && progress < 0.2) { risk += 15; r.actions.push(`⚠️ Meta em risco — ${Math.round(progress*100)}% atingida`); }
        }
      }
      if (r.dealsPerdidosMes > r.dealsGanhosMes * 3 && r.dealsPerdidosMes > 5) { risk += 15; r.actions.push(`⚠️ Taxa de conversão baixa este mês (${r.dealsGanhosMes}G / ${r.dealsPerdidosMes}P)`); }
      // Bônus por performance positiva (balancear score)
      if (r.dealsGanhosMes >= 3) risk -= 15;
      if (r.interacoes7d >= 10) risk -= 10;
      if (r.receitaGanhaMes > 50000) risk -= 10;
      r.riskScore = Math.max(0, Math.min(100, risk));
    }

    const criticalAlerts = db.prepare(`
      SELECT * FROM anomaly_alerts
      WHERE severity = 'critical' AND resolved_at IS NULL
        AND detected_at >= datetime('now', '-2 days')
      ORDER BY detected_at DESC LIMIT 10
    `).all();

    const teamTotals = {
      receitaMes: dealsWonMonth.reduce((s,d) => s + (d.Amount||0), 0),
      dealsGanhosMes: dealsWonMonth.length, dealsPerdidosMes: dealsLostMonth.length,
      dealsAbertos: activeDeals.length, receitaAberta: activeDeals.reduce((s,d) => s + (d.Amount||0), 0),
      interacoes7d: interactionsWeek.filter(i => ownerIds.includes(i.CreatorId)).length,
      tarefasVencidas: Object.values(byOwner).reduce((s,r) => s + r.tarefasVencidas, 0),
    };

    const vendedores = Object.values(byOwner)
      .map(r => ({
        ...r,
        ganhosMes: r.dealsGanhosMes,
        receitaMes: r.receitaGanhaMes,
        dealsParados: r.dealsPardos30d,
        metaPct: r.metaProgress != null ? Math.round(r.metaProgress * 100) : null,
      }))
      .sort((a,b) => b.riskScore - a.riskScore || b.receitaGanhaMes - a.receitaGanhaMes);
    res.json({ teamTotals, vendedores, criticalAlerts, generatedAt: now.toISOString() });
  } catch (e) {
    console.error('[gestor-dashboard]', e.message);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

app.get('/api/ranking', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const period = req.query.period || 'month'; // month | quarter | year
    const year = req.query.year ? Number(req.query.year) : now.getUTCFullYear();
    const month = req.query.month ? Number(req.query.month) : (now.getUTCMonth() + 1);

    // Calcular start conforme período
    let periodStart;
    if (period === 'quarter') {
      const q = Math.floor((month - 1) / 3); // 0=Q1, 1=Q2, 2=Q3, 3=Q4
      periodStart = new Date(Date.UTC(year, q * 3, 1, 0, 0, 0));
    } else if (period === 'year') {
      periodStart = new Date(Date.UTC(year, 0, 1, 0, 0, 0));
    } else {
      periodStart = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
    }
    const periodMonth = periodStart.getUTCMonth() + 1;
    const periodYear = periodStart.getUTCFullYear();

    const dict = await loadDictionary();

    // Define scope app users for ranking view
    let scopeAppUserIds = [];
    if (isAdminOrGestor(req)) {
      scopeAppUserIds = db.prepare('SELECT id FROM app_users WHERE active = 1').all().map(r => r.id);
    } else if ((req.session.role || 'vendedor') === 'supervisor') {
      const rows = db.prepare(`
        SELECT tm.user_id
        FROM team_members tm
        JOIN teams t ON t.id = tm.team_id
        WHERE t.supervisor_user_id = ?
      `).all(req.session.userId);
      scopeAppUserIds = [...new Set([req.session.userId, ...rows.map(r => r.user_id)])];
    } else {
      scopeAppUserIds = [req.session.userId];
    }

    // Map to Ploomes ids for filters
    const scopeUsers = db.prepare(`SELECT id, ploomes_user_id FROM app_users WHERE id IN (${scopeAppUserIds.map(()=>'?').join(',')})`).all(...scopeAppUserIds);
    const scopePloomesIds = scopeUsers.map(u => u.ploomes_user_id).filter(Boolean);

    const data = await computeRanking({
      dict,
      scopeOwnerIds: scopePloomesIds,
      scopeCreatorIds: scopePloomesIds,
      scopeAppUserIds,
      year: periodYear,
      month: periodMonth,
      periodStart,
    });
    res.json({ ...data, period, periodLabel: period === 'quarter' ? `Q${Math.ceil(periodMonth/3)}/${periodYear}` : period === 'year' ? String(periodYear) : `${periodMonth.toString().padStart(2,'0')}/${periodYear}` });
  } catch (e) {
    console.error('[ranking]', e);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ─── Goals (admin/gestor) ─────────────────────────────────────
app.get('/api/goals', requireAuth, requireAdmin, (req, res) => {
  const year = req.query.year ? Number(req.query.year) : new Date().getUTCFullYear();
  const month = req.query.month ? Number(req.query.month) : (new Date().getUTCMonth() + 1);
  const userId = req.query.userId ? Number(req.query.userId) : null;
  let rows;
  if (userId) rows = db.prepare('SELECT * FROM goals WHERE user_id = ? AND year = ? AND month = ? ORDER BY updated_at DESC').all(userId, year, month);
  else rows = db.prepare('SELECT * FROM goals WHERE year = ? AND month = ? ORDER BY updated_at DESC').all(year, month);
  res.json(rows);
});

app.post('/api/goals', requireAuth, requireAdmin, (req, res) => {
  const g = req.body || {};
  if (!g.user_id || !g.year) return res.status(400).json({ error: 'user_id e year são obrigatórios' });
  const stmt = db.prepare(`
    INSERT INTO goals (user_id, year, month, valor_mensal, valor_semanal, interacoes_dia, interacoes_semana, funil_id, funil_mensal, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);
  const r = stmt.run(
    Number(g.user_id), Number(g.year), g.month ? Number(g.month) : null,
    Number(g.valor_mensal || 0), Number(g.valor_semanal || 0),
    Number(g.interacoes_dia || 0), Number(g.interacoes_semana || 0),
    g.funil_id ? Number(g.funil_id) : null,
    Number(g.funil_mensal || 0),
  );
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put('/api/goals/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const g = req.body || {};
  const existing = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Meta não encontrada' });
  db.prepare(`
    UPDATE goals
    SET valor_mensal = ?, valor_semanal = ?, interacoes_dia = ?, interacoes_semana = ?, funil_id = ?, funil_mensal = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    Number(g.valor_mensal ?? existing.valor_mensal),
    Number(g.valor_semanal ?? existing.valor_semanal),
    Number(g.interacoes_dia ?? existing.interacoes_dia),
    Number(g.interacoes_semana ?? existing.interacoes_semana),
    (g.funil_id === null || g.funil_id === undefined) ? existing.funil_id : Number(g.funil_id),
    Number(g.funil_mensal ?? existing.funil_mensal),
    id
  );
  res.json({ ok: true });
});

// ─── Coaching summaries ───────────────────────────────────────
app.get('/api/coaching-summaries/:userId', requireAuth, (req, res) => {
  const userId = Number(req.params.userId);
  if (!canAccessUserId(req, userId)) return res.status(403).json({ error: 'Sem permissão' });
  const rows = db.prepare('SELECT id, user_id, summary, score_delta, created_at FROM coaching_summaries WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(userId);
  res.json(rows);
});

// ─── Diagnóstico de qualidade de dados do CRM ─────────────────────
app.get('/api/data-quality', requireAuth, requireAdminOrGestor, async (req, res) => {
  try {
    const result = await computeDataQualityDiagnostic();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ─── CRM Health ────────────────────────────────────────────────
app.get('/api/crm-health', requireAuth, async (req, res) => {
  const role = req.session.role || 'vendedor';
  if (!['admin','gestor','supervisor'].includes(role)) return res.status(403).json({ error: 'Acesso negado' });
  try {
    const result = await computeCrmHealth();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ─── Chat history by user ─────────────────────────────────────
app.get('/api/chat-history/:userId', requireAuth, (req, res) => {
  const userId = Number(req.params.userId);
  if (!canAccessUserId(req, userId)) return res.status(403).json({ error: 'Sem permissão' });
  const rows = db.prepare('SELECT role, content, created_at FROM messages WHERE user_id = ? ORDER BY id ASC LIMIT 2000').all(userId);
  res.json(rows);
});

// ─── Admin APIs (existing kept) ───────────────────────────────
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, display_name, role, active, ploomes_user_id, created_at, last_login FROM app_users ORDER BY created_at ASC').all();
  res.json(users);
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password || password.length < 4) {
    return res.status(400).json({ error: 'E-mail e senha (mínimo 4 caracteres) são obrigatórios' });
  }
  const uname = username.trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM app_users WHERE username = ?').get(uname);
  if (existing) return res.status(409).json({ error: 'Usuário já existe' });
  const userRole = req.body.role || 'vendedor';
  const displayName = req.body.display_name || '';

  // Prefer explicit ploomes_user_id when provided; otherwise resolve by e-mail
  let ploomesId = req.body.ploomes_user_id ? parseInt(req.body.ploomes_user_id) : null;
  let warning = null;
  let resolvedFromEmail = false;
  if (!ploomesId) {
    try {
      const resolved = await resolvePloomesUserByEmail(uname);
      if (resolved?.id) {
        ploomesId = resolved.id;
        resolvedFromEmail = true;
      } else {
        warning = 'Não encontrei este e-mail no Ploomes (Users). Usuário criado sem ploomes_user_id — selecione manualmente no fallback, se necessário.';
      }
    } catch (e) {
      warning = 'Usuário criado, mas falhou a tentativa de resolver ploomes_user_id por e-mail: ' + e.message;
    }
  }

  const result = db.prepare('INSERT INTO app_users (username, password_hash, role, display_name, ploomes_user_id) VALUES (?, ?, ?, ?, ?)')
    .run(uname, hashPassword(password), userRole, displayName, ploomesId);

  res.json({
    ok: true,
    id: result.lastInsertRowid,
    username: uname,
    ploomes_user_id: ploomesId,
    resolvedFromEmail,
    warning
  });
});

app.put('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { password, active, role, display_name, ploomes_user_id } = req.body;
  const user = db.prepare('SELECT * FROM app_users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (user.username === 'paulo' && active === 0) return res.status(400).json({ error: 'Não é possível desativar o admin principal' });

  if (password && password.length >= 4) {
    db.prepare('UPDATE app_users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
  }
  if (active !== undefined) {
    db.prepare('UPDATE app_users SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  }
  if (role) {
    db.prepare('UPDATE app_users SET role = ? WHERE id = ?').run(role, id);
  }
  if (display_name !== undefined) {
    db.prepare('UPDATE app_users SET display_name = ? WHERE id = ?').run(display_name, id);
  }
  if (ploomes_user_id !== undefined) {
    db.prepare('UPDATE app_users SET ploomes_user_id = ? WHERE id = ?').run(ploomes_user_id ? Number(ploomes_user_id) : null, id);
  }
  res.json({ ok: true });
});

// Resolver ploomes_user_id pelo e-mail automaticamente
app.post('/api/admin/users/:id/resolve-ploomes', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM app_users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  try {
    const resolved = await resolvePloomesUserByEmail(user.username);
    if (resolved) {
      db.prepare('UPDATE app_users SET ploomes_user_id = ? WHERE id = ?').run(resolved.id, id);
      return res.json({ ok: true, ploomes_user_id: resolved.id, name: resolved.name });
    }
    return res.json({ ok: false, warning: 'E-mail não encontrado no Ploomes' });
  } catch(e) {
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM app_users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (user.username === 'paulo') return res.status(400).json({ error: 'Não é possível remover o admin principal' });
  db.prepare('DELETE FROM app_users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ─── Teams admin (minimal) ────────────────────────────────────
app.get('/api/admin/teams', requireAuth, requireAdmin, (req, res) => {
  const teams = db.prepare('SELECT * FROM teams ORDER BY created_at DESC').all();
  const members = db.prepare('SELECT * FROM team_members').all();
  res.json({ teams, members });
});

app.post('/api/admin/teams', requireAuth, requireAdmin, (req, res) => {
  const { name, supervisor_user_id } = req.body;
  if (!name?.trim() || !supervisor_user_id) return res.status(400).json({ error: 'name e supervisor_user_id obrigatórios' });
  const r = db.prepare('INSERT INTO teams (name, supervisor_user_id) VALUES (?, ?)').run(name.trim(), Number(supervisor_user_id));
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.post('/api/admin/teams/:teamId/members', requireAuth, requireAdmin, (req, res) => {
  const teamId = Number(req.params.teamId);
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id obrigatório' });
  db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)').run(teamId, Number(user_id));
  res.json({ ok: true });
});

app.delete('/api/admin/teams/:teamId/members/:userId', requireAuth, requireAdmin, (req, res) => {
  const teamId = Number(req.params.teamId);
  const userId = Number(req.params.userId);
  db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, userId);
  res.json({ ok: true });
});

// ─── History API (session-scoped) ─────────────────────────────

// ─── Chat Sessions (histórico individual por usuário) ─────────
app.get('/api/chat-sessions', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT cs.id, cs.title, cs.created_at, cs.last_message_at,
           COUNT(m.id) as msg_count
    FROM chat_sessions cs
    LEFT JOIN messages m ON m.chat_session_id = cs.id
    WHERE cs.user_id = ?
    GROUP BY cs.id
    ORDER BY cs.last_message_at DESC
    LIMIT 20
  `).all(req.session.userId);
  res.json(rows);
});

app.post('/api/chat-sessions', requireAuth, (req, res) => {
  const title = (req.body.title || 'Nova conversa').substring(0, 80);
  const r = db.prepare('INSERT INTO chat_sessions (user_id, title) VALUES (?, ?)')
    .run(req.session.userId, title);
  res.json({ id: r.lastInsertRowid, title });
});

app.put('/api/chat-sessions/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT user_id FROM chat_sessions WHERE id = ?').get(id);
  if (!row || row.user_id !== req.session.userId) return res.status(403).json({ error: 'Sem permissão' });
  const title = (req.body.title || 'Conversa').substring(0, 80);
  db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(title, id);
  res.json({ ok: true });
});

app.delete('/api/chat-sessions/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT user_id FROM chat_sessions WHERE id = ?').get(id);
  if (!row || row.user_id !== req.session.userId) return res.status(403).json({ error: 'Sem permissão' });
  db.prepare('DELETE FROM messages WHERE chat_session_id = ?').run(id);
  db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.get('/api/chat-sessions/:id/messages', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT user_id FROM chat_sessions WHERE id = ?').get(id);
  if (!row || row.user_id !== req.session.userId) return res.status(403).json({ error: 'Sem permissão' });
  const msgs = db.prepare('SELECT role, content, created_at FROM messages WHERE chat_session_id = ? ORDER BY id ASC').all(id);
  res.json(msgs);
});

app.get('/api/history', requireAuth, (req, res) => {
  const msgs = db.prepare('SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY id ASC').all(req.session.id);
  res.json(msgs);
});

app.delete('/api/history', requireAuth, (req, res) => {
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(req.session.id);
  res.json({ ok: true });
});

// ─── Chat principal ───────────────────────────────────────────
// GPT-4o: fetchData + quantitative.
// Claude Haiku: qualitative coaching + report HTML ([PDF_CONTENT]).

// ─── Sync Ploomes users → app_users ────────────────────────────────────────
app.get('/api/sync-ploomes-users', requireAuth, (req, res) => {
  const role = req.session.role || 'vendedor';
  if (!['admin','gestor'].includes(role)) return res.status(403).json({ error: 'Acesso negado' });
  res.json({ message: 'Use POST para sincronizar' });
});

app.post('/api/sync-ploomes-users', requireAuth, async (req, res) => {
  const role = req.session.role || 'vendedor';
  if (!['admin','gestor'].includes(role)) return res.status(403).json({ error: 'Acesso negado' });

  try {
    const dict = await loadDictionary();
    const now = new Date();
    const cutoff90 = new Date(now - 90 * 24 * 60 * 60 * 1000);
    const vendedores = dict.users.filter(u =>
      !u.Suspended && !u.Integration &&
      u.LastSeen && new Date(u.LastSeen) > cutoff90 &&
      u.Email && u.Email.includes('@vetorv')
    );

    const created = [], updated = [], skipped = [];
    for (const v of vendedores) {
      const email = v.Email.toLowerCase().trim();
      const existing = db.prepare('SELECT id, ploomes_user_id FROM app_users WHERE username = ?').get(email);
      if (existing) {
        if (!existing.ploomes_user_id) {
          db.prepare('UPDATE app_users SET ploomes_user_id = ?, display_name = COALESCE(display_name, ?) WHERE id = ?')
            .run(v.Id, v.Name, existing.id);
          updated.push(email);
        } else {
          skipped.push(email);
        }
      } else {
        // criar sem senha (vendedor precisa definir no primeiro login)
        db.prepare('INSERT INTO app_users (username, password_hash, role, display_name, ploomes_user_id) VALUES (?, ?, ?, ?, ?)')
          .run(email, '', 'vendedor', v.Name, v.Id);
        created.push(email);
      }
    }
    res.json({ ok: true, created, updated, skipped, total: vendedores.length });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// [removido: rota duplicada /api/ploomes-users — consolidada acima]

// ─── Saúde do Funil ────────────────────────────────────────────
const funnelHealthCache = new Map(); // key -> {data, ts}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of funnelHealthCache) {
    if (now - v.ts > FUNNEL_HEALTH_CACHE_TTL * 2) funnelHealthCache.delete(k);
  }
}, 10 * 60 * 1000);
const FUNNEL_HEALTH_CACHE_TTL = 4 * 60 * 60 * 1000;
app.get('/api/funnel-health', requireAuth, async (req, res) => {
  const role = req.session.role || 'vendedor';
  if (!['admin','gestor','supervisor'].includes(role)) return res.status(403).json({ error: 'Acesso negado' });
  try {
    const fhKey = `fh_${req.session.userId}_${req.query.pipelineId||''}`;
    const fhCached = funnelHealthCache.get(fhKey);
    if (fhCached && Date.now() - fhCached.ts < FUNNEL_HEALTH_CACHE_TTL) return res.json(fhCached.data);

    const dict = await loadDictionary();
    const now = new Date();
    const cutoff90 = new Date(now - 90 * 24 * 60 * 60 * 1000);

    // Buscar usuários com LastSeen (dicionário não inclui esse campo)
    const usersRaw = await ploomesGetOnce('/Users?$select=Id,Name,Email,Suspended,Integration,LastSeen');
    const allUsers = usersRaw.value || [];
    const activeUsers = allUsers.filter(u =>
      !u.Suspended && !u.Integration &&
      u.LastSeen && new Date(u.LastSeen) > cutoff90 &&
      !EXCLUDED_FROM_ANALYSIS.includes(u.Id)
    );
    const activeUserIds = new Set(activeUsers.map(u => u.Id));
    const userNameById = Object.fromEntries(allUsers.map(u => [u.Id, u.Name]));

    // Buscar todos os deals abertos (sem filtro de owner — front filtra para supervisor)
    // Excluir funis inativos/de teste
    const inactivePipelineFilter = INACTIVE_PIPELINE_IDS.map(id => `PipelineId%20ne%20${id}`).join('%20and%20');
    const pipelineIdFilter = req.query.pipelineId ? `%20and%20PipelineId%20eq%20${Number(req.query.pipelineId)}` : '';
    const deals = await ploomesGetAll(
      `/Deals?$select=Id,OwnerId,Amount,LastUpdateDate,PipelineId,StageId&$filter=StatusId%20eq%201${inactivePipelineFilter ? '%20and%20' + inactivePipelineFilter : ''}${pipelineIdFilter}`
    );

    const today = new Date();
    today.setUTCHours(0,0,0,0);

    // Agrupar por OwnerId (só vendedores ativos)
    const byOwner = {};
    for (const deal of deals) {
      if (!activeUserIds.has(deal.OwnerId)) continue;
      if (!byOwner[deal.OwnerId]) byOwner[deal.OwnerId] = [];
      byOwner[deal.OwnerId].push(deal);
    }

    const result = [];
    for (const [ownerIdStr, ownerDeals] of Object.entries(byOwner)) {
      const ownerId = Number(ownerIdStr);
      const ownerName = userNameById[ownerId] || dict.userById[ownerId] || `Usuário ${ownerId}`;
      let dirty = [];
      let critical = [];
      let maxDays = 0;

      for (const d of ownerDeals) {
        const lastUpdate = d.LastUpdateDate ? new Date(d.LastUpdateDate) : null;
        const days = lastUpdate ? Math.floor((today - lastUpdate) / (1000 * 60 * 60 * 24)) : 9999;
        if (days > maxDays) maxDays = days;
        const enriched = {
          id: d.Id,
          name: d.Name || `Deal #${d.Id}`,
          amount: d.Amount || 0,
          days,
          pipeline: dict.pipelineById[d.PipelineId] || `Pipeline ${d.PipelineId}`,
          stage: dict.stageById[d.StageId] || `Estágio ${d.StageId}`,
          lastUpdateDate: lastUpdate ? lastUpdate.toLocaleDateString('pt-BR') : '—',
        };
        if (days > 60) { critical.push(enriched); dirty.push(enriched); }
        else if (days > 30) { dirty.push(enriched); }
      }

      const status = critical.length > 0 ? 'critico' : dirty.length > 0 ? 'atencao' : 'limpo';
      const dirtyValue = dirty.reduce((s, d) => s + d.amount, 0);
      const pctDirty = ownerDeals.length > 0 ? dirty.length / ownerDeals.length : 0;

      result.push({
        ownerId,
        ownerName,
        status,
        total: ownerDeals.length,
        dirty: dirty.length,
        critical: critical.length,
        maxDays,
        dirtyValue,
        pctDirty,
        dirtyDeals: dirty,
      });
    }

    // Ordenar: mais crítico primeiro (maior % sujos)
    result.sort((a, b) => {
      if (a.status !== b.status) {
        const order = { critico: 0, atencao: 1, limpo: 2 };
        return order[a.status] - order[b.status];
      }
      return b.pctDirty - a.pctDirty;
    });

    funnelHealthCache.set(fhKey, { data: result, ts: Date.now() });
    res.json(result);
  } catch (e) {
    console.error('[funnel-health]', e);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

app.post('/api/chat', requireAuth, chatRateLimit, async (req, res) => {
  const { message, target_ploomes_id, target_name } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Mensagem vazia' });
  const sessionId = req.session.id;

  try {
    const dict = await loadDictionary();

    const history = db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 16').all(sessionId).reverse();

    // Admin/gestor pode conversar sobre um vendedor específico (target_ploomes_id)
    const requesterRole = req.session.role || 'vendedor';
    const canTargetOther = ['admin','gestor','supervisor'].includes(requesterRole);
    let effectivePloomesIds = getAllowedPloomesIds(req); // null = acesso total
    let coachTargetLabel = '';

    if (canTargetOther && target_ploomes_id) {
      // Modo "admin/gestor conversando sobre vendedor X"
      const targetId = parseInt(target_ploomes_id);
      const targetUser = dict.users.find(u => u.Id === targetId);
      const tName = target_name || (targetUser ? targetUser.Name : `Vendedor ID:${targetId}`);
      coachTargetLabel = `\n\n⚙️ CONTEXTO DO COACH: ${req.session.displayName} (${requesterRole}) está pedindo análise do vendedor "${tName}".\nFoque TODOS os dados e análises neste vendedor específico. Fale sobre ele em terceira pessoa (ex: "Rafael tem...", "ela precisa...").\nUse IDs [${targetId}] para filtrar fetches de Deals/Interações/Tarefas.`;
      effectivePloomesIds = [targetId];
    }

    const userRole = requesterRole;
    // Se o usuário logado é dono da empresa (EXCLUDED_FROM_ANALYSIS), orientar visão de time
    const isExcludedUser = EXCLUDED_FROM_ANALYSIS.includes(Number(req.session.ploomesUserId));
    const ownerNote = isExcludedUser && effectivePloomesIds === null
      ? `

⚠️ IMPORTANTE: O usuário logado (${req.session.displayName}) é o dono da empresa e NÃO atua como vendedor. Quando ele fizer perguntas na 1ª pessoa ("meus deals", "minha performance"), interprete como visão de GESTOR/TIME — não filtre por OwnerId dele. Análise de "seus dados" = análise do time.`
      : '';
    const scopeNote = effectivePloomesIds === null
      ? ownerNote
      : `\n⚠️ RESTRIÇÃO: foco nos IDs Ploomes [${effectivePloomesIds.join(', ')}]. Filtre todos os fetches por OwnerId/CreatorId nesses IDs.${coachTargetLabel}`;

    const activeVendors = dict.users.filter(u => !u.Suspended && !u.Integration);

    const systemPrompt = `Você é um analista sênior de CRM e Sales Coach da VetorV (compressores, ar comprimido, locação e manutenção B2B).
${scopeNote}

## EXCLUSÕES PERMANENTES DE ANÁLISE
- Paulo Victor (ID Ploomes: 10001176) é o dono da empresa e NÃO atua como vendedor. NUNCA inclua Paulo Victor em rankings, médias, análises de performance ou qualquer comparação de equipe. Filtre-o de TODOS os resultados.
- Sarah Baliana (ID Ploomes: 60023650) é gestora e NÃO é vendedora. NUNCA inclua Sarah em rankings, médias ou análises de performance de vendedores.
- FATURAMENTO (ID Ploomes: 10025857) é um usuário de integração/financeiro e NÃO é vendedor. NUNCA inclua FATURAMENTO em análises de performance.
- Funis inativos/de teste (PipelineId: 60009328 = "[Cópia] - Manutenção da Carteira"): NUNCA incluir deals desses funis em análises. Ao fazer fetch de Deals, sempre adicionar filtro: PipelineId ne 10013804 and PipelineId ne 10016564 and PipelineId ne 60000288 and PipelineId ne 60009328 and PipelineId ne 60011853.
- IDs excluídos de análise: ${EXCLUDED_FROM_ANALYSIS.join(', ')}. Esses IDs não devem aparecer em nenhum resultado, média ou ranking.

## REGRA DE SUJEITO E PERSPECTIVA (CRÍTICO)
- Quando analisando dados do time, o sujeito é sempre "a equipe / o time / [nome do vendedor]". NUNCA use "você" quando estiver falando de terceiros.
- Quando analisando um vendedor específico (target): use SEMPRE o nome dele na 3ª pessoa. NUNCA troque para "você" no meio do texto.
- Quando o próprio usuário está no chat (sem target): use "você" consistentemente do início ao fim.
- NUNCA misture perspectivas na mesma resposta.

## INDICADORES CALCULADOS NO SERVIDOR (CRÍTICO)
- Conversão, ticket médio, interações, preenchimento e abandonos são injetados como **[INDICADORES CALCULADOS]** na mensagem do usuário.
- Use os números injetados diretamente. **NÃO recalcule fórmulas** nem reinterprete o denominador.
- Funis Manutenção da Carteira e Prospecção **não entram** em conversão/receita por design.

## QUALIDADE DE DADOS DO CRM (CRÍTICO — PREMISSA GERAL)
**ATENÇÃO: Os dados do CRM da VetorV podem estar incompletos ou incorretamente preenchidos.**
Os vendedores historicamente não seguiam processos de preenchimento. Isso impacta TODA análise.

Regras obrigatórias:
- NUNCA apresente número como "verdade" quando há suspeita de dado sujo — SEMPRE com ressalva explícita
- Ao identificar padrão muito concentrado (>70% em 1 motivo), SEMPRE levantar hipótese de preenchimento incorreto
- Quando a qualidade comprometer a análise: informar o que está comprometido E o que precisaria ser corrigido
- Em análises completas: incluir seção "Diagnóstico de Qualidade" antes de qualquer conclusão
- Ao analisar um vendedor: verificar se ele está preenchendo corretamente (motivo de perda, valor, atualização de etapa)

Indicadores de dado suspeito (verificar sempre):
- % deals perdidos sem motivo de perda preenchido (>20% = alerta; >40% = crítico)
- % deals ganhos com Amount = 0 ou nulo (>10% = alerta)
- % pipeline em aberto sem update há >90 dias (>30% = alerta de pipeline podre)
- Um único motivo de perda com >80% em um funil (possível atalho/default)
- Deals ganhos com ciclo <2 dias em funis longos (possível registro tardio)
- Deals sem OwnerId (>0 = dado inconsistente)

Quando o usuário perguntar sobre qualidade de dados:
1. Buscar /Deals perdidos últimos 180d → checar LossReasonId nulo
2. Buscar /Deals ganhos últimos 180d → checar Amount = 0
3. Buscar /Deals abertos → checar LastUpdateDate > 90/180d atrás
4. Buscar motivos de perda por funil → identificar concentração anormal
5. Calcular score de qualidade e apresentar diagnóstico por dimensão

## MOTIVOS DE PERDA — REGRA CRÍTICA: SEMPRE POR FUNIL
- NUNCA some motivos de perda de funis diferentes e apresente como um único percentual geral.
- Funis diferentes têm nomenclaturas de motivos DISTINTAS. Misturar distorce completamente a análise.
- Ao analisar motivos de perda: SEMPRE segmente por PipelineId e apresente SEPARADO por funil.
- Formato correto: "No funil X, os principais motivos foram: ... | No funil Y, os principais motivos foram: ..."
- Se o usuário perguntar de todos os funis sem especificar: mostre o breakdown por funil, não um total.
- Se o usuário especificar um funil ou vendedor: filtre por esse funil/vendedor e mostre apenas aquele breakdown.
- Para buscar motivos: SEMPRE inclua PipelineId no $select. Ex: $select=Id,LossReasonId,PipelineId,OwnerId
- Ao analisar motivos de perda de UM vendedor específico: SEMPRE faça fetch com filtro de OwnerId desse vendedor. NUNCA reutilize dados de todos os vendedores para filtrar depois — isso distorce os percentuais por funil.

## REGRA DE TAREFAS — METRICAS SEMPRE ESPECIFICADAS
Voce DEVE sempre especificar qual das 3 metricas esta reportando:
- **Backlog atual** = tasks abertas AGORA (sem filtro de data no DateTime — conta tudo em aberto)
- **Overdue atual** = tasks abertas cujo DateTime < agora (vencidas no momento)
- **Fluxo do periodo** = tasks criadas ou finalizadas NESSE periodo especifico
Jamais reporte "tarefas em aberto" sem classificar em qual das 3 categorias acima.

## REGRA CRÍTICA — COLETA DE DADOS
Para responder qualquer pergunta que envolva números, você DEVE primeiro emitir um ou mais fetches no formato abaixo.
NÃO responda sem dados. NÃO invente números. Se não tiver dados, emita o fetch.


## PERFORMANCE / BOAS PRÁTICAS (OBRIGATÓRIO)
- Se a pergunta for ampla (ex.: "como foi o trimestre", "pipeline", "performance geral"), escolha uma janela padrão e DECLARE: últimos 30/90/180 dias.
- Sempre inclua filtro de data nos endpoints /Deals, /Tasks e /InteractionRecords (FinishDate/LastUpdateDate, DateTime, Date).
- Prefira agregações (totais + top N) e queries pequenas. Evite puxar listas gigantes "para depois filtrar".
- Para pipeline em aberto (StatusId eq 1): o filtro de data é OPCIONAL. Sem filtro retorna todos os deals ativos, o que é correto para análise de pipeline total. Se quiser apenas deals recentemente movimentados, adicione LastUpdateDate ge <data>.
- Para Deals ganhos/perdidos (/Deals com StatusId eq 2 ou 3): SEMPRE inclua FinishDate no filtro.
- Para /Tasks e /InteractionRecords: SEMPRE inclua DateTime/Date no filtro.
- Não force filtro de data quando o objetivo é ver o pipeline completo.

Formato exato do fetch (uma linha por fetch, JSON puro):
{"action":"fetch","url":"/Endpoint?$filter=...&$select=...","description":"descrição do que busca"}

Exemplos de fetches comuns:
## CAMPOS PROIBIDOS em /Deals (causam erro 403): Name, Subject, Description, StageName, ReasonId
- Use APENAS: Id, OwnerId, Amount, StatusId, StageId, PipelineId, FinishDate, LastUpdateDate, LossReasonId, DaysInStage, ContactId, AccountId, DealCustomFields

- Deals ganhos no mês: {"action":"fetch","url":"/Deals?$filter=StatusId eq 2 and FinishDate ge 2026-05-01T00:00:00Z&$select=Id,OwnerId,Amount,FinishDate","description":"Deals ganhos em maio/2026"}
- Tarefas vencidas: {"action":"fetch","url":"/Tasks?$filter=Finished eq false&$select=Id,OwnerId,DateTime,Finished","description":"Tarefas em aberto para identificar vencidas"}
- Interações 30 dias: {"action":"fetch","url":"/InteractionRecords?$filter=Date ge 2026-04-10T00:00:00Z&$select=Id,CreatorId,TypeId,Date,ContactId","description":"Interações últimos 30 dias"}
- Deals em aberto: {"action":"fetch","url":"/Deals?$filter=StatusId eq 1&$select=Id,OwnerId,Amount,LastUpdateDate,StageId,PipelineId","description":"Pipeline em aberto"}

## SEGMENTAÇÃO POR FUNIL (OBRIGATÓRIO)
- TODA análise de conversão, ciclo de venda, ticket médio ou motivos de perda deve ser POR FUNIL.
- Funis têm etapas, ciclos e tickets diferentes — misturá-los distorce todos os números.
- Sempre declare antes de calcular: **funil + período + tipo (snapshot ou fluxo)**
- Snapshot = foto do pipeline agora (deals em aberto, aging, por etapa)
- Fluxo = o que aconteceu no período (ganhos, perdas, conversão, ciclo)
- NUNCA use snapshot para responder pergunta de fluxo e vice-versa.

## INDICADORES E LIMITAÇÕES (SEM FÓRMULAS)
- Quando a pergunta for sobre conversão/ticket/abandonos/interações: priorize os **[INDICADORES CALCULADOS]**.
- Se precisar buscar algo que não esteja nos indicadores, faça fetches e explique a limitação quando aplicável.
- Limitação conhecida: não é possível calcular conversão por etapa para o funil inteiro via API (histórico de etapas exige DealId específico).

## ALERTAS DE QUALIDADE AUTOMÁTICOS (SEMPRE VERIFICAR)
Após receber dados, SEMPRE verificar e alertar quando:
1. Um único motivo de perda concentra >80% das perdas em um funil → ⋮ "Atenção: 80%+ das perdas no funil X são classificadas como [motivo]. Isso pode indicar preenchimento padrão incorreto."
2. >20% dos deals perdidos sem motivo preenchido → alertar sobre dado incompleto
3. >30% do pipeline aberto sem atualização há >60 dias → alertar risco de pipeline podre
4. Deals ganhos com Amount = 0 → alertar inconsistência de dado (verifique "inconsistencias" nos agregados)
5. Ciclos de venda muito curtos (<2 dias) em funis tipicamente longos → suspeitar de registro tardio

## INCONSISTÊNCIAS DETECTADAS AUTOMATICAMENTE
- Os agregados incluem "inconsistencias" com deals ganhos sem valor (Amount=0)
- Ao responder, mencionar se encontrou inconsistências: "Foram encontrados X deals ganhos com valor = 0 — isso pode distorcer o ticket médio"

## ESTRUTURA DA RESPOSTA PARA GESTOR
Quando a pergunta for executiva (resumo, panorama, relatório):
1. Snapshot do pipeline (volume + valor + alertas de staleness crítico por SLA do funil)
2. Fluxo do período (ganhos/perdas/win rate/ciclo por funil)
3. Motivos de perda por funil (com alerta se >80% em 1 motivo)
4. Alertas de qualidade (se dado suspeito)
5. Top 3 vendedores + Bottom 3 (por win rate ou volume)
6. 3 ações concretas + 1 risco principal

## REGRA DE FORMATO DA RESPOSTA FINAL
Após receber os dados dos fetches, escreva a análise em português. Seja específico com números reais.
- Nunca exiba IDs numéricos na resposta
- Use nomes dos vendedores (veja mapeamento fornecido)
- Estrutura: contexto → dados → insights → próximos passos
- Termine sempre com 3 ações concretas e priorizadas
- Se falhar em buscar dados: diga claramente qual dado faltou e o que pode impactar na análise`;

    const nowCtx = new Date();
    const todayISO = nowCtx.toISOString().slice(0, 10);
    const thisMonthStartISO = new Date(Date.UTC(nowCtx.getUTCFullYear(), nowCtx.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const thisMonthEndISO = new Date(Date.UTC(nowCtx.getUTCFullYear(), nowCtx.getUTCMonth()+1, 1)).toISOString().slice(0, 10);

    // Inject data quality context when question is about data quality
    let dataQualityContext = '';
    if (/qualidade.*dado|dado.*crm|crm.*qualidade|quantos.*sem|preenchimento|dado.*sujo|auditoria.*dado/i.test(message)) {
      try {
        const dqResult = await computeDataQualityDiagnostic();
        if (!dqResult.error) {
          dataQualityContext = `\n\n[DIAGNÓSTICO DE QUALIDADE DO CRM — calculado ao vivo]:\n${JSON.stringify(dqResult, null, 2)}\n\nUSE ESSES DADOS PARA RESPONDER — não faça fetches adicionais de qualidade se já está aqui.`;
        }
      } catch {}
    }

    // Inject CRM health context (always, for every chat — cached 1h)
    let crmHealthContext = '';
    try {
      const healthData = await computeCrmHealth();
      if (!healthData.error) {
        const s = healthData.summary;
        const vendorScores = (healthData.vendors || []).map(v =>
          `${v.ownerName}: score=${v.hygieneScore}(${v.hygieneLabel}) abandonados=${v.abandoned.count}(${v.abandoned.classification}) semValor=${v.noValue.count} perdasSemMotivo=${v.lostNoReason.noReason}/${v.lostNoReason.total}`
        ).join('; ');
        crmHealthContext = `\n\n[ESTADO DO CRM — calculado agora, use para calibrar confiança das análises]:\n- deals_abandonados_total=${s.totalAbandonedDeals} (abertos sem atualização >90d)\n- perdas_sem_motivo=${s.totalLostNoReason} (${s.pctLostNoReason}% dos ${s.totalLostDeals180d} perdidos nos últimos 180d, excluindo Carteira e Prospecção)\n- scores_por_vendedor: ${vendorScores}\nINSTRUÇÃO OBRIGATÓRIA: Ao final de QUALQUER análise de performance, sempre acrescente uma seção de alerta de qualidade dos dados: "⚠️ Qualidade dos dados: ${s.totalLostNoReason} deals perdidos sem motivo de perda, ${s.totalAbandonedDeals} deals abandonados. Esses dados podem afetar a precisão desta análise." (adapte os números se analisar vendedor específico)`;
      }
    } catch {}

    // Inject pre-calculated sales indicators (30d) to avoid LLM having to compute formulas
    let salesIndicatorsContext = '';
    try {
      const indicators = await computeSalesIndicators(effectivePloomesIds === null ? null : effectivePloomesIds, 30);
      if (!indicators.error) {
        const lines = ['\n\n[INDICADORES CALCULADOS — últimos 30d, USE ESTES NÚMEROS DIRETAMENTE (não recalcule):'];
        lines.push('\nConversão por funil (apenas funis de venda real):');
        for (const [pid, v] of Object.entries(indicators.conversionByPipeline)) {
          lines.push(`  - ${v.name}: ${v.won} ganhos, ${v.lost} perdidos → win rate ${v.winRate}`);
        }
        lines.push('\nTicket médio por funil:');
        for (const [pid, v] of Object.entries(indicators.ticketByPipeline)) {
          lines.push(`  - ${v.name}: média R$${v.mean.toLocaleString('pt-BR')}, mediana R$${v.median.toLocaleString('pt-BR')} (${v.count} deals)`);
        }
        lines.push('\nDeals abandonados (abertos >90d sem update):');
        for (const [oid, v] of Object.entries(indicators.abandonedByOwner)) {
          lines.push(`  - ${v.name}: ${v.count} deals (pior: ${v.worst}, risco R$${v.valueAtRisk.toLocaleString('pt-BR')})`);
        }
        lines.push('\nPreenchimento motivo de perda:');
        for (const [oid, v] of Object.entries(indicators.fillRateByOwner)) {
          lines.push(`  - ${v.name}: ${v.lossWithReason}/${v.lossTotal} (${v.pct})`);
        }
        lines.push('\nInterações registradas (30d):');
        for (const [oid, v] of Object.entries(indicators.interactionsByOwner)) {
          lines.push(`  - ${v.name}: ${v.count}`);
        }
        if (indicators.dataQualityAlerts.length > 0) {
          lines.push('\n⚠️ Alertas de qualidade:');
          for (const a of indicators.dataQualityAlerts) lines.push(`  - ${a}`);
        }
        lines.push('\nNOTA: Funil Manutenção da Carteira e Funil Prospecção NÃO estão nas taxas de conversão ou receita acima (excluídos por design).]');
        salesIndicatorsContext = lines.join('\n');
      }
    } catch {}

    // Inject FONTE DOS DADOS context (lógica de 3 datas — versão final)
    let fonteContext = '';
    try {
      const currentState = isCurrentStateQuery(message);
      const inferredRange = inferDateRangeFromMessage(message);
      const ds = resolveDataSource(
        inferredRange ? inferredRange.startDate : null,
        inferredRange ? inferredRange.endDate : null,
        currentState
      );
      const sourceLabel = {
        warehouse: 'warehouse — dados estáveis, zero chamada API',
        recent: 'recente (API → upsert no warehouse) — dados até ontem',
        api: 'API direta — warehouse não cobre',
      }[ds.source] || ds.source;
      const periodLabel = inferredRange
        ? `${inferredRange.startDate.toISOString().slice(0,10)} a ${inferredRange.endDate.toISOString().slice(0,10)}`
        : '(sem data especificada — estado atual)';
      let fonteLines = [
        `\n\n[FONTE DOS DADOS]:`,
        `- Período solicitado: ${periodLabel}`,
        `- Última extração do warehouse: ${ds.lastExtractionISO ? ds.lastExtractionISO.slice(0,10) : 'N/A'}`,
        `- Fonte usada: ${sourceLabel}`,
        `- Motivo: ${ds.reason}`,
      ];
      if (ds.source === 'recent' && ds.recentSinceISO) {
        fonteLines.push(`- Puxar da API desde: ${ds.recentSinceISO.slice(0,16).replace('T',' ')} UTC (LastUpdateDate ge ${ds.recentSinceISO})`);
        fonteLines.push(`- INSTRUCÃO: faça fetch da API com esse filtro e faça upsert (INSERT OR REPLACE) no warehouse antes de responder`);
      }
      if (ds.source === 'warehouse') {
        fonteLines.push(`- INSTRUCÃO: use os dados do warehouse diretamente, sem chamada API adicional para esse período`);
      }
      fonteContext = fonteLines.join('\n');
    } catch {}

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: message + dataQualityContext + crmHealthContext + salesIndicatorsContext + fonteContext + `\n\n[CONTEXTO TEMPORAL] Hoje: ${todayISO} | Mês atual: ${thisMonthStartISO} a ${thisMonthEndISO} | Fuso: UTC\n\nVendedores ativos (nome->id para filtros de busca, NÃO MOSTRE NA RESPOSTA):\n` + activeVendors.map(u => `${u.Name} => ${u.Id}`).join('\n') + `\n\nMapeamento completo IDs->Nomes (use para resolver IDs nos dados da API, NÃO MOSTRE ESTA LISTA):\n` + dict.users.map(u => `${u.Id} => ${u.Name}`).join('\n') + `\n\nFunis (PipelineId->Nome, NÃO MOSTRE ESTA LISTA):\n` + Object.entries(dict.pipelineById || {}).map(([id, name]) => `${id} => ${name}`).join('\n') + `\n\nMotivos de perda (LossReasonId->Nome, NÃO MOSTRE ESTA LISTA):\n` + Object.entries(dict.lossReasonById || {}).map(([id, name]) => `${id} => ${name}`).join('\n') }
    ];

    // Save user msg
    const chatSessionId = req.body.chat_session_id ? Number(req.body.chat_session_id) : null;
    const cacheUserId = req.session.userId;

    // Inject session cache context into system prompt
    const sessionCacheCtx = getSessionCacheContext(cacheUserId, chatSessionId);
    const systemPromptWithCache = systemPrompt + sessionCacheCtx;

    db.prepare('INSERT INTO messages (session_id, user_id, role, content, chat_session_id) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, req.session.userId, 'user', message, chatSessionId);

    // Usar Claude em todo o fluxo (mais preciso em seguir instruções de fetch e análise)
    let gptResponse = await askClaudeMessages(messages, systemPromptWithCache);

    // execute fetches (up to 5 rounds)
    let totalFetches = 0;
    let totalRecords = 0;

    // Campos que causam 403 na API Ploomes quando usados em /Deals
    const DEALS_FORBIDDEN_FIELDS = ['Name', 'Subject', 'Description', 'StageName', 'ReasonId'];
    function sanitizeDealSelect(url) {
      return sanitizeDealSelectGlobal(url);
    }

    function injectRequiredSelects(url) {
      url = sanitizeDealSelect(url);
      if (/\/Tasks/.test(url) && url.includes('$select=') && !url.includes('DateTime')) {
        url = url.replace(/(\$select=[^&]*)/, '$1,DateTime,Finished,FinishDate,OwnerId');
      }
      if (/\/Deals/.test(url) && url.includes('$select=') && !url.includes('StatusId')) {
        url = url.replace(/(\$select=[^&]*)/, '$1,StatusId,OwnerId,PipelineId,Amount,LastUpdateDate,FinishDate');
      }
      if (/\/Deals/.test(url) && url.includes('$select=') && !url.includes('CreateDate')) {
        url = url.replace(/(\$select=[^&]*)/, '$1,CreateDate');
      }
      if (/\/InteractionRecords/.test(url) && url.includes('$select=')) {
        if (!url.includes('CreatorId')) url = url.replace(/(\$select=[^&]*)/, '$1,CreatorId');
        if (!url.includes('TypeId')) url = url.replace(/(\$select=[^&]*)/, '$1,TypeId');
        if (!url.includes(',Date') && !url.includes('=Date')) url = url.replace(/(\$select=[^&]*)/, '$1,Date');
      }
      return url;
    }

    for (let round = 0; round < 5; round++) {
      const jsonMatches = [...gptResponse.matchAll(/\{"action"\s*:\s*"fetch"\s*,\s*"url"\s*:\s*"([^"]+)"\s*,\s*"description"\s*:\s*"([^"]+)"\s*\}/g)];
      if (jsonMatches.length === 0) break;

      const fetchResults = [];
      for (const match of jsonMatches) {
        let url = injectRequiredSelects(match[1]);
        const desc = match[2];
        // Check session cache first
        const cached = getCachedFetch(cacheUserId, chatSessionId, url);
        if (cached) {
          console.log(`[cache HIT] [fetch r${round+1}] ${desc} -> ${url}`);
          totalFetches++;
          totalRecords += (cached.total || 0);
          fetchResults.push({ description: desc, url, total: cached.total, aggregates: cached.aggregates, sample: cached.sample });
        } else {
          console.log(`[cache MISS] [fetch r${round+1}] ${desc} -> ${url}`);
          try {
            const out = await ploomesFetchForModel(url);
            // For InteractionRecords with > 20 results, compute per-creator aggregates
            if (/\/InteractionRecords/i.test(url) && out.total > 20) {
              const aggr = await ploomesGetInteractionAggregates(url);
              if (!aggr.error) out.aggregates = { ...out.aggregates, ...aggr };
            }
            // For Tasks with > 20 results, compute per-owner count aggregates
            if (/\/Tasks/i.test(url) && out.total > 20) {
              const dict4 = await loadDictionary();
              const taskAggr = await ploomesGetTasksOwnerAggregates(url, dict4.userById);
              if (!taskAggr.error) out.aggregates = { ...out.aggregates, byOwnerCount: taskAggr.byOwnerCount };
            }
            // For Deals with LossReasonId in select and > 20 results, compute loss reason aggregates
            if (/\/Deals/i.test(url) && url.includes('LossReasonId') && out.total > 20) {
              const dict2 = await loadDictionary();
              const lossAggr = await ploomesGetLossReasonAggregates(url, dict2.lossReasonById, dict2.pipelineById);
              if (!lossAggr.error) out.aggregates = { ...out.aggregates, lossReasonBreakdown: lossAggr.byReason, lossReasonByPipeline: lossAggr.byPipeline, lossReasonByOwner: lossAggr.byOwnerReason };
            }
            // For Deals (ganhos/perdidos/abertos) com > 5 results, compute per-owner aggregates (taxa conversão, ciclo, ticket mediana, pipeline velocity por funil)
            if (/\/Deals/i.test(url) && out.total > 5) {
              const dict3 = await loadDictionary();
              const ownerAggr = await ploomesGetDealsOwnerAggregates(url, dict3.userById);
              if (!ownerAggr.error) out.aggregates = { ...out.aggregates, byOwnerAmount: ownerAggr.byOwnerAmount, pipelineMetrics: ownerAggr.pipelineMetrics, globalTicketMedia: ownerAggr.globalTicketMedia, globalTicketMediana: ownerAggr.globalTicketMediana, inconsistencias: ownerAggr.inconsistencias };
            }
            const payload = { total: out.total, aggregates: out.aggregates, sample: (out.sample || []).slice(0, 20) };
            setCachedFetch(cacheUserId, chatSessionId, url, payload);
            totalFetches++;
            totalRecords += (out.total || 0);
            fetchResults.push({ description: desc, url, total: out.total, aggregates: out.aggregates, sample: out.sample });
          } catch (e) {
            fetchResults.push({ description: desc, url, error: e.message });
          }
        }
      }

      const dataContext = fetchResults.map(r => r.error
        ? `ERRO em ${r.description} (${r.url}): ${r.error}`
        : `DADOS ${r.description}: total=${r.total}\nAGREGADOS: ${JSON.stringify(r.aggregates || {}, null, 2)}\nAmostra (até 20):\n${JSON.stringify(r.sample, null, 2)}`
      ).join('\n\n---\n\n');

      gptResponse = await askClaudeMessages([
        ...messages,
        { role: 'assistant', content: gptResponse },
        { role: 'user', content: `Retorno da API Ploomes (use para análise, sem inventar):\n\n${dataContext}` }
      ], systemPromptWithCache);
    }

    // Claude layer: qualitative coaching + PDF (if requested)
    const wantsPdf = /\b(pdf|relat[oó]rio|exportar)\b/i.test(message);

    let finalResponse = gptResponse;

    // Claude faz a síntese final somente se houve fetches reais
    // (se não houve fetches, o gptResponse já é a resposta do Claude e está ok)
    if (Anthropic && ANTHROPIC_API_KEY && totalFetches > 0) {
      const today = new Date();
      const diaDoMes = today.getUTCDate();
      const diasRestantes = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth()+1, 0)).getUTCDate() - diaDoMes;
      const diasUteisRestantes = Math.round(diasRestantes * 22/30);
      const diasUteisDecorridos = Math.max(1, Math.round(diaDoMes * 22/30));

      const claudeSystem = `Você é um Sales Coach de alta performance especializado em vendas B2B industriais (VetorV — compressores, ar comprimido, locação e manutenção). Combine análise rigorosa de dados com desenvolvimento humano concreto.

## Metodologias dominadas:
- SPIN Selling: identifica Situação/Problema/Implicação/Necessidade nos padrões de dados
- Challenger Sale: identifica se o vendedor educa/personaliza/controla vs. só relacionamento
- MEDDIC: verifica Métricas, Comprador Econômico, Critérios/Processo de Decisão presentes
- Funil de conversão por etapa: taxa por estágio e onde está o gargalo

## Vendas B2B industrial — benchmarks:
- Ciclos típicos: 30-90 dias dependendo do porte do cliente
- 5-12 interações antes do fechamento (B2B industrial)
- Pipeline saudável: ≥3x a meta em valor em aberto
- Interações de valor: visita > reunião > ligação > WhatsApp > email
- Stagnação >30d = risco iminente; >60d = provavelmente perdido

## Divisão inteligente de metas (SEMPRE aplicar):
Quando tiver dado de meta mensal, calcule e mostre o ritmo necessário:
- Meta de valor mensal ÷ 4 = meta semanal; ÷ 22 = meta por dia útil
- Meta de interações mensais ÷ 22 = interações/dia útil necessárias
- Compare com realizado e projete: "Ao ritmo atual você fecha o mês com R$X (Y% da meta)"
- Referência: hoje é dia ${diaDoMes} do mês. Dias úteis decorridos: ~${diasUteisDecorridos}. Dias úteis restantes: ~${diasUteisRestantes}.
- Ex: "Meta: R$50k/mês → R$12,5k/semana → R$2,3k/dia útil. Você realizou R$X em ${diasUteisDecorridos} dias úteis — ritmo de R$Y/dia."

## Análise de perfil comportamental (infira dos dados):
- Alto volume de interações + baixo fechamento → orientado a relacionamento; falta senso de urgência
- Poucos contatos + alta conversão → consultivo/assertivo; qualifica bem mas pode perder volume
- Muitos deals abertos há >60d → evita conflito/decisão; precisa trabalhar técnica de fechamento
- Tarefas vencidas altas → problema de organização ou sobrecarga; urgente endereçar
- Poucas visitas, muitas mensagens → pode estar evitando contato de alto valor; incentivar presencial

## Identificação de padrões (seja específico):
- "Você tende a perder deals na etapa [X] — isso sugere [objeção de preço não trabalhada / proposta sem follow-up / falta de urgência criada]"
- "Você abre bem o funil mas fecha pouco → qualificação inicial pode estar fraca (SPIN: está descobrindo a implicação do problema?)"

## Desenvolvimento humano (equilibrar análise e encorajamento):
- Reconheça vitórias explicitamente: "Parabéns pelos X deals ganhos este mês — isso é resultado direto do seu esforço"
- Em baixa performance: seja encorajador com base em dados reais, não genérico
- Seja direto sobre o que precisa mudar — sem rodeios, com respeito e solução clara
- Foco em comportamentos específicos, não críticas vagas

## Regras de output:
- NÃO invente números: use apenas o que está na resposta do analista
- Estrutura clara: contexto → análise → insight → ação
- Se houver análise de performance: [COACH_SUMMARY]...[/COACH_SUMMARY] com 3-6 bullets densos (comportamento + número + recomendação concreta)
- Se pedir relatório/pdf: HTML completo em [PDF_CONTENT]...[/PDF_CONTENT] com design profissional e logo VetorV
- Termine sempre com 1-3 próximos passos priorizados e concretos (com prazo quando possível)`;

      const claudeUser = `Pergunta do usuário:\n${message}\n\nResposta analítica (com dados):\n${gptResponse}\n\nSaída final:`;

      try {
        const claudeText = await askClaude({ system: claudeSystem, user: claudeUser });
        if (claudeText?.trim()) finalResponse = claudeText.trim();
      } catch (e) {
        console.error('[claude] failed:', e.message);
      }
    }

    // Persist coaching summary if present
    const coachMatch = finalResponse.match(/\[COACH_SUMMARY\]([\s\S]*?)\[\/COACH_SUMMARY\]/i);
    if (coachMatch && coachMatch[1]?.trim()) {
      const summary = coachMatch[1].trim();
      db.prepare('INSERT INTO coaching_summaries (user_id, summary, score_delta) VALUES (?, ?, ?)')
        .run(req.session.userId, summary, 0);
    }

    // save assistant msg
    db.prepare('INSERT INTO messages (session_id, user_id, role, content, chat_session_id) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, req.session.userId, 'assistant', finalResponse, chatSessionId);

    // Atualizar last_message_at e title da sessão se necessário
    if (chatSessionId) {
      db.prepare('UPDATE chat_sessions SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?').run(chatSessionId);
      // Auto-title: usar primeiras palavras da primeira mensagem se ainda for "Nova conversa"
      const sess = db.prepare('SELECT title FROM chat_sessions WHERE id = ?').get(chatSessionId);
      if (sess && sess.title === 'Nova conversa') {
        const autoTitle = message.substring(0, 50).trim() + (message.length > 50 ? '...' : '');
        db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(autoTitle, chatSessionId);
      }
    }

    res.json({
      response: finalResponse,
      fetchData: totalFetches > 0 ? { consultas: totalFetches, totalRegistros: totalRecords } : null,
      wantsPdf,
    });

  } catch (e) {
    console.error('[chat error]', e);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ─── Chat Coach (rota separada com systemPrompt socrático) ─────────────────
app.post('/api/chat/coach', requireAuth, chatRateLimit, async (req, res) => {
  const { message, target_ploomes_id, target_name } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Mensagem vazia' });
  const sessionId = req.session.id;

  try {
    const dict = await loadDictionary();
    const history = db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 16').all(sessionId).reverse();

    // Admin/gestor/supervisor pode coachar um vendedor específico (target_ploomes_id)
    const requesterRole = req.session.role || 'vendedor';
    const canTargetOther = ['admin','gestor','supervisor'].includes(requesterRole);
    let effectivePloomesIds = getAllowedPloomesIds(req); // null = acesso total
    let coachTargetLabel = '';

    if (canTargetOther && target_ploomes_id) {
      const targetId = parseInt(target_ploomes_id);
      const targetUser = dict.users.find(u => u.Id === targetId);
      const tName = target_name || (targetUser ? targetUser.Name : `Vendedor ID:${targetId}`);
      coachTargetLabel = `\n\n⚙️ CONTEXTO DO COACHING:\n- Vendedor em desenvolvimento: "${tName}" (ID: ${targetId})\n- REGRA CRÍTICA DE DADOS:\n  1) Dados do vendedor "${tName}": SEMPRE filtrar por OwnerId/CreatorId = [${targetId}]. Use para análise individual e desenvolvimento.\n  2) Dados de outros vendedores (benchmark): quando for útil comparar, faça fetch SEM filtro de owner para obter média do time. NUNCA some/misture os números do vendedor com os do time.\n  3) Apresente SEPARADO: "Você (${tName}): X" e "Média do time: Y". Nunca some ou combine.\n  4) Nunca atribua resultados de outros vendedores ao vendedor em desenvolvimento.\n- Fale sobre ${tName} em terceira pessoa quando reportando para gestor.`;
      effectivePloomesIds = [targetId];
    }

    const isExcludedCoach = EXCLUDED_FROM_ANALYSIS.includes(Number(req.session.ploomesUserId));
    const scopeNote = effectivePloomesIds === null
      ? (isExcludedCoach
          ? `\n⚠️ CONTEXTO: O usuário logado (${req.session.displayName}) é o dono da empresa e NÃO atua como vendedor. Perguntas na 1ª pessoa ("minha performance", "meus deals") devem ser interpretadas como visão de GESTOR — apresente dados do time, NUNCA filtre por OwnerId do usuário logado.`
          : `\n⚠️ CONTEXTO: Você está conversando com ${req.session.displayName} (role: ${requesterRole}), sem vendedor selecionado. Acesso total ao time.`)
      : `\n⚠️ RESTRIÇÃO PRIMÁRIA: dados individuais filtrados por OwnerId/CreatorId = [${effectivePloomesIds.join(', ')}].\n⚠️ BENCHMARK PERMITIDO: para comparar com o time, faça fetch separado SEM filtro de owner e apresente como "média do time" — NUNCA misture com os dados do vendedor em foco.${coachTargetLabel}`;

    const activeVendors = dict.users.filter(u => !u.Suspended && !u.Integration);

    const systemPrompt = `Você é um Coach de Vendas da VetorV (B2B industrial: compressores, ar comprimido, locação e manutenção).\n${scopeNote}\n\n## EXCLUSÕES PERMANENTES\n- Paulo Victor (ID Ploomes: 10001176) é o dono da empresa e NÃO atua como vendedor. NUNCA inclua Paulo Victor em benchmarks, médias do time, rankings ou qualquer análise de performance. Filtre-o de TODOS os fetches.\n- Funis inativos/de teste (PipelineId: 60009328 = "[Cópia] - Manutenção da Carteira"): NUNCA incluir deals desses funis. Ao fazer fetch de Deals, sempre adicionar filtro: PipelineId ne 10013804 and PipelineId ne 10016564 and PipelineId ne 60000288 and PipelineId ne 60009328 and PipelineId ne 60011853.\n- IDs excluídos: ${EXCLUDED_FROM_ANALYSIS.join(', ')}.\n\n## REGRA DE SUJEITO E PERSPECTIVA (CRÍTICO — NUNCA VIOLAR)\n- Quando analisando um vendedor específico (target): use SEMPRE o nome dele na 3ª pessoa do início ao fim. Ex: "Weslayne tem...", "Rafael precisa...". NUNCA troque para "você" no meio do texto quando estiver falando de um terceiro.\n- Quando o próprio usuário está no chat (sem target selecionado): use "você" consistentemente do início ao fim.\n- NUNCA misture perspectivas na mesma resposta. Se começou com o nome, termine com o nome. Se começou com "você", termine com "você".\n\n## PREMISSA: DADOS DO CRM PODEM ESTAR SUJOS\nOs vendedores historicamente não seguiam processos de preenchimento. Isso é premissa do sistema.\n- NUNCA apresente número como verdade absoluta sem verificar qualidade\n- Ao analisar vendedor: verificar se preenche motivo de perda, valor dos deals, atualiza etapas\n- Incluir no coaching individual: diagnóstico de preenchimento (deals sem motivo, sem valor, abandonados)\n\n## POSTURA INVESTIGATIVA (NÃO ASSERTIVA — CRÍTICO)\n- Antes de concluir uma causa-raiz, SEMPRE questionar a qualidade do dado:\n  * Se motivo de perda está concentrado (ex: 9 de 11 = "concorrente"): questione se está sendo preenchido corretamente. Ex: "Vejo que 9 de 11 perdas estão marcadas como 'concorrente'. Isso pode ser real, mas também pode indicar que o motivo não está sendo preenchido com cuidado. Você (ou o vendedor) sabe dizer se essa análise reflete a realidade?"\n  * Se taxa de conversão é muito baixa/alta: perguntar se os dados estão completos\n  * Se padrão parece improvável estatisticamente: levantar hipótese alternativa antes de concluir\n- Coach desenvolve, não julga. SEMPRE terminar com 1 pergunta reflexiva.\n- Usar dados como "ponto de partida para investigação", não como "verdade absoluta".\n\n## INDICADORES CALCULADOS NO SERVIDOR (CRÍTICO)\n- Conversão/ticket/interações/preenchimento/abandonos são injetados como **[INDICADORES CALCULADOS]** na mensagem do usuário.\n- Use os números injetados diretamente. **NÃO recalcule fórmulas**.\n- Funis Manutenção da Carteira e Prospecção não entram em conversão/receita por design.\n\n## MOTIVOS DE PERDA — REGRA CRÍTICA: SEMPRE POR FUNIL\n- NUNCA some motivos de perda de funis diferentes e apresente como um único percentual geral.\n- Funis diferentes têm nomenclaturas de motivos DISTINTAS. Misturar distorce completamente a análise.\n- Ao analisar motivos de perda: SEMPRE segmente por PipelineId e apresente SEPARADO por funil.\n- Formato correto: \"No funil X, os principais motivos foram: ... | No funil Y, os principais motivos foram: ...\"\n- Se o usuário especificar um vendedor: mostre por funil daquele vendedor.\n- Para buscar motivos: SEMPRE inclua PipelineId no $select. Ex: $select=Id,LossReasonId,PipelineId,OwnerId
- Ao analisar motivos de perda de UM vendedor específico: SEMPRE faça fetch com filtro de OwnerId desse vendedor. NUNCA reutilize dados de todos os vendedores para filtrar depois — isso distorce os percentuais por funil.\n\n## ESTRUTURA OBRIGATÓRIA DA RESPOSTA\n1. **Contexto**: o que os dados mostram objetivamente\n2. **Hipóteses**: pelo menos 2 (uma pode questionar o próprio dado)\n3. **Desenvolvimento**: como investigar a causa real\n4. **Ações concretas**: máximo 3\n5. **Pergunta reflexiva**: 1 pergunta que leva o vendedor/gestor a refletir (SEMPRE presente)\n\nOBJETIVO: desenvolver o vendedor (comportamento, método, tomada de decisão) — não apenas reportar números.\n\nMETODOLOGIAS (use como estrutura):\n- SPIN Selling (Situação/Problema/Implicação/Necessidade)\n- Challenger Sale (ensinar, personalizar, assumir controle com respeito)\n\nCOMO RESPONDER:\n1) SE A PERGUNTA FOR AMBÍGUA (não especifica vendedor, período, funil): PRIMEIRO faça 2-3 perguntas curtas para entender o contexto ANTES de qualquer diagnóstico. Responda APENAS as perguntas, sem dar diagnóstico nessa rodada.\n   Exemplos de quando perguntar: 'Estou com dificuldade de fechar' → pergunte: de quem são os dados? qual período? qual funil?\n   NÃO pergunte se o target já está selecionado ou se o contexto já é claro.\n2) Quando o contexto estiver claro, busque dados e identifique 1-2 hipóteses de causa-raiz (habilidade, comportamento, processo, cadência, negociação, qualificação)\n3) Sugira 3-5 ações práticas (frases, cadência, roteiro de ligação, checklist), com prazo\n4) SEMPRE que der coaching sobre performance, comportamento ou prioridades: busque dados reais do CRM ANTES de responder.
   - "como estou na prospecção?" → faça fetch de interações + deals abertos do vendedor
   - "o que priorizar esta semana?" → faça fetch de tarefas vencidas + deals sem atualização
   - "por que não estou fechando?" → faça fetch de deals perdidos + taxa de conversão
   - Não espere o usuário pedir dados. Se há dado que embase o coaching, busque.
   - Exceção: questões puramente comportamentais/atitudinais (medo, motivação, mentalidade) — responda sem fetch.

## REGRAS DE ANÁLISE DE DADOS NO COACH
- Performance e motivos de perda: sempre por funil (nunca misturar funis)
- Conversão/ticket: use os **[INDICADORES CALCULADOS]** quando disponíveis
- Benchmark vs time: fazer fetch separado SEM filtro de owner e apresentar separado como "média do time"
- NUNCA misturar números do vendedor com números do time

## REGRAS DE QUALIDADE DO COACHING
- Fazer 2-4 perguntas investigativas ANTES de dar diagnóstico
- Apresentar SEMPRE pelo menos 2 hipóteses (uma pode questionar o dado em si)
- Nunca assumir causa-raiz com amostra pequena
- Terminar SEMPRE com 1 pergunta reflexiva
- Sujeito SEMPRE consistente: target = 3ª pessoa do início ao fim; sem target = "você" do início ao fim\n\nREGRA DE DADOS (quando precisar):\n- NUNCA invente números.\n- Para qualquer resposta que envolva métricas, você DEVE primeiro emitir fetch(es) no formato abaixo.\n- Sempre use filtros de data (ex.: últimos 30/90 dias) para evitar consultas gigantes.\n- Prefira agregações (totais + top N) em vez de listar tudo.\n- Nunca faça fetch em /Deals, /Tasks, /InteractionRecords sem filtro de data.\n\nFormato exato do fetch (uma linha por fetch, JSON puro):\n{"action":"fetch","url":"/Endpoint?$filter=...&$select=...","description":"descrição"}\n\nBoas práticas de fetch:\n- Use $select mínimo necessário.\n- Sempre inclua $filter com Date/FinishDate/LastUpdateDate quando aplicável.\n- Para Deals: SEMPRE adicionar PipelineId ne 10013804 and PipelineId ne 10016564 and PipelineId ne 60000288 and PipelineId ne 60009328 and PipelineId ne 60011853 no filtro.\n- Para dados do time (benchmark): faça fetch SEM filtro de owner e apresente SEPARADO como "média do time: Y" — NUNCA misture com dados do vendedor em foco.\n\nREGRAS DA RESPOSTA FINAL:\n- Português, tom humano, direto e construtivo.\n- Menos números brutos; mais insight e plano.\n- Termine SEMPRE com 1 pergunta reflexiva (uma frase) para o vendedor pensar e responder.`;

    const nowCtxCoach = new Date();
    const todayISOCoach = nowCtxCoach.toISOString().slice(0, 10);
    const thisMonthStartISOCoach = new Date(Date.UTC(nowCtxCoach.getUTCFullYear(), nowCtxCoach.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const thisMonthEndISOCoach = new Date(Date.UTC(nowCtxCoach.getUTCFullYear(), nowCtxCoach.getUTCMonth()+1, 1)).toISOString().slice(0, 10);

    // Inject CRM health context for coach (cached 1h)
    let crmHealthContextCoach = '';
    try {
      const healthData = await computeCrmHealth();
      if (!healthData.error) {
        const s = healthData.summary;
        const vendorScores = (healthData.vendors || []).map(v =>
          `${v.ownerName}: score=${v.hygieneScore}(${v.hygieneLabel}) abandonados=${v.abandoned.count} semValor=${v.noValue.count} perdasSemMotivo=${v.lostNoReason.noReason}/${v.lostNoReason.total}`
        ).join('; ');
        crmHealthContextCoach = `\n\n[ESTADO DO CRM — calculado agora]:\n- deals_abandonados_total=${s.totalAbandonedDeals}\n- perdas_sem_motivo=${s.totalLostNoReason} (${s.pctLostNoReason}% dos ${s.totalLostDeals180d} perdidos 180d, excluindo Carteira e Prospecção)\n- scores_por_vendedor: ${vendorScores}\nINSTRUÇÃO: Ao final de qualquer análise de performance, incluir alerta: "⚠️ Qualidade dos dados: ${s.totalLostNoReason} deals perdidos sem motivo, ${s.totalAbandonedDeals} deals abandonados. Esses dados podem afetar a precisão desta análise."`;
      }
    } catch {}

    // Inject pre-calculated sales indicators (30d)
    let salesIndicatorsContextCoach = '';
    try {
      const indicators = await computeSalesIndicators(effectivePloomesIds === null ? null : effectivePloomesIds, 30);
      if (!indicators.error) {
        const lines = ['\n\n[INDICADORES CALCULADOS — últimos 30d, USE ESTES NÚMEROS DIRETAMENTE (não recalcule):'];
        lines.push('\nConversão por funil (apenas funis de venda real):');
        for (const [pid, v] of Object.entries(indicators.conversionByPipeline)) {
          lines.push(`  - ${v.name}: ${v.won} ganhos, ${v.lost} perdidos → win rate ${v.winRate}`);
        }
        lines.push('\nTicket médio por funil:');
        for (const [pid, v] of Object.entries(indicators.ticketByPipeline)) {
          lines.push(`  - ${v.name}: média R$${v.mean.toLocaleString('pt-BR')}, mediana R$${v.median.toLocaleString('pt-BR')} (${v.count} deals)`);
        }
        lines.push('\nDeals abandonados (abertos >90d sem update):');
        for (const [oid, v] of Object.entries(indicators.abandonedByOwner)) {
          lines.push(`  - ${v.name}: ${v.count} deals (pior: ${v.worst}, risco R$${v.valueAtRisk.toLocaleString('pt-BR')})`);
        }
        lines.push('\nPreenchimento motivo de perda:');
        for (const [oid, v] of Object.entries(indicators.fillRateByOwner)) {
          lines.push(`  - ${v.name}: ${v.lossWithReason}/${v.lossTotal} (${v.pct})`);
        }
        if (indicators.dataQualityAlerts.length > 0) {
          lines.push('\n⚠️ Alertas de qualidade:');
          for (const a of indicators.dataQualityAlerts) lines.push(`  - ${a}`);
        }
        lines.push('\nNOTA: Carteira e Prospecção não entram em conversão/receita (excluídos por design).]');
        salesIndicatorsContextCoach = lines.join('\n');
      }
    } catch {}

    // Inject FONTE DOS DADOS context (coach endpoint — lógica de 3 datas)
    let fonteContextCoach = '';
    try {
      const currentStateCoach = isCurrentStateQuery(message);
      const inferredRangeCoach = inferDateRangeFromMessage(message);
      const dsCoach = resolveDataSource(
        inferredRangeCoach ? inferredRangeCoach.startDate : null,
        inferredRangeCoach ? inferredRangeCoach.endDate : null,
        currentStateCoach
      );
      const sourceLabelCoach = { warehouse: 'warehouse — dados estáveis', recent: 'recente (API → upsert)', api: 'API direta' }[dsCoach.source] || dsCoach.source;
      const periodLabelCoach = inferredRangeCoach
        ? `${inferredRangeCoach.startDate.toISOString().slice(0,10)} a ${inferredRangeCoach.endDate.toISOString().slice(0,10)}`
        : '(estado atual)';
      const coachFonteLines = [
        `\n\n[FONTE DOS DADOS]:`,
        `- Período: ${periodLabelCoach}`,
        `- Última extração: ${dsCoach.lastExtractionISO ? dsCoach.lastExtractionISO.slice(0,10) : 'N/A'}`,
        `- Fonte: ${sourceLabelCoach} — ${dsCoach.reason}`,
      ];
      if (dsCoach.source === 'recent' && dsCoach.recentSinceISO) {
        coachFonteLines.push(`- Puxar API desde: ${dsCoach.recentSinceISO.slice(0,16).replace('T',' ')} UTC`);
      }
      fonteContextCoach = coachFonteLines.join('\n');
    } catch {}

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: message + crmHealthContextCoach + salesIndicatorsContextCoach + fonteContextCoach + `\n\n[CONTEXTO TEMPORAL] Hoje: ${todayISOCoach} | Mês atual: ${thisMonthStartISOCoach} a ${thisMonthEndISOCoach} | Fuso: UTC\n\nVendedores ativos (nome->id para filtros de busca, NÃO MOSTRE NA RESPOSTA):\n` + activeVendors.map(u => `${u.Name} => ${u.Id}`).join('\n') + `\n\nMapeamento completo IDs->Nomes (use para resolver IDs nos dados da API, NÃO MOSTRE ESTA LISTA):\n` + dict.users.map(u => `${u.Id} => ${u.Name}`).join('\n') + `\n\nFunis (PipelineId->Nome, NÃO MOSTRE ESTA LISTA):\n` + Object.entries(dict.pipelineById || {}).map(([id, name]) => `${id} => ${name}`).join('\n') + `\n\nMotivos de perda (LossReasonId->Nome, NÃO MOSTRE ESTA LISTA):\n` + Object.entries(dict.lossReasonById || {}).map(([id, name]) => `${id} => ${name}`).join('\n') }
    ];

    const chatSessionId = req.body.chat_session_id ? Number(req.body.chat_session_id) : null;
    const cacheUserId = req.session.userId;

    // Inject session cache context
    const sessionCacheCtx = getSessionCacheContext(cacheUserId, chatSessionId);
    const systemPromptWithCache = systemPrompt + sessionCacheCtx;

    db.prepare('INSERT INTO messages (session_id, user_id, role, content, chat_session_id) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, req.session.userId, 'user', message, chatSessionId);

    let gptResponse = await askClaudeMessages(messages, systemPromptWithCache);

    // execute fetches (up to 5 rounds)
    let totalFetches = 0;
    let totalRecords = 0;

    function injectRequiredSelectsCoach(url) {
      url = sanitizeDealSelectGlobal(url);
      if (/\/Tasks/.test(url) && url.includes('$select=') && !url.includes('DateTime')) {
        url = url.replace(/(\$select=[^&]*)/, '$1,DateTime,Finished,FinishDate,OwnerId');
      }
      if (/\/Deals/.test(url) && url.includes('$select=') && !url.includes('StatusId')) {
        url = url.replace(/(\$select=[^&]*)/, '$1,StatusId,OwnerId,PipelineId,Amount,LastUpdateDate,FinishDate');
      }
      if (/\/Deals/.test(url) && url.includes('$select=') && !url.includes('CreateDate')) {
        url = url.replace(/(\$select=[^&]*)/, '$1,CreateDate');
      }
      if (/\/InteractionRecords/.test(url) && url.includes('$select=')) {
        if (!url.includes('CreatorId')) url = url.replace(/(\$select=[^&]*)/, '$1,CreatorId');
        if (!url.includes('TypeId')) url = url.replace(/(\$select=[^&]*)/, '$1,TypeId');
        if (!url.includes(',Date') && !url.includes('=Date')) url = url.replace(/(\$select=[^&]*)/, '$1,Date');
      }
      return url;
    }

    for (let round = 0; round < 5; round++) {
      const jsonMatches = [...gptResponse.matchAll(/\{"action"\s*:\s*"fetch"\s*,\s*"url"\s*:\s*"([^"]+)"\s*,\s*"description"\s*:\s*"([^"]+)"\s*\}/g)];
      if (jsonMatches.length === 0) break;

      const fetchResults = [];
      for (const match of jsonMatches) {
        let url = injectRequiredSelectsCoach(match[1]);
        const desc = match[2];
        const cached = getCachedFetch(cacheUserId, chatSessionId, url);
        if (cached) {
          console.log(`[cache HIT] [coach fetch r${round+1}] ${desc} -> ${url}`);
          totalFetches++;
          totalRecords += (cached.total || 0);
          fetchResults.push({ description: desc, url, total: cached.total, aggregates: cached.aggregates, sample: cached.sample });
        } else {
          console.log(`[cache MISS] [coach fetch r${round+1}] ${desc} -> ${url}`);
          try {
            const out = await ploomesFetchForModel(url);
            // For Tasks with > 20 results, compute per-owner count aggregates
            if (/\/Tasks/i.test(url) && out.total > 20) {
              const dict4 = await loadDictionary();
              const taskAggr = await ploomesGetTasksOwnerAggregates(url, dict4.userById);
              if (!taskAggr.error) out.aggregates = { ...out.aggregates, byOwnerCount: taskAggr.byOwnerCount };
            }
            // For Deals with LossReasonId in select and > 20 results, compute loss reason aggregates
            if (/\/Deals/i.test(url) && url.includes('LossReasonId') && out.total > 20) {
              const dict2 = await loadDictionary();
              const lossAggr = await ploomesGetLossReasonAggregates(url, dict2.lossReasonById, dict2.pipelineById);
              if (!lossAggr.error) out.aggregates = { ...out.aggregates, lossReasonBreakdown: lossAggr.byReason, lossReasonByPipeline: lossAggr.byPipeline, lossReasonByOwner: lossAggr.byOwnerReason };
            }
            // For Deals (ganhos/perdidos/abertos) com > 5 results, compute per-owner aggregates (taxa conversão, ciclo, ticket mediana, pipeline velocity por funil)
            if (/\/Deals/i.test(url) && out.total > 5) {
              const dict3 = await loadDictionary();
              const ownerAggr = await ploomesGetDealsOwnerAggregates(url, dict3.userById);
              if (!ownerAggr.error) out.aggregates = { ...out.aggregates, byOwnerAmount: ownerAggr.byOwnerAmount, pipelineMetrics: ownerAggr.pipelineMetrics, globalTicketMedia: ownerAggr.globalTicketMedia, globalTicketMediana: ownerAggr.globalTicketMediana, inconsistencias: ownerAggr.inconsistencias };
            }
            const payload = { total: out.total, aggregates: out.aggregates, sample: (out.sample || []).slice(0, 20) };
            setCachedFetch(cacheUserId, chatSessionId, url, payload);
            totalFetches++;
            totalRecords += (out.total || 0);
            fetchResults.push({ description: desc, url, total: out.total, aggregates: out.aggregates, sample: out.sample });
          } catch (e) {
            fetchResults.push({ description: desc, url, error: e.message });
          }
        }
      }

      const dataContext = fetchResults.map(r => r.error
        ? `ERRO em ${r.description} (${r.url}): ${r.error}`
        : `DADOS ${r.description}: total=${r.total}\nAGREGADOS: ${JSON.stringify(r.aggregates || {}, null, 2)}\nAmostra (até 20):\n${JSON.stringify(r.sample, null, 2)}`
      ).join('\n\n---\n\n');

      gptResponse = await askClaudeMessages([
        ...messages,
        { role: 'assistant', content: gptResponse },
        { role: 'user', content: `Retorno da API Ploomes (use como insumo. Evite despejar tabela de números; transforme em coaching):\n\n${dataContext}` }
      ], systemPromptWithCache);
    }

    const finalResponse = (gptResponse || '').trim();

    const coachMatch = finalResponse.match(/\[COACH_SUMMARY\]([\s\S]*?)\[\/COACH_SUMMARY\]/i);
    if (coachMatch && coachMatch[1]?.trim()) {
      const summary = coachMatch[1].trim();
      db.prepare('INSERT INTO coaching_summaries (user_id, summary, score_delta) VALUES (?, ?, ?)')
        .run(req.session.userId, summary, 0);
    }

    db.prepare('INSERT INTO messages (session_id, user_id, role, content, chat_session_id) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, req.session.userId, 'assistant', finalResponse, chatSessionId);

    if (chatSessionId) {
      db.prepare('UPDATE chat_sessions SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?').run(chatSessionId);
      const sess = db.prepare('SELECT title FROM chat_sessions WHERE id = ?').get(chatSessionId);
      if (sess && sess.title === 'Nova conversa') {
        const autoTitle = ('Coach: ' + message).substring(0, 50).trim() + (message.length > 50 ? '...' : '');
        db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(autoTitle, chatSessionId);
      }
    }

    res.json({
      response: finalResponse,
      fetchData: totalFetches > 0 ? { consultas: totalFetches, totalRegistros: totalRecords } : null,
      wantsPdf: false
    });

  } catch (e) {
    console.error('[chat/coach error]', e);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});



// ─── Reports: lista de vendedores (supervisor/gestor/admin) ────
app.get('/api/reports/users', requireAuth, (req, res) => {
  const role = req.session.role || 'vendedor';
  if (role === 'vendedor') return res.status(403).json({ error: 'Sem permissão' });

  // IMPORTANT: Reports devem listar vendedores reais do Ploomes (já filtrados)
  // - remove Suspended / Integration / EXCLUDED_FROM_ANALYSIS
  // - supervisor deve ver apenas sua equipe
  (async () => {
    try {
      // Prefer warehouse.db to avoid hammering Ploomes for simple lists
      const wdb = getWarehouseDb();
      let users = null;
      if (wdb) {
        try {
          users = wdb.prepare(`
            SELECT id, name, email
            FROM ploomes_users
            WHERE COALESCE(suspended,0) = 0
              AND COALESCE(integration,0) = 0
          `).all().map(u => ({ id: Number(u.id), name: u.name, email: u.email }));
        } catch {
          users = null;
        }
      }

      // Fallback: live dictionary from Ploomes API
      if (!users) {
        const dict = await loadDictionary();
        users = (dict.users || []).filter(u =>
          !u.Suspended &&
          !u.Integration
        ).map(u => ({ id: Number(u.Id), name: u.Name, email: u.Email }));
      }

      // Global exclusions (PV/Sarah/Faturamento)
      users = (users || []).filter(u => !EXCLUDED_FROM_ANALYSIS.includes(Number(u.id)));

      if (role === 'supervisor') {
        // supervisor: restringe para ploomes_user_id da equipe cadastrada
        const rows = db.prepare(`
          SELECT au.ploomes_user_id AS pid
          FROM team_members tm
          JOIN teams t ON t.id = tm.team_id
          JOIN app_users au ON au.id = tm.user_id
          WHERE t.supervisor_user_id = ?
            AND au.active = 1
            AND au.ploomes_user_id IS NOT NULL
        `).all(req.session.userId);
        const allowed = new Set(rows.map(r => Number(r.pid)).filter(Boolean));
        users = users.filter(u => allowed.has(Number(u.id)));
      }

      users.sort((a, b) => (a.name || '').localeCompare((b.name || ''), 'pt-BR'));
      res.json(users);
    } catch (e) {
      res.status(500).json({ error: 'Erro interno. Tente novamente.' });
    }
  })();
});

// ─── Reports: dados completos por Ploomes UserId ───────────────
// Novo endpoint para o SPA (evita depender de app_users para listar vendedores)
app.get('/api/reports/ploomes/:ploomesUserId', requireAuth, async (req, res) => {
  const role = req.session.role || 'vendedor';
  if (role === 'vendedor') return res.status(403).json({ error: 'Sem permissão' });

  const pid = Number(req.params.ploomesUserId);
  if (!pid) return res.status(400).json({ error: 'ploomesUserId inválido' });
  if (EXCLUDED_FROM_ANALYSIS.includes(pid)) return res.status(403).json({ error: 'Usuário excluído de análises' });

  if (role === 'supervisor') {
    // supervisor: só equipe
    const rows = db.prepare(`
      SELECT au.ploomes_user_id AS pid
      FROM team_members tm
      JOIN teams t ON t.id = tm.team_id
      JOIN app_users au ON au.id = tm.user_id
      WHERE t.supervisor_user_id = ?
        AND au.active = 1
        AND au.ploomes_user_id IS NOT NULL
    `).all(req.session.userId);
    const allowed = new Set(rows.map(r => Number(r.pid)).filter(Boolean));
    if (!allowed.has(pid)) return res.status(403).json({ error: 'Sem permissão para este vendedor' });
  }

  try {
    const wdb = getWarehouseDb();
    if (!wdb) return res.status(500).json({ error: 'warehouse.db não disponível', path: WAREHOUSE_DB_PATH });

    // Report window: last 6 calendar months (including current month)
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1, 0, 0, 0));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
    const startIso = start.toISOString();
    const endIso = end.toISOString();

    const userRow = wdb.prepare('SELECT id, name, email FROM ploomes_users WHERE id = ?').get(pid);
    const displayName = userRow?.name || `Ploomes#${pid}`;

    const pipePlaceholders = (INACTIVE_PIPELINE_IDS || []).map(() => '?').join(',');
    const pipeFilterSql = (INACTIVE_PIPELINE_IDS && INACTIVE_PIPELINE_IDS.length)
      ? ` AND pipeline_id NOT IN (${pipePlaceholders})`
      : '';

    const wonSql = `
      SELECT COUNT(1) AS c, COALESCE(SUM(COALESCE(amount,0)),0) AS s
      FROM deals
      WHERE owner_id = ?
        AND status_id = 2
        AND finish_date >= ?
        AND finish_date < ?
        ${pipeFilterSql}
    `;
    const lostSql = `
      SELECT COUNT(1) AS c
      FROM deals
      WHERE owner_id = ?
        AND status_id = 3
        AND finish_date >= ?
        AND finish_date < ?
        ${pipeFilterSql}
    `;
    const interSql = `
      SELECT COUNT(1) AS c
      FROM interactions
      WHERE creator_id = ?
        AND date >= ?
        AND date < ?
    `;
    const overdueSql = `
      SELECT COUNT(1) AS c
      FROM tasks
      WHERE owner_id = ?
        AND COALESCE(finished,0) = 0
        AND datetime IS NOT NULL
        AND datetime <= ?
    `;

    const argsPipes = (INACTIVE_PIPELINE_IDS && INACTIVE_PIPELINE_IDS.length) ? INACTIVE_PIPELINE_IDS : [];
    const won = wdb.prepare(wonSql).get(pid, startIso, endIso, ...argsPipes);
    const lost = wdb.prepare(lostSql).get(pid, startIso, endIso, ...argsPipes);
    const inter = wdb.prepare(interSql).get(pid, startIso, endIso);
    const overdue = wdb.prepare(overdueSql).get(pid, now.toISOString());

    const lastRun = getWarehouseLastRun();
    res.json({
      usuario: { ploomes_user_id: pid, nome: displayName, email: userRow?.email || null },
      range: { start: startIso, end: endIso, kind: 'last_6_calendar_months' },
      last6m: {
        won_count: Number(won?.c || 0),
        won_sum: Number(won?.s || 0),
        lost_count: Number(lost?.c || 0),
        interactions_count: Number(inter?.c || 0),
        tasks_overdue_count: Number(overdue?.c || 0),
      },
      source: {
        warehouse: true,
        warehouseFresh: isWarehouseFresh(),
        etl_last_finished_at: lastRun?.finished_at || null,
        etl_ok: lastRun ? !!lastRun.ok : null,
      }
    });
  } catch (e) {
    console.error('[reports/ploomes error]', e);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ─── Reports: dados completos de um vendedor ──────────────────
app.get('/api/reports/:userId', requireAuth, async (req, res) => {
  const role = req.session.role || 'vendedor';
  if (role === 'vendedor') return res.status(403).json({ error: 'Sem permissão' });
  const targetId = Number(req.params.userId);
  if (!canAccessUserId(req, targetId)) return res.status(403).json({ error: 'Sem permissão para este vendedor' });

  const target = db.prepare('SELECT id, username, display_name, role, ploomes_user_id FROM app_users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (!target.ploomes_user_id) return res.status(400).json({ error: 'Vendedor sem ploomes_user_id vinculado' });

  try {
    const dict = await loadDictionary();
    const pid = target.ploomes_user_id;
    const ownerFilter = `OwnerId%20eq%20${pid}`;
    const creatorFilter = `CreatorId%20eq%20${pid}`;
    const now = new Date();

    // Últimos 6 meses de dados (mensal)
    const history6m = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const nextD = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1));
      const startIso = isoNoZ(d);
      const endIso = isoNoZ(nextD);

      const [won, lost, inters] = await Promise.all([
        ploomesGetAll(`/Deals?$select=Id,StatusId,Amount,OwnerId,FinishDate&$filter=StatusId%20eq%202%20and%20FinishDate%20ge%20${encodeURIComponent(startIso)}%20and%20FinishDate%20lt%20${encodeURIComponent(endIso)}%20and%20${ownerFilter}`),
        ploomesGetAll(`/Deals?$select=Id,StatusId,Amount,OwnerId,FinishDate&$filter=StatusId%20eq%203%20and%20FinishDate%20ge%20${encodeURIComponent(startIso)}%20and%20FinishDate%20lt%20${encodeURIComponent(endIso)}%20and%20${ownerFilter}`),
        ploomesGetAll(`/InteractionRecords?$select=Id,CreatorId,Date,TypeId&$filter=Date%20ge%20${encodeURIComponent(startIso)}%20and%20Date%20lt%20${encodeURIComponent(endIso)}%20and%20${creatorFilter}`),
      ]);
      const mes = d.toISOString().substring(0, 7);
      const valorGanho = won.reduce((a, b) => a + (b.Amount || 0), 0);
      const visitMeet = inters.filter(x => x.TypeId === 2 || x.TypeId === 5).length;
      history6m.push({
        mes,
        dealsGanhos: won.length, dealsPerdidos: lost.length, valorGanho,
        interacoes: inters.length, visitasReunioes: visitMeet,
        taxaConversao: (won.length + lost.length) > 0
          ? Math.round(won.length / (won.length + lost.length) * 100) : null,
      });
    }

    // Dados do mês atual
    const startMonth = isoNoZ(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
    const [dealsOpen, tasksOpen, coachSummaries] = await Promise.all([
      ploomesGetAll(`/Deals?$select=Id,OwnerId,StatusId,Amount,LastUpdateDate,StageId,PipelineId&$filter=StatusId%20eq%201%20and%20${ownerFilter}`),
      ploomesGetAll(`/Tasks?$select=Id,OwnerId,DateTime,Finished&$filter=Finished%20eq%20false%20and%20${ownerFilter}`),
      Promise.resolve(db.prepare('SELECT summary, score_delta, created_at FROM coaching_summaries WHERE user_id = ? ORDER BY id DESC LIMIT 10').all(targetId)),
    ]);

    const tarefasVencidas = tasksOpen.filter(t => !t.DateTime || new Date(t.DateTime) <= now).length;
    const cutoff30 = new Date(Date.now() - 30*24*60*60*1000);
    const staleDeals = dealsOpen.filter(d => d.LastUpdateDate && new Date(d.LastUpdateDate) <= cutoff30);

    // Alertas de qualidade CRM
    const alertas = [];
    if (tarefasVencidas > 0) alertas.push(`${tarefasVencidas} tarefa(s) vencida(s)`);
    if (staleDeals.length > 0) alertas.push(`${staleDeals.length} deal(s) sem atualização >30 dias`);
    if (dealsOpen.length === 0) alertas.push('Nenhum deal em aberto');

    // Perfil comportamental inferido
    const mesAtual = history6m[history6m.length - 1];
    let perfil = 'Dados insuficientes para análise de perfil';
    if (mesAtual) {
      const { interacoes, dealsGanhos, dealsPerdidos, visitasReunioes } = mesAtual;
      const taxaConv = mesAtual.taxaConversao;
      if (interacoes > 60 && taxaConv !== null && taxaConv < 30)
        perfil = 'Orientado a relacionamento — alto volume de atividades, baixa conversão. Foco em qualificação e fechamento.';
      else if (interacoes < 20 && taxaConv !== null && taxaConv > 50)
        perfil = 'Consultivo/assertivo — qualifica bem e converte, mas pode perder volume de pipeline. Aumentar prospecção.';
      else if (staleDeals.length > 3)
        perfil = 'Tende a evitar confronto — muitos deals parados. Trabalhar técnicas de fechamento e criação de urgência.';
      else if (tarefasVencidas > 5)
        perfil = 'Sobrecarregado ou desorganizado — muitas tarefas vencidas. Revisão de prioridades urgente.';
      else if (visitasReunioes > 10 && taxaConv !== null && taxaConv > 40)
        perfil = 'Vendedor de campo eficiente — alto valor em visitas e boa conversão. Manter cadência e replicar abordagem.';
      else
        perfil = 'Perfil equilibrado — atividade e conversão dentro do esperado. Foco em consistência e crescimento gradual.';
    }

    res.json({
      usuario: { id: target.id, nome: target.display_name || target.username, role: target.role, ploomesId: pid },
      history6m,
      dealsOpen: dealsOpen.length,
      tarefasVencidas,
      staleDeals: staleDeals.length,
      alertas,
      perfil,
      coachSummaries,
    });
  } catch (e) {
    console.error('[reports]', e);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// Export helpers for local tests/scripts (does not affect runtime)
module.exports = {
  getPipelineContext,
  computeSalesIndicators,
  computeCrmHealth,
  computeDataQualityDiagnostic,
  PIPELINE_CATEGORIES,
  INACTIVE_PIPELINE_IDS,
  EXCLUDED_FROM_ANALYSIS,
};

// ─── Engine de detecção de anomalias ──────────────────────────────────────────
async function detectAnomalies() {
  try {
    console.log('[anomaly] iniciando detecção...');
    const dict = await loadDictionary();
    const now = new Date();
    const cutoff21 = new Date(Date.now() - 21*24*60*60*1000);
    const cutoff7  = new Date(Date.now() - 7*24*60*60*1000);
    const startMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const EXCL = EXCLUDED_FROM_ANALYSIS || [];
    const ARCHIVED_PIPELINES = INACTIVE_PIPELINE_IDS || [];
    const ownerIds = Object.keys(dict.userById || {}).filter(id => !EXCL.includes(Number(id)));
    const ownerFilter = ownerIds.map(id => `OwnerId eq ${id}`).join(' or ');
    const creatorFilter = ownerIds.map(id => `CreatorId eq ${id}`).join(' or ');

    const [dealsOpen, interactionsWeek, tasksOpen, dealsMonthLost] = await Promise.all([
      ploomesGetAll(`/Deals?$select=Id,OwnerId,Title,Amount,LastUpdateDate,StatusId,PipelineId&$filter=StatusId%20eq%201${ownerFilter ? `%20and%20(${ownerFilter})` : ''}`),
      ploomesGetAll(`/InteractionRecords?$select=Id,CreatorId,Date&$filter=Date%20ge%20${encodeURIComponent(isoNoZ(cutoff7))}${creatorFilter ? `%20and%20(${creatorFilter})` : ''}`),
      ploomesGetAll(`/Tasks?$select=Id,OwnerId,DateTime,Finished&$filter=Finished%20eq%20false${ownerFilter ? `%20and%20(${ownerFilter})` : ''}`),
      ploomesGetAll(`/Deals?$select=Id,OwnerId,Amount,FinishDate&$filter=StatusId%20eq%203%20and%20FinishDate%20ge%20${encodeURIComponent(isoNoZ(startMonth))}${ownerFilter ? `%20and%20(${ownerFilter})` : ''}`),
    ]);

    const activeDealsOpen = dealsOpen.filter(d => !ARCHIVED_PIPELINES.includes(d.PipelineId));

    const interByOwner = {};
    for (const i of interactionsWeek) {
      interByOwner[i.CreatorId] = (interByOwner[i.CreatorId] || 0) + 1;
    }

    const lostByOwner = {};
    for (const d of dealsMonthLost) {
      lostByOwner[d.OwnerId] = (lostByOwner[d.OwnerId] || 0) + 1;
    }

    const alerts = [];

    // Regra 1: deals parados >21d
    for (const d of activeDealsOpen) {
      if (d.LastUpdateDate && new Date(d.LastUpdateDate) < cutoff21) {
        const days = Math.floor((now - new Date(d.LastUpdateDate)) / 86400000);
        const ownerName = dict.userById?.[d.OwnerId]?.Name || `ID ${d.OwnerId}`;
        alerts.push({
          rule_id: 'deal_stalled',
          severity: days > 45 ? 'critical' : 'warning',
          target_type: 'deal',
          target_id: String(d.Id),
          owner_ploomes_id: d.OwnerId,
          message: `Deal "${d.Title || d.Id}" (${ownerName}) sem atualização há ${days} dias${d.Amount ? ` — R$ ${d.Amount.toLocaleString('pt-BR', {minimumFractionDigits:2})} em risco` : ''}`,
          data_json: JSON.stringify({ dealId: d.Id, days, amount: d.Amount }),
        });
      }
    }

    // Regra 2: vendedor sem interação há 7 dias com deals abertos
    const ownerIdNums = [...new Set(activeDealsOpen.map(d => d.OwnerId).filter(Boolean))];
    for (const pid of ownerIdNums) {
      const hasInteraction = (interByOwner[pid] || 0) > 0;
      const openCount = activeDealsOpen.filter(d => d.OwnerId === pid).length;
      if (!hasInteraction && openCount > 0) {
        const ownerName = dict.userById?.[pid]?.Name || `ID ${pid}`;
        alerts.push({
          rule_id: 'no_activity_7d',
          severity: 'warning',
          target_type: 'owner',
          target_id: String(pid),
          owner_ploomes_id: pid,
          message: `${ownerName}: sem nenhuma interação nos últimos 7 dias com ${openCount} deals em aberto`,
          data_json: JSON.stringify({ openDeals: openCount }),
        });
      }
    }

    // Regra 3: tarefas vencidas excessivas (>5)
    const overdueByOwner = {};
    for (const t of tasksOpen) {
      if (t.DateTime && new Date(t.DateTime) <= now) {
        overdueByOwner[t.OwnerId] = (overdueByOwner[t.OwnerId] || 0) + 1;
      }
    }
    for (const [pid, count] of Object.entries(overdueByOwner)) {
      if (count >= 5) {
        const ownerName = dict.userById?.[pid]?.Name || `ID ${pid}`;
        alerts.push({
          rule_id: 'many_overdue_tasks',
          severity: count >= 10 ? 'critical' : 'warning',
          target_type: 'owner',
          target_id: String(pid),
          owner_ploomes_id: Number(pid),
          message: `${ownerName}: ${count} tarefas vencidas acumuladas`,
          data_json: JSON.stringify({ overdueCount: count }),
        });
      }
    }

    // Salvar no DB (limpar antigos sem resolução > 7 dias, manter histórico)
    db.prepare(`DELETE FROM anomaly_alerts WHERE detected_at < datetime('now', '-7 days') AND resolved_at IS NULL`).run();
    db.prepare(`DELETE FROM anomaly_alerts WHERE detected_at < datetime('now', '-30 days')`).run();

    const insert = db.prepare(`
      INSERT INTO anomaly_alerts (rule_id, severity, target_type, target_id, owner_ploomes_id, message, data_json, detected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(rule_id, target_id) DO UPDATE SET
        severity = excluded.severity,
        message = excluded.message,
        data_json = excluded.data_json,
        detected_at = excluded.detected_at,
        notified = 0
    `);
    for (const a of alerts) {
      insert.run(a.rule_id, a.severity, a.target_type, a.target_id, a.owner_ploomes_id, a.message, a.data_json);
    }
    console.log(`[anomaly] detectados ${alerts.length} alertas (${alerts.filter(a=>a.severity==='critical').length} críticos)`);
  } catch (e) {
    console.error('[anomaly] erro na detecção:', e.message);
  }
}

if (require.main === module) {
  // ─── Warehouse sync diário às 00h BRT (03h UTC) ───────────────────────────
  function scheduleDailySync() {
    const now = new Date();
    // próximo 03:00 UTC
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 0, 0, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const msUntil = next - now;
    console.log(`[cron] próximo sync diário em ${Math.round(msUntil/60000)} min (${next.toISOString()})`);
    setTimeout(() => {
      console.log('[cron] sync diário 00h BRT iniciado');
      kickWarehouseSyncBackground('cron-daily-00h');
      // Limpar fetch_cache acumulado
      try {
        const deleted = db.prepare(`DELETE FROM fetch_cache WHERE expires_at <= CURRENT_TIMESTAMP`).run();
        if (deleted.changes) console.log(`[cron] fetch_cache: ${deleted.changes} entradas expiradas removidas`);
      } catch(e) { console.warn('[cron] fetch_cache cleanup erro:', e.message); }
      // Invalidar caches em memória
      dashboardCache.clear();
      funnelHealthCache.clear();
      scheduleDailySync(); // reagendar para o próximo dia
    }, msUntil);
  }
  scheduleDailySync();
  // Sync imediato no startup se warehouse estiver stale
  setTimeout(() => kickWarehouseSyncBackground('startup'), 30 * 1000);

  // ─── Engine de detecção de anomalias (a cada 6h) ──────────────────────
  setInterval(() => detectAnomalies(), 6 * 60 * 60 * 1000);
  setTimeout(() => detectAnomalies(), 2 * 60 * 1000);

  // Limpeza periódica do fetch_cache
  setInterval(() => {
    try {
      const deleted = db.prepare(`DELETE FROM fetch_cache WHERE expires_at <= CURRENT_TIMESTAMP`).run();
      if (deleted.changes > 0) console.log(`[cache cleanup] ${deleted.changes} entradas expiradas removidas do fetch_cache`);
    } catch(e) { console.warn('[cache cleanup error]', e.message); }
  }, 60 * 60 * 1000);

  // Retenção semanal de mensagens antigas (>90 dias)
  setInterval(() => {
    try {
      const r1 = db.prepare(`DELETE FROM messages WHERE created_at < datetime('now', '-90 days')`).run();
      const r2 = db.prepare(`DELETE FROM fetch_cache WHERE expires_at < datetime('now', '-7 days')`).run();
      if (r1.changes || r2.changes) console.log(`[retention] messages: ${r1.changes} removidas, fetch_cache: ${r2.changes} removidas`);
    } catch(e) { console.warn('[retention error]', e.message); }
  }, 7 * 24 * 60 * 60 * 1000);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] Ploomes Analyst rodando na porta ${PORT}`);
    loadDictionary().catch(e => console.error('[dict] Erro:', e.message));
  });
}
