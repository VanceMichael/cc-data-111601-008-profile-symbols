import { varint, fields } from './reader.mjs';

// profile.proto 常用子集的结构化解码。
// 64 位整数统一用 BigInt 保存，避免超过 JS 安全整数时丢精度；
// 只解释已声明字段，unknown fields 跳过而不猜测含义。

function entries(bytes) {
  return fields(bytes);
}
function single(rows, number) {
  const found = rows.find(row => row.number === number);
  return found?.wire === 0 ? BigInt(found.value) : null;
}
const U64_LIMIT = 1n << 64n;
const SIGN_BIT = 1n << 63n;
// int64 字段按二进制补码还原符号（sample.value、line 等 pprof 声明为 int64）。
function signed(value) {
  return value >= SIGN_BIT ? value - U64_LIMIT : value;
}
function packed(rows, number) {
  const values = [];
  for (const row of rows) {
    if (row.number !== number) continue;
    if (row.wire === 2) {
      let offset = 0;
      while (offset < row.bytes.length) {
        const read = varint(row.bytes, offset);
        offset = read.offset;
        values.push(signed(read.value));
      }
    } else if (row.wire === 0) {
      values.push(signed(BigInt(row.value)));
    }
  }
  return values;
}
function messages(rows, number) {
  return rows.filter(row => row.number === number && row.wire === 2).map(row => fields(row.bytes));
}
function stringAt(strings, index) {
  if (index === null) return null;
  const at = Number(index);
  if (!Number.isSafeInteger(at) || at < 0 || at >= strings.length) return null;
  return strings[at];
}
function decodeMapping(rows, strings) {
  return {
    id: single(rows, 1),
    memoryStart: single(rows, 2),
    memoryLimit: single(rows, 3),
    fileOffset: single(rows, 4) ?? 0n,
    filename: stringAt(strings, single(rows, 5)),
    buildId: stringAt(strings, single(rows, 6)),
    hasFunctions: single(rows, 7),
    hasFilenames: single(rows, 8),
    hasLineNumbers: single(rows, 9),
    hasInlineFrames: single(rows, 10)
  };
}
function decodeLine(rows) {
  return {
    functionId: single(rows, 1),
    line: single(rows, 2) ?? 0n
  };
}
function decodeLocation(rows) {
  return {
    id: single(rows, 1),
    mappingId: single(rows, 2),
    address: single(rows, 3),
    isFolded: single(rows, 4) ?? 0n,
    lines: messages(rows, 5).map(lineRows => decodeLine(lineRows))
  };
}
function decodeFunction(rows, strings) {
  return {
    id: single(rows, 1),
    name: stringAt(strings, single(rows, 2)),
    systemName: stringAt(strings, single(rows, 3)),
    filename: stringAt(strings, single(rows, 4)),
    startLine: single(rows, 5) ?? 0n
  };
}
function decodeLabel(rows, strings) {
  // pprof Label.num 是 int64，按补码还原符号。
  const numRow = rows.find(row => row.number === 3);
  const num = numRow?.wire === 0 ? signed(BigInt(numRow.value)) : null;
  return {
    key: stringAt(strings, single(rows, 1)),
    str: stringAt(strings, single(rows, 2)),
    num,
    numUnit: stringAt(strings, single(rows, 4))
  };
}
function decodeSample(rows, strings) {
  return {
    locationIds: packed(rows, 1),
    value: packed(rows, 2),
    labels: messages(rows, 3).map(labelRows => decodeLabel(labelRows, strings))
  };
}
function decodeSampleType(rows, strings) {
  return {
    type: stringAt(strings, single(rows, 1)),
    unit: stringAt(strings, single(rows, 2))
  };
}

export function decodeProfile(bytes) {
  if (!bytes.length) throw new Error('profile_empty');
  const top = entries(bytes);
  const strings = top.filter(row => row.number === 6 && row.wire === 2).map(row => row.bytes.toString('utf8'));
  const functions = messages(top, 5).map(rows => decodeFunction(rows, strings));
  const functionById = new Map(functions.map(fn => [fn.id, fn]));
  const locations = messages(top, 4).map(rows => {
    const location = decodeLocation(rows);
    // 函数名通过 Function 表解析；找不到对应 function 时不臆造名称。
    for (const line of location.lines) {
      line.functionName = functionById.get(line.functionId)?.name ?? null;
      line.filename = functionById.get(line.functionId)?.filename ?? null;
    }
    return location;
  });
  return {
    kind: 'pprof-profile',
    sampleTypes: messages(top, 1).map(rows => decodeSampleType(rows, strings)),
    samples: messages(top, 2).map(rows => decodeSample(rows, strings)),
    mappings: messages(top, 3).map(rows => decodeMapping(rows, strings)),
    locations,
    functions,
    strings
  };
}

// 大整数以十进制字符串落入 JSON，避免 JSON.stringify 对 BigInt 抛错。
export function profileToJSON(profile) {
  return JSON.stringify(profile, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
}
// 持久化后的解释文档按字段类型精确还原 BigInt。
export function reviveProfile(plain) {
  const big = value => (value === null || value === undefined ? null : BigInt(value));
  return {
    ...plain,
    sampleTypes: plain.sampleTypes,
    samples: plain.samples.map(sample => ({
      locationIds: sample.locationIds.map(BigInt),
      value: sample.value.map(BigInt),
      labels: sample.labels.map(label => ({ ...label, num: label.num === null ? null : BigInt(label.num) }))
    })),
    mappings: plain.mappings.map(mapping => ({
      ...mapping,
      id: big(mapping.id), memoryStart: big(mapping.memoryStart), memoryLimit: big(mapping.memoryLimit),
      fileOffset: big(mapping.fileOffset), hasFunctions: big(mapping.hasFunctions),
      hasFilenames: big(mapping.hasFilenames), hasLineNumbers: big(mapping.hasLineNumbers),
      hasInlineFrames: big(mapping.hasInlineFrames)
    })),
    locations: plain.locations.map(location => ({
      ...location,
      id: big(location.id), mappingId: big(location.mappingId), address: big(location.address),
      isFolded: big(location.isFolded),
      lines: location.lines.map(line => ({
        ...line, functionId: big(line.functionId), line: big(line.line) }))
    })),
    functions: plain.functions.map(fn => ({ ...fn, id: big(fn.id), startLine: big(fn.startLine) }))
  };
}

// 对象地址 = location.address - mapping.memory_start + mapping.file_offset（左闭右开）。
// 返回 null 表示该位置无法按任何已声明映射解释，不应发出符号请求。
export function objectAddress(location, mapping) {
  if (!mapping || location.address === null || mapping.memoryStart === null) return null;
  if (mapping.memoryLimit !== null && location.address >= mapping.memoryLimit) return null;
  if (location.address < mapping.memoryStart) return null;
  return location.address - mapping.memoryStart + (mapping.fileOffset ?? 0n);
}
