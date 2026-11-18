import { acquire } from './transport.mjs';

// The exchange contract allows at most this many distinct addresses per
// request. Chunking is done here so callers never have to know the limit.
export const SYMBOL_BATCH_LIMIT = 2;

const DECIMAL = /^\d+$/;

function decimal(value, field) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw new Error(`invalid_${field}`);
  return BigInt(value);
}

// pprof maps a run-time address to the address inside the binary with
//   object = address - memory_start + file_offset
// and mapping intervals are half-open. Keeping the arithmetic in BigInt
// avoids the 2^53 precision cliff for both addresses and values.
export function objectAddress(location, mapping) {
  if (!mapping) return { reason: 'no_mapping' };
  const start = decimal(mapping.memoryStart ?? '0', 'mapping_memory_start');
  const limit = decimal(mapping.memoryLimit ?? '0', 'mapping_memory_limit');
  const offset = decimal(mapping.fileOffset ?? '0', 'mapping_file_offset');
  const address = decimal(location.address ?? '0', 'location_address');
  if (limit <= start) return { reason: 'empty_mapping' };
  if (address < start || address >= limit) return { reason: 'address_outside_mapping' };
  return { address: (address - start + offset).toString(), start, limit };
}

function locationKey(location, index) {
  return location.id === undefined ? `#${index}` : String(location.id);
}

// Group only by the binary build identity. A file name is metadata, never a
// routing key, so two builds of the same library stay separate.
export function lookupPlan(profile) {
  const mappings = new Map(profile.mappings
    .filter(mapping => mapping.id !== undefined)
    .map(mapping => [String(mapping.id), mapping]));
  const groups = new Map();
  const unresolved = [];
  const alreadySymbolized = [];
  const entries = profile.locations.map((location, index) => {
    const id = locationKey(location, index);
    if ((location.lines?.length ?? 0) > 0) {
      alreadySymbolized.push({ locationId: id, locationIndex: index });
      return null;
    }
    const mappingId = location.mappingId === undefined ? '0' : String(location.mappingId);
    const mapping = mappingId === '0' ? undefined : mappings.get(mappingId);
    if (!mapping) {
      unresolved.push({ locationId: id, locationIndex: index, reason: 'no_mapping' });
      return null;
    }
    if (mapping.buildId === undefined || mapping.buildId === '') {
      unresolved.push({ locationId: id, locationIndex: index, reason: 'missing_build_id',
        mappingId: mapping.id ?? mappingId, file: mapping.file });
      return null;
    }
    const located = objectAddress(location, mapping);
    if (located.reason) {
      unresolved.push({ locationId: id, locationIndex: index, reason: located.reason,
        buildId: mapping.buildId, mappingId: mapping.id ?? mappingId,
        address: location.address, file: mapping.file });
      return null;
    }
    const group = groups.get(mapping.buildId) ?? { buildId: mapping.buildId,
      files: new Set(), addresses: new Map() };
    if (mapping.file !== undefined) group.files.add(mapping.file);
    groups.set(mapping.buildId, group);
    const slots = group.addresses.get(located.address) ?? [];
    slots.push({ locationId: id, locationIndex: index, address: located.address,
      mappingId: mapping.id ?? mappingId,
      ...(mapping.file === undefined ? {} : { file: mapping.file }) });
    group.addresses.set(located.address, slots);
    return { locationId: id, locationIndex: index, buildId: mapping.buildId,
      mappingId: mapping.id ?? mappingId, address: located.address };
  });
  return { groups, entries, unresolved, alreadySymbolized };
}

function sortAddresses(addresses) {
  return [...addresses].sort((left, right) => {
    const a = BigInt(left); const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function chunks(items, width) {
  const result = [];
  for (let offset = 0; offset < items.length; offset += width) result.push(items.slice(offset, offset + width));
  return result;
}

function symbolEndpoint(source, path, addresses) {
  const endpoint = new URL(path, source);
  endpoint.searchParams.set('addresses', addresses.join(','));
  return endpoint.href;
}

function lineRows(lines) {
  return lines.map(line => ({ function: line.function, file: line.file, line: line.line,
    ...(line.column === undefined ? {} : { column: line.column }) }));
}

function serviceEntry(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document) ||
      !document.addresses || typeof document.addresses !== 'object') {
    throw new Error('symbol_response_shape');
  }
  return document;
}

// Resolve locations for every build separately. Samples and sample types are
// carried through untouched: this module only fills location.lines.
export async function symbolizeProfile(profile, { source, catalog, batchLimit = SYMBOL_BATCH_LIMIT,
  transfer = acquire } = {}) {
  const plan = lookupPlan(profile);
  const unresolved = [...plan.unresolved];
  const applied = [];
  const builds = [];
  let routes = null;
  let catalogError;
  try {
    const fetched = await transfer(source, catalog ?? '/catalog');
    const parsed = JSON.parse(fetched.bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.symbolServices ||
        typeof parsed.symbolServices !== 'object') throw new Error('catalog_shape');
    routes = parsed.symbolServices;
  } catch (error) {
    catalogError = error.message;
  }

  const locations = profile.locations.slice();
  const width = Math.max(1, Math.min(batchLimit, SYMBOL_BATCH_LIMIT));

  for (const group of plan.groups.values()) {
    const summary = { buildId: group.buildId, files: [...group.files].sort(),
      addresses: group.addresses.size, requested: 0, resolved: 0, unresolved: 0, requests: [] };
    const service = routes?.[group.buildId];
    if (typeof service !== 'string') {
      summary.reason = catalogError ? 'catalog_unavailable' : 'no_symbol_service';
      for (const slots of group.addresses.values()) {
        for (const slot of slots) unresolved.push({ locationId: slot.locationId,
          locationIndex: slot.locationIndex, buildId: group.buildId, address: slot.address,
          reason: summary.reason, ...(catalogError ? { detail: catalogError } : {}) });
      }
      summary.unresolved = [...group.addresses.values()].reduce((count, slots) => count + slots.length, 0);
      builds.push(summary);
      continue;
    }
    summary.service = service;
    for (const batch of chunks(sortAddresses(group.addresses.keys()), width)) {
      summary.requested += batch.length;
      const request = { buildId: group.buildId, service, addresses: batch };
      try {
        const response = await transfer(source, symbolEndpoint(source, service, batch));
        const document = serviceEntry(JSON.parse(response.bytes.toString('utf8')));
        if (document.buildId !== group.buildId) throw new Error('symbol_build_mismatch');
        const missing = new Set(Array.isArray(document.missing)
          ? document.missing.map(value => String(value)) : []);
        for (const address of batch) {
          const slots = group.addresses.get(address);
          const row = document.addresses[address];
          if (row === undefined) {
            const reason = missing.has(address) ? 'address_missing' : 'address_not_returned';
            for (const slot of slots) unresolved.push({ locationId: slot.locationId,
              locationIndex: slot.locationIndex, buildId: group.buildId, address,
              reason, ...(slot.file === undefined ? {} : { file: slot.file }) });
            summary.unresolved += slots.length;
            continue;
          }
          if (!Array.isArray(row.lines) || row.lines.length === 0 ||
              row.lines.some(line => !line || typeof line.function !== 'string')) {
            for (const slot of slots) unresolved.push({ locationId: slot.locationId,
              locationIndex: slot.locationIndex, buildId: group.buildId, address,
              reason: 'invalid_lines', ...(slot.file === undefined ? {} : { file: slot.file }) });
            summary.unresolved += slots.length;
            continue;
          }
          const lines = lineRows(row.lines);
          for (const slot of slots) {
            locations[slot.locationIndex] = { ...locations[slot.locationIndex], lines };
            applied.push({ locationId: slot.locationId, locationIndex: slot.locationIndex,
              buildId: group.buildId, address, lines: lines.length });
          }
          summary.resolved += slots.length;
        }
        // Addresses the service reports as missing are part of the receipt so
        // the caller can tell "not in this build" from "not returned".
        request.missing = [...missing].sort((left, right) => {
          const a = BigInt(left); const b = BigInt(right); return a < b ? -1 : a > b ? 1 : 0;
        });
        request.status = 'ok';
      } catch (error) {
        for (const address of batch) {
          for (const slot of group.addresses.get(address)) unresolved.push({ locationId: slot.locationId,
            locationIndex: slot.locationIndex, buildId: group.buildId, address,
            reason: 'request_failed', detail: error.message });
        }
        summary.unresolved += batch.reduce((count, address) => count + group.addresses.get(address).length, 0);
        request.status = 'failed';
        request.error = error.message;
      }
      summary.requests.push(request);
    }
    builds.push(summary);
  }

  const resolvedCount = applied.length;
  const status = resolvedCount === 0 ? 'unresolved'
    : unresolved.length === 0 ? 'complete' : 'partial';
  const next = { ...profile, locations };
  return { profile: next, symbolization: { status, builds, applied,
    alreadySymbolized: plan.alreadySymbolized, unresolved } };
}
