import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, varint, fields } from '../src/reader.mjs';
const primary=await readFile(new URL('../fixtures/primary.bin',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../fixtures/upstream.json',import.meta.url),'utf8'));
async function resource(path) {
  const item=manifest.resources[path];
  return item.file ? readFile(new URL(`../fixtures/${item.file}`,import.meta.url)) : Buffer.from(item.body);
}

test('原 profile 表中映射与样本未被预聚合',()=>{
  const result=inspect(primary);assert.equal(result.mappings.length,1);assert.equal(result.samples.length,1);
  assert.equal(result.strings[2],'build-A');assert.equal(result.locations.length,1);
});
test('同名库但不同构建的原件相区别',async()=>{
  const other=inspect(await resource('/profiles/other'));assert.equal(other.strings[1],'libmovement.so');
  assert.equal(other.strings[2],'build-B');
});
test('protobuf 截断和无效 wire 显式失败',()=>{
  assert.throws(()=>varint(Buffer.from([128]),0));assert.throws(()=>fields(Buffer.from([10,9,1])));
  assert.throws(()=>fields(Buffer.from([15])));
});
