/**
 * Packs `dist/` into a zip for the Chrome Web Store (or for sideloading).
 *
 * Uses the `zip` command when it is available and falls back to a small
 * built-in writer otherwise, so it works on any machine with Node.
 *
 * Run with:  npm run zip   (from the extension folder)
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const dist = join(root, 'dist')
const outFile = join(root, 'releases', 'work-tracker-extension.zip')

async function listFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listFiles(full)))
    else out.push(full)
  }
  return out
}

function hasZipBinary() {
  return run('zip', ['-v']).then(
    () => true,
    () => false,
  )
}

// ---------------------------------------------------------------------------
// fallback: a minimal, uncompressed (stored) zip writer
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f)
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  return { time, day }
}

async function writeZip(files, target) {
  await mkdir(dirname(target), { recursive: true })
  const chunks = []
  const central = []
  let offset = 0

  for (const file of files) {
    const name = relative(dist, file).split('\\').join('/')
    const data = await readFile(file)
    const { time, day } = dosDateTime(new Date())
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(Buffer.byteLength(name), 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, Buffer.from(name, 'utf8'), data)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0, 8)
    entry.writeUInt16LE(0, 10)
    entry.writeUInt16LE(time, 12)
    entry.writeUInt16LE(day, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(Buffer.byteLength(name), 28)
    entry.writeUInt16LE(0, 30)
    entry.writeUInt16LE(0, 32)
    entry.writeUInt16LE(0, 34)
    entry.writeUInt16LE(0, 36)
    entry.writeUInt32LE(0, 38)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, Buffer.from(name, 'utf8'))

    offset += local.length + Buffer.byteLength(name) + data.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)

  await new Promise((done, fail) => {
    const stream = createWriteStream(target)
    stream.on('error', fail)
    stream.on('close', done)
    stream.write(Buffer.concat(chunks))
    stream.write(centralBuffer)
    stream.end(end)
  })
}

// ---------------------------------------------------------------------------
const files = await listFiles(dist)
if (files.length === 0) {
  console.error('✗ dist/ is empty — run `npm run build` first.')
  process.exit(1)
}

await mkdir(dirname(outFile), { recursive: true })

if (await hasZipBinary()) {
  await run('zip', ['-r', '-q', '-X', outFile, '.'], { cwd: dist })
} else {
  await writeZip(files, outFile)
}

const { size } = await stat(outFile)
console.log(`✅ ${relative(root, outFile)} — ${files.length} files, ${(size / 1024).toFixed(1)} kB`)
