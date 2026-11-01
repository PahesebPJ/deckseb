import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SebEcosystemObserver } from '../src/core/ecosystem-observer.ts'

describe('ecosystem-observer', () => {
  it('reads mock configurations when files exist', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckseb-eco-'))

    try {
      const topologyPath = path.join(tmpDir, 'topology.json')
      const crewModelsPath = path.join(tmpDir, 'crewseb-models.json')
      const crewPersonasPath = path.join(tmpDir, 'crewseb-personas.json')
      const memosebDbPath = path.join(tmpDir, 'non-existent.sqlite')

      await fs.writeFile(
        topologyPath,
        JSON.stringify({
          schema: 'hubseb-topology/v1',
          nodes: {
            crewseb: { id: 'crewseb' },
            memoseb: { id: 'memoseb' },
          },
        })
      )

      await fs.writeFile(
        crewModelsPath,
        JSON.stringify({
          preset: 'custom-preset',
          concurrency: { mode: 'queue', maxLocalParallel: 2 },
        })
      )

      await fs.writeFile(
        crewPersonasPath,
        JSON.stringify({
          personas: {
            developer: 'Hephaestus',
          },
        })
      )

      const observer = new SebEcosystemObserver({
        topologyPath,
        crewModelsPath,
        crewPersonasPath,
        memosebDbPath,
        homeDir: tmpDir,
      })

      const snapshot = observer.getSnapshot()

      assert.equal(snapshot.optionalMode, true)
      assert.equal(snapshot.hubsebDetected, true)
      assert.equal(snapshot.crewsebDetected, true)
      assert.equal(snapshot.memosebDetected, true)
      assert.equal(snapshot.preset, 'custom-preset')
      assert.equal(snapshot.concurrencyMode, 'queue')
      assert.equal(snapshot.maxLocalParallel, 2)
      assert.equal(snapshot.personas.developer, 'Hephaestus')
      // Fallback for unset personas
      assert.equal(snapshot.personas.architect, 'Juno')
      assert.equal(snapshot.vaultStats.memoryCount, 0)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('degrades gracefully when no hubseb files exist', () => {
    const observer = new SebEcosystemObserver({
      topologyPath: '/tmp/does/not/exist/topo.json',
      crewModelsPath: '/tmp/does/not/exist/models.json',
      crewPersonasPath: '/tmp/does/not/exist/personas.json',
      memosebDbPath: '/tmp/does/not/exist/vault.sqlite',
      homeDir: '/tmp/does/not/exist/home',
    })

    const snapshot = observer.getSnapshot()
    assert.equal(snapshot.optionalMode, true)
    assert.equal(snapshot.hubsebDetected, false)
    assert.equal(snapshot.crewsebDetected, false)
    assert.equal(snapshot.memosebDetected, false)
    assert.equal(snapshot.concurrencyMode, 'parallel')
    assert.equal(snapshot.maxLocalParallel, 1)
    assert.equal(snapshot.vaultStats.memoryCount, 0)
  })
})
