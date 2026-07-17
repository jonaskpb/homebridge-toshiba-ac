/**
 * Codec for the FCU (fan coil unit) state record exchanged with Toshiba's
 * cloud: a 38-hex-character string carrying the full AC state.
 *
 * Ported from KaSroka/Toshiba-AC-control (toshiba_ac/device/fcu_state.py),
 * Apache-2.0.
 *
 * Wire layout (hex character offsets):
 *   0-1   ac status          14-15  air pure ion
 *   2-3   ac mode            16-17  indoor temperature (signed)
 *   4-5   target temperature 18-19  outdoor temperature (signed)
 *         (signed)           20-27  unused (0xff)
 *   6-7   fan mode           28-29  self cleaning
 *   8-9   swing mode         30-37  unused (0xff)
 *   10-11 power selection
 *   12    merit B (nibble)
 *   13    merit A (nibble)
 *
 * 0xff (0x0f for the merit nibbles, -1 for signed temperatures) means
 * "no value" — commands are sparse states where every unchanged field is
 * left at its none-value.
 */

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
} from './properties.js';

export const NONE_VAL = 0xff;
export const NONE_VAL_HALF = 0x0f;
export const NONE_VAL_SIGNED = -1;

const STATE_HEX_LENGTH = 38;

interface EnumCodec<T extends string> {
  fromRaw(raw: number): T;
  toRaw(value: T): number;
}

function makeCodec<T extends string>(
  fromMap: Record<number, T>,
  toMap: Record<string, number>,
  noneValue: T,
): EnumCodec<T> {
  return {
    // The Python library raises on unknown raw values; we fall back to None so
    // an unknown value from a newer firmware cannot break state handling.
    fromRaw: (raw) => fromMap[raw] ?? noneValue,
    toRaw: (value) => toMap[value] ?? NONE_VAL,
  };
}

export const AcStatusCodec = makeCodec<AcStatus>(
  { 0x30: AcStatus.On, 0x31: AcStatus.Off, 0x02: AcStatus.None, [NONE_VAL]: AcStatus.None },
  { [AcStatus.On]: 0x30, [AcStatus.Off]: 0x31, [AcStatus.None]: NONE_VAL },
  AcStatus.None,
);

export const AcModeCodec = makeCodec<AcMode>(
  {
    0x41: AcMode.Auto,
    0x42: AcMode.Cool,
    0x43: AcMode.Heat,
    0x44: AcMode.Dry,
    0x45: AcMode.Fan,
    0x00: AcMode.None,
    [NONE_VAL]: AcMode.None,
  },
  {
    [AcMode.Auto]: 0x41,
    [AcMode.Cool]: 0x42,
    [AcMode.Heat]: 0x43,
    [AcMode.Dry]: 0x44,
    [AcMode.Fan]: 0x45,
    [AcMode.None]: NONE_VAL,
  },
  AcMode.None,
);

export const AcFanModeCodec = makeCodec<AcFanMode>(
  {
    0x41: AcFanMode.Auto,
    0x31: AcFanMode.Quiet,
    0x32: AcFanMode.Low,
    0x33: AcFanMode.MediumLow,
    0x34: AcFanMode.Medium,
    0x35: AcFanMode.MediumHigh,
    0x36: AcFanMode.High,
    0x00: AcFanMode.None,
    [NONE_VAL]: AcFanMode.None,
  },
  {
    [AcFanMode.Auto]: 0x41,
    [AcFanMode.Quiet]: 0x31,
    [AcFanMode.Low]: 0x32,
    [AcFanMode.MediumLow]: 0x33,
    [AcFanMode.Medium]: 0x34,
    [AcFanMode.MediumHigh]: 0x35,
    [AcFanMode.High]: 0x36,
    [AcFanMode.None]: NONE_VAL,
  },
  AcFanMode.None,
);

export const AcSwingModeCodec = makeCodec<AcSwingMode>(
  {
    0x31: AcSwingMode.Off,
    0x41: AcSwingMode.SwingVertical,
    0x42: AcSwingMode.SwingHorizontal,
    0x43: AcSwingMode.SwingVerticalAndHorizontal,
    0x50: AcSwingMode.Fixed1,
    0x51: AcSwingMode.Fixed2,
    0x52: AcSwingMode.Fixed3,
    0x53: AcSwingMode.Fixed4,
    0x54: AcSwingMode.Fixed5,
    0x00: AcSwingMode.None,
    [NONE_VAL]: AcSwingMode.None,
  },
  {
    [AcSwingMode.Off]: 0x31,
    [AcSwingMode.SwingVertical]: 0x41,
    [AcSwingMode.SwingHorizontal]: 0x42,
    [AcSwingMode.SwingVerticalAndHorizontal]: 0x43,
    [AcSwingMode.Fixed1]: 0x50,
    [AcSwingMode.Fixed2]: 0x51,
    [AcSwingMode.Fixed3]: 0x52,
    [AcSwingMode.Fixed4]: 0x53,
    [AcSwingMode.Fixed5]: 0x54,
    [AcSwingMode.None]: NONE_VAL,
  },
  AcSwingMode.None,
);

export const AcPowerSelectionCodec = makeCodec<AcPowerSelection>(
  {
    0x32: AcPowerSelection.Power50,
    0x4b: AcPowerSelection.Power75,
    0x64: AcPowerSelection.Power100,
    [NONE_VAL]: AcPowerSelection.None,
  },
  {
    [AcPowerSelection.Power50]: 0x32,
    [AcPowerSelection.Power75]: 0x4b,
    [AcPowerSelection.Power100]: 0x64,
    [AcPowerSelection.None]: NONE_VAL,
  },
  AcPowerSelection.None,
);

export const AcMeritBCodec = makeCodec<AcMeritB>(
  {
    0x02: AcMeritB.Fireplace1,
    0x03: AcMeritB.Fireplace2,
    0x01: AcMeritB.Off, // Reported by some units after a firmware update
    0x00: AcMeritB.Off,
    [NONE_VAL]: AcMeritB.None,
    [NONE_VAL_HALF]: AcMeritB.None,
  },
  {
    [AcMeritB.Fireplace1]: 0x02,
    [AcMeritB.Fireplace2]: 0x03,
    [AcMeritB.Off]: 0x00,
    [AcMeritB.None]: NONE_VAL,
  },
  AcMeritB.None,
);

export const AcMeritACodec = makeCodec<AcMeritA>(
  {
    0x01: AcMeritA.HighPower,
    0x02: AcMeritA.CduSilent1,
    0x03: AcMeritA.Eco,
    0x04: AcMeritA.Heating8C,
    0x05: AcMeritA.SleepCare,
    0x06: AcMeritA.Floor,
    0x07: AcMeritA.Comfort,
    0x0a: AcMeritA.CduSilent2,
    0x00: AcMeritA.Off,
    [NONE_VAL]: AcMeritA.None,
    [NONE_VAL_HALF]: AcMeritA.None,
  },
  {
    [AcMeritA.HighPower]: 0x01,
    [AcMeritA.CduSilent1]: 0x02,
    [AcMeritA.Eco]: 0x03,
    [AcMeritA.Heating8C]: 0x04,
    [AcMeritA.SleepCare]: 0x05,
    [AcMeritA.Floor]: 0x06,
    [AcMeritA.Comfort]: 0x07,
    [AcMeritA.CduSilent2]: 0x0a,
    [AcMeritA.Off]: 0x00,
    [AcMeritA.None]: NONE_VAL,
  },
  AcMeritA.None,
);

export const AcAirPureIonCodec = makeCodec<AcAirPureIon>(
  { 0x18: AcAirPureIon.On, 0x10: AcAirPureIon.Off, [NONE_VAL]: AcAirPureIon.None },
  { [AcAirPureIon.On]: 0x18, [AcAirPureIon.Off]: 0x10, [AcAirPureIon.None]: NONE_VAL },
  AcAirPureIon.None,
);

export const AcSelfCleaningCodec = makeCodec<AcSelfCleaning>(
  { 0x18: AcSelfCleaning.On, 0x10: AcSelfCleaning.Off, [NONE_VAL]: AcSelfCleaning.None },
  { [AcSelfCleaning.On]: 0x18, [AcSelfCleaning.Off]: 0x10, [AcSelfCleaning.None]: NONE_VAL },
  AcSelfCleaning.None,
);

export const AcTemperatureCodec = {
  fromRaw(raw: number): number | null {
    if (raw === 127 || raw === -128 || raw === NONE_VAL_SIGNED) {
      return null;
    }
    if (raw === 126) {
      return -1; // -1 °C collides with the none-value, so it travels as 126
    }
    return raw;
  },
  toRaw(value: number | null): number {
    if (value === null) {
      return NONE_VAL_SIGNED;
    }
    if (value === -1) {
      return 126;
    }
    if (!Number.isInteger(value) || value < -128 || value > 127) {
      throw new RangeError(`Temperature out of range: ${value}`);
    }
    return value;
  },
};

const toSignedByte = (b: number): number => (b > 127 ? b - 256 : b);
const byteToHex = (v: number): string => (v & 0xff).toString(16).padStart(2, '0');
const signedToHex = (v: number): string => byteToHex(v < 0 ? v + 256 : v);

type EnumRawField =
  | '_acStatus'
  | '_acMode'
  | '_acFanMode'
  | '_acSwingMode'
  | '_acPowerSelection'
  | '_acMeritB'
  | '_acMeritA'
  | '_acAirPureIon'
  | '_acSelfCleaning';

type TemperatureRawField = '_acTemperature' | '_acIndoorTemperature' | '_acOutdoorTemperature';

const ENUM_RAW_FIELDS: EnumRawField[] = [
  '_acStatus',
  '_acMode',
  '_acFanMode',
  '_acSwingMode',
  '_acPowerSelection',
  '_acMeritB',
  '_acMeritA',
  '_acAirPureIon',
  '_acSelfCleaning',
];

const TEMPERATURE_RAW_FIELDS: TemperatureRawField[] = [
  '_acTemperature',
  '_acIndoorTemperature',
  '_acOutdoorTemperature',
];

export class FcuState {
  private _acStatus = NONE_VAL;
  private _acMode = NONE_VAL;
  private _acTemperature = NONE_VAL_SIGNED;
  private _acFanMode = NONE_VAL;
  private _acSwingMode = NONE_VAL;
  private _acPowerSelection = NONE_VAL;
  private _acMeritB = NONE_VAL;
  private _acMeritA = NONE_VAL;
  private _acAirPureIon = NONE_VAL;
  private _acIndoorTemperature = NONE_VAL_SIGNED;
  private _acOutdoorTemperature = NONE_VAL_SIGNED;
  private _acSelfCleaning = NONE_VAL;

  static fromHexState(hexState: string): FcuState {
    const state = new FcuState();
    state.decode(hexState);
    return state;
  }

  clone(): FcuState {
    return FcuState.fromHexState(this.encode());
  }

  encode(): string {
    return [
      byteToHex(this._acStatus),
      byteToHex(this._acMode),
      signedToHex(this._acTemperature),
      byteToHex(this._acFanMode),
      byteToHex(this._acSwingMode),
      byteToHex(this._acPowerSelection),
      (this._acMeritB & 0x0f).toString(16),
      (this._acMeritA & 0x0f).toString(16),
      byteToHex(this._acAirPureIon),
      signedToHex(this._acIndoorTemperature),
      signedToHex(this._acOutdoorTemperature),
      'ffffffff',
      byteToHex(this._acSelfCleaning),
      'ffffffff',
    ].join('');
  }

  decode(hexState: string): void {
    const hex = hexState.trim().toLowerCase();
    // Extra characters beyond the known layout are ignored, as in the
    // Python library.
    if (hex.length < STATE_HEX_LENGTH || !/^[0-9a-f]+$/.test(hex.slice(0, STATE_HEX_LENGTH))) {
      throw new Error(`Invalid AC state "${hexState}"`);
    }
    const byteAt = (pos: number): number => Number.parseInt(hex.slice(pos, pos + 2), 16);
    const signedAt = (pos: number): number => toSignedByte(byteAt(pos));

    this._acStatus = byteAt(0);
    this._acMode = byteAt(2);
    this._acTemperature = signedAt(4);
    this._acFanMode = byteAt(6);
    this._acSwingMode = byteAt(8);
    this._acPowerSelection = byteAt(10);
    this._acMeritB = Number.parseInt(hex[12], 16);
    this._acMeritA = Number.parseInt(hex[13], 16);
    this._acAirPureIon = byteAt(14);
    this._acIndoorTemperature = signedAt(16);
    this._acOutdoorTemperature = signedAt(18);
    this._acSelfCleaning = byteAt(28);
  }

  /**
   * Merge another state record into this one. Fields carrying the none-value
   * in the update are left untouched. Returns whether anything changed.
   */
  update(hexState: string): boolean {
    const incoming = FcuState.fromHexState(hexState);
    let changed = false;

    for (const field of ENUM_RAW_FIELDS) {
      const updated = incoming[field];
      if (updated !== NONE_VAL && updated !== NONE_VAL_HALF && updated !== this[field]) {
        this[field] = updated;
        changed = true;
      }
    }

    for (const field of TEMPERATURE_RAW_FIELDS) {
      const updated = incoming[field];
      if (updated !== NONE_VAL_SIGNED && updated !== this[field]) {
        this[field] = updated;
        changed = true;
      }
    }

    return changed;
  }

  /** Merge indoor/outdoor temperatures from a CMD_HEARTBEAT payload. */
  updateFromHeartbeat(data: Record<string, number>): boolean {
    let changed = false;

    if ('iTemp' in data && data.iTemp !== this._acIndoorTemperature) {
      this._acIndoorTemperature = data.iTemp;
      changed = true;
    }

    if ('oTemp' in data && data.oTemp !== this._acOutdoorTemperature) {
      this._acOutdoorTemperature = data.oTemp;
      changed = true;
    }

    return changed;
  }

  get acStatus(): AcStatus {
    return AcStatusCodec.fromRaw(this._acStatus);
  }

  set acStatus(value: AcStatus) {
    this._acStatus = AcStatusCodec.toRaw(value);
  }

  get acMode(): AcMode {
    return AcModeCodec.fromRaw(this._acMode);
  }

  set acMode(value: AcMode) {
    this._acMode = AcModeCodec.toRaw(value);
  }

  get acTemperature(): number | null {
    return AcTemperatureCodec.fromRaw(this._acTemperature);
  }

  set acTemperature(value: number | null) {
    this._acTemperature = AcTemperatureCodec.toRaw(value);
  }

  get acFanMode(): AcFanMode {
    return AcFanModeCodec.fromRaw(this._acFanMode);
  }

  set acFanMode(value: AcFanMode) {
    this._acFanMode = AcFanModeCodec.toRaw(value);
  }

  get acSwingMode(): AcSwingMode {
    return AcSwingModeCodec.fromRaw(this._acSwingMode);
  }

  set acSwingMode(value: AcSwingMode) {
    this._acSwingMode = AcSwingModeCodec.toRaw(value);
  }

  get acPowerSelection(): AcPowerSelection {
    return AcPowerSelectionCodec.fromRaw(this._acPowerSelection);
  }

  set acPowerSelection(value: AcPowerSelection) {
    this._acPowerSelection = AcPowerSelectionCodec.toRaw(value);
  }

  get acMeritB(): AcMeritB {
    return AcMeritBCodec.fromRaw(this._acMeritB);
  }

  set acMeritB(value: AcMeritB) {
    this._acMeritB = AcMeritBCodec.toRaw(value);
  }

  get acMeritA(): AcMeritA {
    return AcMeritACodec.fromRaw(this._acMeritA);
  }

  set acMeritA(value: AcMeritA) {
    this._acMeritA = AcMeritACodec.toRaw(value);
  }

  get acAirPureIon(): AcAirPureIon {
    return AcAirPureIonCodec.fromRaw(this._acAirPureIon);
  }

  set acAirPureIon(value: AcAirPureIon) {
    this._acAirPureIon = AcAirPureIonCodec.toRaw(value);
  }

  get acIndoorTemperature(): number | null {
    return AcTemperatureCodec.fromRaw(this._acIndoorTemperature);
  }

  set acIndoorTemperature(value: number | null) {
    this._acIndoorTemperature = AcTemperatureCodec.toRaw(value);
  }

  get acOutdoorTemperature(): number | null {
    return AcTemperatureCodec.fromRaw(this._acOutdoorTemperature);
  }

  set acOutdoorTemperature(value: number | null) {
    this._acOutdoorTemperature = AcTemperatureCodec.toRaw(value);
  }

  get acSelfCleaning(): AcSelfCleaning {
    return AcSelfCleaningCodec.fromRaw(this._acSelfCleaning);
  }

  set acSelfCleaning(value: AcSelfCleaning) {
    this._acSelfCleaning = AcSelfCleaningCodec.toRaw(value);
  }

  toString(): string {
    return (
      `AcStatus: ${this.acStatus}, AcMode: ${this.acMode}, AcTemperature: ${this.acTemperature}, ` +
      `AcFanMode: ${this.acFanMode}, AcSwingMode: ${this.acSwingMode}, ` +
      `AcPowerSelection: ${this.acPowerSelection}, AcMeritB: ${this.acMeritB}, ` +
      `AcMeritA: ${this.acMeritA}, AcAirPureIon: ${this.acAirPureIon}, ` +
      `AcIndoorTemperature: ${this.acIndoorTemperature}, AcOutdoorTemperature: ${this.acOutdoorTemperature}, ` +
      `AcSelfCleaning: ${this.acSelfCleaning}`
    );
  }
}

/** Hex encoding of a state with every field at its none-value. */
export const EMPTY_STATE_HEX = new FcuState().encode();
