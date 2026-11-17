import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
import { Store } from '../src/store.mjs';
import { inspect } from '../src/reader.mjs';
import { decodeProfile, reviveProfile } from '../src/profile.mjs';

test('单件资料可解释，畸形输入被拒绝', async () => {
  const fixture = await readFile(new URL('../fixtures/primary.bin', import.meta.url));
  assert.ok(inspect(fixture));
  assert.throws(() => inspect(Buffer.alloc(0)));
});
test('来源领取、原件持久化、重启查询及无副作用拒收', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const body = JSON.stringify({ path: '/primary' });
    const send = path => fetch(`${service.url}/intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    const first = await send('/primary');
    assert.equal(first.status, 201);
    const record = await first.json();
    const { symbolization, ...storedRecord } = record;
    assert.deepEqual(await new Store(directory).list(), [storedRecord]);
    assert.ok(symbolization.summary.resolved >= 1);
    assert.deepEqual(Buffer.from(await (await fetch(`${service.url}/objects/${record.digest}`)).arrayBuffer()),
      await readFile(new URL('../fixtures/primary.bin', import.meta.url)));
    const repeated = await send('/primary');
    assert.equal((await repeated.json()).id, record.id);
    assert.equal((await send('/missing')).status, 422);
    assert.equal((await send('https://example.invalid/foreign')).status, 422);
    assert.equal((await new Store(directory).list()).length, 1);
    const range = await fetch(`${provider.url}/primary`, { headers: { range: 'bytes=0-0' } });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 1);
    const reject = await fetch(`${provider.url}/primary`, { headers: { 'if-match': '"old"' } });
    assert.equal(reject.status, 412);
    assert.ok(body.includes('primary'));
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('符号补领按 buildId 分批请求，部分地址保持未解释并可重补', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'symbol-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const send = path => fetch(`${service.url}/intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    const response = await send('/profiles/mixed');
    assert.equal(response.status, 201);
    const record = await response.json();
    assert.deepEqual(record.symbolization.summary,
      { resolved: 2, unresolved: 3, byReason: { symbol_service_missing: 2, address_outside_mapping: 1 } });

    const interpretation = await (await fetch(`${service.url}/interpretations/${record.id}`)).json();
    const byId = new Map(interpretation.locations.map(location => [location.id, location]));
    // build-A 对象地址 32：保留服务返回的内联链顺序
    assert.deepEqual(byId.get('1').lines.map(line => line.functionName), ['inner', 'outer']);
    // 同名库 build-B 的对象地址 32：不同构建身份，答案不同
    assert.deepEqual(byId.get('4').lines.map(line => line.functionName), ['different']);
    // 服务明确 missing 与区间外地址仍未解释，且原因可定位
    assert.equal(byId.get('2').reason, 'symbol_service_missing');
    assert.equal(byId.get('5').reason, 'address_outside_mapping');

    // 外呼遵守每批 2 个地址的上限
    const symbolRequests = (await (await fetch(`${provider.url}/_requests`)).json())
      .filter(item => item.path.startsWith('/symbols'));
    for (const item of symbolRequests) {
      const addresses = new URL(item.path, 'http://x').searchParams.get('addresses').split(',');
      assert.ok(addresses.length <= 2);
    }
    // 重定位映射的对象地址公式：16896-16384+4096=4608
    assert.ok(symbolRequests.some(item => item.path.includes('addresses=4608')));

    // 重补：pass 追加，已解释位置的内联层次不变
    const again = await fetch(`${service.url}/interpretations/${record.id}/symbolize`, { method: 'POST' });
    assert.equal(again.status, 200);
    const second = await (await fetch(`${service.url}/interpretations/${record.id}`)).json();
    assert.equal(second.passes.length, 2);
    const reById = new Map(second.locations.map(location => [location.id, location]));
    assert.deepEqual(reById.get('1').lines.map(line => line.functionName), ['inner', 'outer']);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('补符号不改动样本取值类型、标签与采样次数', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sample-preserve-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const response = await fetch(`${service.url}/intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/profiles/mixed' }) });
    const record = await response.json();
    const interpretation = await (await fetch(`${service.url}/interpretations/${record.id}`)).json();
    const profile = reviveProfile(interpretation.profile);
    const original = decodeProfile(await readFile(new URL('../fixtures/resource-04.bin', import.meta.url)));
    assert.equal(profile.samples.length, original.samples.length);
    assert.deepEqual(profile.sampleTypes, original.sampleTypes);
    for (let i = 0; i < profile.samples.length; i++) {
      assert.deepEqual(profile.samples[i].value, original.samples[i].value);
      assert.deepEqual(profile.samples[i].labels, original.samples[i].labels);
      assert.deepEqual(profile.samples[i].locationIds, original.samples[i].locationIds);
    }
    // 大整数与负数精确保留
    assert.equal(profile.samples[0].value[1].toString(), '9000000000000000001');
    assert.equal(profile.samples[1].value[0].toString(), '-7');
    // 原始字节未被重写
    assert.deepEqual(await service.store.object(record.digest),
      await readFile(new URL('../fixtures/resource-04.bin', import.meta.url)));
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('解释文档持久化，重启后可继续重补', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'persist-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  let recordId;
  try {
    const response = await fetch(`${service.url}/intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
    recordId = (await response.json()).id;
  } finally { await service.close(); }
  const reopened = await startService({ source: provider.url, directory });
  try {
    const stored = await reopened.store.interpretation(recordId);
    assert.equal(stored.locations[0].status, 'resolved');
    const again = await fetch(`${reopened.url}/interpretations/${recordId}/symbolize`, { method: 'POST' });
    assert.equal(again.status, 200);
    const next = await reopened.store.interpretation(recordId);
    assert.equal(next.passes.length, 2);
    assert.equal(next.locations[0].lines[0].functionName, 'inner');
  } finally { await reopened.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('GET 接口无副作用，未知解释文档返回 404', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'side-effect-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const missing = await fetch(`${service.url}/interpretations/nope`);
    assert.equal(missing.status, 404);
    const symbolizeMissing = await fetch(`${service.url}/interpretations/nope/symbolize`, { method: 'POST' });
    assert.equal(symbolizeMissing.status, 404);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});
