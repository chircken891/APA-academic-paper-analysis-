import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PHASE22_SCHEMA_IDS = Object.freeze([
  'reading-basis', 'render-context', 'language-view', 'parity-review',
  'review-manifest', 'publication-transaction', 'active-index', 'reader-presentation', 'reading-review', 'reading-first-publication',
].map(name => 'phase22/' + name + '-1.0'));

export async function createPhase22ContractValidator(schemaDir = new URL('../../Schema/phase22/', import.meta.url)) {
  const root = schemaDir instanceof URL ? fileURLToPath(schemaDir) : resolve(schemaDir);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addKeyword({ keyword: 'uniqueItemProperty', type: 'array', schemaType: 'string', errors: false,
    validate: (property, values) => new Set(values.map(value => value?.[property])).size === values.length });
  for (const name of (await readdir(root)).filter(name => name.endsWith('.schema.json')).sort()) {
    const schema = JSON.parse(await readFile(resolve(root, name), 'utf8'));
    if (!PHASE22_SCHEMA_IDS.includes(schema.$id) || schema.$id !== 'phase22/' + name.replace('.schema.json', '') + '-1.0') {
      throw new Error('P22_SCHEMA_ID_UNEXPECTED');
    }
    ajv.addSchema(schema);
  }
  return Object.freeze({
    validate(schemaName, value) {
      if (!PHASE22_SCHEMA_IDS.includes(schemaName)) throw new Error('P22_SCHEMA_UNKNOWN');
      const validate = ajv.getSchema(schemaName);
      if (!validate) throw new Error('P22_SCHEMA_NOT_CREATED');
      const ok = Boolean(validate(value));
      return { ok, errors: (validate.errors ?? []).map(error => ({ code: 'P22_SCHEMA_INVALID', path: error.instancePath || '/', message: error.message })) };
    },
    assert(schemaName, value) {
      const result = this.validate(schemaName, value);
      if (!result.ok) throw Object.assign(new Error('P22_SCHEMA_INVALID'), { errors: result.errors });
    },
  });
}

