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
            this.client.subscribe(filter, (err, granted) => {
                if (err) {
                    this.logger?.error(`Failed to subscribe to ${filter}: ${err.message}`);
                } else {
                    this.logger?.info(`Successfully subscribed to ${filter} (QoS: ${granted?.[0]?.qos ?? 'unknown'})`);
                }
            });
        });
    }

    private handleMessage(topic: string, payload: Buffer) {
        let message: any;
        const payloadStr = payload.toString();
        
        // Try to parse as JSON first
        try {
            message = JSON.parse(payloadStr);
        } catch (e) {
            // If not JSON, treat as plain string (e.g., "ONLINE", "OFFLINE" status messages)
            // Wrap it in an object with a 'payload' field for consistency
            message = { payload: payloadStr };
        }

        // Naive topic matching for now (can be improved with mqtt-match)
        let matched = false;
        for (const [filter, handler] of this.messageHandlers.entries()) {
            if (this.mqttMatch(filter, topic)) {
                this.logger?.debug(`[MQTT] Message received on ${topic} (matched filter: ${filter})`);
                handler(topic, message);
                matched = true;
            }
        }
        
        if (!matched) {
            this.logger?.warn(`[MQTT] Received message on ${topic} but no handler matched`);
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
            this.client.subscribe(topicFilter, (err) => {
                if (err) {
                    this.logger?.error(`Failed to subscribe to ${topicFilter}: ${err.message}`);
                } else {
                    this.logger?.info(`Successfully subscribed to ${topicFilter}`);
                }
            });
        } else {
            this.logger?.warn(`MQTT not connected yet, subscription to ${topicFilter} will be attempted on connect`);
        }
    }

    public publish(topic: string, message: any, options?: any): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.client.connected) {
                reject(new Error('MQTT client not connected'));
                return;
            }
            const payload = JSON.stringify(message);
            this.client.publish(topic, payload, options, (err) => {
                if (err) {
                    this.logger?.error(`Failed to publish to ${topic}: ${err.message}`);
                    reject(err);
                } else {
                    this.logger?.info(`[MQTT] Published to ${topic} (${payload.length} bytes)`);
                    resolve();
                }
            });
        });
    }
}

// Singleton instance to be initialized in server.ts
export let mqttService: MqttService;

export function initMqtt(brokerUrl: string, logger?: FastifyBaseLogger, username?: string, password?: string) {
    const options: IClientOptions = {};
    if (username) {
        options.username = username;
    }
    if (password) {
        options.password = password;
    }
    mqttService = new MqttService(brokerUrl, options, logger);
    return mqttService;
}
