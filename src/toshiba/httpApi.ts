/**
 * HTTP client for the Toshiba Home AC Control cloud API.
 *
 * Ported from KaSroka/Toshiba-AC-control (toshiba_ac/utils/http_api.py),
 * Apache-2.0.
 */

import { errorMessage, JitterMode, Log, retryOnException, sleep } from './utils';

const BASE_URL = 'https://mobileapi.toshibahomeaccontrols.com';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const LOGIN_PATH = '/api/Consumer/Login';
const REGISTER_PATH = '/api/Consumer/RegisterMobileDevice';
const AC_MAPPING_PATH = '/api/AC/GetConsumerACMapping';
const AC_STATE_PATH = '/api/AC/GetCurrentACState';

const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_MIN_INTERVAL_MS = 150;
const REQUEST_JITTER_MS = 250;

export class ToshibaHttpApiError extends Error {}

export class ToshibaAuthError extends ToshibaHttpApiError {}

/** The account credentials were rejected — retrying will not help. */
export class ToshibaInvalidCredentialsError extends ToshibaAuthError {}

export class ToshibaRateLimitError extends ToshibaHttpApiError {}

export interface ToshibaAcDeviceInfo {
  acId: string;
  acUniqueId: string;
  acName: string;
  initialAcState: string;
  firmwareVersion: string;
  meritFeature: string;
  acModelId: string;
}

export interface ToshibaAcDeviceAdditionalInfo {
  cdu: string | null;
  fcu: string | null;
}

interface RequestArgs {
  query?: Record<string, string>;
  body?: unknown;
  /** Explicit headers make the request unauthenticated (login). */
  headers?: Record<string, string>;
  reauthOnAuthError?: boolean;
}

export class ToshibaAcHttpApi {
  private accessToken: string | null = null;
  private accessTokenType: string | null = null;
  consumerId: string | null = null;

  private authGeneration = 0;
  private authChain: Promise<void> = Promise.resolve();
  private paceChain: Promise<void> = Promise.resolve();
  private nextRequestNotBefore = 0;

  constructor(
    private readonly log: Log,
    private readonly username: string,
    private readonly password: string,
  ) {}

  /** Serialize requests and keep a minimum interval between them. */
  private pace(): Promise<void> {
    const run = this.paceChain.then(async () => {
      const wait = this.nextRequestNotBefore - Date.now();
      if (wait > 0) {
        await sleep(wait);
      }
      this.nextRequestNotBefore = Date.now() + REQUEST_MIN_INTERVAL_MS + Math.random() * REQUEST_JITTER_MS;
    });
    this.paceChain = run.catch(() => undefined);
    return run;
  }

  private refreshAuthIfStale(failedAuthGeneration: number): Promise<void> {
    const run = this.authChain.then(async () => {
      if (this.authGeneration !== failedAuthGeneration) {
        return; // Someone else already re-authenticated.
      }
      await this.login();
    });
    this.authChain = run.catch(() => undefined);
    return run;
  }

  private requestApi(path: string, args: RequestArgs = {}): Promise<unknown> {
    return retryOnException(
      () =>
        retryOnException(() => this.requestOnce(path, args), {
          retries: 2,
          backoff: 5_000,
          maxBackoff: 30_000,
          shouldRetry: (e) => !(e instanceof ToshibaAuthError) && !(e instanceof ToshibaRateLimitError),
          onRetry: (e, attempt, delay) =>
            this.log.debug(
              `Toshiba API request to ${path} failed (${errorMessage(e)}), ` +
                `retry ${attempt}/2 in ${Math.round(delay / 1000)}s`,
            ),
        }),
      {
        retries: 5,
        backoff: 10_000,
        maxBackoff: 600_000,
        growthFactor: 3,
        jitterMode: JitterMode.Equal,
        shouldRetry: (e) => e instanceof ToshibaRateLimitError,
        onRetry: (e, attempt, delay) =>
          this.log.warn(
            `Toshiba API rate limited on ${path}, retry ${attempt}/5 in ${Math.round(delay / 1000)}s`,
          ),
      },
    );
  }

  private async requestOnce(path: string, args: RequestArgs): Promise<unknown> {
    const { query, body, reauthOnAuthError = true } = args;
    const authGeneration = this.authGeneration;

    let headers = args.headers;
    let isAuthenticatedRequest = false;
    if (!headers) {
      if (!this.accessTokenType || !this.accessToken) {
        throw new ToshibaHttpApiError('Failed to send request, missing access token');
      }
      headers = {
        'Content-Type': 'application/json',
        Authorization: `${this.accessTokenType} ${this.accessToken}`,
        'User-Agent': USER_AGENT,
      };
      isAuthenticatedRequest = true;
    }

    const url = new URL(BASE_URL + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }

    await this.pace();
    this.log.debug(`Sending ${body ? 'POST' : 'GET'} to ${url}`);

    let response: Response;
    try {
      response = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      throw new ToshibaHttpApiError(`Request to ${path} failed: ${errorMessage(e)}`);
    }

    this.log.debug(`Response code: ${response.status}`);

    if (response.status === 200) {
      let json: { IsSuccess?: boolean; ResObj?: unknown; StatusCode?: string; Message?: string };
      try {
        json = (await response.json()) as typeof json;
      } catch (e) {
        throw new ToshibaHttpApiError(`Malformed JSON response for ${path}: ${errorMessage(e)}`);
      }

      if (json.IsSuccess) {
        return json.ResObj;
      }
      if (json.StatusCode === 'InvalidUserNameorPassword') {
        throw new ToshibaInvalidCredentialsError(json.Message ?? 'Invalid username or password');
      }
      throw new ToshibaHttpApiError(json.Message ?? `Toshiba API error calling ${path}`);
    }

    this.log.warn(`Non-200 response from Toshiba API (status=${response.status}, path=${path})`);

    if (isAuthenticatedRequest && response.status === 401) {
      if (reauthOnAuthError) {
        this.log.warn(`Auth failed for ${path} with status 401, refreshing auth and retrying once`);
        await this.refreshAuthIfStale(authGeneration);
        return this.requestOnce(path, { query, body, reauthOnAuthError: false });
      }
      throw new ToshibaAuthError(`HTTP 401 calling ${path}`);
    }

    if (response.status === 403 || response.status === 429) {
      throw new ToshibaRateLimitError(`HTTP ${response.status} calling ${path}`);
    }

    throw new ToshibaHttpApiError(`HTTP ${response.status} calling ${path}`);
  }

  async login(): Promise<void> {
    const res = (await this.requestApi(LOGIN_PATH, {
      body: { Username: this.username, Password: this.password },
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
    })) as { access_token?: string; token_type?: string; consumerId?: string };

    if (!res?.access_token || !res.token_type || !res.consumerId) {
      throw new ToshibaHttpApiError('Malformed login response');
    }

    this.accessToken = res.access_token;
    this.accessTokenType = res.token_type;
    this.consumerId = res.consumerId;
    this.authGeneration += 1;
  }

  /** Register this client as a "mobile device" and obtain an IoT Hub SAS token. */
  async registerClient(deviceId: string): Promise<string> {
    const res = (await this.requestApi(REGISTER_PATH, {
      body: { DeviceID: deviceId, DeviceType: '1', Username: this.username },
    })) as { SasToken?: unknown };

    if (typeof res?.SasToken !== 'string' || !res.SasToken) {
      throw new ToshibaHttpApiError('Missing or malformed SasToken in response');
    }

    return res.SasToken;
  }

  async getDevices(): Promise<ToshibaAcDeviceInfo[]> {
    if (!this.consumerId) {
      throw new ToshibaHttpApiError('Failed to send request, missing consumer id');
    }

    const res = await this.requestApi(AC_MAPPING_PATH, {
      query: { consumerId: this.consumerId },
    });

    // Parse strictly: a malformed-but-"successful" response must fail loudly so
    // the caller retries, rather than resolving to an empty device list (which
    // would make the platform treat every AC unit as removed). This matches the
    // Python library, which raises on the same shapes.
    if (!Array.isArray(res)) {
      throw new ToshibaHttpApiError('Malformed AC mapping response: expected an array of groups');
    }

    const devices: ToshibaAcDeviceInfo[] = [];

    for (const group of res as Array<{ ACList?: unknown }>) {
      const acList = group?.ACList;
      if (!Array.isArray(acList)) {
        throw new ToshibaHttpApiError('Malformed AC mapping response: group is missing ACList');
      }
      for (const device of acList as Array<Record<string, unknown>>) {
        devices.push({
          acId: String(device.Id),
          acUniqueId: String(device.DeviceUniqueId),
          acName: String(device.Name ?? 'Toshiba AC'),
          initialAcState: String(device.ACStateData ?? ''),
          firmwareVersion: String(device.FirmwareVersion ?? ''),
          meritFeature: String(device.MeritFeature ?? ''),
          acModelId: String(device.ACModelId ?? ''),
        });
      }
    }

    return devices;
  }

  async getDeviceState(acId: string): Promise<string> {
    const query: Record<string, string> = { ACId: acId };
    if (this.consumerId) {
      query.consumerId = this.consumerId;
    }

    const res = (await this.requestApi(AC_STATE_PATH, { query })) as { ACStateData?: unknown };

    if (typeof res?.ACStateData !== 'string') {
      throw new ToshibaHttpApiError('Missing or malformed ACStateData in response');
    }

    return res.ACStateData;
  }

  async getDeviceAdditionalInfo(acId: string): Promise<ToshibaAcDeviceAdditionalInfo> {
    const query: Record<string, string> = { ACId: acId };
    if (this.consumerId) {
      query.consumerId = this.consumerId;
    }

    const res = (await this.requestApi(AC_STATE_PATH, { query })) as {
      Cdu?: { model_name?: unknown } | null;
      Fcu?: { model_name?: unknown } | null;
    };

    const cdu = typeof res?.Cdu?.model_name === 'string' ? res.Cdu.model_name : null;
    const fcu = typeof res?.Fcu?.model_name === 'string' ? res.Fcu.model_name : null;

    return { cdu, fcu };
  }
}
