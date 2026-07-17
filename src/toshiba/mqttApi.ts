/**
 * Real-time channel to Toshiba's cloud: the client connects to Toshiba's
 * Azure IoT Hub *as a device*, using the SAS token issued by
 * RegisterMobileDevice.
 *
 * State updates arrive as IoT Hub direct-method invocations named "smmobile"
 * (topic $iothub/methods/POST/...), commands are sent as device-to-cloud
 * messages with the custom property type=mob.
 *
 * Functional port of KaSroka/Toshiba-AC-control (toshiba_ac/utils/amqp_api.py,
 * Apache-2.0), which delegates the transport to the azure-iot-device Python
 * SDK. The MQTT topic and username conventions below mirror that SDK.
 */

import mqtt, { MqttClient } from 'mqtt';

import { errorMessage, Log } from './utils.js';

const IOTHUB_API_VERSION = '2019-10-01';
const CLIENT_TYPE = 'azure-iot-device/2.14.0';
const METHOD_TOPIC_PREFIX = '$iothub/methods/POST/';

const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 300_000;
const TOKEN_RENEWAL_MARGIN_MS = 10 * 60_000;
const TOKEN_RENEWAL_RETRY_MS = 5 * 60_000;
/** setTimeout is limited to a signed 32-bit millisecond value. */
const MAX_TIMER_MS = 2_147_000_000;

export const COMMANDS = ['CMD_FCU_FROM_AC', 'CMD_HEARTBEAT'] as const;

export type CommandHandler = (
  sourceId: string,
  messageId: string,
  targetId: unknown[],
  payload: Record<string, unknown>,
  timeStamp: string,
) => void;

export interface SasTokenInfo {
  hostName: string;
  deviceId: string;
  /** Expiry as a unix timestamp in milliseconds, if present. */
  expiry: number | null;
}

/**
 * Parse an Azure IoT Hub SAS token of the form
 * "SharedAccessSignature sr=<host>%2Fdevices%2F<deviceId>&sig=...&se=<unix>".
 */
export function parseSasToken(token: string): SasTokenInfo {
  const body = token.replace(/^SharedAccessSignature\s+/i, '');
  const fields = new Map<string, string>();
  for (const part of body.split('&')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      fields.set(part.slice(0, idx).trim(), part.slice(idx + 1));
    }
  }

  const sr = fields.get('sr');
  if (!sr) {
    throw new Error('Invalid SAS token: missing sr field');
  }

  const resource = decodeURIComponent(sr);
  const marker = '/devices/';
  const markerIdx = resource.indexOf(marker);
  if (markerIdx <= 0) {
    throw new Error(`Invalid SAS token resource URI: ${resource}`);
  }

  const hostName = resource.slice(0, markerIdx);
  const deviceId = resource.slice(markerIdx + marker.length).split('/')[0];

  const se = fields.get('se');
  const expiry = se && /^\d+$/.test(se) ? Number(se) * 1000 : null;

  return { hostName, deviceId, expiry };
}

export class ToshibaMqttApi {
  private client: MqttClient | null = null;
  private deviceId = '';
  private readonly handlers = new Map<string, CommandHandler>();
  private shuttingDown = false;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer?: NodeJS.Timeout;
  private renewTimer?: NodeJS.Timeout;

  constructor(
    private readonly log: Log,
    private sasToken: string,
    private readonly renewSasTokenCallback: () => Promise<string>,
  ) {}

  registerCommandHandler(command: string, handler: CommandHandler): void {
    if (!(COMMANDS as readonly string[]).includes(command)) {
      throw new Error(`Unknown command: ${command}, should be one of ${COMMANDS.join(' ')}`);
    }
    this.handlers.set(command, handler);
  }

  async connect(): Promise<void> {
    await this.establishConnection();
  }

  private establishConnection(): Promise<void> {
    if (this.shuttingDown) {
      // A renew/reconnect await may have resolved after shutdown() ran; do not
      // resurrect a connection that would then never be closed.
      return Promise.resolve();
    }

    const { hostName, deviceId } = parseSasToken(this.sasToken);
    this.deviceId = deviceId;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      const client = mqtt.connect(`mqtts://${hostName}:8883`, {
        clientId: deviceId,
        username:
          `${hostName}/${deviceId}/?api-version=${IOTHUB_API_VERSION}` +
          `&DeviceClientType=${encodeURIComponent(CLIENT_TYPE)}`,
        password: this.sasToken,
        protocolVersion: 4,
        clean: false,
        keepalive: 60,
        reconnectPeriod: 0, // reconnection is managed by this class
        connectTimeout: 30_000,
      });
      this.client = client;

      client.on('connect', () => {
        client.subscribe(METHOD_TOPIC_PREFIX + '#', { qos: 1 }, (err) => {
          if (err) {
            this.log.warn(`Failed to subscribe to method topic: ${err.message}`);
            settle(err);
            client.end(true);
            return;
          }
          // A healthy connection is up — cancel any reconnect that a prior
          // 'close' armed, so it cannot later tear this connection down.
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
          }
          this.reconnectDelay = RECONNECT_MIN_MS;
          this.log.debug(`Connected to Toshiba IoT hub ${hostName} as ${deviceId}`);
          settle();
        });
      });

      client.on('message', (topic, payload) => this.handleMessage(topic, payload));

      client.on('error', (err) => {
        this.log.debug(`Toshiba IoT hub connection error: ${err.message}`);
        if (!settled) {
          settle(err);
          client.end(true);
        }
      });

      client.on('close', () => {
        if (!settled) {
          settle(new Error('Connection to Toshiba IoT hub closed before it was established'));
          return;
        }
        if (client === this.client && !this.shuttingDown) {
          this.log.info('Connection to Toshiba IoT hub lost');
          this.scheduleReconnect();
        }
      });
    }).then(() => this.scheduleTokenRenewal());
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) {
      return;
    }
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.log.info(`Reconnecting to Toshiba IoT hub in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.disposeClient();
    try {
      await this.refreshTokenIfNearExpiry();
      if (this.shuttingDown) {
        return;
      }
      await this.establishConnection();
      this.log.info('Reconnected to Toshiba IoT hub');
    } catch (e) {
      this.log.warn(`Reconnect to Toshiba IoT hub failed: ${errorMessage(e)}`);
      this.scheduleReconnect();
    }
  }

  private async refreshTokenIfNearExpiry(): Promise<void> {
    const { expiry } = parseSasToken(this.sasToken);
    if (expiry !== null && expiry - Date.now() < TOKEN_RENEWAL_MARGIN_MS) {
      this.log.info('Toshiba IoT hub SAS token expired or about to, requesting a new one');
      this.sasToken = await this.renewSasTokenCallback();
    }
  }

  private scheduleTokenRenewal(): void {
    if (this.renewTimer) {
      clearTimeout(this.renewTimer);
      this.renewTimer = undefined;
    }
    if (this.shuttingDown) {
      return;
    }
    const { expiry } = parseSasToken(this.sasToken);
    if (expiry === null) {
      return;
    }
    const delay = Math.max(5_000, expiry - Date.now() - TOKEN_RENEWAL_MARGIN_MS);
    this.renewTimer = setTimeout(() => {
      this.renewTimer = undefined;
      void this.renewToken();
    }, Math.min(delay, MAX_TIMER_MS));
  }

  private async renewToken(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    const { expiry } = parseSasToken(this.sasToken);
    if (expiry !== null && expiry - Date.now() > 2 * TOKEN_RENEWAL_MARGIN_MS) {
      // Timer fired early (clamped long delay) — just reschedule.
      this.scheduleTokenRenewal();
      return;
    }

    this.log.info('Renewing Toshiba IoT hub SAS token');
    try {
      this.sasToken = await this.renewSasTokenCallback();
    } catch (e) {
      if (this.shuttingDown) {
        return;
      }
      this.log.warn(`Failed to renew SAS token: ${errorMessage(e)}, retrying in 5 minutes`);
      this.renewTimer = setTimeout(() => {
        this.renewTimer = undefined;
        void this.renewToken();
      }, TOKEN_RENEWAL_RETRY_MS);
      return;
    }

    if (this.shuttingDown) {
      return;
    }

    // Reconnect with the fresh token.
    this.disposeClient();
    try {
      await this.establishConnection();
      this.log.info('Reconnected to Toshiba IoT hub with renewed SAS token');
    } catch (e) {
      this.log.warn(`Reconnect with renewed SAS token failed: ${errorMessage(e)}`);
      this.scheduleReconnect();
    }
  }

  private handleMessage(topic: string, payloadBuffer: Buffer): void {
    if (!topic.startsWith(METHOD_TOPIC_PREFIX)) {
      return;
    }

    // Topic format: $iothub/methods/POST/{method name}/?$rid={request id}
    const parts = topic.split('/');
    const methodName = decodeURIComponent(parts[3] ?? '');
    let requestId: string | null = null;
    const queryString = topic.split('?')[1] ?? '';
    for (const pair of queryString.split('&')) {
      const [key, value] = pair.split('=');
      if (key === '$rid' && value !== undefined) {
        requestId = decodeURIComponent(value);
      }
    }

    try {
      this.processMethodRequest(methodName, payloadBuffer);
    } finally {
      this.ackMethodRequest(requestId);
    }
  }

  private processMethodRequest(methodName: string, payloadBuffer: Buffer): void {
    if (methodName !== 'smmobile') {
      this.log.info(`Unknown method name: ${methodName}`);
      return;
    }

    let data: unknown;
    try {
      data = JSON.parse(payloadBuffer.toString('utf8'));
    } catch {
      this.log.warn(`Malformed method payload: ${payloadBuffer.toString('utf8').slice(0, 200)}`);
      return;
    }

    if (typeof data !== 'object' || data === null) {
      this.log.info(`Unsupported payload type for method ${methodName}`);
      return;
    }

    const message = data as Record<string, unknown>;
    const command = message.cmd;
    if (typeof command !== 'string') {
      this.log.error(`Malformed command in payload: ${JSON.stringify(message).slice(0, 200)}`);
      return;
    }

    const handler = this.handlers.get(command);
    if (!handler) {
      this.log.debug(`Unhandled command ${command}`);
      return;
    }

    const { sourceId, messageId, targetId, payload, timeStamp } = message;
    if (
      typeof sourceId !== 'string' ||
      typeof messageId !== 'string' ||
      !Array.isArray(targetId) ||
      typeof payload !== 'object' ||
      payload === null ||
      typeof timeStamp !== 'string'
    ) {
      this.log.error(`Malformed fields in command ${command}: ${JSON.stringify(message).slice(0, 200)}`);
      return;
    }

    try {
      handler(sourceId, messageId, targetId, payload as Record<string, unknown>, timeStamp);
    } catch (e) {
      this.log.error(`Command handler failed for ${command}: ${errorMessage(e)}`);
    }
  }

  private ackMethodRequest(requestId: string | null): void {
    if (requestId === null || !this.client || !this.client.connected) {
      return;
    }
    const topic = `$iothub/methods/res/0/?$rid=${encodeURIComponent(requestId)}`;
    this.client.publish(topic, 'null', { qos: 1 }, (err) => {
      if (err) {
        this.log.debug(`Failed to send method response: ${err.message}`);
      }
    });
  }

  /** Send a device-to-cloud message (a command destined for an AC unit). */
  sendMessage(message: object): Promise<void> {
    const client = this.client;
    if (!client || !client.connected) {
      return Promise.reject(new Error('Not connected to Toshiba IoT hub'));
    }

    // Property bag matching the azure-iot-device SDK: system properties
    // content type/encoding, then the custom property type=mob.
    const topic =
      `devices/${this.deviceId}/messages/events/` +
      '%24.ct=application%2Fjson&%24.ce=utf-8&type=mob';

    return new Promise<void>((resolve, reject) => {
      client.publish(topic, JSON.stringify(message), { qos: 1 }, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  private disposeClient(): void {
    const client = this.client;
    if (!client) {
      return;
    }
    this.client = null;
    client.removeAllListeners();
    client.end(true);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.renewTimer) {
      clearTimeout(this.renewTimer);
      this.renewTimer = undefined;
    }
    const client = this.client;
    this.client = null;
    if (client) {
      client.removeAllListeners();
      await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
    }
  }
}
