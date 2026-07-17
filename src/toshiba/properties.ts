/**
 * Enumerations describing the state of a Toshiba AC unit.
 *
 * Ported from KaSroka/Toshiba-AC-control (toshiba_ac/device/properties.py),
 * Apache-2.0. Enum member values intentionally match the Python enum names so
 * both implementations can be compared 1:1.
 */

export enum AcStatus {
  On = 'ON',
  Off = 'OFF',
  None = 'NONE',
}

export enum AcMode {
  Auto = 'AUTO',
  Cool = 'COOL',
  Heat = 'HEAT',
  Dry = 'DRY',
  Fan = 'FAN',
  None = 'NONE',
}

export enum AcFanMode {
  Auto = 'AUTO',
  Quiet = 'QUIET',
  Low = 'LOW',
  MediumLow = 'MEDIUM_LOW',
  Medium = 'MEDIUM',
  MediumHigh = 'MEDIUM_HIGH',
  High = 'HIGH',
  None = 'NONE',
}

export enum AcSwingMode {
  Off = 'OFF',
  SwingVertical = 'SWING_VERTICAL',
  SwingHorizontal = 'SWING_HORIZONTAL',
  SwingVerticalAndHorizontal = 'SWING_VERTICAL_AND_HORIZONTAL',
  Fixed1 = 'FIXED_1',
  Fixed2 = 'FIXED_2',
  Fixed3 = 'FIXED_3',
  Fixed4 = 'FIXED_4',
  Fixed5 = 'FIXED_5',
  None = 'NONE',
}

export enum AcPowerSelection {
  Power50 = 'POWER_50',
  Power75 = 'POWER_75',
  Power100 = 'POWER_100',
  None = 'NONE',
}

export enum AcMeritB {
  Fireplace1 = 'FIREPLACE_1',
  Fireplace2 = 'FIREPLACE_2',
  Off = 'OFF',
  None = 'NONE',
}

export enum AcMeritA {
  HighPower = 'HIGH_POWER',
  CduSilent1 = 'CDU_SILENT_1',
  Eco = 'ECO',
  Heating8C = 'HEATING_8C',
  SleepCare = 'SLEEP_CARE',
  Floor = 'FLOOR',
  Comfort = 'COMFORT',
  CduSilent2 = 'CDU_SILENT_2',
  Off = 'OFF',
  None = 'NONE',
}

export enum AcAirPureIon {
  Off = 'OFF',
  On = 'ON',
  None = 'NONE',
}

export enum AcSelfCleaning {
  On = 'ON',
  Off = 'OFF',
  None = 'NONE',
}
