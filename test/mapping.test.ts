import { describe, expect, it } from 'vitest';

import {
  acModeToTargetState,
  clampTargetTemperature,
  computeCurrentHeaterCoolerState,
  fanModeToRotationSpeed,
  HAP_CURRENT_STATE,
  HAP_TARGET_STATE,
  rotationSpeedToFanMode,
  targetStateToAcMode,
} from '../src/mapping';
import { AcFanMode, AcMode, AcStatus } from '../src/toshiba/properties';

describe('fan speed mapping', () => {
  it('round-trips every fan mode', () => {
    for (const mode of [
      AcFanMode.Quiet,
      AcFanMode.Low,
      AcFanMode.MediumLow,
      AcFanMode.Medium,
      AcFanMode.MediumHigh,
      AcFanMode.High,
      AcFanMode.Auto,
    ]) {
      expect(rotationSpeedToFanMode(fanModeToRotationSpeed(mode))).toBe(mode);
    }
  });

  it('buckets arbitrary slider values', () => {
    expect(rotationSpeedToFanMode(0)).toBe(AcFanMode.Quiet);
    expect(rotationSpeedToFanMode(50)).toBe(AcFanMode.Medium);
    expect(rotationSpeedToFanMode(100)).toBe(AcFanMode.Auto);
  });
});

describe('target state mapping', () => {
  const allTargets = [HAP_TARGET_STATE.AUTO, HAP_TARGET_STATE.HEAT, HAP_TARGET_STATE.COOL];

  it('maps modes both ways', () => {
    expect(acModeToTargetState(AcMode.Auto, allTargets)).toBe(HAP_TARGET_STATE.AUTO);
    expect(acModeToTargetState(AcMode.Heat, allTargets)).toBe(HAP_TARGET_STATE.HEAT);
    expect(acModeToTargetState(AcMode.Cool, allTargets)).toBe(HAP_TARGET_STATE.COOL);
    expect(targetStateToAcMode(HAP_TARGET_STATE.HEAT)).toBe(AcMode.Heat);
    expect(targetStateToAcMode(HAP_TARGET_STATE.COOL)).toBe(AcMode.Cool);
    expect(targetStateToAcMode(HAP_TARGET_STATE.AUTO)).toBe(AcMode.Auto);
  });

  it('falls back for dry/fan modes', () => {
    expect(acModeToTargetState(AcMode.Dry, allTargets)).toBe(HAP_TARGET_STATE.AUTO);
    expect(acModeToTargetState(AcMode.Fan, allTargets)).toBe(HAP_TARGET_STATE.AUTO);
    // Cool-only unit
    expect(acModeToTargetState(AcMode.Dry, [HAP_TARGET_STATE.COOL])).toBe(HAP_TARGET_STATE.COOL);
  });

  it('falls back when the current mode is not offered', () => {
    expect(acModeToTargetState(AcMode.Heat, [HAP_TARGET_STATE.AUTO, HAP_TARGET_STATE.COOL])).toBe(
      HAP_TARGET_STATE.AUTO,
    );
  });
});

describe('current heater cooler state', () => {
  it('is inactive when off', () => {
    expect(computeCurrentHeaterCoolerState(AcStatus.Off, AcMode.Cool, 25, 22)).toBe(
      HAP_CURRENT_STATE.INACTIVE,
    );
  });

  it('reflects heating and cooling with temperatures', () => {
    expect(computeCurrentHeaterCoolerState(AcStatus.On, AcMode.Cool, 26, 22)).toBe(
      HAP_CURRENT_STATE.COOLING,
    );
    expect(computeCurrentHeaterCoolerState(AcStatus.On, AcMode.Cool, 21, 22)).toBe(HAP_CURRENT_STATE.IDLE);
    expect(computeCurrentHeaterCoolerState(AcStatus.On, AcMode.Heat, 18, 22)).toBe(
      HAP_CURRENT_STATE.HEATING,
    );
    expect(computeCurrentHeaterCoolerState(AcStatus.On, AcMode.Heat, 23, 22)).toBe(HAP_CURRENT_STATE.IDLE);
  });

  it('uses temperatures in auto mode', () => {
    expect(computeCurrentHeaterCoolerState(AcStatus.On, AcMode.Auto, 26, 22)).toBe(
      HAP_CURRENT_STATE.COOLING,
    );
    expect(computeCurrentHeaterCoolerState(AcStatus.On, AcMode.Auto, 18, 22)).toBe(
      HAP_CURRENT_STATE.HEATING,
    );
    expect(computeCurrentHeaterCoolerState(AcStatus.On, AcMode.Auto, 22, 22)).toBe(HAP_CURRENT_STATE.IDLE);
  });

  it('remains active without temperature data', () => {
    expect(computeCurrentHeaterCoolerState(AcStatus.On, AcMode.Cool, null, 22)).toBe(
      HAP_CURRENT_STATE.COOLING,
    );
    expect(computeCurrentHeaterCoolerState(AcStatus.On, AcMode.Fan, 25, null)).toBe(HAP_CURRENT_STATE.IDLE);
  });
});

describe('clampTargetTemperature', () => {
  it('clamps into the 17-30 range', () => {
    expect(clampTargetTemperature(10)).toBe(17);
    expect(clampTargetTemperature(35)).toBe(30);
    expect(clampTargetTemperature(22)).toBe(22);
  });
});
