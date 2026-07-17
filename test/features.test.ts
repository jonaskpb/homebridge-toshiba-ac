import { describe, expect, it } from 'vitest';

import { Features } from '../src/toshiba/features';
import { AcMeritA, AcMeritB, AcMode, AcSwingMode } from '../src/toshiba/properties';

describe('Features.fromMeritStringAndModel', () => {
  it('supports all modes and base features for a plain unit', () => {
    const features = Features.fromMeritStringAndModel('0000', '1');
    expect(features.acMode).toEqual(
      expect.arrayContaining([AcMode.Auto, AcMode.Cool, AcMode.Dry, AcMode.Fan, AcMode.Heat]),
    );
    // Model 1 never gets high power / eco
    expect(features.acMeritA).not.toContain(AcMeritA.HighPower);
    expect(features.acMeritA).not.toContain(AcMeritA.Eco);
    expect(features.acSwingMode).toContain(AcSwingMode.SwingVertical);
    expect(features.acSwingMode).not.toContain(AcSwingMode.SwingHorizontal);
    expect(features.acEnergyReport).toBe(false);
  });

  it('decodes the mode support matrix from bits 6/7', () => {
    // bit 6 set (0x0200): no heating
    const noHeat = Features.fromMeritStringAndModel('0200', '1');
    expect(noHeat.acMode).not.toContain(AcMode.Heat);
    expect(noHeat.acMode).toContain(AcMode.Cool);

    // bit 7 set (0x0100): heating only
    const heatOnly = Features.fromMeritStringAndModel('0100', '1');
    expect(heatOnly.acMode).toContain(AcMode.Heat);
    expect(heatOnly.acMode).not.toContain(AcMode.Cool);

    // both set: everything
    const all = Features.fromMeritStringAndModel('0300', '1');
    expect(all.acMode).toEqual(
      expect.arrayContaining([AcMode.Auto, AcMode.Cool, AcMode.Dry, AcMode.Fan, AcMode.Heat]),
    );
  });

  it('unlocks model 2/3 features from merit bits', () => {
    // 0xc000: bit 0 (floor) + bit 1 (horizontal swing)
    const features = Features.fromMeritStringAndModel('c000', '2');
    expect(features.acMeritA).toContain(AcMeritA.HighPower);
    expect(features.acMeritA).toContain(AcMeritA.Eco);
    expect(features.acMeritA).toContain(AcMeritA.Floor);
    expect(features.acSwingMode).toContain(AcSwingMode.SwingHorizontal);
    expect(features.acSwingMode).toContain(AcSwingMode.SwingVerticalAndHorizontal);

    // Same merit bits on model 1 unlock nothing
    const model1 = Features.fromMeritStringAndModel('c000', '1');
    expect(model1.acMeritA).not.toContain(AcMeritA.Floor);
    expect(model1.acSwingMode).not.toContain(AcSwingMode.SwingHorizontal);
  });

  it('unlocks fireplace and 8°C heating from merit bits on model 2', () => {
    // 0x0c00: bit 4 (fireplace) + bit 5 (8°C heating)
    const features = Features.fromMeritStringAndModel('0c00', '2');
    expect(features.acMeritB).toContain(AcMeritB.Fireplace1);
    expect(features.acMeritB).toContain(AcMeritB.Fireplace2);
    expect(features.acMeritA).toContain(AcMeritA.Heating8C);
  });

  it('unlocks fixed swing and energy report only on model 3', () => {
    // 0x0003: bit 14 (fixed swing) + bit 15 (energy report)
    const model3 = Features.fromMeritStringAndModel('0003', '3');
    expect(model3.acSwingMode).toContain(AcSwingMode.Fixed1);
    expect(model3.acEnergyReport).toBe(true);

    const model2 = Features.fromMeritStringAndModel('0003', '2');
    expect(model2.acSwingMode).not.toContain(AcSwingMode.Fixed1);
    expect(model2.acEnergyReport).toBe(false);
  });

  it('normalizes short merit strings by right-padding with zeros', () => {
    // "c" → "c000" → floor + horizontal swing
    const features = Features.fromMeritStringAndModel('c', '2');
    expect(features.acMeritA).toContain(AcMeritA.Floor);
    expect(features.acSwingMode).toContain(AcSwingMode.SwingHorizontal);
  });

  it('filters mode-dependent merit features in forAcMode', () => {
    const features = Features.fromMeritStringAndModel('3c00', '3');
    expect(features.acMeritA).toContain(AcMeritA.Heating8C);

    const forDry = features.forAcMode(AcMode.Dry);
    expect(forDry.acMeritA).not.toContain(AcMeritA.HighPower);
    expect(forDry.acMeritA).not.toContain(AcMeritA.Eco);
    expect(forDry.acMeritA).not.toContain(AcMeritA.Heating8C);
    expect(forDry.acMeritB).not.toContain(AcMeritB.Fireplace1);

    const forHeat = features.forAcMode(AcMode.Heat);
    expect(forHeat.acMeritA).toContain(AcMeritA.Heating8C);
    expect(forHeat.acMeritB).toContain(AcMeritB.Fireplace1);
  });
});
