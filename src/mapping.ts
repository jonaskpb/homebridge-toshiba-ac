/**
 * Pure helpers translating between Toshiba AC state and HomeKit
 * HeaterCooler characteristic values.
 */

import { AcFanMode, AcMode, AcStatus } from './toshiba/properties.js';

// HAP characteristic values (stable, defined by the HAP specification).
export const HAP_ACTIVE = { INACTIVE: 0, ACTIVE: 1 } as const;
export const HAP_CURRENT_STATE = { INACTIVE: 0, IDLE: 1, HEATING: 2, COOLING: 3 } as const;
export const HAP_TARGET_STATE = { AUTO: 0, HEAT: 1, COOL: 2 } as const;

/** Setpoint range supported by Toshiba units in normal modes. */
export const TARGET_TEMP_MIN = 17;
export const TARGET_TEMP_MAX = 30;

export function clampTargetTemperature(value: number): number {
  return Math.min(TARGET_TEMP_MAX, Math.max(TARGET_TEMP_MIN, value));
}

/**
 * The seven Toshiba fan levels on the 0-100 RotationSpeed scale.
 * Auto sits at 100 so it stays reachable from a single slider.
 */
const FAN_SPEED_STEPS: Array<{ mode: AcFanMode; value: number }> = [
  { mode: AcFanMode.Quiet, value: 15 },
  { mode: AcFanMode.Low, value: 29 },
  { mode: AcFanMode.MediumLow, value: 43 },
  { mode: AcFanMode.Medium, value: 57 },
  { mode: AcFanMode.MediumHigh, value: 72 },
  { mode: AcFanMode.High, value: 86 },
  { mode: AcFanMode.Auto, value: 100 },
];

export function fanModeToRotationSpeed(mode: AcFanMode): number {
  return FAN_SPEED_STEPS.find((step) => step.mode === mode)?.value ?? 57;
}

export function rotationSpeedToFanMode(speed: number): AcFanMode {
  for (const step of FAN_SPEED_STEPS) {
    if (speed <= step.value) {
      return step.mode;
    }
  }
  return AcFanMode.Auto;
}

/**
 * Map the AC mode to TargetHeaterCoolerState. Dry and Fan modes have no
 * HeaterCooler equivalent and are reported as the first valid fallback.
 */
export function acModeToTargetState(mode: AcMode, validTargets: readonly number[]): number {
  switch (mode) {
  case AcMode.Auto:
    if (validTargets.includes(HAP_TARGET_STATE.AUTO)) {
      return HAP_TARGET_STATE.AUTO;
    }
    break;
  case AcMode.Heat:
    if (validTargets.includes(HAP_TARGET_STATE.HEAT)) {
      return HAP_TARGET_STATE.HEAT;
    }
    break;
  case AcMode.Cool:
    if (validTargets.includes(HAP_TARGET_STATE.COOL)) {
      return HAP_TARGET_STATE.COOL;
    }
    break;
  default:
    break;
  }
  if (validTargets.includes(HAP_TARGET_STATE.AUTO)) {
    return HAP_TARGET_STATE.AUTO;
  }
  return validTargets[0] ?? HAP_TARGET_STATE.AUTO;
}

export function targetStateToAcMode(value: number): AcMode {
  switch (value) {
  case HAP_TARGET_STATE.HEAT:
    return AcMode.Heat;
  case HAP_TARGET_STATE.COOL:
    return AcMode.Cool;
  default:
    return AcMode.Auto;
  }
}

/** Heuristic for CurrentHeaterCoolerState based on mode and temperatures. */
export function computeCurrentHeaterCoolerState(
  status: AcStatus,
  mode: AcMode,
  indoorTemperature: number | null,
  targetTemperature: number | null,
): number {
  if (status !== AcStatus.On) {
    return HAP_CURRENT_STATE.INACTIVE;
  }

  const indoor = indoorTemperature;
  const target = targetTemperature;

  switch (mode) {
  case AcMode.Heat:
    if (indoor !== null && target !== null && indoor >= target) {
      return HAP_CURRENT_STATE.IDLE;
    }
    return HAP_CURRENT_STATE.HEATING;
  case AcMode.Cool:
    if (indoor !== null && target !== null && indoor <= target) {
      return HAP_CURRENT_STATE.IDLE;
    }
    return HAP_CURRENT_STATE.COOLING;
  case AcMode.Dry:
    return HAP_CURRENT_STATE.COOLING;
  case AcMode.Fan:
    return HAP_CURRENT_STATE.IDLE;
  case AcMode.Auto:
    if (indoor === null || target === null) {
      return HAP_CURRENT_STATE.IDLE;
    }
    if (indoor > target) {
      return HAP_CURRENT_STATE.COOLING;
    }
    if (indoor < target) {
      return HAP_CURRENT_STATE.HEATING;
    }
    return HAP_CURRENT_STATE.IDLE;
  default:
    return HAP_CURRENT_STATE.IDLE;
  }
}
