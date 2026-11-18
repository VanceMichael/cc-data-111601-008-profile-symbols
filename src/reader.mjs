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
    mappings: nested(3), locations: nested(4), samples: nested(2), sampleTypes: nested(1),
    profile: decodeProfile(bytes) };
}

const SIGN = 1n << 63n;
const WRAP = 1n << 64n;
function signed(value) {
  return value >= SIGN ? value - WRAP : value;
}
function message(field, name) {
  if (field.wire !== 2) throw new Error(`profile_${name}_wire`);
  return fields(field.bytes);
}
function values(field) {
  if (field.wire === 0) return [BigInt(field.value)];
  if (field.wire !== 2) throw new Error('profile_integer_wire');
  const result = [];
  let offset = 0;
  while (offset < field.bytes.length) {
    const read = varint(field.bytes, offset);
    offset = read.offset;
    result.push(read.value);
  }
  return result;
}
function all(decoded, number, packed = false) {
  return decoded.filter(field => field.number === number)
    .flatMap(field => packed ? values(field) : [field.wire === 0 ? BigInt(field.value) : null])
    .filter(value => value !== null);
}
function first(decoded, number) {
  return all(decoded, number)[0];
}
function index(value) {
  if (value === undefined) return undefined;
  const converted = Number(signed(value));
  return Number.isSafeInteger(converted) ? converted : undefined;
}
function text(strings, value) {
  const position = index(value);
  if (position === undefined) return undefined;
  if (position < 0 || position >= strings.length) throw new Error('profile_string_index');
  return strings[position];
}
function numberValue(value) {
  if (value === undefined) return undefined;
  const converted = signed(value);
  return converted >= BigInt(Number.MIN_SAFE_INTEGER) && converted <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(converted) : converted.toString();
}
function truth(decoded, number) {
  const value = first(decoded, number);
  return value !== undefined && value !== 0n;
}

// Structurally decode the pprof subset used by the exchange. 64-bit quantities
// stay exact as decimal strings; rows, order and repeated fields are never
// collapsed.
export function decodeProfile(bytes) {
  if (!bytes.length) throw new Error('profile_empty');
  const decoded = fields(bytes);
  const strings = decoded.filter(field => field.number === 6)
    .map(field => field.wire === 2 ? field.bytes.toString('utf8') : '');
  const sampleTypes = decoded.filter(field => field.number === 1).map(field => {
    const values = message(field, 'sample_type');
    return { type: text(strings, first(values, 1)), unit: text(strings, first(values, 2)) };
  });
  const functions = decoded.filter(field => field.number === 5).map(field => {
    const values = message(field, 'function');
    return {
      id: first(values, 1)?.toString(), name: text(strings, first(values, 2)),
      systemName: text(strings, first(values, 3)), filename: text(strings, first(values, 4)),
      startLine: numberValue(first(values, 5))
    };
  });
  const functionById = new Map(functions.map(fn => [fn.id, fn]));
  const mappings = decoded.filter(field => field.number === 3).map(field => {
    const values = message(field, 'mapping');
    const id = first(values, 1);
    const buildId = text(strings, first(values, 6));
    return {
      id: id?.toString(), memoryStart: first(values, 2)?.toString() ?? '0',
      memoryLimit: first(values, 3)?.toString() ?? '0', fileOffset: first(values, 4)?.toString() ?? '0',
      file: text(strings, first(values, 5)), buildId,
      hasFunctions: truth(values, 7), hasFilenames: truth(values, 8),
      hasLineNumbers: truth(values, 9), hasInlineFrames: truth(values, 10)
    };
  });
  const locations = decoded.filter(field => field.number === 4).map(field => {
    const values = message(field, 'location');
    const lines = values.filter(item => item.number === 4).map(item => {
      const line = message(item, 'line');
      const functionId = first(line, 1)?.toString();
      const fn = functionById.get(functionId);
      return {
        functionId, line: numberValue(first(line, 2)),
        ...(fn?.name === undefined ? {} : { function: fn.name }),
        ...(fn?.filename === undefined ? {} : { file: fn.filename })
      };
    });
    return {
      id: first(values, 1)?.toString(), mappingId: first(values, 2)?.toString() ?? '0',
      address: first(values, 3)?.toString() ?? '0', lines, isFolded: truth(values, 5)
    };
  });
  const samples = decoded.filter(field => field.number === 2).map(field => {
    const values = message(field, 'sample');
    const labels = values.filter(item => item.number === 3).map(item => {
      const label = message(item, 'label');
      const result = { key: text(strings, first(label, 1)) };
      const strIndex = first(label, 2);
      const num = first(label, 3);
      const unitIndex = first(label, 4);
      if (strIndex !== undefined) result.str = text(strings, strIndex);
      if (num !== undefined) result.num = numberValue(num);
      if (unitIndex !== undefined) result.numUnit = text(strings, unitIndex);
      return result;
    });
    return {
      locationIds: all(values, 1, true).map(value => value.toString()),
      values: all(values, 2, true).map(value => signed(value).toString()), labels
    };
  });
  const periodType = decoded.find(field => field.number === 11);
  const period = periodType ? message(periodType, 'period_type') : undefined;
  return {
    strings, sampleTypes, samples, mappings, locations, functions,
    timeNanos: first(decoded, 9)?.toString(), durationNanos: first(decoded, 10)?.toString(),
    ...(period === undefined ? {} : {
      periodType: { type: text(strings, first(period, 1)), unit: text(strings, first(period, 2)) }
    }),
    period: first(decoded, 12)?.toString(),
    comments: all(decoded, 13, true).map(value => text(strings, value)),
    defaultSampleType: text(strings, first(decoded, 14))
  };
}
