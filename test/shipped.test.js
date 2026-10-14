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

test('the declared DSH floor is the one the compatibility notes state', async () => {
  // The floor is a measured claim, written in two places that are easy to update
  // one at a time. This turns that drift into a test failure instead of a
  // discrepancy nobody notices until someone installs on an unsupported host.
  const manifest = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'))
  const notes = await readFile(join(REPO, 'COMPATIBILITY.md'), 'utf8')

  const declared = String(manifest.engines.dsh).trim()
  assert.ok(declared.startsWith('>='), `engines.dsh must be a ">=" range, got ${declared}`)
  // Everything after ">=", prerelease tag included: a range truncated at the patch
  // number would silently stop matching the floor written in the notes.
  const floor = declared.slice(2)

  assert.ok(notes.includes(`DSH ${floor} and later`), `COMPATIBILITY.md must state the floor as "DSH ${floor} and later"`)
  assert.ok(manifest.files.includes('COMPATIBILITY.md'), 'files[] must ship COMPATIBILITY.md')
})

test('npm test runs every test file in test/', async () => {
  // The gate lists its files explicitly, so a new one can sit there never running —
  // which is how a fix lands with its own test green while the gate still reports
  // the old total. This asserts the list against the directory.
  const manifest = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'))
  const present = (await readdir(join(REPO, 'test'))).filter((name) => name.endsWith('.test.js')).sort()

  assert.ok(present.length >= 8, `only found ${present.length} test files`)
  for (const name of present) {
    assert.ok(manifest.scripts.test.includes(`test/${name}`), `test/${name} is not in the npm test script`)
  }
})
