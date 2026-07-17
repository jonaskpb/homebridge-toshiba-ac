/**
 * Feature detection for a Toshiba AC unit, derived from the "MeritFeature"
 * bitfield and the AC model id reported by the cloud API.
 *
 * Ported from KaSroka/Toshiba-AC-control (toshiba_ac/device/features.py),
 * Apache-2.0.
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
} from './properties';

const DISABLED_AC_MERIT_B_FOR_MODE: Partial<Record<AcMode, AcMeritB[]>> = {
  [AcMode.Auto]: [AcMeritB.Fireplace1, AcMeritB.Fireplace2],
  [AcMode.Cool]: [AcMeritB.Fireplace1, AcMeritB.Fireplace2],
  [AcMode.Dry]: [AcMeritB.Fireplace1, AcMeritB.Fireplace2],
  [AcMode.Heat]: [],
  [AcMode.Fan]: [AcMeritB.Fireplace1, AcMeritB.Fireplace2],
};

const DISABLED_AC_MERIT_A_FOR_MODE: Partial<Record<AcMode, AcMeritA[]>> = {
  [AcMode.Auto]: [AcMeritA.Heating8C, AcMeritA.SleepCare, AcMeritA.Floor],
  [AcMode.Cool]: [AcMeritA.Heating8C, AcMeritA.SleepCare, AcMeritA.Floor],
  [AcMode.Dry]: [
    AcMeritA.HighPower,
    AcMeritA.Eco,
    AcMeritA.CduSilent1,
    AcMeritA.CduSilent2,
    AcMeritA.Heating8C,
    AcMeritA.SleepCare,
    AcMeritA.Floor,
  ],
  [AcMode.Heat]: [],
  [AcMode.Fan]: [
    AcMeritA.HighPower,
    AcMeritA.Eco,
    AcMeritA.CduSilent1,
    AcMeritA.CduSilent2,
    AcMeritA.Heating8C,
    AcMeritA.SleepCare,
    AcMeritA.Floor,
  ],
};

export class Features {
  constructor(
    readonly acStatus: AcStatus[],
    readonly acMode: AcMode[],
    readonly acFanMode: AcFanMode[],
    readonly acSwingMode: AcSwingMode[],
    readonly acPowerSelection: AcPowerSelection[],
    readonly acMeritB: AcMeritB[],
    readonly acMeritA: AcMeritA[],
    readonly acAirPureIon: AcAirPureIon[],
    readonly acSelfCleaning: AcSelfCleaning[],
    readonly acEnergyReport: boolean,
  ) {}

  static fromMeritStringAndModel(meritFeature: string, acModelId: string): Features {
    const acStatus = [AcStatus.On, AcStatus.Off, AcStatus.None];
    const acMode: AcMode[] = [AcMode.None];
    const acFanMode = [
      AcFanMode.Auto,
      AcFanMode.Quiet,
      AcFanMode.Low,
      AcFanMode.MediumLow,
      AcFanMode.Medium,
      AcFanMode.MediumHigh,
      AcFanMode.High,
      AcFanMode.None,
    ];
    const acSwingMode = [AcSwingMode.None, AcSwingMode.Off, AcSwingMode.SwingVertical];
    const acPowerSelection = [
      AcPowerSelection.Power50,
      AcPowerSelection.Power75,
      AcPowerSelection.Power100,
      AcPowerSelection.None,
    ];
    const acMeritB = [AcMeritB.None, AcMeritB.Off];
    const acMeritA = [AcMeritA.None, AcMeritA.Off, AcMeritA.SleepCare, AcMeritA.Comfort];
    const acAirPureIon = [AcAirPureIon.None, AcAirPureIon.Off];
    const acSelfCleaning = [AcSelfCleaning.On, AcSelfCleaning.Off, AcSelfCleaning.None];
    let acEnergyReport = false;

    // Normalize the merit feature string to exactly 4 hex characters.
    const normalized = meritFeature.slice(0, 4).padEnd(4, '0');
    let meritValue = Number.parseInt(normalized, 16);
    if (Number.isNaN(meritValue)) {
      meritValue = 0;
    }
    // bit(0) is the most significant bit of the 16-bit merit value.
    const bit = (i: number): boolean => ((meritValue >> (15 - i)) & 1) === 1;

    const modesByBits: Record<string, AcMode[]> = {
      'false,false': [AcMode.Auto, AcMode.Cool, AcMode.Dry, AcMode.Fan, AcMode.Heat],
      'false,true': [AcMode.Heat],
      'true,false': [AcMode.Auto, AcMode.Cool, AcMode.Dry, AcMode.Fan],
      'true,true': [AcMode.Auto, AcMode.Cool, AcMode.Dry, AcMode.Fan, AcMode.Heat],
    };
    acMode.push(...modesByBits[`${bit(6)},${bit(7)}`]);

    if (acModelId === '2' || acModelId === '3') {
      acMeritA.push(AcMeritA.HighPower, AcMeritA.Eco);

      if (bit(0)) {
        acMeritA.push(AcMeritA.Floor);
      }

      if (bit(1)) {
        acSwingMode.push(AcSwingMode.SwingHorizontal, AcSwingMode.SwingVerticalAndHorizontal);
      }

      if (bit(2)) {
        acMeritA.push(AcMeritA.CduSilent1, AcMeritA.CduSilent2);
      }

      if (bit(3)) {
        acAirPureIon.push(AcAirPureIon.On);
      }

      if (bit(4)) {
        acMeritB.push(AcMeritB.Fireplace1, AcMeritB.Fireplace2);
      }

      if (bit(5)) {
        acMeritA.push(AcMeritA.Heating8C);
      }
    }

    if (acModelId === '3') {
      if (bit(14)) {
        acSwingMode.push(
          AcSwingMode.Fixed1,
          AcSwingMode.Fixed2,
          AcSwingMode.Fixed3,
          AcSwingMode.Fixed4,
          AcSwingMode.Fixed5,
        );
      }

      if (bit(15)) {
        acEnergyReport = true;
      }
    }

    return new Features(
      acStatus,
      acMode,
      acFanMode,
      acSwingMode,
      acPowerSelection,
      acMeritB,
      acMeritA,
      acAirPureIon,
      acSelfCleaning,
      acEnergyReport,
    );
  }

  /** Features available in the given AC mode (merit features are mode-dependent). */
  forAcMode(mode: AcMode): Features {
    const disabledB = DISABLED_AC_MERIT_B_FOR_MODE[mode] ?? [];
    const disabledA = DISABLED_AC_MERIT_A_FOR_MODE[mode] ?? [];

    return new Features(
      this.acStatus,
      this.acMode,
      this.acFanMode,
      this.acSwingMode,
      this.acPowerSelection,
      this.acMeritB.filter((m) => !disabledB.includes(m)),
      this.acMeritA.filter((m) => !disabledA.includes(m)),
      this.acAirPureIon,
      this.acSelfCleaning,
      this.acEnergyReport,
    );
  }
}
