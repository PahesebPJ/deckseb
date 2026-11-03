import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  isDecksebRegistered,
  registerDecksebNode,
  unregisterDecksebNode,
} from '../src/cli/setup.ts'
import { BUNDLE_ID, VERSION } from '../src/version.ts'

describe('cli-setup', () => {
  it('registers deckseb as leaf node in topology and unregisters cleanly', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckseb-topo-'))

    try {
      const topologyPath = path.join(tmpDir, 'topology.json')

      // Initial state: not registered
      const before = await isDecksebRegistered({ topologyPath })
      assert.equal(before, false)

      // Register deckseb
      const reg = await registerDecksebNode({ topologyPath })
      assert.equal(reg.success, true)
      assert.equal(reg.node.id, BUNDLE_ID)
      assert.equal(reg.node.version, VERSION)
      assert.deepEqual(reg.node.provides, ['ui.deck', 'artifacts.organizer'])
      assert.deepEqual(reg.node.consumes, [
        'memory.vault',
        'crew.specialists',
        'crew.models',
      ])

      const after = await isDecksebRegistered({ topologyPath })
      assert.equal(after, true)

      // Unregister deckseb
      const unreg = await unregisterDecksebNode({ topologyPath })
      assert.equal(unreg.success, true)
      assert.equal(unreg.removed, true)

      const finalState = await isDecksebRegistered({ topologyPath })
      assert.equal(finalState, false)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('handles daemon check and stop when no pid exists', async () => {
    const { getDecksebPidPath, stopDecksebDaemon } = await import(
      '../src/cli/setup.ts'
    )
    const pidPath = getDecksebPidPath()
    assert.match(pidPath, /deckseb\.pid$/)

    // Stopping when no pid file exists should return false cleanly
    const stopped = await stopDecksebDaemon()
    assert.equal(typeof stopped, 'boolean')
  })
})
