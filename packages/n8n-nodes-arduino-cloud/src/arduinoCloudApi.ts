/**
 * Thin wrappers around `@arduino/arduino-iot-client` that (a) install a
 * bearer token from our tokenCache before each call and (b) expose the
 * handful of operations the action node and trigger actually use.
 *
 * The REST SDK's `ApiClient.instance` is a module-level singleton — sharing
 * it across calls is fine, but mutating its auth inside concurrent flows
 * from different credentials would race. We build a fresh `ApiClient` per
 * call instead; the marginal cost is a tiny object allocation and it
 * removes the cross-credential race entirely.
 */
// Deep-path imports rather than the barrel. The SDK's `index.js` uses lazy
// `Object.defineProperty(exports, ..., {get})` exports for every API/model
// class — esbuild cannot tree-shake those, so importing from the barrel
// pulled ~50 unused API classes (Dashboards, Triggers, OTA, Tags, …) plus
// their model graphs into the bundle. The deep paths bypass the barrel
// and only load what's referenced.
//
// Each sub-module exports its class as `default`, so we use default
// imports here. Type ambient declarations live in src/types/.
import ApiClient from '@arduino/arduino-iot-client/dist/ApiClient';
import ThingsV2Api from '@arduino/arduino-iot-client/dist/api/ThingsV2Api';
import PropertiesV2Api from '@arduino/arduino-iot-client/dist/api/PropertiesV2Api';
import SeriesV2Api from '@arduino/arduino-iot-client/dist/api/SeriesV2Api';
import { getAccessToken, type TokenRequest } from './auth/tokenCache.js';
import { acquireRestToken } from './restThrottle.js';

export interface ThingSummary {
  id: string;
  name: string;
  device_id?: string;
  properties_count?: number;
}

export interface PropertySummary {
  id: string;
  name: string;
  variable_name: string;
  type: string;
  permission: string;
  last_value?: unknown;
  value_updated_at?: string;
  thing_id?: string;
}

export interface HistoricDataPoint {
  time: string;
  value: number;
}

export interface HistoricDataResult {
  property_id: string;
  from: string;
  to: string;
  points: HistoricDataPoint[];
}

interface CommonOpts {
  xOrganization?: string;
}

function withOrg(organizationId?: string): CommonOpts {
  return organizationId ? { xOrganization: organizationId } : {};
}

function throttleKey(credential: TokenRequest): string {
  // Arduino Cloud's quota is keyed on the OAuth2 client, with the optional
  // organization scope acting as an effective sub-key for multi-org setups
  // (different org headers can hit different aggregate budgets in practice).
  return `${credential.clientId}\0${credential.organizationId ?? ''}`;
}

async function buildClient(credential: TokenRequest): Promise<ApiClient> {
  // Block until the per-credential 10/s REST budget has a free slot. Token
  // mint and cache hits do not pass through here, so the bucket is purely
  // for the data plane.
  await acquireRestToken(throttleKey(credential));
  const accessToken = await getAccessToken(credential);
  // ApiClient ctor takes no args; we mutate the returned instance's auth
  // inline because the SDK's `authentications.oauth2` is defined on the
  // prototype-ish shared object otherwise. A fresh ApiClient() instance has
  // its own `authentications` map.
  const client = new ApiClient();
  client.authentications.oauth2.accessToken = accessToken;
  return client;
}

export async function listThings(credential: TokenRequest): Promise<ThingSummary[]> {
  const client = await buildClient(credential);
  const api = new ThingsV2Api(client);
  const things = await api.thingsV2List({
    showProperties: false,
    ...withOrg(credential.organizationId),
  });
  return things.map((t) => ({
    id: t.id,
    name: t.name,
    device_id: t.device_id,
    properties_count: t.properties_count,
  }));
}

export async function listProperties(
  credential: TokenRequest,
  thingId: string,
): Promise<PropertySummary[]> {
  const client = await buildClient(credential);
  const api = new PropertiesV2Api(client);
  const props = await api.propertiesV2List(thingId, {
    ...withOrg(credential.organizationId),
  });
  return props.map((p) => ({
    id: p.id,
    name: p.name,
    variable_name: p.variable_name,
    type: p.type,
    permission: p.permission,
    last_value: p.last_value,
    value_updated_at: p.value_updated_at,
    thing_id: p.thing_id,
  }));
}

export async function getProperty(
  credential: TokenRequest,
  thingId: string,
  propertyId: string,
): Promise<PropertySummary> {
  const client = await buildClient(credential);
  const api = new PropertiesV2Api(client);
  const p = await api.propertiesV2Show(thingId, propertyId, {
    ...withOrg(credential.organizationId),
  });
  return {
    id: p.id,
    name: p.name,
    variable_name: p.variable_name,
    type: p.type,
    permission: p.permission,
    last_value: p.last_value,
    value_updated_at: p.value_updated_at,
    thing_id: p.thing_id,
  };
}

export async function publishProperty(
  credential: TokenRequest,
  thingId: string,
  propertyId: string,
  value: unknown,
  deviceId?: string,
): Promise<void> {
  const client = await buildClient(credential);
  const api = new PropertiesV2Api(client);
  const body: { value: unknown; device_id?: string } = { value };
  if (deviceId) body.device_id = deviceId;
  await api.propertiesV2Publish(thingId, propertyId, body, {
    ...withOrg(credential.organizationId),
  });
}

export async function historicData(
  credential: TokenRequest,
  propertyIds: string[],
  from: Date,
  to: Date,
): Promise<HistoricDataResult[]> {
  const client = await buildClient(credential);
  const api = new SeriesV2Api(client);
  const req = { from, to, properties: propertyIds };
  const batch = await api.seriesV2HistoricData(req, {
    ...withOrg(credential.organizationId),
  });
  // Response shape: { responses: [{ property_id, times, values, from_date, to_date, ... }] }.
  // The SDK has been observed to return `null` (not `{responses: []}`) for
  // properties with no data in the requested window — guard accordingly so
  // the n8n node returns count:0 in that case instead of throwing.
  const responses = batch?.responses ?? [];
  return responses.map((r) => {
    const times = r.times ?? [];
    const values = r.values ?? [];
    const points: HistoricDataPoint[] = [];
    const len = Math.min(times.length, values.length);
    for (let i = 0; i < len; i++) {
      const t = times[i];
      points.push({
        time: t instanceof Date ? t.toISOString() : String(t),
        value: values[i],
      });
    }
    return {
      property_id: r.property_id ?? '',
      from: toIsoString(r.from_date ?? from),
      to: toIsoString(r.to_date ?? to),
      points,
    };
  });
}

function toIsoString(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : d;
}
