import { randomBytes } from 'crypto';

/**
 * Unique ID for this API instance in the cluster.
 * Used for MQTT response routing and deterministic job IDs.
 */
export const INSTANCE_ID = process.env.INSTANCE_ID || randomBytes(3).toString('hex');

console.log(`🆔 API Instance ID: ${INSTANCE_ID}`);
