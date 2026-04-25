/**
 * Integration tests — run against a real Arduino Cloud sandbox.
 *
 * Always-on contract: nothing in this file mutates the user's account
 * unless they explicitly opt in by setting one of the WRITE_* env vars
 * below. The default run is read-only against existing Things and
 * properties.
 *
 * Required (always):
 *   ARDUINO_CLOUD_CLIENT_ID
 *   ARDUINO_CLOUD_CLIENT_SECRET
 *
 * Optional:
 *   ARDUINO_CLOUD_ORGANIZATION_ID       header for multi-org accounts
 *
 *   ARDUINO_CLOUD_TEST_THING_ID         enables getProperty / listProperties / historicData
 *   ARDUINO_CLOUD_TEST_PROPERTY_ID      pairs with TEST_THING_ID for getProperty / historicData
 *
 *   ARDUINO_CLOUD_WRITE_PROPERTY_ID     opt-in: enables Set against this property
 *   ARDUINO_CLOUD_WRITE_VALUE           value to publish (default: "1.0")
 *
 *   ARDUINO_CLOUD_TRIGGER_VARIABLE_NAME opt-in: enables the MQTT trigger end-to-end
 *                                       test. Pairs with TEST_THING_ID, and the
 *                                       Thing must own a property whose
 *                                       variable_name matches this and which is
 *                                       writable so the test can publish to it.
 *
 * Run from repo root:
 *
 *   ARDUINO_CLOUD_CLIENT_ID=... ARDUINO_CLOUD_CLIENT_SECRET=... \
 *     ARDUINO_CLOUD_TEST_THING_ID=... ARDUINO_CLOUD_TEST_PROPERTY_ID=... \
 *     npm run test:integration -w packages/n8n-nodes-arduino-cloud
 *
 * Each test that needs a particular env var skips itself when the var is
 * absent — so the file is useful with whatever subset of credentials is
 * available, not all-or-nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  __resetTokenCacheForTests,
  fetchToken,
  getAccessToken,
  type TokenRequest,
} from '../src/auth/tokenCache.js';
import {
  getProperty,
  historicData,
  listProperties,
  listThings,
  publishProperty,
} from '../src/arduinoCloudApi.js';
import { CloudClientManager, type CloudCredential } from '../src/cloudClientManager.js';

const CLIENT_ID = process.env.ARDUINO_CLOUD_CLIENT_ID;
const CLIENT_SECRET = process.env.ARDUINO_CLOUD_CLIENT_SECRET;
const ORG_ID = process.env.ARDUINO_CLOUD_ORGANIZATION_ID;

const TEST_THING_ID = process.env.ARDUINO_CLOUD_TEST_THING_ID;
const TEST_PROPERTY_ID = process.env.ARDUINO_CLOUD_TEST_PROPERTY_ID;

const WRITE_PROPERTY_ID = process.env.ARDUINO_CLOUD_WRITE_PROPERTY_ID;
const WRITE_VALUE_RAW = process.env.ARDUINO_CLOUD_WRITE_VALUE ?? '1.0';

const TRIGGER_VARIABLE_NAME = process.env.ARDUINO_CLOUD_TRIGGER_VARIABLE_NAME;

const credReq: TokenRequest | null =
  CLIENT_ID && CLIENT_SECRET
    ? { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, organizationId: ORG_ID }
    : null;

const cloudCred: CloudCredential | null =
  CLIENT_ID && CLIENT_SECRET
    ? { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, organizationId: ORG_ID }
    : null;

if (!credReq) {
  describe.skip('arduino-cloud integration', () => {
    it('set ARDUINO_CLOUD_CLIENT_ID and ARDUINO_CLOUD_CLIENT_SECRET to run', () => {});
  });
}

describe.skipIf(!credReq)('arduino-cloud integration — auth', () => {
  beforeAll(() => __resetTokenCacheForTests());

  it('mints a token via OAuth2 client_credentials and returns a non-empty bearer', async () => {
    const { accessToken, expiresAt } = await fetchToken(credReq!);
    expect(typeof accessToken).toBe('string');
    expect(accessToken.length).toBeGreaterThan(20);
    // Tokens come back with a future expiry — a stale or stuck cache would
    // have us pass back a long-expired token. The 5s lower bound catches
    // that without being flaky.
    expect(expiresAt - Date.now()).toBeGreaterThan(5_000);
  });

  it('the token cache returns the same token within its TTL (no second mint)', async () => {
    // The cache is the load-bearing piece for staying inside the 10 req/s
    // REST budget; if it accidentally re-minted on every call we'd burn
    // through it on every workflow execution.
    const a = await getAccessToken(credReq!);
    const b = await getAccessToken(credReq!);
    expect(a).toBe(b);
  });
});

describe.skipIf(!credReq)('arduino-cloud integration — REST', () => {
  it('listThings returns an array (possibly empty) without throwing', async () => {
    // The thinnest possible smoke test for the REST plumbing — bearer
    // injection, host, organization header, response unmarshalling. This
    // would catch a broken SDK upgrade or wrong audience claim before the
    // real tests do.
    const things = await listThings(credReq!);
    expect(Array.isArray(things)).toBe(true);
    if (things.length > 0) {
      const sample = things[0];
      expect(typeof sample.id).toBe('string');
      expect(typeof sample.name).toBe('string');
    }
  });

  it.skipIf(!TEST_THING_ID)(
    'listProperties returns the configured Thing\'s properties with the documented summary fields',
    async () => {
      const props = await listProperties(credReq!, TEST_THING_ID!);
      expect(props.length).toBeGreaterThan(0);
      const sample = props[0];
      // These five fields are what loadOptions and the action node rely
      // on. If the SDK ever drops one we want the integration test to
      // surface it before the n8n UI does.
      expect(typeof sample.id).toBe('string');
      expect(typeof sample.name).toBe('string');
      expect(typeof sample.variable_name).toBe('string');
      expect(typeof sample.type).toBe('string');
      expect(typeof sample.permission).toBe('string');
    },
  );

  it.skipIf(!(TEST_THING_ID && TEST_PROPERTY_ID))(
    'getProperty round-trip: the value the node returns matches the one in listProperties',
    async () => {
      // Two SDK paths reach the same property. They must agree, otherwise
      // the loadOptions dropdown shows one value but a configured node
      // returns another.
      const props = await listProperties(credReq!, TEST_THING_ID!);
      const fromList = props.find((p) => p.id === TEST_PROPERTY_ID);
      expect(fromList).toBeDefined();
      const fromGet = await getProperty(credReq!, TEST_THING_ID!, TEST_PROPERTY_ID!);
      expect(fromGet.id).toBe(fromList!.id);
      expect(fromGet.variable_name).toBe(fromList!.variable_name);
      expect(fromGet.type).toBe(fromList!.type);
    },
  );

  it.skipIf(!(TEST_THING_ID && TEST_PROPERTY_ID))(
    'historicData over the last hour returns a points-shaped array (possibly empty) without throwing',
    async () => {
      // The Arduino Cloud series API returns a `null` body (not
      // {responses:[]}) when the property has no points in the window,
      // and our wrapper now coalesces that to []. Both shapes are
      // legitimate — the contract we lock here is "no throw, array out,
      // and any returned points have the documented {time:string,
      // value:number} shape" so a future SDK rename of times/values
      // surfaces immediately.
      const to = new Date();
      const from = new Date(to.getTime() - 60 * 60 * 1000);
      const series = await historicData(credReq!, [TEST_PROPERTY_ID!], from, to);
      expect(Array.isArray(series)).toBe(true);
      for (const r of series) {
        expect(typeof r.property_id).toBe('string');
        expect(Array.isArray(r.points)).toBe(true);
        for (const p of r.points) {
          expect(typeof p.time).toBe('string');
          expect(typeof p.value).toBe('number');
        }
      }
    },
  );
});

describe.skipIf(!(credReq && TEST_THING_ID && WRITE_PROPERTY_ID))(
  'arduino-cloud integration — write (opt-in)',
  () => {
    it('publishProperty resolves without throwing', async () => {
      // Opt-in only — the user explicitly designates a property as safe
      // to write to in test runs. We don't read-back-and-compare because
      // the value may need to round-trip through the device, which we
      // can't observe from a REST integration test. Successful resolve is
      // the signal we want.
      const value = parseValueForWrite(WRITE_VALUE_RAW);
      await expect(
        publishProperty(credReq!, TEST_THING_ID!, WRITE_PROPERTY_ID!, value),
      ).resolves.toBeUndefined();
    });
  },
);

describe.skipIf(!(cloudCred && TEST_THING_ID && TRIGGER_VARIABLE_NAME))(
  'arduino-cloud integration — MQTT trigger (opt-in)',
  () => {
    afterAll(async () => {
      // Reset the manager between full integration runs so a leaked entry
      // doesn't keep an MQTT client open after vitest exits — when run
      // from CI this would hang the process.
      CloudClientManager.getInstance().__resetForTests();
    });

    it(
      'manager.subscribe completes against the live broker and unsubscribes cleanly',
      async () => {
        // What this test actually proves end-to-end:
        //   - The OAuth2 credentials authenticate to the MQTT broker.
        //   - `arduino-iot-js` accepts our (thingId, variable_name)
        //     against a real Thing and resolves onPropertyValue.
        //   - The manager's subscribe → unsubscribe lifecycle round-trips
        //     against a real client without leaking refcount.
        //
        // What it intentionally does NOT assert: a REST publish round-
        // trips through the broker to our handler. That fan-out depends
        // on whether a device is currently echoing the property and
        // other broker-side conditions we can't control from a test
        // — making it a real-world workflow concern, not a property of
        // our code. The deterministic dedup/refcount/demux properties
        // that *are* under our control live in cloudClientManager.test.ts.
        const mgr = CloudClientManager.getInstance();
        const credentialKey = `integration:${CLIENT_ID}`;

        const props = await listProperties(credReq!, TEST_THING_ID!);
        const target = props.find((p) => p.variable_name === TRIGGER_VARIABLE_NAME);
        if (!target) {
          throw new Error(
            `ARDUINO_CLOUD_TRIGGER_VARIABLE_NAME="${TRIGGER_VARIABLE_NAME}" not found on Thing ${TEST_THING_ID}. ` +
              `Available variables: ${props.map((p) => p.variable_name).join(', ')}`,
          );
        }

        const unsubscribe = await mgr.subscribe(
          credentialKey,
          cloudCred!,
          TEST_THING_ID!,
          TRIGGER_VARIABLE_NAME!,
          () => {},
        );
        // arduino-iot-js's onPropertyValue can resolve before the broker
        // SUBACK, and the SDK's mqtt client surfaces a late SUBACK as
        // an unhandled "Connection closed" rejection if we tear down
        // immediately. Give the broker a moment to acknowledge before
        // disconnecting — this is a real concern for any short-lived
        // workflow run, not just tests.
        await new Promise((r) => setTimeout(r, 500));
        await unsubscribe();
      },
      15_000,
    );
  },
);

/** Best-effort coercion for the user-supplied write value, mirroring auto mode. */
function parseValueForWrite(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

