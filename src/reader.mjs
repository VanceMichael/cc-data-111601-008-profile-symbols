export function varint(bytes, offset) {
  let value = 0n; let shift = 0n;
  for (let count = 0; count < 10; count++) {
    if (offset >= bytes.length) throw new Error('protobuf_short_varint');
    const byte = bytes[offset++]; value |= BigInt(byte & 127) << shift;
    if (!(byte & 128)) return { value, offset };
    shift += 7n;
  }
  throw new Error('protobuf_varint_limit');
}
export function fields(bytes) {
  const result = []; let offset = 0;
  while (offset < bytes.length) {
    const key = varint(bytes, offset); offset = key.offset;
    const number = Number(key.value >> 3n); const wire = Number(key.value & 7n);
    if (!number) throw new Error('protobuf_field_zero');
    if (wire === 0) {
      const read = varint(bytes, offset); offset = read.offset; result.push({ number, wire, value: read.value.toString() });
    } else if (wire === 2) {
      const length = varint(bytes, offset); offset = length.offset;
      const end = offset + Number(length.value);
      if (!Number.isSafeInteger(end) || end > bytes.length) throw new Error('protobuf_short_field');
      result.push({ number, wire, bytes: bytes.subarray(offset, end) }); offset = end;
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (offset + size > bytes.length) throw new Error('protobuf_fixed_short');
      result.push({ number, wire, bytes: bytes.subarray(offset, offset + size) }); offset += size;
    } else throw new Error('protobuf_wire_unsupported');
  }
  return result;
}
export function inspect(bytes) {
  if (!bytes.length) throw new Error('profile_empty');
  const decoded = fields(bytes);
  const nested = number => decoded.filter(field => field.number === number).map(field => fields(field.bytes).map(item => ({
    number: item.number, wire: item.wire, value: item.value, data: item.bytes?.toString('base64') })));
  return { kind: 'pprof-tables', strings: decoded.filter(field => field.number === 6).map(field => field.bytes.toString('utf8')),
    mappings: nested(3), locations: nested(4), samples: nested(2), sampleTypes: nested(1) };
}
