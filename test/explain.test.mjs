import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
import { decodeProfile } from '../src/reader.mjs';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'explain-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  const intake = async path => {
    const response = await fetch(`${service.url}/intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    assert.equal(response.status, 201);
    return response.json();
  };
  const explain = async record => {
    const response = await fetch(`${service.url}/explanations`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ record }) });
    return { status: response.status, body: await response.json() };
  };
  return { directory, provider, service, intake, explain,
    close: async () => { await service.close(); await provider.close();
      await rm(directory, { recursive: true, force: true }); } };
}

test('真实符号服务按 build id 补领内联链且样本原样保留', async () => {
  const context = await setup();
  try {
    const record = await context.intake('/primary');
    const original = decodeProfile(await context.service.store.object(record.digest));
    const { status, body } = await context.explain(record.id);
    assert.equal(status, 200);
    assert.deepEqual(body.sampleTypes, original.sampleTypes);
    assert.deepEqual(body.samples, original.samples);
    assert.equal(body.symbolization.status, 'complete');
    assert.deepEqual(body.locations[0].lines.map(line => line.function), ['inner', 'outer']);
    assert.equal(body.symbolization.applied[0].buildId, 'build-A');

    const requests = await (await fetch(`${context.provider.url}/_requests`)).json();
    assert.deepEqual(requests.filter(item => item.path.startsWith('/symbols/'))
      .map(item => item.path), ['/symbols/build-A?addresses=32']);

    const saved = await (await fetch(`${context.service.url}/explanations/${record.digest}`)).json();
    assert.deepEqual(saved.profile.locations[0].lines.map(line => line.function), ['inner', 'outer']);
  } finally { await context.close(); }
});

test('同名库不同 build id 使用各自符号服务', async () => {
  const context = await setup();
  try {
    const primary = await context.intake('/primary');
    const other = await context.intake('/profiles/other');
    const first = (await context.explain(primary.id)).body;
    const second = (await context.explain(other.id)).body;
    assert.deepEqual(first.locations[0].lines.map(line => line.function), ['inner', 'outer']);
    assert.deepEqual(second.locations[0].lines.map(line => line.function), ['different']);
    assert.equal(second.symbolization.builds[0].buildId, 'build-B');
    const requests = await (await fetch(`${context.provider.url}/_requests`)).json();
    const paths = requests.filter(item => item.path.startsWith('/symbols/')).map(item => item.path);
    assert.ok(paths.includes('/symbols/build-A?addresses=32'));
    assert.ok(paths.includes('/symbols/build-B?addresses=32'));
  } finally { await context.close(); }
});

test('再次补领保留已有内联层次并重开资料可读', async () => {
  const context = await setup();
  try {
    const record = await context.intake('/primary');
    const once = (await context.explain(record.id)).body;
    const twice = (await context.explain(record.id)).body;
    assert.deepEqual(twice.locations[0].lines, once.locations[0].lines);
    assert.equal(twice.symbolization.applied.length, 1);
    assert.equal(twice.symbolization.alreadySymbolized.length, 1);
    assert.equal(twice.symbolization.alreadySymbolized[0].locationId, '1');

    const reopened = await startService({ source: context.provider.url, directory: context.directory });
    try {
      const saved = await (await fetch(`${reopened.url}/explanations/${record.digest}`)).json();
      assert.deepEqual(saved.profile.locations[0].lines.map(line => line.function), ['inner', 'outer']);
    } finally { await reopened.close(); }
  } finally { await context.close(); }
});

test('未知资料和未解释的原因都显式返回', async () => {
  const context = await setup();
  try {
    assert.equal((await context.explain('missing-id')).status, 422);
    const record = await context.intake('/primary');
    assert.equal((await fetch(`${context.service.url}/explanations/${record.digest}`)).status, 404);
  } finally { await context.close(); }
});
