#!/usr/bin/env node
/*
  sync_warehouse.js

  Incremental ETL from Ploomes API into a local SQLite "warehouse".
  - READ-ONLY against Ploomes (GET only)
  - Paginated using $top/$skip
  - Materializes a few indicator tables to reduce API usage and compute server-side.

  Usage:
    node /opt/ploomes-analyst/scripts/sync_warehouse.js

  Env:
    PLOOMES_API_KEY (required)
    PLOOMES_BASE (optional, default https://api2.ploomes.com)
    WAREHOUSE_DB_PATH (optional, default /opt/ploomes-analyst/warehouse.db)
*/

const https = require('https');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const PLOOMES_API_KEY = process.env.PLOOMES_API_KEY;
const PLOOMES_BASE = process.env.PLOOMES_BASE || 'https://api2.ploomes.com';
const WAREHOUSE_DB_PATH = process.env.WAREHOUSE_DB_PATH || '/opt/ploomes-analyst/warehouse.db';

// Exclusions (align with server.js)
const EXCLUDED_FROM_ANALYSIS = [10001176]; // PV
const INACTIVE_PIPELINE_IDS = [10013804, 10016564, 60000288, 60009328, 60011853];

if (!PLOOMES_API_KEY) {
  console.error('Missing env PLOOMES_API_KEY');
  process.exit(2);
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function isoNow() { return new Date().toISOString(); }
function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function ploomesGetOnce(urlPath) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(PLOOMES_BASE + urlPath);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: { 'User-Key': PLOOMES_API_KEY },
      timeout: 30000,
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (typeof parsed === 'string') return reject(new Error('API returned string: ' + parsed.substring(0, 120)));
          if (parsed.value && typeof parsed.value === 'string') return reject(new Error('API error: ' + parsed.value));
          resolve(parsed);
        } catch (e) {
          reject(new Error('JSON parse error: ' + data.substring(0, 200)));
        }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
  });
}

async function ploomesGetAll(urlPath, { top = 100, maxRecords = 200000 } = {}) {
  const results = [];
  let skip = 0;
  // Remove any $top/$skip and re-add deterministically
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

function openDb(dbPath) {
  ensureDir(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS etl_runs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      ok INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS ploomes_users(
      id INTEGER PRIMARY KEY,
      name TEXT,
      email TEXT,
      suspended INTEGER,
      integration INTEGER,
      last_seen TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS pipelines(
      id INTEGER PRIMARY KEY,
      name TEXT,
      archived INTEGER DEFAULT 0,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS stages(
      id INTEGER PRIMARY KEY,
      name TEXT,
      pipeline_id INTEGER,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stages_pipeline_id ON stages(pipeline_id);

    CREATE TABLE IF NOT EXISTS loss_reasons(
      id INTEGER PRIMARY KEY,
      name TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS deals(
      id INTEGER PRIMARY KEY,
      owner_id INTEGER,
      pipeline_id INTEGER,
      stage_id INTEGER,
      status_id INTEGER,
      amount REAL,
      create_date TEXT,
      last_update_date TEXT,
      finish_date TEXT,
      loss_reason_id INTEGER,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deals_last_update_date ON deals(last_update_date);
    CREATE INDEX IF NOT EXISTS idx_deals_finish_date ON deals(finish_date);
    CREATE INDEX IF NOT EXISTS idx_deals_owner_id ON deals(owner_id);
    CREATE INDEX IF NOT EXISTS idx_deals_pipeline_id ON deals(pipeline_id);
    CREATE INDEX IF NOT EXISTS idx_deals_status_id ON deals(status_id);

    CREATE TABLE IF NOT EXISTS interactions(
      id INTEGER PRIMARY KEY,
      creator_id INTEGER,
      date TEXT,
      type_id INTEGER,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_interactions_date ON interactions(date);
    CREATE INDEX IF NOT EXISTS idx_interactions_creator_id ON interactions(creator_id);

    CREATE TABLE IF NOT EXISTS tasks(
      id INTEGER PRIMARY KEY,
      owner_id INTEGER,
      datetime TEXT,
      finished INTEGER,
      finish_date TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_datetime ON tasks(datetime);
    CREATE INDEX IF NOT EXISTS idx_tasks_owner_id ON tasks(owner_id);

    -- Materialized views (tables)
    CREATE TABLE IF NOT EXISTS mv_pipeline_snapshot(
      run_id INTEGER,
      pipeline_id INTEGER,
      owner_id INTEGER,
      open_count INTEGER,
      open_sum REAL,
      stale_30_count INTEGER,
      stale_60_count INTEGER,
      stale_90_count INTEGER,
      PRIMARY KEY(run_id, pipeline_id, owner_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mv_pipeline_snapshot_run ON mv_pipeline_snapshot(run_id);

    CREATE TABLE IF NOT EXISTS mv_conversion(
      run_id INTEGER,
      period_days INTEGER,
      pipeline_id INTEGER,
      won_count INTEGER,
      lost_count INTEGER,
      win_rate REAL,
      PRIMARY KEY(run_id, period_days, pipeline_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mv_conversion_run ON mv_conversion(run_id);

    CREATE TABLE IF NOT EXISTS mv_loss_reasons(
      run_id INTEGER,
      period_days INTEGER,
      pipeline_id INTEGER,
      loss_reason_id INTEGER,
      lost_count INTEGER,
      pct REAL,
      PRIMARY KEY(run_id, period_days, pipeline_id, loss_reason_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mv_loss_reasons_run ON mv_loss_reasons(run_id);

    CREATE TABLE IF NOT EXISTS mv_hygiene(
      run_id INTEGER,
      owner_id INTEGER,
      score INTEGER,
      abandoned_90d INTEGER,
      open_no_amount INTEGER,
      lost_no_reason_pct REAL,
      PRIMARY KEY(run_id, owner_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mv_hygiene_run ON mv_hygiene(run_id);
  `);
}

function isExcluded(ownerId, pipelineId) {
  if (ownerId && EXCLUDED_FROM_ANALYSIS.includes(Number(ownerId))) return true;
  if (pipelineId && INACTIVE_PIPELINE_IDS.includes(Number(pipelineId))) return true;
  return false;
}

function upsertMany(db, table, rows, cols, pkCol = 'id') {
  if (!rows.length) return 0;
  const placeholders = cols.map(() => '?').join(',');
  const stmt = db.prepare(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})\n` +
    `ON CONFLICT(${pkCol}) DO UPDATE SET ` + cols.filter(c => c !== pkCol).map(c => `${c}=excluded.${c}`).join(',')
  );
  const tx = db.transaction((items) => {
    for (const r of items) stmt.run(cols.map(c => r[c]));
  });
  tx(rows);
  return rows.length;
}

function computeMedian(values) {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 0 ? (v[mid - 1] + v[mid]) / 2 : v[mid];
}

function materialize(db, runId) {
  const nowIso = isoNow();
  const d30 = isoDaysAgo(30);
  const d90 = isoDaysAgo(90);
  const d180 = isoDaysAgo(180);

  const clearStmt = db.prepare('DELETE FROM mv_pipeline_snapshot WHERE run_id = ?');
  clearStmt.run(runId);
  db.prepare('DELETE FROM mv_conversion WHERE run_id = ?').run(runId);
  db.prepare('DELETE FROM mv_loss_reasons WHERE run_id = ?').run(runId);
  db.prepare('DELETE FROM mv_hygiene WHERE run_id = ?').run(runId);

  // Snapshot (open deals)
  db.exec(`
    INSERT INTO mv_pipeline_snapshot(run_id, pipeline_id, owner_id, open_count, open_sum, stale_30_count, stale_60_count, stale_90_count)
    SELECT
      ${runId} as run_id,
      pipeline_id,
      owner_id,
      COUNT(*) as open_count,
      SUM(COALESCE(amount,0)) as open_sum,
      SUM(CASE WHEN last_update_date IS NULL OR (julianday('${nowIso}') - julianday(last_update_date)) > 30 THEN 1 ELSE 0 END) as stale_30_count,
      SUM(CASE WHEN last_update_date IS NULL OR (julianday('${nowIso}') - julianday(last_update_date)) > 60 THEN 1 ELSE 0 END) as stale_60_count,
      SUM(CASE WHEN last_update_date IS NULL OR (julianday('${nowIso}') - julianday(last_update_date)) > 90 THEN 1 ELSE 0 END) as stale_90_count
    FROM deals
    WHERE status_id = 1
      AND (owner_id IS NULL OR owner_id NOT IN (${EXCLUDED_FROM_ANALYSIS.join(',')}))
      AND (pipeline_id IS NULL OR pipeline_id NOT IN (${INACTIVE_PIPELINE_IDS.join(',')}))
    GROUP BY pipeline_id, owner_id;
  `);

  // Conversion 30/90 by pipeline
  for (const periodDays of [30, 90]) {
    const cutoff = periodDays === 30 ? d30 : d90;
    db.exec(`
      INSERT INTO mv_conversion(run_id, period_days, pipeline_id, won_count, lost_count, win_rate)
      WITH agg AS (
        SELECT
          pipeline_id,
          SUM(CASE WHEN status_id = 2 THEN 1 ELSE 0 END) as won_count,
          SUM(CASE WHEN status_id = 3 THEN 1 ELSE 0 END) as lost_count
        FROM deals
        WHERE status_id IN (2,3)
          AND finish_date >= '${cutoff}'
          AND (pipeline_id IS NULL OR pipeline_id NOT IN (${INACTIVE_PIPELINE_IDS.join(',')}))
          AND (owner_id IS NULL OR owner_id NOT IN (${EXCLUDED_FROM_ANALYSIS.join(',')}))
        GROUP BY pipeline_id
      )
      SELECT
        ${runId} as run_id,
        ${periodDays} as period_days,
        pipeline_id,
        won_count,
        lost_count,
        CASE WHEN (won_count + lost_count) > 0 THEN (won_count * 1.0 / (won_count + lost_count)) ELSE NULL END as win_rate
      FROM agg;
    `);
  }

  // Loss reasons 30/90 by pipeline
  for (const periodDays of [30, 90]) {
    const cutoff = periodDays === 30 ? d30 : d90;
    // total lost by pipeline
    const totals = db.prepare(`
      SELECT pipeline_id, COUNT(*) as lost_total
      FROM deals
      WHERE status_id = 3
        AND finish_date >= ?
        AND (pipeline_id IS NULL OR pipeline_id NOT IN (${INACTIVE_PIPELINE_IDS.join(',')}))
        AND (owner_id IS NULL OR owner_id NOT IN (${EXCLUDED_FROM_ANALYSIS.join(',')}))
      GROUP BY pipeline_id
    `).all(cutoff);
    const totalMap = new Map(totals.map(r => [String(r.pipeline_id), r.lost_total]));
    const rows = db.prepare(`
      SELECT pipeline_id, loss_reason_id, COUNT(*) as lost_count
      FROM deals
      WHERE status_id = 3
        AND finish_date >= ?
        AND (pipeline_id IS NULL OR pipeline_id NOT IN (${INACTIVE_PIPELINE_IDS.join(',')}))
        AND (owner_id IS NULL OR owner_id NOT IN (${EXCLUDED_FROM_ANALYSIS.join(',')}))
      GROUP BY pipeline_id, loss_reason_id
    `).all(cutoff);
    const ins = db.prepare(`
      INSERT OR REPLACE INTO mv_loss_reasons(run_id, period_days, pipeline_id, loss_reason_id, lost_count, pct)
      VALUES(?,?,?,?,?,?)
    `);
    const tx = db.transaction(() => {
      for (const r of rows) {
        const total = totalMap.get(String(r.pipeline_id)) || 0;
        const pct = total > 0 ? (r.lost_count / total) : null;
        ins.run(runId, periodDays, r.pipeline_id, r.loss_reason_id || null, r.lost_count, pct);
      }
    });
    tx();
  }

  // Hygiene by owner (simple, transparent scoring)
  const owners = db.prepare(`
    SELECT DISTINCT owner_id FROM deals
    WHERE owner_id IS NOT NULL
      AND owner_id NOT IN (${EXCLUDED_FROM_ANALYSIS.join(',')})
  `).all().map(r => r.owner_id);

  const insH = db.prepare(`
    INSERT OR REPLACE INTO mv_hygiene(run_id, owner_id, score, abandoned_90d, open_no_amount, lost_no_reason_pct)
    VALUES(?,?,?,?,?,?)
  `);
  const txH = db.transaction(() => {
    for (const oid of owners) {
      const abandoned90 = db.prepare(`
        SELECT COUNT(*) as c
        FROM deals
        WHERE owner_id = ?
          AND status_id = 1
          AND (last_update_date IS NULL OR (julianday(?) - julianday(last_update_date)) > 90)
      `).get(oid, nowIso).c;
      const openNoAmount = db.prepare(`
        SELECT COUNT(*) as c
        FROM deals
        WHERE owner_id = ?
          AND status_id = 1
          AND (amount IS NULL OR amount = 0)
      `).get(oid).c;
      const lostStats = db.prepare(`
        SELECT
          SUM(CASE WHEN loss_reason_id IS NULL THEN 1 ELSE 0 END) as no_reason,
          COUNT(*) as total
        FROM deals
        WHERE owner_id = ?
          AND status_id = 3
          AND finish_date >= ?
      `).get(oid, d180);
      const lostNoReasonPct = (lostStats.total || 0) > 0 ? (lostStats.no_reason / lostStats.total) : null;

      // Score de higiene unificado (40+30+30) — mesma fórmula do API fallback em server.js
      // 40pts: % perdidos COM motivo de perda
      const pts_motivo = (lostStats.total || 0) > 0
        ? +((1 - lostNoReasonPct) * 40).toFixed(1)
        : 40; // sem perdas = ok
      // 30pts: % deals abertos COM valor
      const totalOpen = db.prepare(`SELECT COUNT(*) as c FROM deals WHERE owner_id=? AND status_id=1`).get(oid).c;
      const withValue = db.prepare(`SELECT COUNT(*) as c FROM deals WHERE owner_id=? AND status_id=1 AND amount > 0`).get(oid).c;
      const pts_valor = totalOpen > 0 ? +(withValue / totalOpen * 30).toFixed(1) : 30;
      // 30pts: % deals abertos atualizados nos últimos 30d
      const d30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const recentUpdated = db.prepare(`SELECT COUNT(*) as c FROM deals WHERE owner_id=? AND status_id=1 AND last_update_date >= ?`).get(oid, d30).c;
      const pts_atualiz = totalOpen > 0 ? +(recentUpdated / totalOpen * 30).toFixed(1) : 30;
      const score = Math.max(0, Math.min(100, Math.round(pts_motivo + pts_valor + pts_atualiz)));
      const lostNoReasonPct_val = (lostStats.total || 0) > 0 ? lostNoReasonPct : null;
      insH.run(runId, oid, score, abandoned90, openNoAmount, lostNoReasonPct_val);
    }
  });
  txH();
}

async function main() {
  const fullExtract = process.argv.includes('--full');
  const interactionsDays = (() => {
    const idx = process.argv.indexOf('--interactions-days');
    return idx >= 0 ? parseInt(process.argv[idx+1]) || 365 : 365;
  })();

  const db = openDb(WAREHOUSE_DB_PATH);
  migrate(db);

  const startedAt = isoNow();
  const runId = db.prepare('INSERT INTO etl_runs(started_at, ok, error) VALUES(?,0,?)').run(startedAt, fullExtract ? 'full-extract' : null).lastInsertRowid;
  console.log(`[warehouse] run ${runId} started_at=${startedAt} full=${fullExtract}`);

  try {
    let sinceIso;
    if (fullExtract) {
      sinceIso = null; // no date filter on deals
      console.log('[warehouse] FULL EXTRACT MODE — ignoring watermark, extracting all deals');
    } else {
      // Determine incremental start: last successful run started_at minus 2 days
      const lastOk = db.prepare("SELECT started_at FROM etl_runs WHERE ok=1 AND (error IS NULL OR error != 'full-extract-running') ORDER BY id DESC LIMIT 1").get();
      sinceIso = isoDaysAgo(2);
      if (lastOk && lastOk.started_at) {
        const t = new Date(lastOk.started_at).getTime() - 2 * 24 * 60 * 60 * 1000;
        sinceIso = new Date(t).toISOString();
      }
    }
    const interactionsCutoff = isoDaysAgo(interactionsDays);
    const tasksCutoff = isoDaysAgo(interactionsDays);

    // Reference tables
    const [users, pipelines, stages, lossReasons] = await Promise.all([
      ploomesGetAll('/Users?$select=Id,Name,Email,Suspended,Integration'),
      ploomesGetAll('/Deals@Pipelines?$select=Id,Name'),
      ploomesGetAll('/Deals@Stages?$select=Id,Name,PipelineId'),
      ploomesGetAll('/Deals@LossReasons?$select=Id,Name'),
    ]);
    const updatedAt = isoNow();
    upsertMany(db, 'ploomes_users', (users||[]).map(u => ({
      id: Number(u.Id),
      name: u.Name || null,
      email: u.Email || null,
      suspended: u.Suspended ? 1 : 0,
      integration: u.Integration ? 1 : 0,
      last_seen: null,
      updated_at: updatedAt,
    })), ['id','name','email','suspended','integration','last_seen','updated_at']);
    upsertMany(db, 'pipelines', (pipelines||[]).map(p => ({
      id: Number(p.Id),
      name: p.Name || null,
      archived: INACTIVE_PIPELINE_IDS.includes(Number(p.Id)) ? 1 : 0,
      updated_at: updatedAt,
    })), ['id','name','archived','updated_at']);
    upsertMany(db, 'stages', (stages||[]).map(s => ({
      id: Number(s.Id),
      name: s.Name || null,
      pipeline_id: s.PipelineId != null ? Number(s.PipelineId) : null,
      updated_at: updatedAt,
    })), ['id','name','pipeline_id','updated_at']);
    upsertMany(db, 'loss_reasons', (lossReasons||[]).map(r => ({
      id: Number(r.Id),
      name: r.Name || null,
      updated_at: updatedAt,
    })), ['id','name','updated_at']);

    // Deals (incremental or full)
    const pipeExcl = INACTIVE_PIPELINE_IDS.map(id => `PipelineId ne ${id}`).join(' and ');
    const pvExcl = EXCLUDED_FROM_ANALYSIS.map(id => `OwnerId ne ${id}`).join(' and ');
    const baseExcl = `(${pipeExcl}) and (${pvExcl})`;
    const dealsFilter = sinceIso
      ? `/Deals?$filter=LastUpdateDate ge ${sinceIso} and ${baseExcl}`
      : `/Deals?$filter=${baseExcl}`;
    const deals = await ploomesGetAll(
      dealsFilter + `&$select=Id,OwnerId,PipelineId,StageId,StatusId,Amount,CreateDate,LastUpdateDate,FinishDate,LossReasonId`,
      { maxRecords: 500000 }
    );
    console.log(`[warehouse] deals fetched: ${deals.length}`);
    const dealRows = [];
    for (const d of (deals || [])) {
      if (!d || !d.Id) continue;
      if (isExcluded(d.OwnerId, d.PipelineId)) continue;
      dealRows.push({
        id: Number(d.Id),
        owner_id: d.OwnerId != null ? Number(d.OwnerId) : null,
        pipeline_id: d.PipelineId != null ? Number(d.PipelineId) : null,
        stage_id: d.StageId != null ? Number(d.StageId) : null,
        status_id: d.StatusId != null ? Number(d.StatusId) : null,
        amount: d.Amount != null ? Number(d.Amount) : null,
        create_date: d.CreateDate || null,
        last_update_date: d.LastUpdateDate || null,
        finish_date: d.FinishDate || null,
        loss_reason_id: d.LossReasonId != null ? Number(d.LossReasonId) : null,
        updated_at: updatedAt,
      });
    }
    upsertMany(db, 'deals', dealRows, ['id','owner_id','pipeline_id','stage_id','status_id','amount','create_date','last_update_date','finish_date','loss_reason_id','updated_at']);

    // Interactions (last N days, configurable)
    console.log(`[warehouse] fetching interactions since ${interactionsCutoff}`);
    const interactions = await ploomesGetAll(
      `/InteractionRecords?$filter=Date ge ${interactionsCutoff}&$select=Id,CreatorId,TypeId,Date`,
      { maxRecords: 500000 }
    );
    console.log(`[warehouse] interactions fetched: ${interactions.length}`);
    const interRows = [];
    for (const i of (interactions || [])) {
      if (!i || !i.Id) continue;
      if (i.CreatorId && EXCLUDED_FROM_ANALYSIS.includes(Number(i.CreatorId))) continue;
      interRows.push({
        id: Number(i.Id),
        creator_id: i.CreatorId != null ? Number(i.CreatorId) : null,
        date: i.Date || null,
        type_id: i.TypeId != null ? Number(i.TypeId) : null,
        updated_at: updatedAt,
      });
    }
    upsertMany(db, 'interactions', interRows, ['id','creator_id','date','type_id','updated_at']);

    // Tasks: open + closed in N days
    console.log(`[warehouse] fetching tasks since ${tasksCutoff}`);
    const openTasks = await ploomesGetAll(
      `/Tasks?$filter=Finished eq false&$select=Id,OwnerId,DateTime,Finished,FinishDate`,
      { maxRecords: 200000 }
    );
    const closedTasks = await ploomesGetAll(
      `/Tasks?$filter=Finished eq true and FinishDate ge ${tasksCutoff}&$select=Id,OwnerId,DateTime,Finished,FinishDate`,
      { maxRecords: 200000 }
    );
    console.log(`[warehouse] tasks fetched: open=${openTasks.length} closed=${closedTasks.length}`);
    const taskRows = [];
    for (const t of [...(openTasks||[]), ...(closedTasks||[])]) {
      if (!t || !t.Id) continue;
      if (t.OwnerId && EXCLUDED_FROM_ANALYSIS.includes(Number(t.OwnerId))) continue;
      taskRows.push({
        id: Number(t.Id),
        owner_id: t.OwnerId != null ? Number(t.OwnerId) : null,
        datetime: t.DateTime || null,
        finished: t.Finished ? 1 : 0,
        finish_date: t.FinishDate || null,
        updated_at: updatedAt,
      });
    }
    upsertMany(db, 'tasks', taskRows, ['id','owner_id','datetime','finished','finish_date','updated_at']);

    // Materialize
    materialize(db, Number(runId));

    db.prepare('UPDATE etl_runs SET finished_at=?, ok=1, error=NULL WHERE id=?').run(isoNow(), runId);
    console.log(`[warehouse] run ${runId} finished OK`);
  } catch (err) {
    db.prepare('UPDATE etl_runs SET finished_at=?, ok=0, error=? WHERE id=?').run(isoNow(), String(err && err.stack ? err.stack : err), runId);
    console.error(`[warehouse] run ${runId} FAILED`, err);
    process.exitCode = 1;
  } finally {
    try { db.close(); } catch {}
  }
}

main();

