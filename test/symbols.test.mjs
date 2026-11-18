import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeProfile } from '../src/reader.mjs';
import { objectAddress, lookupPlan, symbolizeProfile, SYMBOL_BATCH_LIMIT } from '../src/symbols.mjs';

const primary = await readFile(new URL('../fixtures/primary.bin', import.meta.url));
const other = await readFile(new URL('../fixtures/resource-01.bin', import.meta.url));
const document = decodeProfile(primary);

test('结构与样本标签按原件解码，不合并取值类型', () => {
  assert.deepEqual(document.sampleTypes, [{ type: 'samples', unit: 'count' }]);
  assert.equal(document.samples.length, 1);
  assert.deepEqual(document.samples[0].values, ['3']);
  assert.deepEqual(document.samples[0].labels, [{ key: 'worker', str: 'worker' }]);
  assert.deepEqual(document.samples[0].locationIds, ['1']);
  assert.equal(document.mappings[0].buildId, 'build-A');
  assert.equal(document.mappings[0].file, 'libmovement.so');
});

test('重定位按 memory_start/file_offset 计算且区间左闭右开', () => {
  const mapping = { memoryStart: '4096', memoryLimit: '8192', fileOffset: '0' };
  assert.equal(objectAddress({ address: '4128' }, mapping).address, '32');
  assert.equal(objectAddress({ address: '4096' }, mapping).address, '0');
  assert.equal(objectAddress({ address: '8192' }, mapping).reason, 'address_outside_mapping');
  assert.equal(objectAddress({ address: '4095' }, mapping).reason, 'address_outside_mapping');
  const relocated = { memoryStart: '4096', memoryLimit: '8192', fileOffset: '128' };
  assert.equal(objectAddress({ address: '4128' }, relocated).address, '160');
  assert.equal(objectAddress({ address: '4128' }, undefined).reason, 'no_mapping');
});

test('超过安全整数的地址仍然精确', () => {
  const mapping = { memoryStart: '18446744073709551610', memoryLimit: '18446744073709551615',
    fileOffset: '1' };
  assert.equal(objectAddress({ address: '18446744073709551614' }, mapping).address, '5');
  assert.equal(objectAddress({ address: '9007199254740993' }, { memoryStart: '9007199254740992',
    memoryLimit: '9007199254740994', fileOffset: '0' }).address, '1');
});

test('同名库不同 build id 分开建组，缺 build id 的地址不猜测', () => {
  const plan = lookupPlan(decodeProfile(other));
  assert.deepEqual([...plan.groups.keys()], ['build-B']);
  const unmapped = lookupPlan({ ...document, locations: [{ id: '9', mappingId: '0', address: '1', lines: [] }] });
  assert.equal(unmapped.unresolved[0].reason, 'no_mapping');
  const noBuild = lookupPlan({ ...document, mappings: [{ id: '1', memoryStart: '0', memoryLimit: '8',
    fileOffset: '0', file: 'libmovement.so' }] });
  assert.equal(noBuild.unresolved[0].reason, 'missing_build_id');
});

test('已有 lines 的位置在补领计划中保留，不重复请求', () => {
  const existing = { ...document, locations: [{ ...document.locations[0],
    lines: [{ function: 'inner' }, { function: 'outer' }] }] };
  const plan = lookupPlan(existing);
  assert.equal(plan.groups.size, 0);
  assert.equal(plan.alreadySymbolized.length, 1);
});

function source(routes, responder) {
  const requests = [];
  return { requests, acquire: async (base, path) => {
    requests.push(path);
    if (path === '/catalog') return { bytes: Buffer.from(JSON.stringify({ symbolServices: routes })) };
    const addresses = new URL(path, base).searchParams.get('addresses').split(',');
    return { bytes: Buffer.from(JSON.stringify(responder(path, addresses))) };
  } };
}

test('批量按上限拆分且返回部分覆盖时明确未解释位置', async () => {
  const locations = [32, 33, 34].map((address, index) => ({ id: String(index + 1), mappingId: '1',
    address: String(4096 + address), lines: [] }));
  const profile = { ...document, locations };
  const upstream = source({ 'build-A': '/symbols/build-A' }, (path, addresses) => ({
    buildId: 'build-A',
    addresses: Object.fromEntries(addresses.map(address =>
      [address, { lines: [{ function: `fn-${address}`, file: 'a.cc', line: 1 }] }])),
    missing: []
  }));
  const outcome = await symbolizeProfile(profile, { source: 'http://source.test', catalog: '/catalog',
    transfer: upstream.acquire });
  const symbolRequests = upstream.requests.filter(path => !path.startsWith('/catalog'));
  assert.equal(symbolRequests.length, 2);
  for (const path of symbolRequests) {
    const batch = new URL(path, 'http://source.test').searchParams.get('addresses').split(',');
    assert.ok(batch.length <= SYMBOL_BATCH_LIMIT, `batch ${batch.length} exceeds limit`);
  }
  assert.deepEqual(symbolRequests.map(path => new URL(path, 'http://source.test').searchParams
    .get('addresses')), ['32,33', '34']);
  assert.equal(outcome.symbolization.status, 'complete');
});

test('同一构建的不同加载地址归一到同一对象地址，不重复请求', async () => {
  const profile = { ...document, mappings: [
    { id: '1', memoryStart: '4096', memoryLimit: '8192', fileOffset: '0', file: 'libmovement.so', buildId: 'build-A' },
    { id: '2', memoryStart: '12288', memoryLimit: '16384', fileOffset: '0', file: 'libmovement.so', buildId: 'build-A' }
  ], locations: [
    { id: '1', mappingId: '1', address: '4128', lines: [] },
    { id: '2', mappingId: '2', address: '12320', lines: [] }
  ] };
  const upstream = source({ 'build-A': '/symbols/build-A' }, (path, addresses) => ({
    buildId: 'build-A', addresses: Object.fromEntries(addresses.map(address =>
      [address, { lines: [{ function: 'inner' }, { function: 'outer' }] }])), missing: []
  }));
  const outcome = await symbolizeProfile(profile, { source: 'http://source.test',
    catalog: '/catalog', transfer: upstream.acquire });
  const planned = upstream.requests.filter(path => path !== '/catalog')
    .map(path => new URL(path, 'http://source.test').pathname + new URL(path, 'http://source.test').search);
  assert.deepEqual(planned, ['/symbols/build-A?addresses=32']);
  assert.equal(outcome.symbolization.applied.length, 2);
  assert.deepEqual(outcome.profile.locations.map(location => location.lines.length), [2, 2]);
  assert.equal(outcome.symbolization.builds[0].addresses, 1);
});

test('多种取值类型与标签在补领后逐项保持不变', async () => {
  const profile = { ...document,
    sampleTypes: [{ type: 'cpu', unit: 'nanoseconds' }, { type: 'allocs', unit: 'count' }],
    samples: [
      { locationIds: ['1'], values: ['999999999999999999', '-3'], labels: [
        { key: 'thread', str: 'worker-1' }, { key: 'size', num: '8589934592', numUnit: 'bytes' }] },
      { locationIds: ['1'], values: ['7', '0'], labels: [] }
    ] };
  const upstream = source({ 'build-A': '/symbols/build-A' }, (path, addresses) => ({
    buildId: 'build-A', addresses: { '32': { lines: [{ function: 'inner' }, { function: 'outer' }] } },
    missing: []
  }));
  const outcome = await symbolizeProfile(profile, { source: 'http://source.test',
    catalog: '/catalog', transfer: upstream.acquire });
  assert.deepEqual(outcome.profile.sampleTypes, profile.sampleTypes);
  assert.deepEqual(outcome.profile.samples, profile.samples);
  assert.equal(outcome.profile.locations[0].lines.length, 2);
});

test('服务返回部分覆盖时保留未解释地址且不拆内联链', async () => {
  const profile = { ...document, locations: [
    { id: '1', mappingId: '1', address: '4128', lines: [] },
    { id: '2', mappingId: '1', address: '4144', lines: [] }
  ] };
  const upstream = source({ 'build-A': '/symbols/build-A' }, (path, addresses) => ({
    buildId: 'build-A', addresses: { '32': { lines: [{ function: 'inner', file: 'a.cc', line: 12 },
      { function: 'outer', file: 'b.cc', line: 20 }] } }, missing: ['48']
  }));
  const outcome = await symbolizeProfile(profile, { source: 'http://source.test',
    catalog: '/catalog', transfer: upstream.acquire });
  assert.equal(outcome.symbolization.status, 'partial');
  assert.deepEqual(outcome.profile.locations[0].lines.map(line => line.function), ['inner', 'outer']);
  assert.equal(outcome.profile.locations[1].lines.length, 0);
  assert.deepEqual(outcome.symbolization.unresolved.map(item => [item.address, item.reason]),
    [['48', 'address_missing']]);
  assert.deepEqual(outcome.profile.samples, document.samples);
  assert.deepEqual(outcome.profile.sampleTypes, document.sampleTypes);
});
