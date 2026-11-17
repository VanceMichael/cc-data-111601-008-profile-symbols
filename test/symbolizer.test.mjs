import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeProfile, objectAddress, reviveProfile, profileToJSON } from '../src/profile.mjs';
import { planRequests, applyResponses, symbolizePass, SYMBOL_BATCH_LIMIT } from '../src/symbolizer.mjs';

const mixed = decodeProfile(await readFile(new URL('../fixtures/resource-04.bin', import.meta.url)));
const primary = decodeProfile(await readFile(new URL('../fixtures/primary.bin', import.meta.url)));
const catalog = { symbolServices: { 'build-A': '/symbols/build-A', 'build-B': '/symbols/build-B' } };
const find = (locations, id) => locations.find(item => item.id === BigInt(id));

test('对象地址按重定位公式精确计算，区间外返回 null', () => {
  const mappingById = new Map(mixed.mappings.map(mapping => [mapping.id, mapping]));
  assert.equal(objectAddress(find(mixed.locations, 1), mappingById.get(1n)).toString(), '32');
  assert.equal(objectAddress(find(mixed.locations, 3), mappingById.get(3n)).toString(), '4608');
  assert.equal(objectAddress(find(mixed.locations, 5), mappingById.get(1n)), null);
});

test('同名库不同 buildId 与相同对象地址必须分开请求', () => {
  const { requests } = planRequests(mixed);
  const buildA = requests.filter(request => request.buildId === 'build-A');
  const buildB = requests.filter(request => request.buildId === 'build-B');
  assert.ok(buildA.length >= 1 && buildB.length === 1);
  assert.deepEqual(buildB[0].addresses.map(value => value.toString()), ['32']);
  // build-A 与 build-B 都有对象地址 32，但路由不同、互不合并
  assert.ok(buildA.some(request => request.addresses.some(address => address.toString() === '32')));
});

test('每批不超过服务上限，去重按 buildId+对象地址', () => {
  assert.equal(SYMBOL_BATCH_LIMIT, 2);
  const { requests } = planRequests(mixed);
  for (const request of requests) assert.ok(request.addresses.length <= SYMBOL_BATCH_LIMIT);
  const all = requests.flatMap(request => request.addresses.map(value => `${request.buildId}:${value}`));
  assert.equal(new Set(all).size, all.length);
});

test('部分覆盖：已声明 missing 与未覆盖位置分别标记且可追溯', () => {
  const plan = planRequests(mixed);
  const exchanges = plan.requests.map(request => ({ request,
    body: { buildId: request.buildId, addresses: {}, missing: request.addresses.map(value => value.toString()) } }));
  // 只让 build-A 的 32 有答案，其余按各场景处理
  exchanges[0] = { request: plan.requests[0], body: {
    buildId: 'build-A',
    addresses: { 32: { lines: [{ function: 'inner', file: 'a.cc', line: 12 }] } },
    missing: ['48'] } };
  const locations = applyResponses(plan, exchanges);
  assert.equal(find(locations, 1).status, 'resolved');
  assert.equal(find(locations, 1).lines[0].functionName, 'inner');
  assert.equal(find(locations, 2).reason, 'symbol_service_missing');
  // 4608 那批被全量声明 missing
  assert.equal(find(locations, 3).reason, 'symbol_service_missing');
  assert.equal(find(locations, 5).reason, 'address_outside_mapping');
});

test('响应未声明 missing 也未给地址时标记 not_covered，而不是当作成功', () => {
  const plan = planRequests(mixed);
  const target = plan.requests.find(request => request.addresses.some(value => value.toString() === '4608'));
  const locations = applyResponses(plan, [{ request: target, body: { buildId: 'build-A', addresses: {}, missing: [] } }]);
  assert.equal(find(locations, 3).status, 'unresolved');
  assert.equal(find(locations, 3).reason, 'symbol_service_not_covered');
});

test('内联链按服务返回顺序保留，多层不重排', async () => {
  const calls = [];
  const fetcher = async (route, addresses) => {
    calls.push([route, addresses.map(value => value.toString())]);
    return { buildId: 'build-A', addresses: {
      32: { lines: [
        { function: 'inner', file: 'a.cc', line: 12 },
        { function: 'outer', file: 'b.cc', line: 20 }] } }, missing: ['48'] };
  };
  const pass = await symbolizePass({ profile: primary, catalog, fetcher });
  const only = find(pass.locations, 1);
  assert.deepEqual(only.lines.map(line => line.functionName), ['inner', 'outer']);
  assert.deepEqual(only.lines.map(line => line.line.toString()), ['12', '20']);
});

test('重补不打散已有内联层次，只追加 pass 记录', async () => {
  const chain = [{ function: 'inner', file: 'a.cc', line: 12 }, { function: 'outer', file: 'b.cc', line: 20 }];
  const fetcher = async (_route, addresses) => ({
    buildId: 'build-A',
    addresses: addresses.some(value => value.toString() === '32') ? { 32: { lines: chain } } : {},
    missing: addresses.filter(value => value.toString() !== '32').map(value => value.toString()) });
  const first = await symbolizePass({ profile: mixed, catalog, fetcher });
  assert.equal(find(first.locations, 1).lines.length, 2);
  // 第二轮服务“改口”也不能覆盖已解释位置；且不会再为它发请求
  const secondFetcher = async (route, addresses) => {
    return { buildId: 'build-A', addresses: { 32: { lines: [{ function: 'tampered' }] } }, missing: [] };
  };
  const second = await symbolizePass({ profile: mixed, catalog, previous: first, fetcher: secondFetcher });
  assert.deepEqual(find(second.locations, 1).lines.map(line => line.functionName), ['inner', 'outer']);
  // 第二轮规划中，已解释的位置 1 不再属于任何请求；build-B 的位置 4 是另一身份，仍可继续补领
  const replanned = planRequests(mixed, first.locations);
  const requestedMembers = replanned.requests.flatMap(request => request.members.map(id => id.toString()));
  assert.ok(!requestedMembers.includes('1'));
  assert.ok(requestedMembers.includes('4'));
});

test('补领全程不合并样本、不改取值与标签，超出安全整数精确表示', async () => {
  const fetcher = async (_route, addresses) => ({ buildId: 'build-A',
    addresses: Object.fromEntries(addresses.map(value => [value.toString(), { lines: [] }])), missing: [] });
  const before = profileToJSON(mixed);
  await symbolizePass({ profile: mixed, catalog, fetcher });
  assert.equal(profileToJSON(mixed), before);
  const values = mixed.samples.map(sample => sample.value.map(value => value.toString()));
  assert.deepEqual(values, [['3', '9000000000000000001'], ['-7', '42']]);
  assert.equal(mixed.samples[0].labels[0].key, 'worker');
  assert.equal(mixed.samples[1].labels[1].num.toString(), '17');
  assert.equal(mixed.sampleTypes.length, 2);
  assert.equal(mixed.samples.length, 2);
});

test('缺少路由、请求失败和 buildId 不匹配都留下可定位原因', async () => {
  const noRoute = await symbolizePass({ profile: primary, catalog: { symbolServices: {} },
    fetcher: async () => { throw new Error('unreachable'); } });
  assert.equal(find(noRoute.locations, 1).reason, 'symbol_route_not_configured');
  const failed = await symbolizePass({ profile: primary, catalog,
    fetcher: async () => { throw new Error('source_status_503'); } });
  assert.equal(find(failed.locations, 1).reason, 'source_status_503');
  const mismatch = await symbolizePass({ profile: primary, catalog,
    fetcher: async () => ({ buildId: 'build-X', addresses: {}, missing: [] }) });
  assert.equal(find(mismatch.locations, 1).reason, 'build_id_mismatch');
});

test('解释文档持久化往返后大整数与内联层次完整', async () => {
  const pass = await symbolizePass({ profile: primary, catalog,
    fetcher: async () => ({ buildId: 'build-A',
      addresses: { 32: { lines: [{ function: 'inner', file: 'a.cc', line: 12 }] } }, missing: [] }) });
  const doc = { profile: primary, locations: pass.locations, passes: [pass], summary: pass.summary };
  const revived = reviveProfile(JSON.parse(profileToJSON(doc)).profile);
  assert.equal(revived.locations[0].address.toString(), '4128');
  assert.equal(revived.samples[0].value[0].toString(), '3');
});

test('同 buildId 同对象地址的多个位置只请求一次并共享答案', async () => {
  // 两个加载地址不同的映射属于同一构建，对象地址同为 32。
  const profile = {
    kind: 'pprof-profile', strings: ['', 'lib.so', 'build-A'], sampleTypes: [], samples: [], functions: [],
    mappings: [
      { id: 1n, memoryStart: 4096n, memoryLimit: 8192n, fileOffset: 0n, filename: 'lib.so', buildId: 'build-A' },
      { id: 2n, memoryStart: 12288n, memoryLimit: 16384n, fileOffset: 0n, filename: 'lib.so', buildId: 'build-A' }
    ],
    locations: [
      { id: 1n, mappingId: 1n, address: 4128n, isFolded: 0n, lines: [] },
      { id: 2n, mappingId: 2n, address: 12320n, isFolded: 0n, lines: [] }
    ]
  };
  const plan = planRequests(profile);
  assert.equal(plan.requests.length, 1);
  assert.deepEqual(plan.requests[0].members.map(id => id.toString()), ['1', '2']);
  const locations = applyResponses(plan, [{ request: plan.requests[0],
    body: { buildId: 'build-A', addresses: { 32: { lines: [{ function: 'shared', file: 'x.cc', line: 1 }] } }, missing: [] } }]);
  assert.deepEqual(locations.map(item => item.lines[0].functionName), ['shared', 'shared']);
});

test('profile 原生已带内联层次的位置不发请求且原样保留', async () => {
  const profile = {
    kind: 'pprof-profile', strings: ['', 'lib.so', 'build-A', 'native', 'n.cc'], sampleTypes: [], samples: [],
    functions: [{ id: 9n, name: 'native', systemName: null, filename: 'n.cc', startLine: 0n }],
    mappings: [{ id: 1n, memoryStart: 4096n, memoryLimit: 8192n, fileOffset: 0n, filename: 'lib.so', buildId: 'build-A' }],
    locations: [{ id: 1n, mappingId: 1n, address: 4128n, isFolded: 0n,
      lines: [{ functionId: 9n, line: 77n, functionName: 'native', filename: 'n.cc' }] }]
  };
  const called = [];
  const pass = await symbolizePass({ profile, catalog,
    fetcher: async (route, addresses) => { called.push([route, addresses]); return { addresses: {}, missing: [] }; } });
  assert.equal(called.length, 0);
  assert.equal(pass.locations[0].status, 'resolved');
  assert.equal(pass.locations[0].lines[0].functionName, 'native');
  assert.equal(pass.locations[0].lines[0].filename, 'n.cc');
});

test('Function 表解析原生内联帧，缺 function 时不臆造名称', async () => {
  const { decodeProfile } = await import('../src/profile.mjs');
  // 手工构造带 Function 表的 pprof：string 1=fn 2=f.cc
  const enc = (() => {
    const varint = value => { let n = BigInt(value); if (n < 0n) n += 1n << 64n;
      const out = []; do { let b = Number(n & 127n); n >>= 7n; if (n) b |= 128; out.push(b); } while (n);
      return Buffer.from(out); };
    const tag = (f, w) => varint((BigInt(f) << 3n) | BigInt(w));
    const vf = (f, v) => Buffer.concat([tag(f, 0), varint(v)]);
    const sf = (f, s) => Buffer.concat([tag(f, 2), varint(Buffer.byteLength(s)), Buffer.from(s)]);
    const msg = (f, parts) => Buffer.concat([tag(f, 2), varint(Buffer.concat(parts).length), ...parts]);
    return Buffer.concat([
      msg(5, [vf(1, 1), vf(2, 1), vf(4, 2)]),
      msg(3, [vf(1, 1), vf(2, 4096), vf(3, 8192), vf(6, 3)]),
      msg(4, [vf(1, 1), vf(2, 1), vf(3, 4128), msg(5, [vf(1, 1), vf(2, 55)])]),
      sf(6, ''), sf(6, 'fn'), sf(6, 'f.cc'), sf(6, 'build-A')
    ]);
  })();
  const profile = decodeProfile(enc);
  assert.equal(profile.functions[0].name, 'fn');
  assert.equal(profile.locations[0].lines[0].functionName, 'fn');
  assert.equal(profile.locations[0].lines[0].line.toString(), '55');
});
