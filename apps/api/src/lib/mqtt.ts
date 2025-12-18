import mqtt, { MqttClient as Client, IClientOptions } from 'mqtt';
import { FastifyBaseLogger } from 'fastify';

/**
 * Wrapper around MQTT Client for SpotFi API
 * - Manages connection to broker
 * - Handles subscriptions and routing of messages
 * - Publishes commands to routers
 */
export class MqttService {
    private client: Client;
    private logger?: FastifyBaseLogger;
    private messageHandlers: Map<string, (topic: string, message: any) => void> = new Map();

    constructor(brokerUrl: string, options?: IClientOptions, logger?: FastifyBaseLogger) {
        this.logger = logger;
        this.client = mqtt.connect(brokerUrl, {
            clean: true,
            connectTimeout: 4000,
            reconnectPeriod: 1000,
            ...options,
        });

        this.client.on('connect', () => {
            this.logger?.info('Connected to MQTT Broker');
            this.resubscribe();
        });

        this.client.on('error', (err) => {
            this.logger?.error(`MQTT Error: ${err.message}`);
        });

        this.client.on('message', (topic, payload) => {
            this.handleMessage(topic, payload);
        });
    }

    private resubscribe() {
        this.messageHandlers.forEach((_, filter) => {
            this.client.subscribe(filter, (err) => {
                if (err) this.logger?.error(`Failed to subscribe to ${filter}: ${err.message}`);
            });
        });
    }

    private handleMessage(topic: string, payload: Buffer) {
        let message: any;
        try {
            message = JSON.parse(payload.toString());
        } catch (e) {
            this.logger?.warn(`Received non-JSON MQTT message on ${topic}`);
            return;
        }

        // Naive topic matching for now (can be improved with mqtt-match)
        for (const [filter, handler] of this.messageHandlers.entries()) {
            if (this.mqttMatch(filter, topic)) {
                handler(topic, message);
            }
        }
    }

    // Simple wildcard matcher for MQTT topics (+ and #)
    private mqttMatch(filter: string, topic: string): boolean {
        const filterParts = filter.split('/');
        const topicParts = topic.split('/');

        for (let i = 0; i < filterParts.length; i++) {
            const p = filterParts[i];
            if (p === '#') return true;
            if (p !== '+' && p !== topicParts[i]) return false;
        }
        return filterParts.length === topicParts.length;
    }

    public subscribe(topicFilter: string, handler: (topic: string, message: any) => void) {
        this.messageHandlers.set(topicFilter, handler);
        if (this.client.connected) {
            this.client.subscribe(topicFilter);
        }
    }

    public publish(topic: string, message: any, options?: any): Promise<void> {
        return new Promise((resolve, reject) => {
            this.client.publish(topic, JSON.stringify(message), options, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
}

// Singleton instance to be initialized in server.ts
export let mqttService: MqttService;

export function initMqtt(brokerUrl: string, logger?: FastifyBaseLogger) {
    mqttService = new MqttService(brokerUrl, {}, logger);
    return mqttService;
}
