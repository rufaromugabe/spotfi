import { Queue, Worker, Job } from 'bullmq';
import { redis } from '../lib/redis.js';
import { reconcileRouterSessions } from '../services/session-reconciliation.js';

export interface ReconciliationJobData {
    routerId: string;
}

export const reconciliationQueue = new Queue<ReconciliationJobData>('router-reconciliation', {
    connection: redis,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 5000,
        },
        removeOnComplete: {
            age: 3600, // Keep completed jobs for 1 hour
            count: 100, // Keep last 100 jobs
        },
        removeOnFail: {
            age: 86400, // Keep failed jobs for 24 hours
        },
    },
});

// Mock logger for the worker since Fastify logger isn't available here
const workerLogger: any = {
    info: (msg: any) => console.log(`[ReconciliationWorker] INFO: ${msg}`),
    error: (msg: any) => console.error(`[ReconciliationWorker] ERROR: ${msg}`),
    warn: (msg: any) => console.warn(`[ReconciliationWorker] WARN: ${msg}`),
    debug: (msg: any) => console.debug(`[ReconciliationWorker] DEBUG: ${msg}`),
    fatal: (msg: any) => console.error(`[ReconciliationWorker] FATAL: ${msg}`),
    trace: (msg: any) => console.trace(`[ReconciliationWorker] TRACE: ${msg}`),
    child: () => workerLogger
};

export const reconciliationWorker = new Worker<ReconciliationJobData>(
    'router-reconciliation',
    async (job: Job<ReconciliationJobData>) => {
        const { routerId } = job.data;
        try {
            console.log(`[ReconciliationWorker] Processing router ${routerId} (Job ${job.id})`);
            await reconcileRouterSessions(routerId, workerLogger);
            return { success: true };
        } catch (error: any) {
            console.error(`[ReconciliationWorker] Failed to reconcile router ${routerId}:`, error);
            throw error;
        }
    },
    {
        connection: redis,
        concurrency: 5, // Limit concurrent heavy DB operations
        limiter: {
            max: 10,     // Max 10 jobs
            duration: 1000 // per second
        }
    }
);

reconciliationWorker.on('completed', (job) => {
    console.log(`[ReconciliationWorker] Job ${job.id} completed for router ${job.data.routerId}`);
});

reconciliationWorker.on('failed', (job, err) => {
    console.error(`[ReconciliationWorker] Job ${job?.id} failed: ${err.message}`);
});

process.on('SIGTERM', async () => {
    await reconciliationWorker.close();
    await reconciliationQueue.close();
});
