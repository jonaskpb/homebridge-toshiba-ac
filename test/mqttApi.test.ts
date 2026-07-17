import { describe, expect, it } from 'vitest';

import { parseSasToken } from '../src/toshiba/mqttApi';

describe('parseSasToken', () => {
  it('parses host, device id and expiry', () => {
    const token =
      'SharedAccessSignature sr=toshibasmaciothubprod.azure-devices.net%2Fdevices%2Fuser%40example.com_hb1234&' +
      'sig=abc%2Bdef%3D&se=1750000000';
    const info = parseSasToken(token);
    expect(info.hostName).toBe('toshibasmaciothubprod.azure-devices.net');
    expect(info.deviceId).toBe('user@example.com_hb1234');
    expect(info.expiry).toBe(1_750_000_000_000);
  });

  it('handles tokens without expiry', () => {
    const token = 'SharedAccessSignature sr=host.azure-devices.net%2Fdevices%2Fabc&sig=xyz';
    const info = parseSasToken(token);
    expect(info.hostName).toBe('host.azure-devices.net');
    expect(info.deviceId).toBe('abc');
    expect(info.expiry).toBeNull();
  });

  it('rejects tokens without a resource URI', () => {
    expect(() => parseSasToken('SharedAccessSignature sig=xyz&se=123')).toThrow();
    expect(() => parseSasToken('SharedAccessSignature sr=hostonly&sig=xyz')).toThrow();
  });
});
