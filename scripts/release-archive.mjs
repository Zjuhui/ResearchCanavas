import { deflateRawSync, inflateRawSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 0xff] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}
function checkedName(value) {
  if (!value || value.includes('\\') || value.startsWith('/') || value.split('/').some(part => part === '..') || /^[a-z]:/i.test(value)) throw new Error(`Unsafe archive member: ${value}`);
  return value;
}
// Fixed DOS timestamps, sorted paths and level-9 compression make release bytes
// independent of checkout locations and filesystem modification times.
export function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  const unique = new Set();
  for (const entry of [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const name = Buffer.from(checkedName(entry.name));
    if (unique.has(entry.name)) throw new Error(`Duplicate archive member: ${entry.name}`);
    unique.add(entry.name);
    const data = Buffer.from(entry.data), compressed = deflateRawSync(data, { level: 9 }), checksum = crc32(data);
    if (data.length > 0xffffffff || offset > 0xffffffff || name.length > 65535) throw new Error('Release exceeds ZIP32 limits');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50, 0); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6); index.writeUInt16LE(0x800, 8); index.writeUInt16LE(8, 10); index.writeUInt16LE(33, 14);
    index.writeUInt32LE(checksum, 16); index.writeUInt32LE(compressed.length, 20); index.writeUInt32LE(data.length, 24); index.writeUInt16LE(name.length, 28); index.writeUInt32LE(offset, 42);
    central.push(index, name); offset += header.length + name.length + compressed.length;
  }
  if (entries.length > 65535) throw new Error('Release has too many members');
  const centralBytes = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

export function unzip(data) {
  let end = data.length - 22;
  while (end >= Math.max(0, data.length - 65557) && data.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || data.readUInt32LE(end) !== 0x06054b50) throw new Error('Invalid ZIP end record');
  const count = data.readUInt16LE(end + 10), entries = [];
  let index = data.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (data.readUInt32LE(index) !== 0x02014b50) throw new Error('Invalid ZIP central directory');
    const method = data.readUInt16LE(index + 10), size = data.readUInt32LE(index + 20), length = data.readUInt32LE(index + 24), nameLength = data.readUInt16LE(index + 28), extra = data.readUInt16LE(index + 30), comment = data.readUInt16LE(index + 32), offset = data.readUInt32LE(index + 42);
    const name = checkedName(data.subarray(index + 46, index + 46 + nameLength).toString('utf8'));
    if (data.readUInt32LE(offset) !== 0x04034b50) throw new Error('Invalid ZIP local header');
    const start = offset + 30 + data.readUInt16LE(offset + 26) + data.readUInt16LE(offset + 28), packed = data.subarray(start, start + size);
    const content = method === 8 ? inflateRawSync(packed) : method === 0 ? Buffer.from(packed) : undefined;
    if (!content || content.length !== length || crc32(content) !== data.readUInt32LE(index + 16)) throw new Error(`ZIP checksum mismatch: ${name}`);
    if (!name.endsWith('/')) entries.push({ name, data: content });
    index += 46 + nameLength + extra + comment;
  }
  return entries;
}
