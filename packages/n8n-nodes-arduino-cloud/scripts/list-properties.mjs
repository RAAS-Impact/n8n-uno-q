#!/usr/bin/env node
/**
 * Print every Thing on the configured Arduino Cloud account (or just one,
 * if ARDUINO_CLOUD_TEST_THING_ID is set), with each Thing's properties
 * listed underneath. Useful when picking values for the integration test
 * env vars (ARDUINO_CLOUD_TEST_PROPERTY_ID, ARDUINO_CLOUD_WRITE_PROPERTY_ID,
 * ARDUINO_CLOUD_TRIGGER_VARIABLE_NAME).
 *
 * Reads credentials from process.env, falling back to the monorepo-root
 * .env so it just works after `npm run test:integration` has been
 * configured.
 *
 *   node packages/n8n-nodes-arduino-cloud/scripts/list-properties.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApiClient,
  ThingsV2Api,
  PropertiesV2Api,
} from '@arduino/arduino-iot-client';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

loadEnvFile(path.join(repoRoot, '.env'));

const CLIENT_ID = process.env.ARDUINO_CLOUD_CLIENT_ID;
const CLIENT_SECRET = process.env.ARDUINO_CLOUD_CLIENT_SECRET;
const ORG_ID = process.env.ARDUINO_CLOUD_ORGANIZATION_ID;
const FILTER_THING_ID = process.env.ARDUINO_CLOUD_TEST_THING_ID;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    'Missing ARDUINO_CLOUD_CLIENT_ID and/or ARDUINO_CLOUD_CLIENT_SECRET (set them in .env or your shell).',
  );
  process.exit(1);
}

const accessToken = await fetchToken(CLIENT_ID, CLIENT_SECRET, ORG_ID);
const client = new ApiClient();
client.authentications.oauth2.accessToken = accessToken;
const orgHeader = ORG_ID ? { xOrganization: ORG_ID } : {};

const things = await new ThingsV2Api(client).thingsV2List({
  showProperties: false,
  ...orgHeader,
});

const targets = FILTER_THING_ID
  ? things.filter((t) => t.id === FILTER_THING_ID)
  : things;

if (targets.length === 0) {
  console.error(
    FILTER_THING_ID
      ? `No Thing with id ${FILTER_THING_ID} visible to these credentials.`
      : 'Account has no Things.',
  );
  process.exit(2);
}

const propsApi = new PropertiesV2Api(client);
for (const t of targets) {
  const props = await propsApi.propertiesV2List(t.id, { ...orgHeader });
  console.log(`\nThing  ${t.name}`);
  console.log(`  id   ${t.id}`);
  if (props.length === 0) {
    console.log('  (no properties)');
    continue;
  }
  console.log('');
  console.table(
    props.map((p) => ({
      id: p.id,
      name: p.name,
      variable_name: p.variable_name,
      type: p.type,
      permission: p.permission,
      last_value: previewValue(p.last_value),
    })),
  );
}

console.log(
  '\nCopy the property `id` you want into ARDUINO_CLOUD_TEST_PROPERTY_ID,',
);
console.log(
  'and the `variable_name` of a writable property into ARDUINO_CLOUD_TRIGGER_VARIABLE_NAME.',
);

// ---- helpers --------------------------------------------------------------

async function fetchToken(clientId, clientSecret, organizationId) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    audience: 'https://api2.arduino.cc/iot',
  });
  if (organizationId) body.set('organization_id', organizationId);
  const r = await fetch('https://api2.arduino.cc/iot/v1/clients/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) {
    throw new Error(`Token request failed: ${r.status} ${await r.text()}`);
  }
  const json = await r.json();
  return json.access_token;
}

function previewValue(v) {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 30 ? s.slice(0, 27) + '...' : s;
}

function loadEnvFile(p) {
  // Tiny .env parser so the script works without dotenv. Skips comments,
  // strips matching surrounding quotes, never overwrites pre-existing
  // process.env keys (so a shell export still wins).
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, 'utf-8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in process.env) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}
