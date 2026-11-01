#!/usr/bin/env node
import fs from 'node:fs/promises'
import { SebEcosystemObserver } from '../core/ecosystem-observer.ts'
import { detectPlanInStream } from '../core/plan-detector.ts'
import { BUNDLE_ID, VERSION } from '../version.ts'
import {
  isDecksebRegistered,
  registerDecksebNode,
  unregisterDecksebNode,
} from './setup.ts'

function printHelp(): void {
  console.log(`
${BUNDLE_ID} v${VERSION} - Desktop mission control & PTY terminal hub for *seb ecosystem

Usage:
  deckseb setup            Register deckseb as a leaf node (ui.deck) in hubseb topology
  deckseb purge            Remove deckseb from hubseb topology
  deckseb status [--json]  Inspect *seb ecosystem health, topology, and active subagents
  deckseb detect <file>    Detect implementation plans or Mermaid diagrams in a markdown file
  deckseb --version, -v    Display deckseb version
  deckseb --help, -h       Display this help message
`)
}

async function handleStatus(jsonMode: boolean): Promise<void> {
  const observer = new SebEcosystemObserver()
  const snapshot = observer.getSnapshot()
  const registered = await isDecksebRegistered()

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          version: VERSION,
          bundleId: BUNDLE_ID,
          registeredInTopology: registered,
          snapshot,
        },
        null,
        2
      )
    )
    return
  }

  console.log(`\n🪐 deckseb v${VERSION} Ecosystem Status:`)
  console.log(`  • Registered in hubseb: ${registered ? '✅ YES' : '❌ NO'}`)
  console.log(
    `  • hubseb detected:      ${snapshot.hubsebDetected ? '✅ YES' : '⚠️ NO'}`
  )
  console.log(
    `  • crewseb detected:     ${snapshot.crewsebDetected ? '✅ YES' : '⚠️ NO'}`
  )
  console.log(
    `  • memoseb detected:     ${snapshot.memosebDetected ? '✅ YES' : '⚠️ NO'}`
  )
  console.log(
    `  • herdr detected:       ${snapshot.herdrDetected ? '✅ YES' : '⚠️ NO'}`
  )
  console.log(`  • Concurrency preset:   ${snapshot.preset} (${snapshot.concurrencyMode}, maxLocal=${snapshot.maxLocalParallel})`)
  console.log(`  • Available hosts:      ${snapshot.availableHosts.join(', ')}`)
  console.log(
    `  • Memoseb Vault stats:  ${snapshot.vaultStats.memoryCount} memories across ${snapshot.vaultStats.projectCount} projects (~${snapshot.vaultStats.totalTokens} tokens)\n`
  )
}

async function handleDetect(filePath: string, jsonMode: boolean): Promise<void> {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    const detected = detectPlanInStream('cli-session', 'active-project', content, filePath)

    if (!detected) {
      if (jsonMode) {
        console.log(JSON.stringify({ detected: null }))
      } else {
        console.log(`No implementation plan or Mermaid diagram detected in: ${filePath}`)
      }
      return
    }

    if (jsonMode) {
      console.log(JSON.stringify({ detected }, null, 2))
      return
    }

    console.log(`\n📋 Artifact Detected!`)
    console.log(`  • Title:   ${detected.title}`)
    console.log(`  • Segment: ${detected.segment}`)
    console.log(`  • Path:    ${detected.filePath}`)
    console.log(`  • Diagrams: ${detected.mermaidBlocks.length} Mermaid block(s) found\n`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Error reading ${filePath}: ${msg}`)
    process.exit(1)
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]
  const jsonMode = args.includes('--json')

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp()
    return
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(`${BUNDLE_ID} v${VERSION}`)
    return
  }

  switch (command) {
    case 'setup': {
      const outcome = await registerDecksebNode()
      console.log(`✅ Registered ${BUNDLE_ID} in ${outcome.topologyFile}`)
      break
    }
    case 'purge': {
      const outcome = await unregisterDecksebNode()
      if (outcome.removed) {
        console.log(`🧹 Removed ${BUNDLE_ID} from ${outcome.topologyFile}`)
      } else {
        console.log(`ℹ️ ${BUNDLE_ID} was not registered in ${outcome.topologyFile}`)
      }
      break
    }
    case 'status': {
      await handleStatus(jsonMode)
      break
    }
    case 'detect': {
      const targetFile = args[1]
      if (!targetFile) {
        console.error('Error: specify file path to detect: deckseb detect <path>')
        process.exit(1)
      }
      await handleDetect(targetFile, jsonMode)
      break
    }
    default: {
      console.error(`Unknown command: ${command}`)
      printHelp()
      process.exit(1)
    }
  }
}

main().catch((err) => {
  console.error('Fatal CLI error:', err)
  process.exit(1)
})
