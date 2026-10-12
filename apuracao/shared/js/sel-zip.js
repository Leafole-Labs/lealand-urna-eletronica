// Codec ZIP mínimo (entradas STORED, sem compressão), sem dependências.
// Semântica dos magic bytes igual à de urnaemu/src/lib/results/zip.js
// (local 0x04034B50, central 0x02014B50, end 0x06054B50).
// Puro ESM, sem DOM: navegador e node (WebCrypto disponível nos dois).
export const ZIP_SIG_LOCAL = 0x04034b50;
export const ZIP_SIG_CENTRAL = 0x02014b50;
export const ZIP_SIG_END = 0x06054b50;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

export function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}

export function b64decode(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export async function sha256hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha512hex(text) {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-512', typeof text === 'string' ? te.encode(text) : text);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function dosTime(date) {
  const d = date instanceof Date ? date : new Date();
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((Math.floor(d.getSeconds() / 2)) & 31),
    date: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)
  };
}

function u16(v) {
  return Uint8Array.of(v & 0xff, (v >>> 8) & 0xff);
}
function u32(v) {
  return Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** @param {{name:string, data:Uint8Array}[]} entries — nomes ASCII, sem `..` */
export function createZip(entries) {
  for (const e of entries) {
    if (!/^[\x20-\x7e]+$/.test(e.name) || e.name.includes('..') || e.name.startsWith('/')) {
      throw new Error(`Nome inválido no ZIP: ${e.name}`);
    }
  }
  const { time, date } = dosTime(new Date());
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = te.encode(e.name);
    const data = e.data;
    const crc = crc32(data);
    const local = concat([
      u32(ZIP_SIG_LOCAL), u16(20), u16(0x0800), u16(0), u16(time), u16(date),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data
    ]);
    central.push(concat([
      u32(ZIP_SIG_CENTRAL), u16(20), u16(20), u16(0x0800), u16(0), u16(time), u16(date),
      u32(crc), u32(data.length), u32(data.length), u16(name.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name
    ]));
    locals.push(local);
    offset += local.length;
  }
  const centralStart = offset;
  const centralBytes = concat(central);
  const end = concat([
    u32(ZIP_SIG_END), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBytes.length), u32(centralStart), u16(0)
  ]);
  return concat([...locals, centralBytes, end]);
}

function r16(b, o) {
  return b[o] | (b[o + 1] << 8);
}
function r32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/** @returns {{name:string, data:Uint8Array}[]} — aceita somente STORED. */
export function readZip(bytes) {
  const entries = [];
  let at = 0;
  let sawCentral = false;
  while (at + 4 <= bytes.length) {
    const sig = r32(bytes, at);
    if (sig === ZIP_SIG_CENTRAL || sig === ZIP_SIG_END) {
      sawCentral = true;
      break;
    }
    if (sig !== ZIP_SIG_LOCAL) throw new Error('ZIP inválido: assinatura inesperada.');
    if (at + 30 > bytes.length) throw new Error('ZIP inválido: cabeçalho truncado.');
    const flags = r16(bytes, at + 6);
    const method = r16(bytes, at + 8);
    const crc = r32(bytes, at + 14);
    const compSize = r32(bytes, at + 18);
    const nameLen = r16(bytes, at + 26);
    const extraLen = r16(bytes, at + 28);
    if (flags & 0x0001) throw new Error('ZIP inválido: entrada criptografada.');
    if (flags & 0x0008) throw new Error('ZIP inválido: descritor de dados não suportado.');
    if (method !== 0) throw new Error('ZIP inválido: somente entradas sem compressão (STORED).');
    const nameStart = at + 30;
    if (nameStart + nameLen + extraLen + compSize > bytes.length) {
      throw new Error('ZIP inválido: entrada truncada.');
    }
    const name = td.decode(bytes.subarray(nameStart, nameStart + nameLen));
    if (!name || name.includes('..') || name.startsWith('/')) {
      throw new Error(`ZIP inválido: nome proibido (${name || '?'}).`);
    }
    const data = bytes.slice(nameStart + nameLen + extraLen, nameStart + nameLen + extraLen + compSize);
    if (crc32(data) !== crc) throw new Error(`ZIP inválido: CRC de ${name} não confere.`);
    entries.push({ name, data });
    at = nameStart + nameLen + extraLen + compSize;
  }
  if (!entries.length) throw new Error('ZIP inválido: nenhum arquivo.');
  if (!sawCentral) throw new Error('ZIP inválido: diretório central ausente.');
  return entries;
}
