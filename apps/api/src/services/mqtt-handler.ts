import { FastifyBaseLogger } from 'fastify';
import { mqttService } from '../lib/mqtt.js';
import { prisma } from '../lib/prisma.js';
import { recordRouterHeartbeat, markRouterOffline } from './redis-router.js';

export class MqttHandler {
    private logger: FastifyBaseLogger;

    constructor(logger: FastifyBaseLogger) {
        this.logger = logger;
    }

    setup() {
        this.logger.info('Setting up MQTT topic subscriptions...');

        // 1. Router Metrics (Heartbeat)
        mqttService.subscribe('spotfi/router/+/metrics', async (topic, message) => {
            const routerId = this.extractRouterId(topic, 2);
            if (!routerId) return;

            // Update heartbeat in Redis
            await recordRouterHeartbeat(routerId).catch(() => { });

            this.logger.debug(`[MQTT] Received metrics for ${routerId}`);
        });

        // 2. Router Status (LWT / Online / Offline)
        mqttService.subscribe('spotfi/router/+/status', async (topic, message) => {
            const routerId = this.extractRouterId(topic, 2);
            if (!routerId) return;

            // Message can be an object or a string depending on how it was sent
            const status = message.status || message.payload || (typeof message === 'string' ? message : '');

            if (status === 'ONLINE') {
                await this.handleRouterOnline(routerId);
            } else if (status === 'OFFLINE') {
                await this.handleRouterOffline(routerId);
            }
        });
    }

    private extractRouterId(topic: string, index: number): string | null {
        const parts = topic.split('/');
        return parts.length > index ? parts[index] : null;
    }

    private async handleRouterOnline(routerId: string) {
        this.logger.info(`[MQTT] Router ${routerId} connected (ONLINE)`);
        try {
            // Update DB immediately for visibility
            await prisma.router.update({
                where: { id: routerId },
                data: {
                    status: 'ONLINE',
                    lastSeen: new Date()
                }
            });
            // Also update Redis to ensure it doesn't get swept by the background job
            await recordRouterHeartbeat(routerId);
        } catch (err: any) {
            this.logger.error(`Failed to mark router ${routerId} ONLINE: ${err.message}`);
        }
    }

    private async handleRouterOffline(routerId: string) {
        this.logger.info(`[MQTT] Router ${routerId} disconnected (OFFLINE)`);
        try {
            // Update DB immediately
            await prisma.router.update({
                where: { id: routerId },
                data: { status: 'OFFLINE' }
            });
            // Remove from Redis so it is known as offline
            await markRouterOffline(routerId);
        } catch (err: any) {
            this.logger.error(`Failed to mark router ${routerId} OFFLINE: ${err.message}`);
        }
    }
}
