import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import { getConfig } from './config.ts';
import { getDatabase } from './db.ts';
import { FoundationError } from './auth.ts';
import { registerResourceCleanup } from './resource-cleanup.ts';
import { runRetentionBatch } from './retention.ts';
import {runTrackedAssetRetention} from './tracked-assets.ts';
import { googleQueue, reconcileGoogleImports, startGoogleImportWorker } from './google-jobs.ts';
import {keywordQueue,executeKeywordResearch,reconcileKeywordJobs} from './keyword-research.ts';
import {domainResearchQueue,executeDomainResearch,reconcileDomainResearchJobs} from './domain-research.ts';
import {promptExecutionQueue,executePromptExecution,executePromptComparison,reconcilePromptExecutionJobs} from './prompt-execution.ts';
import {suggestionQueue} from './ai-suggestions.ts';
import {executeAiSuggestion,reconcileAiSuggestionJobs} from './ai-suggestion-worker.ts';
import {aiSearchQueue,executeAiSearch,reconcileAiSearchJobs} from './ai-search.ts';
import {contentSupportQueue} from './ai-content-support.ts';
import {executeContentSupport,reconcileContentSupportJobs} from './ai-content-support-worker.ts';
import {domainRedirectQueue,executeDomainRedirectCheck,reconcileDomainRedirectChecks} from './domain-redirects.ts';
import {siteAuditQueue} from './site-audits.ts';
import {rankQueue} from './rank-execution.ts';
import {rankPollQueue,executeRankDispatch,pollRankDispatch,reconcileRankJobs} from './rank-worker.ts';
import {claimDueRankOccurrence} from './rank-recurring.ts';
import {claimDuePromptOccurrence} from './prompt-recurring.ts';
import {startSiteAuditWorker,reconcileSiteAudits,stopSiteAudits} from './site-audit-worker.ts';

const queueName = 'setup-probe';
let bossPromise: Promise<PgBoss> | undefined;
let workerPromise: Promise<void> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let heartbeatTask: Promise<unknown> | undefined;
let retentionTask: Promise<unknown> | undefined;
let recurringTimer: ReturnType<typeof setInterval> | undefined;
let recurringTask: Promise<unknown> | undefined;
let workerStarted = false;

export function getBoss(): Promise<PgBoss> {
  if (!bossPromise) {
    registerResourceCleanup('jobs', stopJobs);
    const boss = new PgBoss({ connectionString: getConfig().databaseUrl, schedule: false, connectionTimeoutMillis: 5000 });
    boss.on('error', () => console.error('Job queue unavailable; check database availability.'));
    bossPromise = (async () => {
      try {
        await boss.start();
        await boss.createQueue(queueName);
        await boss.createQueue(googleQueue);
        await boss.createQueue(keywordQueue);
        await boss.createQueue(domainResearchQueue);
        await boss.createQueue(promptExecutionQueue);
        await boss.createQueue(suggestionQueue);
        await boss.createQueue(aiSearchQueue);
        await boss.createQueue(contentSupportQueue);
        await boss.createQueue(domainRedirectQueue);
        await boss.createQueue(siteAuditQueue);
        await boss.createQueue(rankQueue);
        await boss.createQueue(rankPollQueue);
        return boss;
      } catch (error) {
        await boss.stop({ graceful: false }).catch(() => undefined);
        bossPromise = undefined;
        throw error;
      }
    })();
  }
  return bossPromise;
}

export async function enqueueProbe(projectId: string, userId: string, requestId: string) {
  const boss = await getBoss();
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT w.id FROM workspace w JOIN project p ON p.workspace_id=w.id WHERE p.id=$1 FOR UPDATE OF w', [projectId]);
    const access = await client.query('SELECT m.role FROM membership m JOIN project p ON p.workspace_id=m.workspace_id WHERE p.id=$1 AND m.user_id=$2', [projectId, userId]);
    if (!['owner', 'admin', 'editor'].includes(access.rows[0]?.role)) throw new FoundationError(404, 'Project not found or unavailable.');
    const inserted = await client.query<{ id: string; status: string }>(
      `INSERT INTO import_probe(id, project_id, user_id, request_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, request_id) DO NOTHING RETURNING id, status`,
      [randomUUID(), projectId, userId, requestId],
    );
    let probe = inserted.rows[0];
    if (probe) {
      const jobId = await boss.send(queueName, { probeId: probe.id }, {
        id: probe.id, retryLimit: 2, retryDelay: 5, expireInSeconds: 30,
        db: { executeSql: (text, values) => client.query(text, values) },
      });
      if (!jobId) throw new Error('Probe could not be queued');
    } else {
      const existing = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM import_probe WHERE project_id = $1 AND request_id = $2',
        [projectId, requestId],
      );
      probe = existing.rows[0];
      if (!probe) throw new Error('Probe no longer exists');
    }
    await client.query('COMMIT');
    return probe;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function reconcileProbes(projectId?: string): Promise<void> {
  const { pool } = getDatabase();
  const pending = await pool.query(
    'SELECT 1 FROM import_probe WHERE status = $1 AND ($2::text IS NULL OR project_id = $2) LIMIT 1',
    ['queued', projectId ?? null],
  );
  if (!pending.rowCount) return;
  await getBoss();
  // Pinned pg-boss 12 stores all queue partitions beneath pgboss.job; recheck this read when upgrading it.
  await pool.query(
    `UPDATE import_probe probe SET status = 'failed', completed_at = now(),
       error = 'The worker check did not complete. Run the check again.'
     FROM import_probe pending LEFT JOIN pgboss.job job ON job.id = pending.id AND job.name = $1
     WHERE probe.id = pending.id AND probe.status = 'queued'
       AND ($2::text IS NULL OR probe.project_id = $2)
       AND (job.id IS NULL OR job.state IN ('failed', 'cancelled', 'completed'))`,
    [queueName, projectId ?? null],
  );
}

async function heartbeat() {
  const boss = await getBoss();
  if (!await boss.getQueue(queueName)) throw new Error('Worker queue is unavailable');
  await reconcileProbes();
  await reconcileGoogleImports();
  await reconcileKeywordJobs();
  await reconcileDomainResearchJobs();
  await reconcileRankJobs();
  await reconcilePromptExecutionJobs();
  await reconcileAiSuggestionJobs();
  await reconcileAiSearchJobs();
  await reconcileContentSupportJobs();
  await reconcileDomainRedirectChecks();
  await reconcileSiteAudits();
  // ponytail: one worker health row covers the single-worker Compose profile; use instance IDs before scaling workers.
  return getDatabase().pool.query(
    `INSERT INTO worker_heartbeat(id, last_seen_at) VALUES ('foundation-worker', now())
     ON CONFLICT (id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  );
}

export function startWorker(): Promise<void> {
  if (!workerPromise) workerPromise = (async () => {
    try {
      const boss = await getBoss();
      await reconcileKeywordJobs();
      await reconcileDomainResearchJobs();
      await reconcileRankJobs();
      await reconcilePromptExecutionJobs();
      await reconcileAiSuggestionJobs();
      await reconcileAiSearchJobs();
      await reconcileContentSupportJobs();
      await reconcileDomainRedirectChecks();
      await boss.work<{ probeId: string }>(queueName, { batchSize: 5 }, async (jobs) => {
        for (const job of jobs) {
          if (typeof job.data?.probeId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(job.data.probeId)) {
            throw new Error('Invalid setup probe payload');
          }
          await getDatabase().pool.query(
            `WITH access AS (
               SELECT ip.id, EXISTS (
                 SELECT 1 FROM project p JOIN membership m ON m.workspace_id = p.workspace_id
                 WHERE p.id = ip.project_id AND m.user_id = ip.user_id AND m.role IN ('owner', 'admin', 'editor')
               ) AS allowed FROM import_probe ip WHERE ip.id = $1 AND ip.status = 'queued'
             ) UPDATE import_probe ip SET
               status = CASE WHEN access.allowed THEN 'completed' ELSE 'denied' END,
               completed_at = now(),
               error = CASE WHEN access.allowed THEN NULL ELSE 'Project access was revoked before this check ran.' END
             FROM access WHERE ip.id = access.id AND ip.status = 'queued'`,
            [job.data.probeId],
          );
        }
      });
      await startGoogleImportWorker(boss);
      await boss.work<{runId:string}>(keywordQueue,{batchSize:1},async jobs=>{for(const job of jobs)await executeKeywordResearch(job.data?.runId);});
      await boss.work<{runId:string}>(domainResearchQueue,{batchSize:1},async jobs=>{for(const job of jobs)await executeDomainResearch(job.data?.runId);});
      await boss.work<{dispatchId:string}>(rankQueue,{batchSize:1},async jobs=>{for(const job of jobs)await executeRankDispatch(job.data?.dispatchId);});
      await boss.work<{dispatchId:string;generation:string}>(rankPollQueue,{batchSize:1},async jobs=>{for(const job of jobs)await pollRankDispatch(job.data?.dispatchId,job.data?.generation);});
      // ponytail: the comparisonId branch drains jobs queued before per-child Start; remove one release after C2
      // ponytail: one job per child since D3, so the 0.5s floor poll keeps the pre-D3 ceiling (a 2s poll per comparison of up to
      // four children); children still run one at a time per worker. Upgrade path: localConcurrency for parallel children.
      await boss.work<{executionId?:string;comparisonId?:string}>(promptExecutionQueue,{batchSize:1,pollingIntervalSeconds:0.5},async jobs=>{for(const job of jobs)await(job.data?.executionId?executePromptExecution(job.data.executionId):executePromptComparison(job.data?.comparisonId as string));});
      await boss.work<{runId:string}>(suggestionQueue,{batchSize:1},async jobs=>{for(const job of jobs)await executeAiSuggestion(job.data?.runId);});
      await boss.work<{runId:string}>(aiSearchQueue,{batchSize:1},async jobs=>{for(const job of jobs)await executeAiSearch(job.data?.runId);});
      await boss.work<{runId:string}>(contentSupportQueue,{batchSize:1},async jobs=>{for(const job of jobs)await executeContentSupport(job.data?.runId);});
      await boss.work<{checkId:string}>(domainRedirectQueue,{batchSize:1},async jobs=>{for(const job of jobs)await executeDomainRedirectCheck(job.data?.checkId);});
      await startSiteAuditWorker(boss);
      workerStarted = true;
      await heartbeat();
      heartbeatTimer = setInterval(() => {
        if (!heartbeatTask) heartbeatTask = heartbeat()
          .catch(() => console.error('Worker heartbeat failed; check database availability.'))
          .finally(() => { heartbeatTask = undefined; });
        if (!retentionTask) retentionTask = runRetentionBatch().then(()=>runTrackedAssetRetention())
          .catch(() => console.error('Retention cleanup failed; inspect retention status and database availability.'))
          .finally(() => { retentionTask = undefined; });
      }, 10_000);
      // Keep provider preflight outside heartbeat/healthcheck and never overlap a
      // prior claim. ponytail: one due tracker per family per tick caps each at six
      // starts/minute; use a bounded claim queue if workload requires more.
      recurringTimer = setInterval(() => {
        if (!recurringTask) recurringTask = Promise.allSettled([claimDueRankOccurrence(),claimDuePromptOccurrence()])
          .then(results=>{if(results.some(result=>result.status==='rejected'))console.error('Recurring schedule check failed; inspect schedule status and database availability.');})
          .finally(() => { recurringTask = undefined; });
      }, 10_000);
    } catch (error) {
      await stopJobs();
      throw error;
    }
  })();
  return workerPromise;
}

export async function stopJobs() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
  if (recurringTimer) clearInterval(recurringTimer);
  recurringTimer = undefined;
  await heartbeatTask;
  await retentionTask;
  await recurringTask;
  await stopSiteAudits();
  const boss = await bossPromise?.catch(() => undefined);
  try {
    await boss?.stop({ graceful: true, timeout: 30_000 });
  } finally {
    bossPromise = undefined;
    workerPromise = undefined;
    if (workerStarted) {
      workerStarted = false;
      await getDatabase().pool.query("DELETE FROM worker_heartbeat WHERE id = 'foundation-worker'")
        .catch(() => console.error('Worker heartbeat cleanup failed; it will expire automatically.'));
    }
  }
}
