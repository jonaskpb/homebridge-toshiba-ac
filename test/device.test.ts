import { describe, expect, it, vi } from 'vitest';

import { ToshibaAcDevice } from '../src/toshiba/device';
import type { ToshibaAcDeviceInfo } from '../src/toshiba/httpApi';
import { AcMode, AcStatus } from '../src/toshiba/properties';

const noopLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// ON, COOL, 22°C, fan AUTO, swing OFF, power 100%, no merit, ion off,
// indoor 22, outdoor 30, self-clean off
const INITIAL_STATE = '3042164131640010161effffffff10ffffffff';

function makeDevice(sendMessage: (msg: object) => Promise<void>) {
  const info: ToshibaAcDeviceInfo = {
    acId: 'ac-id',
    acUniqueId: 'unique-1',
    acName: 'Test AC',
    initialAcState: INITIAL_STATE,
    firmwareVersion: '1.0.0',
    meritFeature: '0000',
    acModelId: '3',
  };
  const mqttApi = { sendMessage: vi.fn(sendMessage) };
  const httpApi = { getDeviceAdditionalInfo: vi.fn(), getDeviceState: vi.fn() };
  const device = new ToshibaAcDevice(
    noopLog,
    info,
    'client-device',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mqttApi as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    httpApi as any,
  );
  return { device, mqttApi };
}

/** Extract the encoded command payload from a captured sendMessage call. */
function sentData(mqttApi: { sendMessage: { mock: { calls: unknown[][] } } }, index: number): string {
  const message = mqttApi.sendMessage.mock.calls[index][0] as { payload: { data: string } };
  return message.payload.data;
}

describe('ToshibaAcDevice command handling', () => {
  it('sends only the changed field as a sparse command', async () => {
    const { device, mqttApi } = makeDevice(() => Promise.resolve());
    await device.applyPartialState({ status: AcStatus.Off });

    expect(mqttApi.sendMessage).toHaveBeenCalledOnce();
    const data = sentData(mqttApi, 0);
    // Status byte is OFF (0x31); mode byte stays none (ff) because only status changed
    expect(data.slice(0, 2)).toBe('31');
    expect(data.slice(2, 4)).toBe('ff');
    expect(device.acStatus).toBe(AcStatus.Off);
  });

  it('does not send when the requested state already matches', async () => {
    const { device, mqttApi } = makeDevice(() => Promise.resolve());
    await device.applyPartialState({ status: AcStatus.On, mode: AcMode.Cool });
    expect(mqttApi.sendMessage).not.toHaveBeenCalled();
  });

  it('does not drop a rapid reversal issued during an in-flight publish', async () => {
    // Hold the first publish open until we release it, simulating the QoS-1
    // PUBACK round-trip during which a second command can arrive.
    let releaseFirst!: () => void;
    const firstPublished = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    const { device, mqttApi } = makeDevice(() => {
      call += 1;
      return call === 1 ? firstPublished : Promise.resolve();
    });

    // t=0: turn Off (publish is held open)
    const offPromise = device.applyPartialState({ status: AcStatus.Off });
    // The optimistic merge is synchronous, so the state already reads Off.
    expect(device.acStatus).toBe(AcStatus.Off);

    // t=1: user reverses to On while the Off publish is still in flight.
    const onPromise = device.applyPartialState({ status: AcStatus.On });
    expect(device.acStatus).toBe(AcStatus.On);

    releaseFirst();
    await Promise.all([offPromise, onPromise]);

    // Both commands must have been sent — the reversal was not swallowed.
    expect(mqttApi.sendMessage).toHaveBeenCalledTimes(2);
    expect(sentData(mqttApi, 0).slice(0, 2)).toBe('31'); // OFF
    expect(sentData(mqttApi, 1).slice(0, 2)).toBe('30'); // ON
    expect(device.acStatus).toBe(AcStatus.On);
  });

  it('applies indoor/outdoor temperatures from a heartbeat', () => {
    const { device } = makeDevice(() => Promise.resolve());
    device.handleCmdHeartbeat({ iTemp: '18', oTemp: 'fb' }); // 0xfb = -5 signed
    expect(device.acIndoorTemperature).toBe(24);
    expect(device.acOutdoorTemperature).toBe(-5);
  });
});
