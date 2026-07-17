import type { PlatformAccessory, Service } from 'homebridge';

import {
  acModeToTargetState,
  clampTargetTemperature,
  computeCurrentHeaterCoolerState,
  fanModeToRotationSpeed,
  HAP_ACTIVE,
  HAP_TARGET_STATE,
  rotationSpeedToFanMode,
  TARGET_TEMP_MAX,
  TARGET_TEMP_MIN,
  targetStateToAcMode,
} from './mapping.js';
import type { ToshibaAcPlatform } from './platform.js';
import { PartialAcState, ToshibaAcDevice } from './toshiba/device.js';
import { AcMeritA, AcMode, AcStatus, AcSwingMode } from './toshiba/properties.js';
import { errorMessage } from './toshiba/utils.js';

/** HomeKit often sets several characteristics at once (scenes, mode+power);
 * commands are coalesced for this long and sent as one message. */
const COMMAND_COALESCE_MS = 150;

const OUTDOOR_SENSOR_SUBTYPE = 'outdoor-temperature';

export class ToshibaAcAccessory {
  private readonly service: Service;
  private outdoorService: Service | null = null;

  private pending: PartialAcState = {};
  private flushTimer?: NodeJS.Timeout;
  private lastIndoorTemperature: number | null = null;
  private lastOutdoorTemperature: number | null = null;
  private readonly enabledSwingMode: AcSwingMode;
  private readonly validTargetStates: number[];

  constructor(
    private readonly platform: ToshibaAcPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: ToshibaAcDevice,
  ) {
    const { Service, Characteristic } = platform;

    const informationService = accessory.getService(Service.AccessoryInformation);
    informationService
      ?.setCharacteristic(Characteristic.Manufacturer, 'Toshiba')
      .setCharacteristic(Characteristic.Model, this.modelName())
      .setCharacteristic(Characteristic.SerialNumber, device.acUniqueId)
      .setCharacteristic(Characteristic.FirmwareRevision, device.firmwareVersion || '0.0.0');

    this.service = accessory.getService(Service.HeaterCooler) ?? accessory.addService(Service.HeaterCooler);
    this.service.setCharacteristic(Characteristic.Name, device.name);

    this.enabledSwingMode = this.resolveSwingMode();
    this.validTargetStates = this.resolveValidTargetStates();

    this.service
      .getCharacteristic(Characteristic.Active)
      .onGet(() => (this.device.acStatus === AcStatus.On ? HAP_ACTIVE.ACTIVE : HAP_ACTIVE.INACTIVE))
      .onSet((value) =>
        this.queueCommand({ status: value === HAP_ACTIVE.ACTIVE ? AcStatus.On : AcStatus.Off }),
      );

    this.service
      .getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .onGet(() => this.currentHeaterCoolerState());

    this.service
      .getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .setProps({ validValues: this.validTargetStates })
      .onGet(() => acModeToTargetState(this.device.acMode, this.validTargetStates))
      .onSet((value) => this.queueCommand({ mode: targetStateToAcMode(value as number) }));

    this.service
      .getCharacteristic(Characteristic.CurrentTemperature)
      // HAP's default range starts at 0 °C — allow sub-zero readings.
      .setProps({ minValue: -100, maxValue: 100 })
      .onGet(() => this.currentTemperature());

    for (const characteristic of [
      Characteristic.CoolingThresholdTemperature,
      Characteristic.HeatingThresholdTemperature,
    ]) {
      this.service
        .getCharacteristic(characteristic)
        .setProps({ minValue: TARGET_TEMP_MIN, maxValue: TARGET_TEMP_MAX, minStep: 1 })
        .onGet(() => this.targetTemperature())
        .onSet((value) => this.setTargetTemperature(value as number));
    }

    this.service
      .getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(() => fanModeToRotationSpeed(this.device.acFanMode))
      .onSet((value) => this.queueCommand({ fanMode: rotationSpeedToFanMode(value as number) }));

    this.service
      .getCharacteristic(Characteristic.SwingMode)
      .onGet(() =>
        this.isSwinging()
          ? Characteristic.SwingMode.SWING_ENABLED
          : Characteristic.SwingMode.SWING_DISABLED,
      )
      .onSet((value) =>
        this.queueCommand({
          swingMode:
            value === Characteristic.SwingMode.SWING_ENABLED ? this.enabledSwingMode : AcSwingMode.Off,
        }),
      );

    this.setupOutdoorSensor();

    device.onStateChanged(() => this.updateFromDevice());
    this.updateFromDevice();
  }

  private resolveSwingMode(): AcSwingMode {
    const requested = this.platform.config.swingModeType ?? 'vertical';
    const wanted =
      requested === 'horizontal'
        ? AcSwingMode.SwingHorizontal
        : requested === 'both'
          ? AcSwingMode.SwingVerticalAndHorizontal
          : AcSwingMode.SwingVertical;

    if (this.device.supported.acSwingMode.includes(wanted)) {
      return wanted;
    }
    if (wanted !== AcSwingMode.SwingVertical) {
      this.platform.log.warn(
        `[${this.device.name}] Swing mode "${requested}" not supported by this unit, using vertical`,
      );
    }
    return AcSwingMode.SwingVertical;
  }

  private resolveValidTargetStates(): number[] {
    const modes = this.device.supported.acMode;
    const valid: number[] = [];
    if (modes.includes(AcMode.Auto)) {
      valid.push(HAP_TARGET_STATE.AUTO);
    }
    if (modes.includes(AcMode.Heat)) {
      valid.push(HAP_TARGET_STATE.HEAT);
    }
    if (modes.includes(AcMode.Cool)) {
      valid.push(HAP_TARGET_STATE.COOL);
    }
    if (valid.length === 0) {
      valid.push(HAP_TARGET_STATE.AUTO, HAP_TARGET_STATE.HEAT, HAP_TARGET_STATE.COOL);
    }
    return valid;
  }

  private setupOutdoorSensor(): void {
    const { Service, Characteristic } = this.platform;
    const existing = this.accessory.getServiceById(Service.TemperatureSensor, OUTDOOR_SENSOR_SUBTYPE);

    if (!this.platform.config.exposeOutdoorTemperature) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return;
    }

    this.outdoorService =
      existing ??
      this.accessory.addService(
        Service.TemperatureSensor,
        `${this.device.name} Outdoor`,
        OUTDOOR_SENSOR_SUBTYPE,
      );
    this.outdoorService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -100, maxValue: 100 })
      .onGet(() => this.outdoorTemperature());
  }

  private isSwinging(): boolean {
    const swing = this.device.acSwingMode;
    return (
      swing === AcSwingMode.SwingVertical ||
      swing === AcSwingMode.SwingHorizontal ||
      swing === AcSwingMode.SwingVerticalAndHorizontal
    );
  }

  private currentHeaterCoolerState(): number {
    return computeCurrentHeaterCoolerState(
      this.device.acStatus,
      this.device.acMode,
      this.device.acIndoorTemperature,
      this.device.acTemperature,
    );
  }

  private currentTemperature(): number {
    const indoor = this.device.acIndoorTemperature;
    if (indoor !== null) {
      this.lastIndoorTemperature = indoor;
      return indoor;
    }
    return this.lastIndoorTemperature ?? this.targetTemperature();
  }

  private targetTemperature(): number {
    return clampTargetTemperature(this.device.acTemperature ?? 22);
  }

  private setTargetTemperature(value: number): void {
    if (this.device.acMode === AcMode.Heat && this.device.acMeritA === AcMeritA.Heating8C) {
      this.platform.log.warn(
        `[${this.device.name}] 8°C heating mode is active — ` +
          'change the setpoint from the Toshiba app instead',
      );
      // Reject the write so HomeKit reverts the tile to the real value instead
      // of displaying a setpoint that was never applied.
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE,
      );
    }
    this.queueCommand({ temperature: Math.round(clampTargetTemperature(value)) });
  }

  private outdoorTemperature(): number {
    const outdoor = this.device.acOutdoorTemperature;
    if (outdoor !== null) {
      this.lastOutdoorTemperature = outdoor;
      return outdoor;
    }
    // Never publish a fabricated 0 °C — it is a plausible real reading that
    // would mis-trigger temperature automations. Fall back to the last known
    // outdoor value, or the indoor temperature as a neutral placeholder.
    return this.lastOutdoorTemperature ?? this.currentTemperature();
  }

  private queueCommand(partial: PartialAcState): void {
    Object.assign(this.pending, partial);
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => void this.flushPending(), COMMAND_COALESCE_MS);
  }

  private async flushPending(): Promise<void> {
    this.flushTimer = undefined;
    const pending = this.pending;
    this.pending = {};

    // A power-off wins over everything else queued alongside it.
    const command: PartialAcState = pending.status === AcStatus.Off ? { status: AcStatus.Off } : pending;

    try {
      await this.device.applyPartialState(command);
    } catch (e) {
      this.platform.log.error(`[${this.device.name}] Failed to send command: ${errorMessage(e)}`);
      // Re-sync HomeKit with the actual device state.
      this.updateFromDevice();
    }
  }

  private modelName(): string {
    const models = [this.device.cduModel, this.device.fcuModel].filter(Boolean);
    if (models.length > 0) {
      return models.join(' / ');
    }
    return `Toshiba AC (model ${this.device.acModelId || 'unknown'})`;
  }

  private updateFromDevice(): void {
    const { Service, Characteristic } = this.platform;
    const device = this.device;

    const indoor = device.acIndoorTemperature;
    if (indoor !== null) {
      this.lastIndoorTemperature = indoor;
    }

    this.service.updateCharacteristic(
      Characteristic.Active,
      device.acStatus === AcStatus.On ? HAP_ACTIVE.ACTIVE : HAP_ACTIVE.INACTIVE,
    );
    this.service.updateCharacteristic(
      Characteristic.CurrentHeaterCoolerState,
      this.currentHeaterCoolerState(),
    );
    this.service.updateCharacteristic(
      Characteristic.TargetHeaterCoolerState,
      acModeToTargetState(device.acMode, this.validTargetStates),
    );
    this.service.updateCharacteristic(Characteristic.CurrentTemperature, this.currentTemperature());
    this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, this.targetTemperature());
    this.service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, this.targetTemperature());
    this.service.updateCharacteristic(
      Characteristic.RotationSpeed,
      fanModeToRotationSpeed(device.acFanMode),
    );
    this.service.updateCharacteristic(
      Characteristic.SwingMode,
      this.isSwinging()
        ? Characteristic.SwingMode.SWING_ENABLED
        : Characteristic.SwingMode.SWING_DISABLED,
    );

    this.accessory
      .getService(Service.AccessoryInformation)
      ?.updateCharacteristic(Characteristic.Model, this.modelName());

    if (this.outdoorService) {
      // Only publish a genuine reading; suppress the null→0 fabrication.
      const outdoor = device.acOutdoorTemperature;
      if (outdoor !== null) {
        this.lastOutdoorTemperature = outdoor;
        this.outdoorService.updateCharacteristic(Characteristic.CurrentTemperature, outdoor);
      }
    }
  }
}
