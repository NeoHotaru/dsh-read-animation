/**
 * Print the JSON Schema that the harness's own `defineTool` derives from
 * `PARAMETER_SPEC`, so `PARAMETERS` in `lib/tool.js` can be regenerated after a
 * spec change.
 *
 * The plugin ships the compiled schema as a literal instead of calling
 * `defineTool` at runtime (see the module comment in `lib/tool.js`). This script
 * and the drift check in `test/integration/harness.mjs` are what keep the two in
 * step.
 *
 * Usage: DSH_HARNESS_MODULES=<dir with @deepseek-ai/*> node scripts/derive-schema.mjs
 *
 * @module scripts/derive-schema
 */

import { ensureHarnessModules, findHarnessModules } from './link-modules.mjs'
import { OUTPUT_SPEC, PARAMETER_SPEC } from '../lib/tool.js'

const modulesRoot = findHarnessModules()
if (modulesRoot === undefined) {
  console.error(
    'Set DSH_HARNESS_MODULES to the directory containing @deepseek-ai/* — for a global\n' +
      'npm install that is <npm root -g>/@deepseek-ai/dsh/node_modules',
  )
  process.exit(2)
}
ensureHarnessModules(modulesRoot)

const { defineTool, valueSchemaSpecToJsonSchema } = await import('@deepseek-ai/dsh-tools')

const { parameters } = defineTool({
  name: 'schema-derivation-only',
  description: 'not registered',
  parameters: PARAMETER_SPEC,
  output: { schema: { type: 'json' }, render: () => [] },
  async execute() {
    return null
  },
})

console.log('// PARAMETERS')
console.log(JSON.stringify(parameters, null, 2))
console.log('\n// OUTPUT_SCHEMA')
console.log(JSON.stringify(valueSchemaSpecToJsonSchema(OUTPUT_SPEC), null, 2))
