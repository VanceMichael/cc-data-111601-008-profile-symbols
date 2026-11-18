import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { acquire } from './transport.mjs';
import { inspect, decodeProfile } from './reader.mjs';
import { symbolizeProfile } from './symbols.mjs';
import { startProvider } from './provider.mjs';

async function body(request, limit = 16384) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

// Symbolization may only add location lines. Sample types, sample values,
// labels and their order are part of the original observation and must be
// returned byte-for-byte equivalent.
function assertObservationsUntouched(before, after) {
  const same = JSON.stringify([before.sampleTypes, before.samples]) ===
    JSON.stringify([after.sampleTypes, after.samples]);
  if (!same) throw new Error('symbolization_changed_samples');
}

function locationKey(location, index) {
  return location.id === undefined ? `#${index}` : String(location.id);
}

// Re-apply previously received lines by location identity. A later pass must
// not restart from empty lines, which would split an existing inline chain.
function restoreLines(original, stored) {
  if (!stored?.profile?.locations) return original;
  const previous = new Map(stored.profile.locations
    .map((location, index) => [locationKey(location, index), location]));
  const locations = original.locations.map((location, index) => {
    const kept = previous.get(locationKey(location, index));
    if (!kept || (location.lines?.length ?? 0) > 0) return location;
    if (!Array.isArray(kept.lines) || kept.lines.length === 0) return location;
    if (String(kept.mappingId) !== String(location.mappingId) ||
        String(kept.address) !== String(location.address)) return location;
    return { ...location, lines: kept.lines };
  });
  return { ...original, locations };
}

function mergeSymbolization(outcome, stored, original) {
  assertObservationsUntouched(original, outcome.profile);
  if (stored?.profile) assertObservationsUntouched(stored.profile, outcome.profile);
  const applied = new Map();
  for (const item of stored?.symbolization?.applied ?? []) applied.set(item.locationIndex, item);
  for (const item of outcome.symbolization.applied) applied.set(item.locationIndex, item);
  const ordered = [...applied.values()].sort((left, right) => left.locationIndex - right.locationIndex)
    .filter(item => (outcome.profile.locations[item.locationIndex]?.lines?.length ?? 0) > 0);
  const unresolved = outcome.symbolization.unresolved;
  const status = ordered.length === 0 ? 'unresolved' : unresolved.length === 0 ? 'complete' : 'partial';
  return {
    profile: { ...outcome.profile, sampleTypes: original.sampleTypes, samples: original.samples },
    symbolization: { ...outcome.symbolization, status, applied: ordered, unresolved }
  };
}

export async function startService({ source, directory, port = 0 }) {
  const store = await new Store(directory).initialize();
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
        const payload = await body(request);
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const parsed = inspect(result.bytes);
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      if (url.pathname === '/explanations' && request.method === 'POST') {
        const payload = await body(request);
        if (typeof payload.record !== 'string') throw new Error('record_required');
        const record = await store.find(payload.record);
        if (!record) throw new Error('record_not_found');
        const stored = await store.loadSymbols(record.digest);
        const original = decodeProfile(await store.object(record.digest));
        const base = restoreLines(original, stored);
        const outcome = await symbolizeProfile(base, { source });
        const merged = mergeSymbolization(outcome, stored, original);
        const saved = await store.saveSymbols(record.digest, merged);
        return response.end(JSON.stringify({ record: { id: record.id, digest: record.digest },
          sampleTypes: saved.profile.sampleTypes, samples: saved.profile.samples,
          symbolization: saved.symbolization, locations: saved.profile.locations }));
      }
      if (url.pathname.startsWith('/explanations/') && request.method === 'GET') {
        const found = await store.find(url.pathname.slice('/explanations/'.length));
        if (!found) { response.writeHead(404); return response.end(JSON.stringify({ error: 'not_found' })); }
        const saved = await store.loadSymbols(found.digest);
        if (!saved) { response.writeHead(404); return response.end(JSON.stringify({ error: 'not_symbolized' })); }
        return response.end(JSON.stringify(saved));
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) { response.statusCode = 422; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, store, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const provider = process.env.SOURCE_URL ? null : await startProvider();
  const source = process.env.SOURCE_URL ?? provider.url;
  let service;
  try {
    service = await startService({ source, directory: process.env.DATA_DIR ?? './data',
      port: Number(process.env.PORT ?? 4102) });
  } catch (error) {
    if (provider) await provider.close();
    throw error;
  }
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await service.close();
    if (provider) await provider.close();
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  console.log(JSON.stringify({ product: service.url, source }));
}
