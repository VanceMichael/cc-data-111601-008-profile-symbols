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
  const intake = path => fetch(`${service.url}/intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
  for (const path of ['/primary', '/profiles/other', '/profiles/mixed']) {
    const response = await intake(path);
    if (response.status !== 201) throw new Error(await response.text());
    const record = await response.json();
    console.log(`接收 ${path}`, record.symbolization);
    const interpretation = await (await fetch(`${service.url}/interpretations/${record.id}`)).json();
    for (const location of interpretation.locations) {
      const chain = location.lines.map(line => `${line.functionName}(${line.filename}:${line.line})`).join(' <- ');
      console.log(`  位置 ${location.id} buildId=${location.buildId ?? '-'} 对象地址=${location.objectAddress ?? '-'} ` +
        `${location.status}${chain ? ` 内联链=${chain}` : ` 原因=${location.reason}`}`);
    }
  }
  // 重补：只追加 pass，已解释的内联层次原样保留
  const first = await intake('/primary');
  const record = await first.json();
  const again = await fetch(`${service.url}/interpretations/${record.id}/symbolize`, { method: 'POST' });
  console.log('重新补领结果（幂等，pass 追加）', await again.json());
  console.log('已保存资料', await (await fetch(`${service.url}/records`)).json());
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
