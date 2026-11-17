import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { acquire } from './transport.mjs';
import { inspect } from './reader.mjs';
import { decodeProfile, reviveProfile } from './profile.mjs';
import { symbolizePass, summarize } from './symbolizer.mjs';

export async function startService({ source, directory, port = 0 }) {
  const store = await new Store(directory).initialize();
  const readBody = async request => {
    const chunks = []; let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 16384) throw new Error('request_too_large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  // 所有外呼都走 transport：同源、拒跳转、限时、限长。
  const fetchCatalog = async () => {
    const result = await acquire(source, '/catalog');
    return JSON.parse(result.bytes.toString('utf8'));
  };
  const symbolFetcher = (route, addresses) => acquire(source,
    `${route}?addresses=${addresses.map(value => value.toString()).join(',')}`).then(result => JSON.parse(result.bytes.toString('utf8')));
  // 补领只在解释层进行；每次都校验样本结构未被任何环节改动。
  const runSymbolization = async ({ id, profile, previous, catalog, catalogError }) => {
    const fingerprint = value => JSON.stringify(value,
      (_key, item) => (typeof item === 'bigint' ? item.toString() : item));
    const before = fingerprint({ samples: profile.samples, sampleTypes: profile.sampleTypes,
      mappings: profile.mappings, strings: profile.strings });
    const pass = await symbolizePass({ profile, catalog, previous, fetcher: symbolFetcher });
    if (catalogError) {
      pass.catalogError = catalogError;
      for (const location of pass.locations) {
        if (location.status !== 'resolved') location.reason ??= 'catalog_unavailable';
      }
      pass.summary = summarize(pass.locations);
    }
    const after = fingerprint({ samples: profile.samples, sampleTypes: profile.sampleTypes,
      mappings: profile.mappings, strings: profile.strings });
    if (after !== before) throw new Error('profile_tables_changed');
    const passes = previous ? [...previous.passes, pass] : [pass];
    const interpretation = {
      id,
      profile: {
        kind: profile.kind,
        sampleTypes: profile.sampleTypes,
        samples: profile.samples,
        mappings: profile.mappings,
        locations: profile.locations,
        functions: profile.functions,
        strings: profile.strings
      },
      locations: pass.locations,
      passes,
      summary: pass.summary
    };
    await store.saveInterpretation(id, interpretation);
    return interpretation;
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true }));
      if (url.pathname === '/records' && request.method === 'GET') return response.end(JSON.stringify(await store.list()));
      if (url.pathname.startsWith('/objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await store.object(url.pathname.slice(9)));
      }
      if (url.pathname === '/intakes' && request.method === 'POST') {
        const payload = JSON.parse((await readBody(request)).toString());
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const parsed = inspect(result.bytes);
        const profile = decodeProfile(result.bytes); // 结构解释失败则不登记
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        // 原件已存在且已解释时保持幂等，不重复外呼。
        let interpretation = null;
        try {
          interpretation = await store.interpretation(record.id);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          let catalog = { symbolServices: {} };
          let catalogError = null;
          try { catalog = await fetchCatalog(); }
          catch (catalogFailure) { catalogError = catalogFailure.message; }
          interpretation = await runSymbolization(
            { id: record.id, profile, previous: null, catalog, catalogError });
        }
        response.statusCode = 201;
        return response.end(JSON.stringify({
          ...record,
          symbolization: { summary: interpretation.summary, unresolved: interpretation.summary.unresolved }
        }));
      }
      const interpretationMatch = /^\/interpretations\/([A-Za-z0-9-]{1,64})$/.exec(url.pathname);
      if (interpretationMatch && request.method === 'GET') {
        return response.end(JSON.stringify(await store.interpretation(interpretationMatch[1])));
      }
      // 重新补领是显式 POST；只追加新 pass，已有内联层次在 planRequests 中原样继承。
      const symbolizeMatch = /^\/interpretations\/([A-Za-z0-9-]{1,64})\/symbolize$/.exec(url.pathname);
      if (symbolizeMatch && request.method === 'POST') {
        const id = symbolizeMatch[1];
        const record = await store.find(id);
        if (!record) { response.writeHead(404); return response.end(JSON.stringify({ error: 'record_not_found' })); }
        const previous = await store.interpretation(id);
        const profile = reviveProfile(previous.profile);
        const catalog = await fetchCatalog();
        const interpretation = await runSymbolization({ id, profile, previous, catalog });
        response.statusCode = 200;
        return response.end(JSON.stringify({ summary: interpretation.summary, passes: interpretation.passes.length }));
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) {
      response.statusCode = error.code === 'ENOENT' ? 404 : 422;
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, store, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.SOURCE_URL) throw new Error('SOURCE_URL_required');
  const service = await startService({ source: process.env.SOURCE_URL,
    directory: process.env.DATA_DIR ?? './data', port: Number(process.env.PORT ?? 4102) });
  console.log(JSON.stringify({ product: service.url }));
}
