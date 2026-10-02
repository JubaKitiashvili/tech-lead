// scripts/lib/atomic.mjs
// Atomic JSON records for the loop's lock and state files. A record is written whole to a
// temporary file in its own directory (<dir>/.tmp-<pid>-<hex>) and only then given its
// name, so a reader in another process sees either no record, the old one or the new one,
// never a partial one.
//   createExclusive(file, obj) -> true, or false when file already exists (link(2) is the
//                                 exclusive step, so two racers cannot both win)
//   writeReplace(file, obj)       creates or replaces file (rename(2))
//   readJson(file) -> object | null; null only when file is missing; throws
//                                 Error('corrupt: <file>') when the content is not a JSON object
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

function writeTemp(file, obj) {
  const tmp = path.join(path.dirname(file), `.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`)
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj) + '\n', { flag: 'wx' })
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
  return tmp
}

export function createExclusive(file, obj) {
  const tmp = writeTemp(file, obj)
  try {
    fs.linkSync(tmp, file)
    return true
  } catch (e) {
    if (e.code === 'EEXIST') return false
    throw e
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

export function writeReplace(file, obj) {
  const tmp = writeTemp(file, obj)
  try {
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

export function readJson(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`corrupt: ${file}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`corrupt: ${file}`)
  return value
}
