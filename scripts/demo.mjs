import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());
  const response = await fetch(`${service.url}/intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
  if (response.status !== 201) throw new Error(await response.text());
  const record = await response.json();
  console.log('接收结果', record);
  const explained = await fetch(`${service.url}/explanations`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ record: record.id }) });
  if (!explained.ok) throw new Error(await explained.text());
  const explanation = await explained.json();
  console.log('解释结果', explanation.symbolization);
  console.log('内联调用链', explanation.locations[0].lines);
  console.log('已保存资料', await (await fetch(`${service.url}/records`)).json());
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
