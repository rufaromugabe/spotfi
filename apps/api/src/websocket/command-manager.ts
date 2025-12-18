import { WebSocket } from 'ws'; // Keeping if needed for types, but removing usage
import { FastifyBaseLogger } from 'fastify';
import { mqttService } from '../lib/mqtt.js';

interface PendingCommand {
  resolve: (value: any) => void;
  reject: (error: any) => void;
  timeout: NodeJS.Timeout;
  commandId: string;
}

class CommandManager {
  private pendingCommands = new Map<string, PendingCommand>();
  private commandIdCounter = 0;
  private serverPrefix = Math.random().toString(36).substring(2, 6);
  private logger?: FastifyBaseLogger;
  private readonly DEFAULT_TIMEOUT = 10000; // 10s default timeout (aggressive)

  setLogger(logger: FastifyBaseLogger) {
    this.logger = logger;
  }

  generateCommandId(): string {
    this.commandIdCounter++;
    // Example: cmd_1700000000_a9f1_1
    return `cmd_${Date.now()}_${this.serverPrefix}_${this.commandIdCounter}`;
  }

  // Renamed or overloaded: no longer needs socket
  async sendCommand(
    routerId: string,
    command: string,
    params: any = {},
    timeout: number = this.DEFAULT_TIMEOUT
  ): Promise<any> {
    return new Promise(async (resolve, reject) => {
      const commandId = this.generateCommandId();

      // Set up timeout
      const timeoutId = setTimeout(() => {
        this.pendingCommands.delete(commandId);
        reject(new Error(`Command timeout after ${timeout}ms`));
      }, timeout);

      // Store pending command
      this.pendingCommands.set(commandId, {
        resolve,
        reject,
        timeout: timeoutId,
        commandId
      });

      // Only support ubus RPC calls (rpc message type)
      if (command !== 'ubus_call') {
        clearTimeout(timeoutId);
        this.pendingCommands.delete(commandId);
        reject(new Error(`Invalid command type: ${command}. Only 'ubus_call' is supported.`));
        return;
      }

      // Generic ubus RPC call - params contains path, method, args
      const message = {
        type: 'rpc',
        id: commandId,
        path: params.path,
        method: params.method,
        args: params.args || {}
      };

      try {
        // Publish to MQTT
        const topic = `spotfi/router/${routerId}/rpc/request`;
        await mqttService.publish(topic, message);

        if (this.logger) {
          this.logger.debug(`[Router ${routerId}] Sent MQTT rpc call: ${params.path}.${params.method} (id: ${commandId})`);
        }
      } catch (error: any) {
        clearTimeout(timeoutId);
        this.pendingCommands.delete(commandId);
        reject(new Error(`Failed to publish command: ${error.message}`));
      }
    });
  }

  handleResponse(commandId: string, response: any): void {
    const pending = this.pendingCommands.get(commandId);
    if (!pending) {
      if (this.logger) {
        this.logger.warn(`Received response for unknown command: ${commandId}`);
      }
      return;
    }

    // Clear timeout
    clearTimeout(pending.timeout);
    this.pendingCommands.delete(commandId);

    // Check for errors
    if (response.type === 'error' || response.status === 'error') {
      // Create error with full response attached so we can access result/stderr
      const error = new Error(response.error || response.message || 'Command failed') as any;
      error.response = response; // Attach full response for error inspection
      error.result = response.result; // Also attach result directly for convenience
      error.stderr = response.stderr; // Attach stderr if available
      pending.reject(error);
      return;
    }

    // Resolve with response data
    pending.resolve(response);
  }

  clearAll(routerId?: string): void {
    // Clear all pending commands (optionally for a specific router)
    for (const [commandId, pending] of this.pendingCommands.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingCommands.clear();

    if (this.logger && routerId) {
      this.logger.info(`Cleared all pending commands for router ${routerId}`);
    }
  }

  getPendingCount(): number {
    return this.pendingCommands.size;
  }
}

export const commandManager = new CommandManager();
