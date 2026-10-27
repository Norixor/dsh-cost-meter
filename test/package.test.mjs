// Run: node --test test/package.test.mjs
// What gets published and synced is the "files" list of package.json: a root module that index.js imports but the list
// forgets would crash the installed plugin at load time while every test here, which runs from the source folder, passes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('every root module the shipped modules import is in the files list', () => {
  const shipped = pkg.files.filter((file) => /^[\w-]+\.js$/.test(file))
  const missing = []
  for (const file of shipped) {
    const source = readFileSync(join(root, file), 'utf8')
    for (const match of source.matchAll(/^\s*(?:import|export)\b[^'"\n]*from\s+'\.\/([\w-]+\.js)'/gm)) {
      if (!pkg.files.includes(match[1])) missing.push(file + ' → ' + match[1])
    }
  }
  assert.deepEqual(missing, [])
  assert.ok(shipped.includes('index.js') && shipped.includes('balance.js'))
})
