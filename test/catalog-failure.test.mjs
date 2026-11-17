import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../src/service.mjs';

// catalog 持续失败的最小来源，验证产品不把未知解释成空成功。
async function startFailingCatalogSource({ profileBytes }) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/catalog') { response.writeHead(503); return response.end('catalog down'); }
    if (url.pathname === '/primary') {
      response.setHeader('Content-Type', 'application/octet-stream');
      return response.end(profileBytes);
    }
    response.writeHead(404); response.end('not_found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}

test('catalog 不可用时原件仍登记，未解释位置保留原因而不是伪造空结果', async () => {
  const { readFile } = await import('node:fs/promises');
  const profileBytes = await readFile(new URL('../fixtures/primary.bin', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'catalog-down-'));
  const source = await startFailingCatalogSource({ profileBytes });
  const service = await startService({ source: source.url, directory });
  try {
    const response = await fetch(`${service.url}/intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
    assert.equal(response.status, 201);
    const record = await response.json();
    assert.equal(record.symbolization.summary.unresolved, 1);
    const interpretation = await (await fetch(`${service.url}/interpretations/${record.id}`)).json();
    assert.equal(interpretation.locations[0].status, 'unresolved');
    assert.equal(interpretation.locations[0].reason, 'symbol_route_not_configured');
    assert.equal(interpretation.passes[0].catalogError, 'source_status_503');
    // 样本依旧原样保留
    assert.equal(interpretation.profile.samples.length, 1);
  } finally {
    await service.close(); await source.close(); await rm(directory, { recursive: true, force: true });
  }
});
