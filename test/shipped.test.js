/**
 * Invariants about the shipped files, checkable without a DSH tree.
 *
 * These two used to live only in the integration harness, which prints SKIP and
 * exits 0 when `DSH_HARNESS_MODULES` is unset — so on a machine that had never set
 * it, "the integration suite is green" meant nothing had been checked at all.
 * Anything that can be verified from the repository alone belongs here, where
 * `npm test` always runs it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = join(REPO, 'lib')

/** Every shipped module file name. */
async function shippedModules() {
  return (await readdir(LIB)).filter((name) => name.endsWith('.js')).sort()
}

test('no shipped module imports @deepseek-ai/* at runtime', async () => {
  const modules = await shippedModules()
  assert.ok(modules.length >= 10, `only found ${modules.length} modules`)

  for (const module of modules) {
    const text = await readFile(join(LIB, module), 'utf8')
    const offenders = [
      ...text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"](@deepseek-ai\/[^'"]+)['"]/g),
    ].map((match) => match[1])
    assert.deepEqual(offenders, [], `${module} imports ${offenders.join(', ')}`)
  }
})

test('every relative import a shipped module makes is itself shipped', async () => {
  for (const module of await shippedModules()) {
    const text = await readFile(join(LIB, module), 'utf8')
    const targets = [...text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"](\.\/[^'"]+)['"]/g)].map(
      (match) => match[1],
    )
    for (const target of targets) {
      await access(join(LIB, target)).catch(() => {
        assert.fail(`${module} imports ${target}, which is not in lib/`)
      })
    }
  }
})

test('the package ships everything the runtime and its own scripts need', async () => {
  const manifest = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'))
  for (const required of ['lib', 'cordis.patch.yml', 'LICENSE']) {
    assert.ok(manifest.files.includes(required), `files[] is missing ${required}`)
  }
  // `scripts/` carries the two npm scripts this package advertises; leaving it out
  // publishes a package whose own `npm run` entries are broken.
  const advertised = Object.values(manifest.scripts).filter((line) => line.includes('scripts/'))
  if (advertised.length > 0) {
    assert.ok(manifest.files.includes('scripts'), 'files[] must include scripts/ when scripts are advertised')
  }
})

test('the bundle patch mounts the package that declares it', async () => {
  const manifest = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'))
  const patch = await readFile(join(REPO, manifest.dsh.bundle.patch), 'utf8')
  const row = /-\s*id:\s*(\S+)\s*\n\s*name:\s*'([^']+)'/.exec(patch)
  assert.ok(row, 'the patch must contain one insert row with an id and a name')
  assert.equal(row[1], manifest.name, 'the row id should match the package name, as the other plugins do')
  assert.equal(row[2], manifest.name, 'the loader resolves `name` as a package specifier')
})
