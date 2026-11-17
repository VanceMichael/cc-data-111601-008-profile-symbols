// 生成合成 pprof 夹具（公开约定的子集）。运行：node scripts/make-fixtures.mjs
// 输出确定性字节，不访问网络，不读取任何外部资料。
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const encodeVarint = value => {
  let n = BigInt(value);
  if (n < 0n) n += 1n << 64n; // int64 负数按二进制补码编码
  const out = [];
  do {
    let byte = Number(n & 127n);
    n >>= 7n;
    if (n) byte |= 128;
    out.push(byte);
  } while (n);
  return Buffer.from(out);
};
const tag = (field, wire) => Buffer.concat([encodeVarint((BigInt(field) << 3n) | BigInt(wire))]);
const varintField = (field, value) => Buffer.concat([tag(field, 0), encodeVarint(value)]);
const bytesField = (field, bytes) => Buffer.concat([tag(field, 2), encodeVarint(bytes.length), bytes]);
const stringField = (field, value) => bytesField(field, Buffer.from(value, 'utf8'));
const packedField = (field, values) => {
  if (!values.length) return Buffer.alloc(0);
  return bytesField(field, Buffer.concat(values.map(encodeVarint)));
};
const message = (field, chunks) => bytesField(field, Buffer.concat(chunks.filter(Boolean)));

// string table:
// 0 "" 1 libmovement.so 2 libmovement-copy.so 3 build-A 4 build-B
// 5 worker 6 nanos 7 cycles 8 samples 9 count 10 index 11 slot
function buildMixed() {
  const strings = ['', 'libmovement.so', 'libmovement-copy.so', 'build-A', 'build-B',
    'worker', 'nanos', 'cycles', 'samples', 'count', 'index', 'slot'];
  const sampleType = (type, unit) => message(1, [varintField(1, type), varintField(2, unit)]);
  const mapping = ({ id, start, limit, offset, filename, buildId }) => message(3, [
    varintField(1, id), varintField(2, start), varintField(3, limit), varintField(4, offset),
    varintField(5, filename), varintField(6, buildId)
  ]);
  const location = ({ id, mappingId, address }) => message(4, [
    varintField(1, id), varintField(2, mappingId), varintField(3, address)
  ]);
  const labelString = (key, str) => message(3, [varintField(1, key), varintField(2, str)]);
  const labelNumber = (key, num, unit) => message(3, [
    varintField(1, key), varintField(3, num), varintField(4, unit)
  ]);
  const sample = ({ locationIds, values, labels }) => message(2, [
    packedField(1, locationIds), packedField(2, values), ...labels
  ]);
  return Buffer.concat([
    sampleType(8, 9), sampleType(6, 7),
    mapping({ id: 1, start: 4096n, limit: 8192n, offset: 0n, filename: 1, buildId: 3 }),
    mapping({ id: 2, start: 8192n, limit: 12288n, offset: 0n, filename: 1, buildId: 4 }),
    mapping({ id: 3, start: 16384n, limit: 20480n, offset: 4096n, filename: 2, buildId: 3 }),
    // 对象地址 32：build-A 有符号（含内联链）
    location({ id: 1, mappingId: 1, address: 4128n }),
    // 对象地址 48：build-A 明确 missing
    location({ id: 2, mappingId: 1, address: 4144n }),
    // 重定位映射：16896-16384+4096=4608，build-A 不提供 -> 部分未覆盖
    location({ id: 3, mappingId: 3, address: 16896n }),
    // build-B 的对象地址 32，与 build-A 同名库同对象地址，须按 buildId 区分
    location({ id: 4, mappingId: 2, address: 8224n }),
    // 落在映射区间之外，不应产生符号请求
    location({ id: 5, mappingId: 1, address: 9000n }),
    sample({ locationIds: [1n, 2n], values: [3n, 9000000000000000001n], labels: [labelString(5, 11)] }),
    sample({ locationIds: [3n, 4n, 5n], values: [-7n, 42n],
      labels: [labelString(5, 11), labelNumber(10, 17n, 6)] }),
    ...strings.map(value => stringField(6, value))
  ]);
}

const bytes = buildMixed();
await writeFile(join(root, 'fixtures', 'resource-04.bin'), bytes);
console.log(`resource-04.bin ${bytes.length} bytes sha via npm test`);
