import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readdir, readFile } from 'node:fs/promises';

const SCHEMA_NAMES = new Set(['v3/source-package', 'v3/analysis-package']);

export async function createV3ContractValidator(schemaDir = new URL('../../Schema/contracts/', import.meta.url)) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addKeyword({
    keyword: 'uniqueItemProperty', type: 'array', schemaType: 'string', errors: false,
    validate(property, values) {
      return new Set(values.map(value => value?.[property])).size === values.length;
    }
  });
  const names = (await readdir(schemaDir)).filter(name => /^v3-.*\.schema\.json$/.test(name)).sort();
  for (const name of names) {
    const schema = JSON.parse(await readFile(new URL(name, schemaDir), 'utf8'));
    if (!SCHEMA_NAMES.has(schema.$id)) throw new Error('Unexpected V3 schema ID');
    ajv.addSchema(schema);
  }
  return {
    validate(schemaName, value) {
      if (!SCHEMA_NAMES.has(schemaName)) throw new Error('Unknown schema');
      const validate = ajv.getSchema(schemaName);
      if (!validate) throw new Error('Unknown schema');
      const ok = Boolean(validate(value));
      return { ok, errors: (validate.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message}`).sort() };
    },
    assert(schemaName, value) {
      const result = this.validate(schemaName, value);
      if (!result.ok) throw new Error(`${schemaName} validation failed:\n${result.errors.join('\n')}`);
    }
  };
}
