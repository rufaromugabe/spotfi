import { WebSocket } from 'ws';
import { FastifyBaseLogger } from 'fastify';

interface PendingCommand {
  resolve: (value: any) => void;
  reject: (error: any) => void;
  timeout: NodeJS.Timeout;
  commandId: string;
}

class CommandManager {
  private pendingCommands = new Map<string, PendingCommand>();
  private commandIdCounter = 0;
  private logger?: FastifyBaseLogger;

  setLogger(logger: FastifyBaseLogger) {
    this.logger = logger;
  }

  generateCommandId(): string {
    this.commandIdCounter++;
    return `cmd_${Date.now()}_${this.commandIdCounter}`;
  }

  sendCommand(
    routerId: string,
    socket: WebSocket,
    command: string,
    params: any = {},
    timeout: number = 30000
  ): Promise<any> {
    return new Promise((resolve, reject) => {
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

      // Send command
      const message = {
        type: 'command',
        commandId,
        command,
        params,
        timestamp: new Date().toISOString()
      };

      try {
        socket.send(JSON.stringify(message));
        if (this.logger) {
          this.logger.debug(`[Router ${routerId}] Sent command: ${command} (id: ${commandId})`);
        }
      } catch (error: any) {
        clearTimeout(timeoutId);
        this.pendingCommands.delete(commandId);
        reject(new Error(`Failed to send command: ${error.message}`));
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
      pending.reject(new Error(response.error || response.message || 'Command failed'));
      return;
    }

    // Resolve with response data
    pending.resolve(response);
  }

  handleCommandProgress(commandId: string, progress: any): void {
    // For now, we don't handle progress - commands are fire-and-forget or wait for completion
    // This could be extended to support progress callbacks
    if (this.logger) {
      this.logger.debug(`Command ${commandId} progress: ${JSON.stringify(progress)}`);
    }
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
