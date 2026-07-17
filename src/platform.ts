import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { ToshibaAcAccessory } from './accessory';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { ToshibaAcDevice } from './toshiba/device';
import { ToshibaAcDeviceManager } from './toshiba/deviceManager';
import { ToshibaInvalidCredentialsError } from './toshiba/httpApi';
import { errorMessage, sleep } from './toshiba/utils';

export interface ToshibaAcPlatformConfig extends PlatformConfig {
  username?: string;
  password?: string;
  refreshIntervalMinutes?: number;
  swingModeType?: 'vertical' | 'horizontal' | 'both';
  exposeOutdoorTemperature?: boolean;
}

const DEVICE_ID_STORE_FILE = '.homebridge-toshiba-ac.json';

export class ToshibaAcPlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly config: ToshibaAcPlatformConfig;

  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private manager: ToshibaAcDeviceManager | null = null;

  constructor(
    readonly log: Logging,
    config: PlatformConfig,
    readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.config = config as ToshibaAcPlatformConfig;

    api.on('didFinishLaunching', () => {
      void this.init();
    });

    api.on('shutdown', () => {
      void this.manager?.shutdown();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(`Restoring cached accessory ${accessory.displayName}`);
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private async init(): Promise<void> {
    const { username, password } = this.config;
    if (!username || !password) {
      this.log.error(
        'Missing "username" and/or "password" in the platform config — ' +
          'add your Toshiba Home AC Control credentials to start the plugin.',
      );
      return;
    }

    const refreshIntervalMinutes = Math.min(1440, Math.max(5, this.config.refreshIntervalMinutes ?? 30));
    const deviceIdSuffix = this.loadOrCreateDeviceIdSuffix(username);

    for (let attempt = 1; ; attempt++) {
      const manager = new ToshibaAcDeviceManager(
        this.log,
        username,
        password,
        deviceIdSuffix,
        refreshIntervalMinutes,
      );
      try {
        await manager.connect();
        const devices = await manager.getDevices();
        this.manager = manager;
        this.setupAccessories(devices);
        this.log.info(`Toshiba AC ready — ${devices.length} unit(s) connected`);
        return;
      } catch (e) {
        await manager.shutdown().catch(() => undefined);

        if (e instanceof ToshibaInvalidCredentialsError) {
          this.log.error(
            `Toshiba login failed: ${errorMessage(e)}. ` +
              'Check the username/password in the plugin config; not retrying.',
          );
          return;
        }

        const delaySeconds = Math.min(600, 30 * 2 ** Math.min(attempt - 1, 5));
        this.log.error(
          `Toshiba AC setup failed (attempt ${attempt}): ${errorMessage(e)}. ` +
            `Retrying in ${delaySeconds}s.`,
        );
        await sleep(delaySeconds * 1000);
      }
    }
  }

  private setupAccessories(devices: ToshibaAcDevice[]): void {
    const activeUuids = new Set<string>();

    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(`homebridge-toshiba-ac:${device.acUniqueId}`);
      activeUuids.add(uuid);

      let accessory = this.cachedAccessories.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(device.name, uuid);
        accessory.context.acUniqueId = device.acUniqueId;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.set(uuid, accessory);
        this.log.info(`Added accessory for ${device.name}`);
      } else {
        this.log.debug(`Reusing cached accessory for ${device.name}`);
      }

      new ToshibaAcAccessory(this, accessory, device);
    }

    const staleAccessories = [...this.cachedAccessories.values()].filter(
      (accessory) => !activeUuids.has(accessory.UUID),
    );
    if (staleAccessories.length > 0) {
      // Never unregister *everything*: if the account reports zero units while
      // we still have cached accessories, the far likelier cause is a transient
      // cloud/API problem than the user removing all their ACs. Deleting them
      // would irrecoverably lose their HomeKit rooms, scenes, and automations.
      if (devices.length === 0) {
        this.log.warn(
          `No AC units were returned but ${staleAccessories.length} accessory(ies) are cached — ` +
            'keeping them to avoid deleting HomeKit rooms/scenes. ' +
            'Remove them manually if the unit is truly gone.',
        );
        return;
      }
      for (const accessory of staleAccessories) {
        this.log.info(`Removing stale accessory ${accessory.displayName}`);
        this.cachedAccessories.delete(accessory.UUID);
      }
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
    }
  }

  /**
   * A stable, random per-install device id suffix. Kept out of the Homebridge
   * accessory cache so a cache wipe does not register a new "mobile device".
   * Deliberately not the Python library's fixed default, so this plugin does
   * not steal the IoT Hub connection of a Home Assistant integration running
   * on the same account.
   */
  private loadOrCreateDeviceIdSuffix(username: string): string {
    const storePath = path.join(this.api.user.storagePath(), DEVICE_ID_STORE_FILE);
    let store: Record<string, string> = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object') {
        store = parsed as Record<string, string>;
      }
    } catch {
      // First run or unreadable store — regenerate below.
    }

    const key = `deviceId:${username}`;
    let suffix = store[key];
    if (typeof suffix !== 'string' || !suffix) {
      suffix = 'hb' + randomBytes(7).toString('hex');
      store[key] = suffix;
      try {
        fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
      } catch (e) {
        this.log.warn(`Could not persist device id store: ${errorMessage(e)}`);
      }
      this.log.info(`Generated new Toshiba mobile device id suffix ${suffix}`);
    }
    return suffix;
  }
}
