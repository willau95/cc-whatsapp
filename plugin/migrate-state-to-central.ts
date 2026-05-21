#!/usr/bin/env bun
/**
 * Migrate cc-whatsapp state from per-project `<project>/.claude/cc-whatsapp/`
 * (old layout) to centralized `~/.cc-whatsapp/projects/<id>/` (new layout).
 *
 * Why: state in Desktop/Documents/iCloud hits macOS TCC (Bun lacks Folder
 * access). Centralizing eliminates the issue entirely — state lives in $HOME
 * which is always accessible.
 *
 * Safe to re-run. Idempotent. Existing central state is NOT overwritten.
 *
 * Usage:
 *   bun migrate-state-to-central.ts                 # default: scan known roots
 *   bun migrate-state-to-central.ts /path/to/proj   # migrate a specific project
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

const CC_HOME = join(homedir(), '.cc-whatsapp')
const CC_PROJECTS_DIR = join(CC_HOME, 'projects')

function pathToId(absPath: string): string {
  return Buffer.from(absPath).toString('base64url')
}

function scanLegacyProjects(): string[] {
  const found = new Set<string>()
  const roots = [
    join(homedir(), 'Projects'),
    join(homedir(), 'Desktop'),
    join(homedir(), 'Documents'),
    homedir(),
  ]
  for (const root of roots) {
    if (!existsSync(root)) continue
    let entries: string[]
    try { entries = readdirSync(root) } catch { continue }
    for (const name of entries) {
      const abs = join(root, name)
      const legacyState = join(abs, '.claude', 'cc-whatsapp')
      const legacyCfg = join(legacyState, 'config.json')
      if (existsSync(legacyCfg)) found.add(abs)
    }
  }
  // Also check registry.json (old discovery mechanism)
  try {
    const reg = JSON.parse(readFileSync(join(CC_HOME, 'registry.json'), 'utf8'))
    const paths = Array.isArray(reg) ? reg : (Array.isArray(reg.projects) ? reg.projects : [])
    for (const p of paths) {
      if (existsSync(join(p, '.claude', 'cc-whatsapp', 'config.json'))) {
        found.add(p)
      }
    }
  } catch {}
  return Array.from(found)
}

function migrateOne(projectPath: string): { ok: boolean; reason: string; id?: string } {
  const legacy = join(projectPath, '.claude', 'cc-whatsapp')
  if (!existsSync(legacy)) return { ok: false, reason: 'no legacy state dir' }
  const id = pathToId(projectPath)
  const central = join(CC_PROJECTS_DIR, id)

  // If central already exists with content, skip (idempotent)
  if (existsSync(join(central, 'config.json'))) {
    return { ok: true, reason: 'already migrated (central exists)', id }
  }

  mkdirSync(central, { recursive: true, mode: 0o700 })

  // Move all entries from legacy to central
  const moved: string[] = []
  for (const name of readdirSync(legacy)) {
    const src = join(legacy, name)
    const dst = join(central, name)
    if (existsSync(dst)) continue   // don't overwrite
    try { renameSync(src, dst); moved.push(name) } catch (err) {
      // Could be cross-device — fall back to copy+delete
      try {
        const buf = readFileSync(src)
        writeFileSync(dst, buf)
        moved.push(name + ' (copied)')
      } catch {}
    }
  }

  // Add project_path field to config.json
  const cfgPath = join(central, 'config.json')
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    cfg.project_path = projectPath
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
  } catch (err) {
    return { ok: false, reason: `couldn't add project_path: ${err}` }
  }

  // Remove empty legacy dir (best effort)
  try {
    const remaining = readdirSync(legacy)
    if (remaining.length === 0) rmdirSync(legacy)
  } catch {}

  return { ok: true, reason: `moved ${moved.length} items`, id }
}

function main(): void {
  const args = process.argv.slice(2)
  const targets = args.length > 0 ? args : scanLegacyProjects()

  if (targets.length === 0) {
    console.log('No legacy cc-whatsapp projects found.')
    return
  }

  console.log(`Found ${targets.length} legacy project(s) to migrate:`)
  for (const t of targets) console.log('  ', t)
  console.log('')

  mkdirSync(CC_PROJECTS_DIR, { recursive: true, mode: 0o700 })

  let ok = 0, fail = 0
  for (const target of targets) {
    const r = migrateOne(target)
    if (r.ok) {
      console.log(`  ✓ ${target}  →  ${join(CC_PROJECTS_DIR, r.id!)} · ${r.reason}`)
      ok++
    } else {
      console.log(`  ✗ ${target}  ${r.reason}`)
      fail++
    }
  }
  console.log('')
  console.log(`Done. ${ok} migrated, ${fail} failed.`)
}

main()
