import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

/**
 * Compiles caller-provided Phase-21 companion schemas without touching the
 * frozen `Schema/contracts/` V3 registry.
 */
export async function createPhase21ContractValidator({ schemas } = {}) {
  if (!Array.isArray(schemas) || schemas.length === 0) throw new Error('Explicit Phase-21 schema objects are required.');
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const schema of schemas) {
    if (!schema || typeof schema !== 'object' || typeof schema.$id !== 'string' || !schema.$id.startsWith('phase21/')) {
      throw new Error('Phase-21 schemas require a phase21/ ID.');
    }
    ajv.addSchema(schema);
  }
  return {
    validate(schemaId, record) {
      if (typeof schemaId !== 'string' || !schemaId.startsWith('phase21/')) throw new Error('Unknown Phase-21 schema.');
      const validate = ajv.getSchema(schemaId);
      if (!validate) throw new Error('Unknown Phase-21 schema.');
      const ok = Boolean(validate(record));
      return { ok, errors: (validate.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message}`).sort(compare) };
    },
  };
}

export function validatePhase21Record(validator, schemaId, record) {
  if (!validator || typeof validator.validate !== 'function') throw new Error('A Phase-21 validator is required.');
  return validator.validate(schemaId, record);
}
