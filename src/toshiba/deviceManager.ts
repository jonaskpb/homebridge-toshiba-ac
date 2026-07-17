/**
 * Connects the HTTP and MQTT channels and owns the device registry.
 *
 * Ported from KaSroka/Toshiba-AC-control (toshiba_ac/device_manager.py),
 * Apache-2.0.
 */

import { ToshibaAcDevice } from './device';
import { ToshibaAcHttpApi } from './httpApi';
import { ToshibaMqttApi } from './mqttApi';
import { Log } from './utils';

export class ToshibaAcDeviceManagerError extends Error {}

export class ToshibaAcDeviceManager {
  /** Identifier under which this plugin registers as a "mobile device". */
  readonly clientDeviceId: string;

  private httpApi: ToshibaAcHttpApi | null = null;
  private mqttApi: ToshibaMqttApi | null = null;
  private sasToken: string | null = null;
  private readonly devices = new Map<string, ToshibaAcDevice>();

  constructor(
    private readonly log: Log,
    private readonly username: string,
    private readonly password: string,
    deviceIdSuffix: string,
    private readonly refreshIntervalMinutes: number,
  ) {
    this.clientDeviceId = `${username}_${deviceIdSuffix}`;
  }

  async connect(): Promise<void> {
    try {
      if (!this.httpApi) {
        this.httpApi = new ToshibaAcHttpApi(this.log, this.username, this.password);
        await this.httpApi.login();
      }

      if (!this.sasToken) {
        this.sasToken = await this.httpApi.registerClient(this.clientDeviceId);
      }

      if (!this.mqttApi) {
        this.mqttApi = new ToshibaMqttApi(this.log, this.sasToken, () => this.renewSasToken());
        this.mqttApi.registerCommandHandler('CMD_FCU_FROM_AC', (sourceId, _messageId, _targetId, payload) => {
          const device = this.devices.get(sourceId);
          if (!device) {
            this.log.warn(`Ignoring CMD_FCU_FROM_AC for unknown source id ${sourceId}`);
            return;
          }
          device.handleCmdFcuFromAc(payload);
        });
        this.mqttApi.registerCommandHandler('CMD_HEARTBEAT', (sourceId, _messageId, _targetId, payload) => {
          const device = this.devices.get(sourceId);
          if (!device) {
            this.log.warn(`Ignoring CMD_HEARTBEAT for unknown source id ${sourceId}`);
            return;
          }
          device.handleCmdHeartbeat(payload);
        });
        await this.mqttApi.connect();
      }
    } catch (e) {
      await this.shutdown();
      throw e;
    }
  }

  async getDevices(): Promise<ToshibaAcDevice[]> {
    const httpApi = this.httpApi;
    const mqttApi = this.mqttApi;
    if (!httpApi || !mqttApi) {
      throw new ToshibaAcDeviceManagerError('Not connected');
    }

    if (this.devices.size === 0) {
      const devicesInfo = await httpApi.getDevices();

      for (const info of devicesInfo) {
        this.log.debug(
          `Found device ${info.acName} ` +
            `(MeritFeature: ${info.meritFeature}, Model id: ${info.acModelId}, ` +
            `Firmware: ${info.firmwareVersion}, Initial state: ${info.initialAcState})`,
        );
        const device = new ToshibaAcDevice(this.log, info, this.clientDeviceId, mqttApi, httpApi);
        this.devices.set(device.acUniqueId, device);
        device.connect(this.refreshIntervalMinutes);
      }
    }

    return [...this.devices.values()];
  }

  private async renewSasToken(): Promise<string> {
    if (!this.httpApi) {
      throw new ToshibaAcDeviceManagerError('Not connected');
    }
    this.sasToken = await this.httpApi.registerClient(this.clientDeviceId);
    return this.sasToken;
  }

  async shutdown(): Promise<void> {
    for (const device of this.devices.values()) {
      device.shutdown();
    }
    this.devices.clear();

    const mqttApi = this.mqttApi;
    this.mqttApi = null;
    this.httpApi = null;
    this.sasToken = null;

    if (mqttApi) {
      await mqttApi.shutdown();
    }
  }
}
