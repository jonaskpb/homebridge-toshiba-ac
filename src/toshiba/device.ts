/**
 * A single Toshiba AC unit: holds the current FCU state, validates and sends
 * commands, and consumes push updates.
 *
 * Ported from KaSroka/Toshiba-AC-control (toshiba_ac/device/__init__.py),
 * Apache-2.0.
 */

import { FcuState } from './fcuState';
import { Features } from './features';
import { ToshibaAcHttpApi, ToshibaAcDeviceInfo } from './httpApi';
import { ToshibaMqttApi } from './mqttApi';
import {
  AcAirPureIon,
  AcFanMode,
  AcMeritA,
  AcMeritB,
  AcMode,
  AcPowerSelection,
  AcSelfCleaning,
  AcStatus,
  AcSwingMode,
} from './properties';
import { errorMessage, Log } from './utils';

const POLL_JITTER_MS = 300_000;

export class ToshibaAcDeviceError extends Error {}

export interface PartialAcState {
  status?: AcStatus;
  mode?: AcMode;
  temperature?: number;
  fanMode?: AcFanMode;
  swingMode?: AcSwingMode;
}

export class ToshibaAcDevice {
  readonly name: string;
  readonly acId: string;
  readonly acUniqueId: string;
  readonly firmwareVersion: string;
  readonly acModelId: string;
  readonly fcuState: FcuState;

  cduModel: string | null = null;
  fcuModel: string | null = null;

  private readonly _supported: Features;
  private readonly stateListeners: Array<() => void> = [];
  private pollTimer?: NodeJS.Timeout;

  constructor(
    private readonly log: Log,
    info: ToshibaAcDeviceInfo,
    /** Identifier this plugin registered as a "mobile device" (command source id). */
    private readonly clientDeviceId: string,
    private readonly mqttApi: ToshibaMqttApi,
    private readonly httpApi: ToshibaAcHttpApi,
  ) {
    this.name = info.acName;
    this.acId = info.acId;
    this.acUniqueId = info.acUniqueId;
    this.firmwareVersion = info.firmwareVersion;
    this.acModelId = info.acModelId;

    let state: FcuState;
    try {
      state = FcuState.fromHexState(info.initialAcState);
    } catch (e) {
      this.log.warn(`[${this.name}] Invalid initial AC state (${errorMessage(e)}), starting empty`);
      state = new FcuState();
    }
    this.fcuState = state;

    this._supported = Features.fromMeritStringAndModel(info.meritFeature, info.acModelId);
  }

  get supported(): Features {
    return this._supported;
  }

  onStateChanged(listener: () => void): void {
    this.stateListeners.push(listener);
  }

  private notifyStateChanged(): void {
    this.log.debug(`[${this.name}] Current state: ${this.fcuState}`);
    for (const listener of this.stateListeners) {
      try {
        listener();
      } catch (e) {
        this.log.error(`[${this.name}] State listener failed: ${errorMessage(e)}`);
      }
    }
  }

  /** Start background work: one-shot additional info fetch and periodic state reload. */
  connect(refreshIntervalMinutes: number): void {
    void this.loadAdditionalInfo();
    this.schedulePoll(refreshIntervalMinutes * 60_000);
  }

  shutdown(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async loadAdditionalInfo(): Promise<void> {
    try {
      const info = await this.httpApi.getDeviceAdditionalInfo(this.acId);
      this.cduModel = info.cdu;
      this.fcuModel = info.fcu;
      this.notifyStateChanged();
    } catch (e) {
      this.log.debug(`[${this.name}] Failed to load additional device info: ${errorMessage(e)}`);
    }
  }

  private schedulePoll(intervalMs: number): void {
    const delay = intervalMs + Math.random() * POLL_JITTER_MS;
    this.pollTimer = setTimeout(async () => {
      try {
        await this.stateReload();
      } catch (e) {
        this.log.warn(`[${this.name}] State reload failed: ${errorMessage(e)}`);
      }
      this.schedulePoll(intervalMs);
    }, delay);
  }

  async stateReload(): Promise<void> {
    const hexState = await this.httpApi.getDeviceState(this.acId);
    this.log.debug(`[${this.name}] AC state from HTTP: ${hexState}`);
    if (this.fcuState.update(hexState)) {
      this.notifyStateChanged();
    }
  }

  handleCmdFcuFromAc(payload: Record<string, unknown>): void {
    const data = payload.data;
    if (typeof data !== 'string') {
      this.log.error(`[${this.name}] Malformed AC state from IoT hub: ${JSON.stringify(data)}`);
      return;
    }
    this.log.debug(`[${this.name}] AC state from IoT hub: ${data}`);
    try {
      if (this.fcuState.update(data)) {
        this.notifyStateChanged();
      }
    } catch (e) {
      this.log.error(`[${this.name}] Failed to parse AC state from IoT hub: ${errorMessage(e)}`);
    }
  }

  handleCmdHeartbeat(payload: Record<string, unknown>): void {
    // Values are single-byte hex strings; temperatures are signed.
    const data: Record<string, number> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value !== 'string' || !/^[0-9a-fA-F]{2}$/.test(value)) {
        continue;
      }
      let parsed = Number.parseInt(value, 16);
      if (key.includes('Temp') && parsed > 127) {
        parsed -= 256;
      }
      data[key] = parsed;
    }
    this.log.debug(`[${this.name}] AC heartbeat from IoT hub: ${JSON.stringify(data)}`);

    if (this.fcuState.updateFromHeartbeat(data)) {
      this.notifyStateChanged();
    }
  }

  /**
   * Send a sparse state (only changed fields set, the rest at none-values)
   * to the AC after validating it against the unit's supported features.
   */
  async sendStateToAc(state: FcuState): Promise<void> {
    const futureState = this.fcuState.clone();
    futureState.update(state.encode());

    if (!this.supported.acStatus.includes(futureState.acStatus)) {
      throw new ToshibaAcDeviceError(
        `[${this.name}] Trying to set unsupported ac status: ${futureState.acStatus}`,
      );
    }

    if (!this.supported.acMode.includes(futureState.acMode)) {
      throw new ToshibaAcDeviceError(
        `[${this.name}] Trying to set unsupported ac mode: ${futureState.acMode}`,
      );
    }

    const supportedForMode = this.supported.forAcMode(futureState.acMode);

    const warnIfSameMode = (message: string): void => {
      if (futureState.acMode === this.acMode) {
        this.log.warn(message);
      }
    };

    if (!supportedForMode.acFanMode.includes(futureState.acFanMode)) {
      warnIfSameMode(`[${this.name}] Trying to set unsupported ac fan mode: ${futureState.acFanMode}`);
      state.acFanMode = AcFanMode.None;
    }

    if (!supportedForMode.acSwingMode.includes(futureState.acSwingMode)) {
      warnIfSameMode(`[${this.name}] Trying to set unsupported ac swing mode: ${futureState.acSwingMode}`);
      state.acSwingMode = AcSwingMode.None;
    }

    if (!supportedForMode.acPowerSelection.includes(futureState.acPowerSelection)) {
      warnIfSameMode(
        `[${this.name}] Trying to set unsupported ac power selection: ${futureState.acPowerSelection}`,
      );
      state.acPowerSelection = AcPowerSelection.None;
    }

    if (!supportedForMode.acMeritB.includes(futureState.acMeritB)) {
      warnIfSameMode(`[${this.name}] Trying to set unsupported ac merit b: ${futureState.acMeritB}`);
      state.acMeritB = AcMeritB.Off;
    }

    if (!supportedForMode.acMeritA.includes(futureState.acMeritA)) {
      warnIfSameMode(`[${this.name}] Trying to set unsupported ac merit a: ${futureState.acMeritA}`);
      state.acMeritA = AcMeritA.Off;
    }

    if (!supportedForMode.acAirPureIon.includes(futureState.acAirPureIon)) {
      warnIfSameMode(`[${this.name}] Trying to set unsupported ac air pure ion: ${futureState.acAirPureIon}`);
      state.acAirPureIon = AcAirPureIon.None;
    }

    if (!supportedForMode.acSelfCleaning.includes(futureState.acSelfCleaning)) {
      warnIfSameMode(`[${this.name}] Trying to set unsupported ac self cleaning: ${futureState.acSelfCleaning}`);
      state.acSelfCleaning = AcSelfCleaning.None;
    }

    // If we are requesting to turn on, we have to clear the self-cleaning flag.
    if (state.acStatus === AcStatus.On && this.acSelfCleaning === AcSelfCleaning.On) {
      state.acSelfCleaning = AcSelfCleaning.Off;
    }

    // In HEATING_8C mode reported temperatures are 16 degrees higher than the
    // actual setpoint (only when heating).
    if (state.acTemperature !== null) {
      if (futureState.acMode === AcMode.Heat && futureState.acMeritA === AcMeritA.Heating8C) {
        state.acTemperature = state.acTemperature + 16;
      }
    }

    const encodedState = state.encode();
    this.log.debug(`[${this.name}] Sending command: ${state}`);

    // Optimistically merge the command into the local state *before* awaiting
    // the network round-trip. This makes HomeKit reflect it immediately, and —
    // crucially — makes a command that arrives while this publish is still in
    // flight diff against the intended state rather than stale state (otherwise
    // a rapid A→B→A reversal would be silently dropped as a no-op).
    if (this.fcuState.update(encodedState)) {
      this.notifyStateChanged();
    }

    try {
      await this.mqttApi.sendMessage({
        sourceId: this.clientDeviceId,
        messageId: '0000000',
        targetId: [this.acUniqueId],
        cmd: 'CMD_FCU_TO_AC',
        payload: { data: encodedState },
        timeStamp: '0000000',
      });
    } catch (e) {
      // The optimistic merge above may now misrepresent the AC — re-sync from
      // the cloud so HomeKit reflects reality.
      this.log.debug(`[${this.name}] Command send failed (${errorMessage(e)}), reloading state`);
      void this.stateReload().catch(() => undefined);
      throw e;
    }
  }

  /** Build one sparse command out of the fields that actually change, and send it. */
  async applyPartialState(partial: PartialAcState): Promise<void> {
    const state = new FcuState();
    let hasChanges = false;

    if (partial.status !== undefined && partial.status !== this.acStatus) {
      state.acStatus = partial.status;
      hasChanges = true;
    }
    if (partial.mode !== undefined && partial.mode !== this.acMode) {
      state.acMode = partial.mode;
      hasChanges = true;
    }
    if (partial.temperature !== undefined && partial.temperature !== this.acTemperature) {
      state.acTemperature = partial.temperature;
      hasChanges = true;
    }
    if (partial.fanMode !== undefined && partial.fanMode !== this.acFanMode) {
      state.acFanMode = partial.fanMode;
      hasChanges = true;
    }
    if (partial.swingMode !== undefined && partial.swingMode !== this.acSwingMode) {
      state.acSwingMode = partial.swingMode;
      hasChanges = true;
    }

    if (!hasChanges) {
      return;
    }

    await this.sendStateToAc(state);
  }

  get acStatus(): AcStatus {
    return this.fcuState.acStatus;
  }

  get acMode(): AcMode {
    return this.fcuState.acMode;
  }

  get acTemperature(): number | null {
    // In HEATING_8C mode reported temperatures are 16 degrees higher than the
    // actual setpoint (only when heating).
    let temperature = this.fcuState.acTemperature;
    if (
      this.fcuState.acMode === AcMode.Heat &&
      this.fcuState.acMeritA === AcMeritA.Heating8C &&
      temperature !== null
    ) {
      temperature -= 16;
    }
    return temperature;
  }

  get acFanMode(): AcFanMode {
    return this.fcuState.acFanMode;
  }

  get acSwingMode(): AcSwingMode {
    return this.fcuState.acSwingMode;
  }

  get acPowerSelection(): AcPowerSelection {
    return this.fcuState.acPowerSelection;
  }

  get acMeritA(): AcMeritA {
    return this.fcuState.acMeritA;
  }

  get acMeritB(): AcMeritB {
    return this.fcuState.acMeritB;
  }

  get acAirPureIon(): AcAirPureIon {
    return this.fcuState.acAirPureIon;
  }

  get acIndoorTemperature(): number | null {
    return this.fcuState.acIndoorTemperature;
  }

  get acOutdoorTemperature(): number | null {
    return this.fcuState.acOutdoorTemperature;
  }

  get acSelfCleaning(): AcSelfCleaning {
    return this.fcuState.acSelfCleaning;
  }
}
