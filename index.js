/**
 * DSH 工作移植插件
 *
 * 设计：用**聊天命令**作为唯一入口，不需要任何 Client↔Host RPC。
 *   /dshmig-export    导出工作（含代码、数据、对话记录、目录结构）
 *   /dshmig-import    导入工作并按目录结构还原或重建
 *   /dshmig   查看可用的子命令
 *
 * 命令的 handler 全在 Host 侧执行，结果以文本形式显示在对话里。
 * 这是 DSH 插件最标准、最简的形式（参照官方 /compact 的实现）。
 *
 * 核心逻辑（三件事）：
 *   导出 = 复制工作目录 + 复制会话 + 记录目录结构 → 打包
 *   导入 = 解包 + 按结构摆回去 + 改 cwd + 改会话目录名 + 改索引
 *   新建分类 = mkdir
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-work-migrator'
export const inject = ['commands']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TOOLKIT = path.resolve(HERE, '..', '..')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const LOG_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/

// ---------------------------------------------------------------------------
// 路径与环境
// ---------------------------------------------------------------------------

function dshHome () {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
}

function readJson (f, fallback = null) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return fallback }
}

function writeJson (f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8')
}

/** cwd -> DSH 项目目录名（照抄规则，不要推导） */
function projectKey (cwd) {
  let out = ''
  let prevSep = false
  for (const ch of cwd) {
    const code = ch.codePointAt(0)
    if (ch === '\\' || ch === '/' || ch === ':') {
      if (!prevSep) out += '-'
      prevSep = true
      continue
    }
    prevSep = false
    if (/[A-Za-z0-9._-]/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return `--${out}--`
}

// ---------------------------------------------------------------------------
// 会话日志读写（铁律：首帧只有 header 一行）
// ---------------------------------------------------------------------------

function decompressAll (buf) {
  const parts = []
  let off = 0
  let frames = 0
  while (off < buf.length) {
    const next = buf.indexOf(MAGIC, off + 4)
    const end = next < 0 ? buf.length : next
    parts.push(zlib.zstdDecompressSync(buf.subarray(off, end)))
    frames++
    off = end
  }
  if (frames === 0) throw new Error('不是 zstd 数据')
  return { text: Buffer.concat(parts).toString('utf8'), frames }
}

function compressFrames (lines) {
  if (!lines.length) throw new Error('内容为空')
  const f1 = zlib.zstdCompressSync(Buffer.from(lines[0] + '\n', 'utf8'))
  if (lines.length === 1) return f1
  const rest = lines.slice(1).map(l => l + '\n').join('')
  const f2 = zlib.zstdCompressSync(Buffer.from(rest, 'utf8'))
  return Buffer.concat([f1, f2])
}

function validateFrames (buf) {
  const frames = []
  let off = 0
  try {
    while (off < buf.length) {
      const next = buf.indexOf(MAGIC, off + 4)
      const end = next < 0 ? buf.length : next
      frames.push(zlib.zstdDecompressSync(buf.subarray(off, end)).toString('utf8'))
      off = end
    }
  } catch (e) {
    return { ok: false, problems: ['解压失败: ' + e.message] }
  }
  if (!frames.length) return { ok: false, problems: ['无帧'] }
  const problems = []
  frames.forEach((t, i) => { if (!t.endsWith('\n')) problems.push(`帧${i + 1}未以换行结尾`) })
  const first = frames[0]
  const inner = first.slice(0, -1).split('\n').length - 1
  if (inner > 0) problems.push(`首帧含${inner + 1}行(应1行)`)
  try {
    if (JSON.parse(first.trim()).type !== 'session') problems.push('首行type不是session')
  } catch { problems.push('首行非JSON') }
  return { ok: problems.length === 0, problems }
}

function findLog (sessionsRoot, sessionId) {
  let dirs
  try { dirs = fs.readdirSync(sessionsRoot, { withFileTypes: true }) } catch { return null }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name === '_fix_backup') continue
    const sd = path.join(sessionsRoot, d.name, sessionId)
    if (!fs.existsSync(sd)) continue
    const logs = fs.readdirSync(sd).filter(f => LOG_RE.test(f)).sort()
    if (logs.length) return { log: path.join(sd, logs[0]), dir: sd, project: d.name }
  }
  return null
}

// ---------------------------------------------------------------------------
// 目录结构模型
//   一个「分组」= 某个目录，下面挂若干工作目录
//   manifest 里记录：
//     groups:  [{ name, relPath }]
//     works:   [{ name, relPath, group, sessions: [...] }]
// ---------------------------------------------------------------------------

/** 扫描本机工作区，推导分组结构 */
function scanStructure (home) {
  const doc = readJson(path.join(home, 'storages', 'workspace.json'), { tables: { workspaces: {} } })
  const entries = Object.entries(doc.tables.workspaces || {}).map(([id, w]) => ({
    id,
    path: String(w.path || ''),
    title: w.title || '',
    sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds : []
  }))
  const norm = p => p.replace(/[\\/]+$/, '').toLowerCase()

  // 找父目录（有子工作区挂在下面）
  const groups = []
  for (const e of entries) {
    const children = entries.filter(o => o.id !== e.id && norm(o.path).startsWith(norm(e.path) + '\\'))
    if (children.length) groups.push({ id: e.id, path: e.path, title: e.title, children: children.map(c => c.path) })
  }
  const groupIds = new Set(groups.map(g => g.id))

  // 每个「工作」属于哪个分组。
  // 分组本身（有子项的容器目录）不是工作，必须排除，否则会出现在导出列表里。
  const works = entries.filter(e => !groupIds.has(e.id)).map(e => {
    const parent = groups
      .filter(g => norm(e.path).startsWith(norm(g.path) + '\\'))
      .sort((a, b) => b.path.length - a.path.length)[0]
    return {
      id: e.id,
      path: e.path,
      title: e.title,
      sessionIds: e.sessionIds,
      groupPath: parent ? parent.path : null,
      groupTitle: parent ? parent.title : null
    }
  })

  return { groups, works, doc }
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

function collectFiles (root, skip = new Set(['node_modules', '.venv', '__pycache__', '.git', '.cache', 'dist', 'build'])) {
  const out = []
  const walk = (dir) => {
    let items
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      if (skip.has(it.name)) continue
      const abs = path.join(dir, it.name)
      if (it.isDirectory()) walk(abs)
      else if (it.isFile()) out.push(abs)
    }
  }
  walk(root)
  return out
}

/** 极简 zip 写入（store 方式，不压缩已压缩的文件） */
function crc32 (buf) {
  let c = 0xffffffff
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let x = i
      for (let k = 0; k < 8; k++) x = (x & 1) ? (0xedb88320 ^ (x >>> 1)) : (x >>> 1)
      t[i] = x >>> 0
    }
    return t
  })())
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 流式计算文件 CRC32（不整块读入内存） */
function crc32File (file) {
  const table = crc32Table()
  let c = 0xffffffff
  const CHUNK = 4 * 1024 * 1024
  const buf = Buffer.allocUnsafe(CHUNK)
  const fd = fs.openSync(file, 'r')
  try {
    let pos = 0
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos)
      if (n <= 0) break
      for (let i = 0; i < n; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
      pos += n
    }
  } finally {
    fs.closeSync(fd)
  }
  return (c ^ 0xffffffff) >>> 0
}

/** CRC32 查表（缓存） */
function crc32Table () {
  if (crc32Table.cache) return crc32Table.cache
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let x = i
    for (let k = 0; k < 8; k++) x = (x & 1) ? (0xedb88320 ^ (x >>> 1)) : (x >>> 1)
    t[i] = x >>> 0
  }
  crc32Table.cache = t
  return t
}

/** 写 zip（支持 zip64）。
 *
 * 为什么会超 2 GiB 报错：
 *   旧实现把大小/偏移全部写成 32 位，且一次性把整个包 hold 在内存里。
 *   现在：
 *     · 每个文件当帧立刻落盘，不累积在内存
 *     · 大小或偏移超过 0xFFFFFFFF 时，自动写 zip64 扩展字段
 *     · 中央目录结束后补 EOCD64 + 定位记录 + 普通 EOCD
 */
function zipWrite (entries, zipPath) {
  const MAX32 = 0xffffffff
  const fd = fs.openSync(zipPath, 'w')
  const central = []
  let offset = 0
  const needsZip64 = { value: false }

  // zip64 扩展字段：ID 0x0001，按需追加未压缩大小 / 压缩大小 / 偏移
  function zip64Extra (vals) {
    const body = Buffer.alloc(vals.length * 8)
    vals.forEach((v, i) => body.writeBigUInt64LE(BigInt(v), i * 8))
    const head = Buffer.alloc(4)
    head.writeUInt16LE(0x0001, 0)
    head.writeUInt16LE(body.length, 2)
    return Buffer.concat([head, body])
  }

  try {
    for (const e of entries) {
      const nameBuf = Buffer.from(e.name, 'utf8')

      // 支持两种来源：内存 data，或磁盘 file（流式，避免大文件占内存）
      let size
      let openFile = null
      if (e.file) {
        let st
        try { st = fs.statSync(e.file) } catch { continue }
        if (!st.isFile()) continue
        size = st.size
        openFile = e.file
      } else {
        size = e.data.length
      }

      // 流式算 CRC（不整块读入）
      const crc = openFile ? crc32File(openFile) : crc32(e.data)

      const bigSize = size > MAX32
      const bigOffset = offset > MAX32
      if (bigSize || bigOffset) needsZip64.value = true

      const extraParts = []
      const z64vals = []
      if (bigSize) z64vals.push(size, size)
      if (bigOffset) z64vals.push(offset)
      if (z64vals.length) extraParts.push(zip64Extra(z64vals))
      const extra = extraParts.length ? Buffer.concat(extraParts) : Buffer.alloc(0)

      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(bigSize || bigOffset ? 45 : 20, 4)
      local.writeUInt16LE(0x0800, 6)
      local.writeUInt16LE(0, 8)
      local.writeUInt16LE(0, 10)
      local.writeUInt16LE(0x21, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(bigSize ? MAX32 : size, 18)
      local.writeUInt32LE(bigSize ? MAX32 : size, 22)
      local.writeUInt16LE(nameBuf.length, 26)
      local.writeUInt16LE(extra.length, 28)

      fs.writeSync(fd, local)
      fs.writeSync(fd, nameBuf)
      if (extra.length) fs.writeSync(fd, extra)

      if (openFile) {
        // 分块拷贝
        const CHUNK = 8 * 1024 * 1024
        const buf = Buffer.allocUnsafe(CHUNK)
        const rfd = fs.openSync(openFile, 'r')
        try {
          let pos = 0
          while (pos < size) {
            const n = fs.readSync(rfd, buf, 0, Math.min(CHUNK, size - pos), pos)
            if (n <= 0) break
            fs.writeSync(fd, buf, 0, n)
            pos += n
          }
        } finally {
          fs.closeSync(rfd)
        }
      } else {
        const CHUNK = 8 * 1024 * 1024
        for (let p = 0; p < size; p += CHUNK) {
          fs.writeSync(fd, e.data, p, Math.min(CHUNK, size - p))
        }
      }

      central.push({ nameBuf, crc, size, offset })
      offset += local.length + nameBuf.length + extra.length + size
    }

    const cdStart = offset

    for (const c of central) {
      const bigSize = c.size > MAX32
      const bigOffset = c.offset > MAX32
      const z64vals = []
      if (bigSize) z64vals.push(c.size, c.size)
      if (bigOffset) z64vals.push(c.offset)
      const extra = z64vals.length ? zip64Extra(z64vals) : Buffer.alloc(0)

      const h = Buffer.alloc(46)
      h.writeUInt32LE(0x02014b50, 0)
      h.writeUInt16LE(45, 4)                     // version made by
      h.writeUInt16LE(bigSize || bigOffset ? 45 : 20, 6)
      h.writeUInt16LE(0x0800, 8)
      h.writeUInt16LE(0, 10)
      h.writeUInt16LE(0, 12)
      h.writeUInt16LE(0x21, 14)
      h.writeUInt32LE(c.crc, 16)
      h.writeUInt32LE(bigSize ? MAX32 : c.size, 20)
      h.writeUInt32LE(bigSize ? MAX32 : c.size, 24)
      h.writeUInt16LE(c.nameBuf.length, 28)
      h.writeUInt16LE(extra.length, 30)
      h.writeUInt16LE(0, 32)
      h.writeUInt16LE(0, 34)
      h.writeUInt16LE(0, 36)
      h.writeUInt32LE(0, 38)
      h.writeUInt32LE(bigOffset ? MAX32 : c.offset, 42)
      fs.writeSync(fd, h)
      fs.writeSync(fd, c.nameBuf)
      if (extra.length) fs.writeSync(fd, extra)
      offset += h.length + c.nameBuf.length + extra.length
    }

    const cdSize = offset - cdStart
    const count = central.length

    // 需要时先写 EOCD64 与定位记录
    if (needsZip64.value || count > 0xffff || cdSize > MAX32 || cdStart > MAX32) {
      const eocd64 = Buffer.alloc(56)
      eocd64.writeUInt32LE(0x06064b50, 0)
      eocd64.writeBigUInt64LE(44n, 4)                    // size of remaining record
      eocd64.writeUInt16LE(45, 12)
      eocd64.writeUInt16LE(45, 14)
      eocd64.writeUInt32LE(0, 16)
      eocd64.writeUInt32LE(0, 20)
      eocd64.writeBigUInt64LE(BigInt(count), 24)
      eocd64.writeBigUInt64LE(BigInt(count), 32)
      eocd64.writeBigUInt64LE(BigInt(cdSize), 40)
      eocd64.writeBigUInt64LE(BigInt(cdStart), 48)
      const eocd64Offset = offset
      fs.writeSync(fd, eocd64)
      offset += eocd64.length

      const loc = Buffer.alloc(20)
      loc.writeUInt32LE(0x07064b50, 0)
      loc.writeUInt32LE(0, 4)
      loc.writeBigUInt64LE(BigInt(eocd64Offset), 8)
      loc.writeUInt32LE(1, 16)
      fs.writeSync(fd, loc)
      offset += loc.length
    }

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(Math.min(count, 0xffff), 8)
    eocd.writeUInt16LE(Math.min(count, 0xffff), 10)
    eocd.writeUInt32LE(Math.min(cdSize, MAX32), 12)
    eocd.writeUInt32LE(Math.min(cdStart, MAX32), 16)
    eocd.writeUInt16LE(0, 20)
    fs.writeSync(fd, eocd)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 读 zip（支持 zip64，不整块读入内存）。
 *
 * 旧实现用 fs.readFileSync 把整个包读进内存，超过 2 GiB 会直接报
 *   "File size (N) is greater than 2 GiB"。
 * 现在用文件句柄按需读取：中央目录读一次，文件内容按条目逐个读。
 */
function zipRead (zipPath) {
  const MAX32 = 0xffffffff
  /** 单次读取块大小：远低于 2 GiB 上限，也足够大以保持吞吐 */
  const READ_CHUNK = 64 * 1024 * 1024
  const fd = fs.openSync(zipPath, 'r')
  const out = []

  /**
   * 读指定区间的字节。
   *
   * ⚠️ 单次 readSync 的 length 有上限（约 2 GiB，超出会变成负数），
   * 所以大文件必须分块读并拼接，不能一次 allocUnsafe(整个大小)。
   */
  function readAt (position, length) {
    if (length <= 0) return Buffer.alloc(0)
    const chunks = []
    let remaining = length
    let pos = position
    while (remaining > 0) {
      const want = Math.min(remaining, READ_CHUNK)
      const b = Buffer.allocUnsafe(want)
      let got = 0
      while (got < want) {
        const n = fs.readSync(fd, b, got, want - got, pos + got)
        if (n <= 0) break
        got += n
      }
      if (got === 0) break
      chunks.push(got === want ? b : b.subarray(0, got))
      pos += got
      remaining -= got
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length - remaining)
  }

  /** 只读头部若干字节（不 alloc 全部） */
  function readHead (position, length) {
    if (length <= 0) return Buffer.alloc(0)
    const b = Buffer.allocUnsafe(length)
    let got = 0
    while (got < length) {
      const n = fs.readSync(fd, b, got, length - got, position + got)
      if (n <= 0) break
      got += n
    }
    return got === length ? b : b.subarray(0, got)
  }

  try {
    const fileSize = fs.fstatSync(fd).size

    // 1) 从尾部找 EOCD（可能带注释，最多扫 64 KiB）
    const tailLen = Math.min(fileSize, 65558)
    const tail = readAt(fileSize - tailLen, tailLen)
    let eocdRel = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocdRel = i; break }
    }
    if (eocdRel < 0) throw new Error('不是有效的 zip（找不到目录结尾）')
    const eocdPos = fileSize - tailLen + eocdRel

    let total = tail.readUInt16LE(eocdRel + 10)
    let cdSize = tail.readUInt32LE(eocdRel + 12)
    let cdOff = tail.readUInt32LE(eocdRel + 16)

    // 2) 如果是 zip64，读 EOCD64 定位记录
    if (total === 0xffff || cdSize === MAX32 || cdOff === MAX32) {
      const locPos = eocdPos - 20
      if (locPos >= 0) {
        const loc = readAt(locPos, 20)
        if (loc.length === 20 && loc.readUInt32LE(0) === 0x07064b50) {
          const eocd64Pos = Number(loc.readBigUInt64LE(8))
          const e64 = readAt(eocd64Pos, 56)
          if (e64.length >= 56 && e64.readUInt32LE(0) === 0x06064b50) {
            total = Number(e64.readBigUInt64LE(32))
            cdSize = Number(e64.readBigUInt64LE(40))
            cdOff = Number(e64.readBigUInt64LE(48))
          }
        }
      }
    }

    // 3) 读中央目录（只读目录区，不含文件内容）
    const cd = readAt(cdOff, cdSize)
    let p = 0
    for (let i = 0; i < total; i++) {
      if (p + 46 > cd.length) break
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏')
      let csize = cd.readUInt32LE(p + 20)
      let usize = cd.readUInt32LE(p + 24)
      const nlen = cd.readUInt16LE(p + 28)
      const elen = cd.readUInt16LE(p + 30)
      const clen = cd.readUInt16LE(p + 32)
      let lho = cd.readUInt32LE(p + 42)
      const name = cd.toString('utf8', p + 46, p + 46 + nlen)

      // zip64 扩展字段：按 (usize, csize, offset) 的顺序补齐被置为 0xFFFFFFFF 的项
      if (elen > 0) {
        let ep = p + 46 + nlen
        const eEnd = ep + elen
        while (ep + 4 <= eEnd) {
          const hid = cd.readUInt16LE(ep)
          const hsz = cd.readUInt16LE(ep + 2)
          if (hid === 0x0001) {
            let vp = ep + 4
            const vEnd = vp + hsz
            if (usize === MAX32 && vp + 8 <= vEnd) { usize = Number(cd.readBigUInt64LE(vp)); vp += 8 }
            if (csize === MAX32 && vp + 8 <= vEnd) { csize = Number(cd.readBigUInt64LE(vp)); vp += 8 }
            if (lho === MAX32 && vp + 8 <= vEnd) { lho = Number(cd.readBigUInt64LE(vp)); vp += 8 }
            break
          }
          ep += 4 + hsz
        }
      }

      // 4) 读本地头，算数据起点
      const lh = readAt(lho, 30)
      if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) throw new Error('本地文件头损坏：' + name)
      const lnlen = lh.readUInt16LE(26)
      const lelen = lh.readUInt16LE(28)
      const dataOff = lho + 30 + lnlen + lelen

      out.push({
        name,
        size: usize,
        // 关闭句柄后仍可读：每次 read() 自己开一次文件
        read: () => {
          const h = fs.openSync(zipPath, 'r')
          try {
            const chunks = []
            let remaining = csize
            let pos = dataOff
            while (remaining > 0) {
              const want = Math.min(remaining, READ_CHUNK)
              const b = Buffer.allocUnsafe(want)
              let got = 0
              while (got < want) {
                const n = fs.readSync(h, b, got, want - got, pos + got)
                if (n <= 0) break
                got += n
              }
              if (got === 0) break
              chunks.push(got === want ? b : b.subarray(0, got))
              pos += got
              remaining -= got
            }
            return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, csize - remaining)
          } finally {
            fs.closeSync(h)
          }
        }
      })

      p += 46 + nlen + elen + clen
    }
  } finally {
    fs.closeSync(fd)
  }
  return out
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

const USAGE = [
  '工作迁移命令：',
  '',
  '  /dshmig-export                        导出全部工作',
  '  /dshmig-export <输出路径>              导出全部工作到指定路径',
  '  /dshmig-export <工作名>                只导出某个工作',
  '',
  '  /dshmig-import <包路径>               查看包内结构（不写盘）',
  '  /dshmig-import <包路径> 还原           按原目录结构还原',
  '  /dshmig-import <包路径> 平铺 <目标目录>  全部平铺到目标目录',
  '  /dshmig-import <包路径> 分组 <名>=<目录> ...  按指定分组安置',
  '',
  '  /dshmig status                查看当前分组结构'
].join('\n')

function ok (text) { return { kind: 'success', text } }
function err (text) { return { kind: 'error', text } }

/** /export */
async function doExport (home, args) {
  const { groups, works } = scanStructure(home)
  if (!works.length) return err('没有找到任何工作区')

  const rawArgs = args.trim()
  let outFile = ''
  let only = null

  if (rawArgs) {
    if (/\.dsht$/i.test(rawArgs) || rawArgs.includes('\\') || rawArgs.includes('/')) outFile = rawArgs
    else only = rawArgs
  }

  const targets = only ? works.filter(w => w.title === only || path.basename(w.path) === only) : works
  if (!targets.length) return err(`找不到工作：${only}\n可用：${works.map(w => w.title).join('、')}`)

  if (!outFile) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 8)
    outFile = path.join(process.env.USERPROFILE || home, `dshexport-${stamp}.dsht`)
  }

  const exportRoot = (() => {
    // 用所有工作路径的最长公共前缀作为导出根
    const paths = targets.map(t => path.dirname(t.path))
    let common = paths[0]
    for (const p of paths.slice(1)) {
      while (!p.toLowerCase().startsWith(common.toLowerCase() + '\\') && common.length > 3) {
        common = path.dirname(common)
      }
    }
    return common
  })()

  const entries = []
  const manifest = {
    format: 'dsh-work-pack',
    version: 1,
    createdAt: new Date().toISOString(),
    exportRoot,
    groups: groups.map(g => ({
      title: g.title,
      path: g.path,
      rel: path.relative(exportRoot, g.path) || '.'
    })),
    works: []
  }

  let fileCount = 0
  const sessionsRoot = path.join(home, 'sessions')

  for (const w of targets) {
    const rel = path.relative(exportRoot, w.path)
    const rec = {
      title: w.title,
      path: w.path,
      rel,
      group: w.groupTitle,
      groupRel: w.groupPath ? path.relative(exportRoot, w.groupPath) : null,
      sessions: []
    }

    // 工作文件
    if (fs.existsSync(w.path)) {
      for (const f of collectFiles(w.path)) {
        const inner = path.relative(w.path, f)
        entries.push({ name: `works/${rel}/${inner}`, data: fs.readFileSync(f) })
        fileCount++
      }
    }

    // 会话
    for (const sid of w.sessionIds) {
      const found = findLog(sessionsRoot, sid)
      if (!found) continue
      const raw = fs.readFileSync(found.log)
      const chk = validateFrames(raw)
      if (!chk.ok) continue
      entries.push({ name: `sessions/${sid}.jsonl.zstd`, data: raw })
      rec.sessions.push({ sessionId: sid, projectDir: found.project })
      fileCount++
    }

    manifest.works.push(rec)
  }

  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') })
  zipWrite(entries, outFile)

  const size = fs.statSync(outFile).size
  const lines = [
    `已导出 ${targets.length} 个工作、${fileCount} 个文件`,
    `输出：${outFile}`,
    `大小：${(size / 1024 / 1024).toFixed(1)} MB`,
    '',
    '目录结构：',
    ...targets.map(w => `  ${w.groupTitle ? w.groupTitle + ' / ' : ''}${w.title}  (${w.sessionIds.length} 会话)`)
  ]
  return ok(lines.join('\n'))
}

/** /import */
async function doImport (home, args) {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return err(USAGE)
  const packFile = parts[0]
  if (!fs.existsSync(packFile)) return err(`找不到包：${packFile}`)

  const mode = parts[1] || 'view'
  const rest = parts.slice(2)

  const entries = zipRead(packFile)
  const mf = entries.find(e => e.name === 'manifest.json')
  if (!mf) return err('包内缺少 manifest.json')
  const manifest = JSON.parse(mf.read().toString('utf8'))

  if (mode === 'view') {
    const lines = [
      `包内结构（来源：${manifest.createdAt}）`,
      `导出根目录：${manifest.exportRoot}`,
      '',
      '分组：',
      ...(manifest.groups || []).map(g => `  ◆ ${g.title}  (${g.rel})`),
      '',
      '工作：'
    ]
    for (const w of manifest.works) {
      lines.push(`  · ${w.title}  (${w.sessions.length} 会话)`)
      lines.push(`      原位置：${w.group ? w.group + ' / ' : ''}${w.rel}`)
    }
    lines.push('')
    lines.push('确认后执行：')
    lines.push(`  /dshmig-import ${packFile} 还原                     按原结构还原`)
    lines.push(`  /dshmig-import ${packFile} 平铺 D:\\目标目录          全部放同一目录`)
    lines.push(`  /dshmig-import ${packFile} 分组 "工具=D:\\Harness Record\\0_Tools"  按分组安置`)
    return ok(lines.join('\n'))
  }

  // ---- 计算安置方案 ----
  const placements = []
  if (mode === '还原') {
    for (const w of manifest.works) {
      placements.push({ work: w, target: path.join(manifest.exportRoot, w.rel) })
    }
  } else if (mode === '平铺') {
    const target = rest[0]
    if (!target) return err('平铺需要目标目录：/import <包> 平铺 <目录>')
    for (const w of manifest.works) placements.push({ work: w, target: path.join(target, path.basename(w.rel)) })
  } else if (mode === '分组') {
    const map = {}
    for (const r of rest) {
      const i = r.indexOf('=')
      if (i > 0) map[r.slice(0, i).replace(/^"|"$/g, '')] = r.slice(i + 1).replace(/^"|"$/g, '')
    }
    if (!Object.keys(map).length) return err('分组需要 <分组名>=<目录>，可写多个')
    for (const w of manifest.works) {
      const dir = map[w.group] || Object.values(map)[0]
      placements.push({ work: w, target: path.join(dir, path.basename(w.rel)) })
    }
  } else {
    return err('未知模式：' + mode + '\n\n' + USAGE)
  }

  // ---- 冲突预检：绝不覆盖任何已存在的东西 ----
  const sessionsRootPre = path.join(home, 'sessions')

  // 先备份再判断？不行 —— 冲突必须在任何写操作之前判定。
  // 1) 目标目录已存在（含「目标就是原地」这种重新导入的情况）
  const dirConflicts = []
  for (const p of placements) {
    if (!fs.existsSync(p.target)) continue
    // 原地且内容为空目录也算冲突 —— 说明上次导入过
    dirConflicts.push(p.target)
  }

  // 2) 会话 ID 已存在（同一个包装两次，或包里的工作和本机已有工作合并）
  const sessionConflicts = []
  for (const p of placements) {
    for (const s of p.work.sessions || []) {
      const found = findLog(sessionsRootPre, s.sessionId)
      if (found) sessionConflicts.push({ sessionId: s.sessionId, where: found.project })
    }
  }

  if (dirConflicts.length || sessionConflicts.length) {
    const lines = ['导入被拒绝：目标位置已存在内容，本工具绝不覆盖。', '']
    if (dirConflicts.length) {
      lines.push('【目录已存在】')
      for (const d of dirConflicts) lines.push('  ' + d)
      lines.push('')
    }
    if (sessionConflicts.length) {
      lines.push('【会话已存在】')
      for (const s of sessionConflicts) lines.push(`  ${s.sessionId}  (现在位于 ${s.where})`)
      lines.push('')
    }
    lines.push('处理办法：')
    lines.push('  · 换一个目标位置（导入时选「新建分组」或别的分组）')
    lines.push('  · 或者先在 DSH 里删除/归档旧的同名工作，再重新导入')
    return err(lines.join('\n'))
  }

  // ---- 备份 ----
  const bkDir = path.join(home, 'storages', 'work-migrator', 'backup-' + Date.now())
  const sessionsRoot = path.join(home, 'sessions')
  try {
    fs.mkdirSync(bkDir, { recursive: true })
    const wsDoc = path.join(home, 'storages', 'workspace.json')
    if (fs.existsSync(wsDoc)) fs.copyFileSync(wsDoc, path.join(bkDir, 'workspace.json'))
    for (const p of placements) {
      for (const s of p.work.sessions || []) {
        const found = findLog(sessionsRoot, s.sessionId)
        if (found) {
          const dst = path.join(bkDir, 'logs', s.sessionId + '.zstd')
          fs.mkdirSync(path.dirname(dst), { recursive: true })
          fs.copyFileSync(found.log, dst)
        }
      }
    }
  } catch (e) {
    return err('备份失败，已中止：' + e.message)
  }

  // ---- 执行 ----
  const doc = readJson(path.join(home, 'storages', 'workspace.json'))
  if (!doc) return err('读不到 workspace.json')
  const norm = p => p.replace(/[\\/]+$/, '').toLowerCase()
  const log = []
  let moved = 0
  let sessFixed = 0

  for (const p of placements) {
    const w = p.work
    const target = p.target

    // 1) 建目标目录（含分组 = 自动创建文件夹）
    fs.mkdirSync(path.dirname(target), { recursive: true })

    // 2) 释放工作文件
    const prefix = `works/${w.rel}/`
    for (const e of entries) {
      if (!e.name.startsWith(prefix)) continue
      const inner = e.name.slice(prefix.length)
      const out = path.join(target, ...inner.split('/'))
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.writeFileSync(out, e.read())
    }
    log.push(`  ✓ ${w.title} → ${target}`)
    moved++

    // 3) 会话：写日志 + 改 cwd + 会话目录改名
    const newKey = projectKey(target)
    for (const s of w.sessions || []) {
      const src = entries.find(e => e.name === `sessions/${s.sessionId}.jsonl.zstd`)
      if (!src) continue
      const srcBuf = src.read()
      const chk = validateFrames(srcBuf)
      if (!chk.ok) { log.push(`    ! ${s.sessionId.slice(0, 12)} 帧结构不合规，跳过`); continue }

      const lines = decompressAll(srcBuf).text.split('\n').filter(l => l !== '')
      const header = JSON.parse(lines[0])
      header.cwd = target
      const out = compressFrames([JSON.stringify(header), ...lines.slice(1)])

      const found = findLog(sessionsRoot, s.sessionId)
      const dir = path.join(sessionsRoot, newKey)
      fs.mkdirSync(dir, { recursive: true })
      const dest = path.join(dir, s.sessionId)
      if (found && norm(found.dir) !== norm(dest)) {
        // 不永久删除：把旧目录移进本次备份目录下
        const oldToBk = path.join(bkDir, 'old-session-dirs', s.sessionId)
        try {
          fs.mkdirSync(path.dirname(oldToBk), { recursive: true })
          fs.renameSync(found.dir, oldToBk)
        } catch {
          // 移不动就保留原地，不阻断（新位置会写一份新的）
        }
      }
      fs.mkdirSync(dest, { recursive: true })
      fs.writeFileSync(path.join(dest, 'session.v4.jsonl.zstd'), out)
      sessFixed++
    }

    // 4) 更新 workspace.json
    let hit = null
    for (const [id, e] of Object.entries(doc.tables.workspaces || {})) {
      if (norm(e.path) === norm(w.path)) { hit = id; break }
    }
    const sidList = (w.sessions || []).map(s => s.sessionId)
    if (hit) {
      doc.tables.workspaces[hit].path = target
      doc.tables.workspaces[hit].sessionIds = sidList
      doc.tables.workspaces[hit].updatedAt = new Date().toISOString()
    } else {
      const id = cryptoRandomId()
      doc.tables.workspaces[id] = {
        path: target,
        title: w.title,
        sessionIds: sidList,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
      if (!Array.isArray(doc.global.workspaceIds)) doc.global.workspaceIds = []
      doc.global.workspaceIds.push(id)
    }
  }

  writeJson(path.join(home, 'storages', 'workspace.json'), doc)

  return ok([
    `导入完成：${moved} 个工作，${sessFixed} 个会话`,
    '',
    ...log,
    '',
    '**请重启 DSH 使改动生效。**',
    `备份位置：${bkDir}`
  ].join('\n'))
}

function cryptoRandomId () {
  try {
    return globalThis.crypto?.randomUUID?.() || `ws-${Date.now()}-${Math.random().toString(16).slice(2)}`
  } catch {
    return `ws-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

/** /migrate status */
async function doStatus (home) {
  const { groups, works } = scanStructure(home)
  const lines = ['当前分组结构：', '']
  for (const g of groups) {
    lines.push(`◆ ${g.title}`)
    lines.push(`    ${g.path}`)
    for (const w of works.filter(x => x.groupTitle === g.title)) {
      lines.push(`    └ ${w.title}  (${w.sessionIds.length} 会话)`)
    }
    lines.push('')
  }
  const loose = works.filter(w => !w.groupTitle)
  if (loose.length) {
    lines.push('未归入分组：')
    for (const w of loose) lines.push(`  · ${w.title}  (${w.sessionIds.length} 会话)  ${w.path}`)
  }
  return ok(lines.join('\n'))
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/**
 * 桥接目录：Client 写请求文件，Host 轮询处理并写响应。
 *
 * 为什么用文件而不是 RPC：
 *   Client 与 Host 之间的 typert Remote 需要额外的代码生成，
 *   第三方插件用文件桥接最稳，DSH 升级也不会碎。
 */
function bridgeDir (home) {
  return path.join(home, 'storages', 'work-migrator', 'bridge')
}

function writeJsonFile (f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const tmp = f + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  fs.renameSync(tmp, f)
}

function readJsonFile (f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null }
}

/** 处理一个桥接请求 */
async function handleBridge (req, home) {
  const tool = req.tool
  const p = req.payload || {}
  try {
    if (tool === 'localState') {
      const { groups, works } = scanStructure(home)
      return { ok: true, data: { home, groups, workspaces: works } }
    }
    if (tool === 'inspectPack') {
      if (!p.packFile || !fs.existsSync(p.packFile)) return { ok: false, error: '找不到包：' + (p.packFile || '(空)') }
      const entries = zipRead(p.packFile)
      const mf = entries.find(e => e.name === 'manifest.json')
      if (!mf) return { ok: false, error: '包内缺少 manifest.json' }
      const manifest = JSON.parse(mf.read().toString('utf8'))
      // 兼容旧包：早期 manifest 只有 title，没有 name
      for (const w of manifest.works || []) {
        if (!w.name) w.name = w.title || String(w.rel || '').split(/[\\/]/).pop() || '(未命名)'
      }
      return { ok: true, data: manifest }
    }
    if (tool === 'doExport') {
      return await doExportSelected(home, p)
    }
    if (tool === 'doImport') {
      return await doImportStructured(home, p)
    }
    return { ok: false, error: '未知工具: ' + tool }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  }
}

/** 把界面参数拼成 doExport 的命令行字符串 */
function buildExportArgs (p) {
  const paths = Array.isArray(p.paths) ? p.paths : []
  const out = String(p.outFile || '').trim()
  // 命令行形态：只有目标路径 + 可选的工作名。
  // 这里不负责「导出哪些工作」——那一步由 handleBridge 直接按路径筛选，
  // 避免把多个绝对路径塞进一行文本里。
  return out
}

/**
 * 导出指定的工作（界面直调，不走命令行文本）。
 *
 * @param {string} home
 * @param {object} p { paths: string[], outFile: string }
 */
async function doExportSelected (home, p) {
  const picked = Array.isArray(p.paths) ? p.paths.filter(Boolean) : []
  const outRaw = String(p.outFile || '').trim().replace(/^["']|["']$/g, '')
  if (!picked.length) return { kind: 'error', text: '没有选择要导出的工作' }
  if (!outRaw) return { kind: 'error', text: '没有指定输出文件' }

  // 必须绝对路径：相对路径会被拼到 DSH 的进程工作目录下
  const outFile = path.isAbsolute(outRaw) ? outRaw : path.resolve(home, outRaw)

  const { groups, works } = scanStructure(home)
  const norm = q => String(q).replace(/[\\/]+$/, '').toLowerCase()
  const targets = works.filter(w => picked.some(q => norm(q) === norm(w.path)))
  if (!targets.length) return { kind: 'error', text: '选中的工作不在当前工作区列表里' }

  const sessionsRoot = path.join(home, 'sessions')

  // 公共父目录：manifest 里记录相对路径用
  const exportRoot = (() => {
    const dirs = targets.map(t => path.dirname(t.path))
    let common = dirs[0]
    for (const d of dirs.slice(1)) {
      while (common.length > 3 && !norm(d).startsWith(norm(common) + '\\')) {
        common = path.dirname(common)
      }
    }
    return common
  })()

  const entries = []
  const manifest = {
    format: 'dsh-work-pack',
    version: 1,
    createdAt: new Date().toISOString(),
    exportRoot,
    groups: groups.map(g => ({ title: g.title, path: g.path, rel: path.relative(exportRoot, g.path) || '.' })),
    works: []
  }

  // 不把文件读进内存：entries 里存的是「来源路径」或「小块数据」，
  // zipWrite 逐条流式落盘。这样 2 GB 以上的包也不会爆内存。
  let fileCount = 0
  for (const w of targets) {
    const rel = path.relative(exportRoot, w.path)
    const rec = {
      // name 与 title 同值：界面按 name 索引，兼容两种写法
      name: w.title,
      title: w.title,
      path: w.path,
      rel,
      group: w.groupTitle,
      groupRel: w.groupPath ? path.relative(exportRoot, w.groupPath) : null,
      sessions: []
    }

    if (fs.existsSync(w.path)) {
      for (const f of collectFiles(w.path)) {
        const inner = path.relative(w.path, f)
        entries.push({
          name: `works/${rel.split(path.sep).join('/')}/${inner.split(path.sep).join('/')}`,
          file: f
        })
        fileCount++
      }
    }

    for (const sid of w.sessionIds) {
      const found = findLog(sessionsRoot, sid)
      if (!found) continue
      const raw = fs.readFileSync(found.log)
      if (!validateFrames(raw).ok) continue
      entries.push({ name: `sessions/${sid}.jsonl.zstd`, data: raw })
      rec.sessions.push({ sessionId: sid, projectName: found.project })
      fileCount++
    }

    manifest.works.push(rec)
  }

  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') })

  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  zipWrite(entries, outFile)

  const size = fs.statSync(outFile).size
  return {
    kind: 'success',
    text: [
      `已导出 ${targets.length} 个工作、${fileCount} 个文件`,
      `输出：${outFile}`,
      `大小：${(size / 1024 / 1024).toFixed(1)} MB`,
      '',
      '目录结构：',
      ...targets.map(w => `  ${w.groupTitle ? w.groupTitle + ' / ' : ''}${w.title}  (${w.sessionIds.length} 会话)`)
    ].join('\n')
  }
}

/**
 * 导入（界面直调，结构化参数，不走命令行文本）。
 *
 * ⚠️ 为什么不用命令行字符串：
 *   路径里常有空格（"Harness Record Export File"），
 *   拼成 `"名=路径"` 再按空格切分会把路径拆碎。
 *
 * @param {string} home
 * @param {object} p { packFile, assignments: [{ workName, targetPath, isOriginal, createGroup }] }
 */
async function doImportStructured (home, p) {
  const packFile = String(p.packFile || '').trim().replace(/^["']|["']$/g, '')
  const assignments = Array.isArray(p.assignments) ? p.assignments : []
  const steps = []
  const say = (s) => { steps.push(s) }

  if (!packFile) return err('没有指定包路径')
  if (!fs.existsSync(packFile)) return err('找不到包：' + packFile)
  if (!assignments.length) return err('没有指定任何工作的归属')

  // ---- 1. 读包 ----
  const entries = zipRead(packFile)
  const mf = entries.find(e => e.name === 'manifest.json')
  if (!mf) return err('包内缺少 manifest.json')
  const manifest = JSON.parse(mf.read().toString('utf8'))
  const packWorks = manifest.works || []
  say(`包内工作 ${packWorks.length} 个`)

  // ---- 2. 计算安置方案 ----
  const norm = q => String(q).replace(/[\\/]+$/, '').toLowerCase()
  const placements = []
  for (const a of assignments) {
    const w = packWorks.find(x => (x.name || x.title) === a.workName || x.title === a.workName)
    if (!w) { say(`  ! 包里找不到「${a.workName}」，跳过`); continue }
    let target = String(a.targetPath || '').trim()
    if (!target) {
      // 没给目标：用包内原始位置
      target = path.join(manifest.exportRoot || '', w.rel || '')
    }
    target = path.resolve(target)
    placements.push({ work: w, target, createGroup: a.createGroup || null })
  }
  if (!placements.length) return err('没有可导入的工作\n' + steps.join('\n'))

  // ---- 3. 冲突预检 ----
  const sessionsRoot = path.join(home, 'sessions')
  const dirConflicts = []
  const sessionConflicts = []
  for (const pl of placements) {
    if (fs.existsSync(pl.target)) dirConflicts.push(pl.target)
    for (const s of pl.work.sessions || []) {
      const found = findLog(sessionsRoot, s.sessionId)
      if (found) sessionConflicts.push({ id: s.sessionId, where: found.project })
    }
  }
  if (dirConflicts.length || sessionConflicts.length) {
    const lines = ['导入被拒绝：目标位置已存在内容，本工具绝不覆盖。', '']
    if (dirConflicts.length) {
      lines.push('【目录已存在】')
      for (const d of dirConflicts) lines.push('  ' + d)
      lines.push('')
    }
    if (sessionConflicts.length) {
      lines.push('【会话已存在】')
      for (const s of sessionConflicts) lines.push(`  ${s.id}  (位于 ${s.where})`)
      lines.push('')
    }
    lines.push('处理办法：')
    lines.push('  · 换一个目标位置（导入时选「新建分组」或别的分组）')
    lines.push('  · 或者先删除旧的同名工作，再重新导入')
    return err(lines.join('\n'))
  }
  say('冲突检查通过')

  // ---- 4. 备份 ----
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const bkDir = path.join(home, 'storages', 'work-migrator', 'backup-' + stamp)
  try {
    fs.mkdirSync(bkDir, { recursive: true })
    const wsDoc = path.join(home, 'storages', 'workspace.json')
    if (fs.existsSync(wsDoc)) fs.copyFileSync(wsDoc, path.join(bkDir, 'workspace.json'))
    for (const pl of placements) {
      for (const s of pl.work.sessions || []) {
        const found = findLog(sessionsRoot, s.sessionId)
        if (!found) continue
        const dst = path.join(bkDir, 'logs', s.sessionId + '.zstd')
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.copyFileSync(found.log, dst)
      }
    }
    say('已备份到 ' + bkDir)
  } catch (e) {
    return err('备份失败，已中止：' + e.message)
  }

  // ---- 5. 释放文件 + 会话 + 登记 ----
  const wsPath = path.join(home, 'storages', 'workspace.json')
  const doc = readJson(wsPath)
  if (!doc) return err('读不到 workspace.json')
  if (!doc.tables) doc.tables = {}
  if (!doc.tables.workspaces) doc.tables.workspaces = {}

  let doneWorks = 0
  let doneSessions = 0

  for (const pl of placements) {
    const w = pl.work
    const target = pl.target

    // 5.1 建目标目录（分组目录一并创建）
    fs.mkdirSync(target, { recursive: true })

    // 5.2 释放工作文件
    const rel = String(w.rel || '').split(path.sep).join('/')
    const prefix = `works/${rel}/`
    let files = 0
    for (const e of entries) {
      if (!e.name.startsWith(prefix)) continue
      const inner = e.name.slice(prefix.length)
      if (!inner || inner.endsWith('/')) continue
      const outPath = path.join(target, ...inner.split('/'))
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      fs.writeFileSync(outPath, e.read())
      files++
    }
    // 有些包的路径前缀可能不带 works/
    if (files === 0) {
      const altPrefix = `works/${rel}/`
      for (const e of entries) {
        if (e.name === 'manifest.json') continue
        if (!e.name.startsWith('works/')) continue
        if (!e.name.startsWith(altPrefix)) continue
        const inner = e.name.slice(altPrefix.length)
        const outPath = path.join(target, ...inner.split('/'))
        fs.mkdirSync(path.dirname(outPath), { recursive: true })
        fs.writeFileSync(outPath, e.read())
        files++
      }
    }
    say(`  ✓ ${w.name || w.title} → ${target}  (${files} 文件)`)

    // 5.3 会话：写日志（改 cwd）+ 移到新项目目录
    const newKey = projectKey(target)
    const sessionIds = []
    for (const s of w.sessions || []) {
      const src = entries.find(e => e.name === `sessions/${s.sessionId}.jsonl.zstd`)
      if (!src) continue
      const raw = src.read()
      const chk = validateFrames(raw)
      if (!chk.ok) { say(`    ! ${s.sessionId.slice(0, 16)} 帧结构不合规，跳过：${chk.problems.join(';')}`); continue }

      const lines = decompressAll(raw).text.split('\n').filter(l => l !== '')
      const header = JSON.parse(lines[0])
      header.cwd = target
      const outBuf = compressFrames([JSON.stringify(header), ...lines.slice(1)])

      const newDir = path.join(sessionsRoot, newKey)
      fs.mkdirSync(newDir, { recursive: true })
      const dest = path.join(newDir, s.sessionId)
      const found = findLog(sessionsRoot, s.sessionId)
      if (found && norm(found.dir) !== norm(dest)) {
        // 不永久删除：移进本次备份
        try {
          const oldToBk = path.join(bkDir, 'old-session-dirs', s.sessionId)
          fs.mkdirSync(path.dirname(oldToBk), { recursive: true })
          fs.renameSync(found.dir, oldToBk)
        } catch { /* 移不动就留着 */ }
      }
      fs.mkdirSync(dest, { recursive: true })
      fs.writeFileSync(path.join(dest, detectLogName(found)), outBuf)
      sessionIds.push(s.sessionId)
      doneSessions++
    }

    // 5.4 更新 workspace.json 登记
    let hitId = null
    for (const [id, e] of Object.entries(doc.tables.workspaces)) {
      if (norm(e.path) === norm(target)) { hitId = id; break }
    }
    const title = w.name || w.title || path.basename(target)
    if (hitId) {
      doc.tables.workspaces[hitId].path = target
      doc.tables.workspaces[hitId].sessionIds = sessionIds
      doc.tables.workspaces[hitId].updatedAt = new Date().toISOString()
    } else {
      const id = randomId()
      doc.tables.workspaces[id] = {
        path: target,
        title,
        sessionIds,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
      if (!doc.global) doc.global = {}
      if (!Array.isArray(doc.global.workspaceIds)) doc.global.workspaceIds = []
      doc.global.workspaceIds.push(id)
    }
    doneWorks++
  }

  writeJson(wsPath, doc)
  say('已更新工作区登记')

  // ---- 6. 分组目录登记（让新建的分组出现在侧边栏）----
  try {
    const groupDirs = new Set()
    for (const pl of placements) {
      if (!pl.createGroup) continue
      const gdir = path.join(pl.createGroup.parent, pl.createGroup.title)
      groupDirs.add(gdir)
    }
    for (const gdir of groupDirs) {
      if (!fs.existsSync(gdir)) continue
      const exists = Object.values(doc.tables.workspaces).some(e => norm(e.path) === norm(gdir))
      if (exists) continue
      const id = randomId()
      doc.tables.workspaces[id] = {
        path: gdir,
        title: path.basename(gdir),
        sessionIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
      if (!doc.global) doc.global = {}
      if (!Array.isArray(doc.global.workspaceIds)) doc.global.workspaceIds = []
      doc.global.workspaceIds.push(id)
    }
    writeJson(wsPath, doc)
  } catch { /* 分组登记失败不影响主流程 */ }

  return ok([
    `导入完成：${doneWorks} 个工作，${doneSessions} 个会话`,
    '',
    ...steps,
    '',
    '**请重启 DSH 使工作区与对话生效。**',
    `备份：${bkDir}`
  ].join('\n'))
}

/** 尽量沿用原日志文件名（session.vN.jsonl.zstd） */
function detectLogName (found) {
  try {
    if (found && found.log) return path.basename(found.log)
  } catch { /* 忽略 */ }
  return 'session.v4.jsonl.zstd'
}

function randomId () {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch { /* 忽略 */ }
  return 'ws-' + Date.now() + '-' + Math.random().toString(16).slice(2)
}

/** 把界面参数拼成 doImport 的命令行字符串 */
function buildImportArgs (p) {
  const pack = String(p.packFile || '').trim().replace(/^["']|["']$/g, '')
  const items = Array.isArray(p.assignments) ? p.assignments : []
  if (!items.length) return `"${pack}"`
  // 全部保持原分组 → 还原
  if (items.every(a => a.isOriginal)) return `"${pack}" 还原`
  // 全部同一个目标目录 → 平铺
  const dirs = [...new Set(items.map(a => path.dirname(a.targetPath)))]
  if (dirs.length === 1 && !items.some(a => a.createGroup)) return `"${pack}" 平铺 "${dirs[0]}"`
  // 按分组
  const parts = []
  const seen = new Set()
  for (const a of items) {
    const groupName = a.createGroup ? a.createGroup.title : (a.groupName || '其他')
    const dir = a.createGroup ? path.join(a.createGroup.parent, a.createGroup.title) : path.dirname(a.targetPath)
    const key = groupName + '|' + dir
    if (seen.has(key)) continue
    seen.add(key)
    parts.push(`"${groupName}=${dir}"`)
  }
  return `"${pack}" 分组 ${parts.join(' ')}`
}

/** 轮询桥接目录 */
async function pumpBridge (home) {
  const dir = bridgeDir(home)
  if (!fs.existsSync(dir)) return
  let files
  try { files = fs.readdirSync(dir) } catch { return }
  for (const f of files) {
    if (!f.startsWith('req-') || !f.endsWith('.json')) continue
    const id = f.slice(4, -5)
    const reqFile = path.join(dir, f)
    const resFile = path.join(dir, `res-${id}.json`)
    if (fs.existsSync(resFile)) continue
    const req = readJsonFile(reqFile)
    if (!req) { writeJsonFile(resFile, { ok: false, error: '请求文件无法解析' }); continue }
    const res = await handleBridge(req, home)
    writeJsonFile(resFile, { ...res, at: Date.now() })
    try { fs.rmSync(reqFile, { force: true }) } catch { /* 忽略 */ }
  }
}

/** 清理旧的响应文件 */
function cleanBridge (home) {
  const dir = bridgeDir(home)
  if (!fs.existsSync(dir)) return
  const now = Date.now()
  try {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f)
      try {
        const st = fs.statSync(full)
        if (now - st.mtimeMs > 10 * 60 * 1000) fs.rmSync(full, { force: true })
      } catch { /* 忽略 */ }
    }
  } catch { /* 忽略 */ }
}

export function apply (ctx) {
  const home = dshHome()
  fs.mkdirSync(bridgeDir(home), { recursive: true })

  // ---- 桥接命令：Client 通过 ctx.remote.commands.execute 调用 ----
  // 调用形如：/dshmig-bridge {"tool":"localState","payload":{}}
  // 结果以 JSON 文本返回。
  ctx.commands.register({
    name: 'dshmig-bridge',
    description: '内部：工作迁移的界面桥接',
    hidden: true,
    handler: async (invocation) => {
      const raw = String(invocation.rawInput || '').trim()

      // 诊断日志：记录 DSH 实际传进来的原始参数
      try {
        const logFile = path.join(dshHome(), 'storages', 'work-migrator', 'bridge-debug.log')
        fs.mkdirSync(path.dirname(logFile), { recursive: true })
        fs.appendFileSync(logFile, [
          new Date().toISOString(),
          '  rawLen=' + raw.length,
          '  raw=[' + raw.slice(0, 200) + ']',
          '  safe=' + /^[A-Za-z0-9_-]+$/.test(raw)
        ].join('') + '\n', 'utf8')
      } catch { /* 忽略 */ }

      let args
      try {
        // 参数是 base64url 编码的 JSON；也兼容纯 JSON 形式。
        // base64url 只含 A-Za-z0-9-_，不会碰到空格、+、/ 导致的损坏。
        let text
        if (/^[A-Za-z0-9_-]+$/.test(raw)) {
          // 还原成标准 base64 再解码
          const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
          const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
          text = Buffer.from(b64 + pad, 'base64').toString('utf8')
        } else {
          text = raw
        }
        args = JSON.parse(text || '{}')
      } catch (e) {
        return { kind: 'error', text: JSON.stringify({ ok: false, error: '参数解析失败：' + e.message + '｜收到 ' + raw.length + ' 字符，开头：' + raw.slice(0, 30) }) }
      }
      let res
      try {
        res = await handleBridge(args, home)
      } catch (e) {
        res = { ok: false, error: String(e && e.message ? e.message : e) }
      }
      // 统一输出：一律包成 { ok, data } 或 { ok:false, error } 的 JSON 文本。
      // handleBridge 的三种返回：
      //   { ok:true, data:{...} }          → localState / inspectPack
      //   { kind:'success', text:'...' }   → doExport / doImport
      //   { kind:'error', text:'...' }     → 失败
      let payload
      if (res && res.kind === 'success') payload = { ok: true, data: { text: res.text } }
      else if (res && res.kind === 'error') payload = { ok: false, error: res.text }
      else if (res && res.ok === true) payload = { ok: true, data: res.data }
      else payload = { ok: false, error: (res && res.error) || '未知错误' }
      return { kind: 'success', text: JSON.stringify(payload) }
    }
  })


  // 轮询：Client 写请求 → Host 执行 → 写响应
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    pumpBridge(home)
      .catch(() => {})
      .finally(() => { running = false })
  }, 500)
  ctx.effect(() => () => clearInterval(timer), 'work-migrator: bridge poll')

  // 定期清理旧文件
  const gcTimer = setInterval(() => cleanBridge(home), 5 * 60 * 1000)
  ctx.effect(() => () => clearInterval(gcTimer), 'work-migrator: bridge gc')

  ctx.commands.register({
    name: 'dshmig-export',
    description: '导出开发工作（代码 + 数据 + 对话记录 + 目录结构）',
    usage: '/dshmig-export [输出路径 | 工作名]',
    handler: async (invocation) => {
      try {
        return await doExport(home, invocation.rawInput || '')
      } catch (e) {
        return err('导出失败：' + (e && e.message ? e.message : String(e)))
      }
    }
  })

  ctx.commands.register({
    name: 'dshmig-import',
    description: '导入开发工作并按目录结构还原或重建',
    usage: '/dshmig-import <包路径> [还原|平铺 <目录>|分组 <名>=<目录> ...]',
    handler: async (invocation) => {
      try {
        return await doImport(home, invocation.rawInput || '')
      } catch (e) {
        return err('导入失败：' + (e && e.message ? e.message : String(e)))
      }
    }
  })

  ctx.commands.register({
    name: 'dshmig',
    description: '工作迁移：查看当前分组结构',
    usage: '/dshmig status',
    handler: async (invocation) => {
      const sub = (invocation.rawInput || '').trim()
      if (sub === 'status' || sub === '') return doStatus(home)
      return err(USAGE)
    }
  })

  ctx.effect(() => {
    ctx.logger?.info?.('dsh-work-migrator ready; home=%s', home)
    return () => {}
  }, 'work-migrator: mount')
}
