import { describe, expect, it } from 'vitest';

import { EMPTY_STATE_HEX, FcuState } from '../src/toshiba/fcuState';
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
} from '../src/toshiba/properties';

// ON, COOL, 25°C, fan AUTO, swing OFF, power 100%, merit B off, merit A off,
// pure ion OFF, indoor 22°C, outdoor 30°C, self cleaning OFF
const SAMPLE_STATE = '3042194131640010161effffffff10ffffffff';

describe('FcuState', () => {
  it('decodes a full state record', () => {
    const state = FcuState.fromHexState(SAMPLE_STATE);
    expect(state.acStatus).toBe(AcStatus.On);
    expect(state.acMode).toBe(AcMode.Cool);
    expect(state.acTemperature).toBe(25);
    expect(state.acFanMode).toBe(AcFanMode.Auto);
    expect(state.acSwingMode).toBe(AcSwingMode.Off);
    expect(state.acPowerSelection).toBe(AcPowerSelection.Power100);
    expect(state.acMeritB).toBe(AcMeritB.Off);
    expect(state.acMeritA).toBe(AcMeritA.Off);
    expect(state.acAirPureIon).toBe(AcAirPureIon.Off);
    expect(state.acIndoorTemperature).toBe(22);
    expect(state.acOutdoorTemperature).toBe(30);
    expect(state.acSelfCleaning).toBe(AcSelfCleaning.Off);
  });

  it('round-trips encode(decode(x))', () => {
    expect(FcuState.fromHexState(SAMPLE_STATE).encode()).toBe(SAMPLE_STATE);
  });

  it('ignores extra trailing characters when decoding', () => {
    const state = FcuState.fromHexState(SAMPLE_STATE + 'deadbeef');
    expect(state.encode()).toBe(SAMPLE_STATE);
  });

  it('rejects short or invalid input', () => {
    expect(() => FcuState.fromHexState('3042')).toThrow();
    expect(() => FcuState.fromHexState('zz'.repeat(19))).toThrow();
  });

  it('encodes an empty state as all 0xff', () => {
    expect(EMPTY_STATE_HEX).toBe('f'.repeat(38));
    expect(new FcuState().encode()).toBe(EMPTY_STATE_HEX);
  });

  it('encodes merit A/B as single nibbles', () => {
    const state = new FcuState();
    state.acMeritB = AcMeritB.Fireplace1;
    state.acMeritA = AcMeritA.Eco;
    const hex = state.encode();
    expect(hex[12]).toBe('2');
    expect(hex[13]).toBe('3');
    // Round-trip through decode
    const decoded = FcuState.fromHexState(hex);
    expect(decoded.acMeritB).toBe(AcMeritB.Fireplace1);
    expect(decoded.acMeritA).toBe(AcMeritA.Eco);
  });

  it('treats decoded merit nibble 0xf as none', () => {
    const state = FcuState.fromHexState(EMPTY_STATE_HEX);
    expect(state.acMeritA).toBe(AcMeritA.None);
    expect(state.acMeritB).toBe(AcMeritB.None);
  });

  it('handles the temperature special values', () => {
    const state = new FcuState();

    state.acTemperature = null;
    expect(state.encode().slice(4, 6)).toBe('ff');
    expect(state.acTemperature).toBeNull();

    state.acTemperature = -1; // travels as 126 (0x7e)
    expect(state.encode().slice(4, 6)).toBe('7e');
    expect(state.acTemperature).toBe(-1);

    // 127 and -128 decode as null
    expect(FcuState.fromHexState('30427f4131640010161effffffff10ffffffff').acTemperature).toBeNull();
    expect(FcuState.fromHexState('3042804131640010161effffffff10ffffffff').acTemperature).toBeNull();
  });

  it('merges only non-none fields in update()', () => {
    const state = FcuState.fromHexState(SAMPLE_STATE);

    const sparse = new FcuState();
    sparse.acMode = AcMode.Heat;
    sparse.acTemperature = 21;

    expect(state.update(sparse.encode())).toBe(true);
    expect(state.acMode).toBe(AcMode.Heat);
    expect(state.acTemperature).toBe(21);
    // Untouched fields stay intact
    expect(state.acStatus).toBe(AcStatus.On);
    expect(state.acFanMode).toBe(AcFanMode.Auto);
    expect(state.acIndoorTemperature).toBe(22);
  });

  it('reports no change when update matches current state', () => {
    const state = FcuState.fromHexState(SAMPLE_STATE);
    expect(state.update(SAMPLE_STATE)).toBe(false);
    expect(state.update(EMPTY_STATE_HEX)).toBe(false);
  });

  it('updates temperatures from heartbeat data', () => {
    const state = FcuState.fromHexState(SAMPLE_STATE);
    expect(state.updateFromHeartbeat({ iTemp: 24, oTemp: -3 })).toBe(true);
    expect(state.acIndoorTemperature).toBe(24);
    expect(state.acOutdoorTemperature).toBe(-3);
    expect(state.updateFromHeartbeat({ iTemp: 24 })).toBe(false);
  });
});
