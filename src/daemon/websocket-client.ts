import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { WS_URL } from '../utils/config.js';
import { ToolsExecutor } from './tools-executor.js';

const RECONNECT_INTERVAL = 5000;  // 5 seconds - matching extension
const MAX_RECONNECT_ATTEMPTS = 100;  // matching extension

export interface WebSocketClientOptions {
    projectId: string;
    apiKey: string;
    wsUrl?: string;
    workspaceRoot?: string;
}

export interface UserInfo {
    email: string;
    user_id: string;
}

export interface ProjectInfo {
    project_id: string;
    project_name: string;
}

/**
 * WebSocket client matching extension's websocket-client.js
 */
interface InFlightTool {
    toolName: string;
    startedAt: number;
}

export class WebSocketClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private authenticated = false;
    private projectInfo: ProjectInfo | null = null;
    private userInfo: UserInfo | null = null;
    private toolsExecutor: ToolsExecutor | null = null;

    private shouldReconnect = true;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private apiKey: string;
    private projectId: string;
    private wsUrl: string;
    private isConnecting = false;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = MAX_RECONNECT_ATTEMPTS;
    private workspaceRoot: string;
    private inFlight: Map<string, InFlightTool> = new Map();

    constructor(options: WebSocketClientOptions) {
        super();
        this.apiKey = options.apiKey;
        this.projectId = options.projectId;
        this.wsUrl = options.wsUrl || WS_URL;
        this.workspaceRoot = options.workspaceRoot || process.cwd();

        // Initialize tools executor
        this.toolsExecutor = new ToolsExecutor(this, this.workspaceRoot);
    }

    /**
     * Set the tools executor
     */
    setToolsExecutor(toolsExecutor: ToolsExecutor): void {
        this.toolsExecutor = toolsExecutor;
        console.log('[WS-Client] Tools executor set');
    }

    /**
     * Connect to WebSocket server
     */
    async connect(): Promise<any> {
        if (!this.apiKey || !this.projectId) {
            throw new Error('API key and project ID are required');
        }

        this.shouldReconnect = true;
        this.reconnectAttempts = 0;

        console.log(`[WS-Client] Initiating connection to project: ${this.projectId}`);

        return this._attemptConnection();
    }

    /**
     * Internal method to attempt connection
     */
    private async _attemptConnection(): Promise<any> {
        if (this.isConnecting) {
            console.log('[WS-Client] Connection attempt already in progress, skipping...');
            return;
        }

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(`[WS-Client] Max reconnection attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
            this.emit('max_reconnects_reached');
            this.shouldReconnect = false;
            return;
        }

        this.isConnecting = true;
        this.reconnectAttempts++;

        // Emit reconnecting event
        this.emit('reconnecting', this.reconnectAttempts);

        return new Promise((resolve, reject) => {
            // IMPORTANT: Use project_id in URL, matching extension
            const wsUrl = `${this.wsUrl}/ws/extension/${this.projectId}`;
            console.log(`[WS-Client] Connecting to ${wsUrl} (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

            try {
                this.ws = new WebSocket(wsUrl);
            } catch (error) {
                console.error('[WS-Client] Failed to create WebSocket:', error);
                this.isConnecting = false;
                this._scheduleReconnect();
                reject(error);
                return;
            }

            // Connection timeout (10 seconds) - matching extension
            const timeout = setTimeout(() => {
                console.log('[WS-Client] Connection timeout (10s)');
                if (this.ws) {
                    this.ws.close();
                }
                this.isConnecting = false;
                this._scheduleReconnect();
                reject(new Error('Connection timeout'));
            }, 10000);

            // WebSocket opened - send auth
            this.ws.on('open', () => {
                console.log('[WS-Client] ✓ WebSocket connection opened');
                this.emit('connecting');

                // Send authentication message - matching extension format
                const authMessage = {
                    type: 'auth',
                    api_key: this.apiKey,
                    project_id: this.projectId,
                };

                console.log('[WS-Client] Sending authentication...');
                this.ws!.send(JSON.stringify(authMessage));
            });

            // Message received
            this.ws.on('message', (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString());

                    if (message.type === 'auth_success') {
                        clearTimeout(timeout);
                        this.authenticated = true;
                        this.userInfo = message.user;
                        this.projectInfo = message.project;
                        this.isConnecting = false;
                        this.reconnectAttempts = 0;

                        console.log('[WS-Client] ✓✓✓ AUTHENTICATION SUCCESSFUL ✓✓✓');
                        if (this.userInfo) {
                            console.log(`[WS-Client] User: ${this.userInfo.email}`);
                        }
                        if (this.projectInfo) {
                            console.log(`[WS-Client] Project: ${this.projectInfo.project_name}`);
                        }

                        if (this.reconnectTimer) {
                            clearTimeout(this.reconnectTimer);
                            this.reconnectTimer = null;
                        }

                        // Emit connected event
                        this.emit('connected', this.projectInfo);

                        resolve(message);

                    } else if (message.type === 'auth_failed') {
                        clearTimeout(timeout);
                        console.error('[WS-Client] ❌ AUTHENTICATION FAILED:', message.message);
                        this.isConnecting = false;
                        this.shouldReconnect = false; // Don't retry on auth failure
                        this.emit('auth_failed', message.message);
                        reject(new Error(message.message));

                    } else {
                        // Handle other messages
                        this.handleMessage(message);
                    }
                } catch (err) {
                    console.error('[WS-Client] Error parsing message:', err);
                }
            });

            // WebSocket error
            this.ws.on('error', (error: Error) => {
                clearTimeout(timeout);
                console.error('[WS-Client] WebSocket error:', error.message);
                this.isConnecting = false;
                this.emit('error', error);
                this._scheduleReconnect();
                reject(error);
            });

            // WebSocket closed
            this.ws.on('close', (code: number, reason: Buffer) => {
                clearTimeout(timeout);
                console.log(`[WS-Client] Connection closed (code: ${code}, reason: ${reason?.toString() || 'none'})`);
                if (this.inFlight.size > 0) {
                    const now = Date.now();
                    const abandoned = Array.from(this.inFlight.entries()).map(
                        ([rid, info]) => `${info.toolName}#${rid.slice(0, 8)} (${now - info.startedAt}ms)`
                    );
                    console.warn(`[WS-Client] Abandoning ${this.inFlight.size} in-flight tool call(s): ${abandoned.join(', ')}`);
                }
                this.authenticated = false;
                this.isConnecting = false;

                this.emit('disconnected', code, reason?.toString());

                if (this.shouldReconnect) {
                    this._scheduleReconnect();
                }
            });
        });
    }

    /**
     * Schedule reconnection attempt
     */
    private _scheduleReconnect(): void {
        if (this.reconnectTimer || !this.shouldReconnect) {
            return;
        }

        console.log(`[WS-Client] Scheduling reconnect in ${RECONNECT_INTERVAL}ms... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            console.log('[WS-Client] Attempting to reconnect...');
            this._attemptConnection().catch(err => {
                console.error('[WS-Client] Reconnection failed:', err.message);
            });
        }, RECONNECT_INTERVAL);
    }

    /**
     * Handle incoming messages
     */
    private async handleMessage(message: any): Promise<void> {
        console.log(`[WS-Client] ← Received: ${message.type}`);

        if (message.type === 'execute_tool') {
            await this.handleToolRequest(message);
        } else if (message.type === 'tool_ack') {
            console.log(`[WS-Client] Server acknowledged tool: ${message.tool} (${message.request_id})`);
            this.emit('tool_acknowledged', message);
        } else if (message.type === 'pong') {
            console.log('[WS-Client] Pong received');
            this.emit('pong');
        } else if (message.type === 'error') {
            console.error('[WS-Client] Server error:', message.message);
            this.emit('server_error', message.message);
        } else if (message.type === 'user_input_required') {
            console.log('[WS-Client] 🔔 User input required notification received');
            console.log(`[WS-Client]   Agent: ${message.agent_name}`);
            console.log(`[WS-Client]   Questions: ${message.questions_count}`);
            this.emit('user_input_required', {
                agent_id: message.agent_id,
                agent_name: message.agent_name,
                questions_count: message.questions_count,
                message: message.message
            });
        } else {
            console.log('[WS-Client] Unknown message type:', message.type);
            this.emit('message', message);
        }
    }

    /**
     * Handle tool execution request from server
     */
    private async handleToolRequest(message: any): Promise<void> {
        const toolName = message.tool;
        const params = message.params || {};
        const requestId = message.request_id;

        console.log(`[WS-Client] ═══════════════════════════════════`);
        console.log(`[WS-Client] TOOL EXECUTION REQUEST`);
        console.log(`[WS-Client] Tool: ${toolName}`);
        console.log(`[WS-Client] Request ID: ${requestId}`);
        console.log(`[WS-Client] Params:`, JSON.stringify(params, null, 2));
        console.log(`[WS-Client] ═══════════════════════════════════`);

        if (!this.toolsExecutor) {
            console.error('[WS-Client] ❌ Tools executor not available');
            this.safeSend({
                type: 'tool_error',
                tool: toolName,
                request_id: requestId,
                error: 'Tools executor not initialized'
            });
            return;
        }

        this.inFlight.set(requestId, { toolName, startedAt: Date.now() });

        try {
            console.log(`[WS-Client] Executing tool: ${toolName}...`);
            const result = await this.toolsExecutor.executeTool(toolName, params);

            console.log(`[WS-Client] ✓ Tool execution completed`);
            console.log(`[WS-Client] Result status: ${result?.status || 'unknown'}`);

            const sent = this.safeSend({
                type: 'tool_result',
                tool: toolName,
                result: result,
                request_id: requestId,
                timestamp: new Date().toISOString()
            });

            if (sent) {
                console.log(`[WS-Client] → Tool result sent to server`);
                this.emit('tool_executed', { tool: toolName, result, requestId });
            }

        } catch (error) {
            console.error(`[WS-Client] ❌ Tool execution failed:`, error);

            this.safeSend({
                type: 'tool_error',
                tool: toolName,
                request_id: requestId,
                error: (error as Error).message,
                timestamp: new Date().toISOString()
            });

            this.emit('tool_error', { tool: toolName, error, requestId });
        } finally {
            this.inFlight.delete(requestId);
        }
    }

    /**
     * Send a message without throwing when the socket is closed.
     * Returns true if the frame was dispatched, false otherwise.
     */
    private safeSend(message: object): boolean {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            const msgType = (message as any).type ?? 'unknown';
            console.warn(`[WS-Client] Dropping ${msgType}; socket not open (in-flight: ${this.inFlight.size})`);
            return false;
        }
        try {
            this.ws.send(JSON.stringify(message));
            return true;
        } catch (err) {
            console.warn(`[WS-Client] Send failed: ${(err as Error).message}`);
            return false;
        }
    }

    /**
     * Send a message to the server
     */
    async sendMessage(message: object): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket not connected');
        }

        this.ws.send(JSON.stringify(message));
    }

    /**
     * Send a ping to keep connection alive
     */
    async ping(): Promise<void> {
        if (this.isConnected()) {
            await this.sendMessage({ type: 'ping' });
            console.log('[WS-Client] → Sent: ping');
        }
    }

    /**
     * Check if connected and authenticated
     */
    isConnected(): boolean {
        return this.authenticated && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    /**
     * Disconnect from server
     */
    disconnect(): void {
        console.log('[WS-Client] Manual disconnect requested');
        this.shouldReconnect = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        this.authenticated = false;
        this.emit('disconnected', 1000, 'Manual disconnect');
    }

    /**
     * Get project information
     */
    getProjectInfo(): ProjectInfo | null {
        return this.projectInfo;
    }

    /**
     * Get user information
     */
    getUserInfo(): UserInfo | null {
        return this.userInfo;
    }

    /**
     * Get current reconnection attempt count
     */
    getReconnectAttempts(): number {
        return this.reconnectAttempts;
    }
}
