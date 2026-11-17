import { objectAddress } from './profile.mjs';

// 合作方符号服务每次最多 2 个不同地址（见 docs/upstream.md）。
export const SYMBOL_BATCH_LIMIT = 2;

// 依据 profile 与上一轮解释，规划本轮需要补领的符号请求。
// 已经有内联层次（lines）的位置不再请求；同一 buildId 下相同对象地址去重，
// 多个位置共享同一份答案，绝不按文件名或映射加载地址合并。
export function planRequests(profile, previousLocations = []) {
  const prior = new Map(previousLocations.map(item => [item.id, item]));
  const mappingById = new Map(profile.mappings.map(mapping => [mapping.id, mapping]));
  const groups = new Map(); // buildId -> Map(objectAddress -> locationId[])
  const locations = [];
  for (const location of profile.locations) {
    const old = prior.get(location.id);
    const base = {
      id: location.id,
      mappingId: location.mappingId,
      address: location.address,
      objectAddress: null,
      buildId: null,
      status: 'unresolved',
      reason: null,
      lines: old?.lines ? structuredClone(old.lines) : location.lines.map(line => ({ ...line }))
    };
    const mapping = mappingById.get(location.mappingId);
    if (base.lines.length) {
      base.status = 'resolved';
      base.reason = null;
      base.buildId = mapping?.buildId ?? null;
      const target = objectAddress(location, mapping);
      base.objectAddress = target;
    } else if (!mapping) {
      base.reason = 'mapping_not_found';
    } else if (!mapping.buildId) {
      base.buildId = null;
      base.reason = 'build_id_missing';
    } else {
      base.buildId = mapping.buildId;
      const target = objectAddress(location, mapping);
      if (target === null) {
        base.reason = 'address_outside_mapping';
      } else {
        base.objectAddress = target;
        if (!groups.has(mapping.buildId)) groups.set(mapping.buildId, new Map());
        const byAddress = groups.get(mapping.buildId);
        if (!byAddress.has(target)) byAddress.set(target, []);
        byAddress.get(target).push(location.id);
      }
    }
    locations.push(base);
  }
  const requests = [];
  for (const [buildId, byAddress] of groups) {
    const addresses = [...byAddress.keys()];
    for (let begin = 0; begin < addresses.length; begin += SYMBOL_BATCH_LIMIT) {
      const batch = addresses.slice(begin, begin + SYMBOL_BATCH_LIMIT);
      requests.push({ buildId, addresses: batch, members: batch.flatMap(address => byAddress.get(address)) });
    }
  }
  return { locations, requests };
}

function normalizeLines(payload) {
  if (!payload || !Array.isArray(payload.lines) || payload.lines.length === 0) return null;
  return payload.lines.map(line => ({
    functionName: typeof line?.function === 'string' ? line.function : null,
    filename: typeof line?.file === 'string' ? line.file : null,
    line: /^-?\d+$/.test(String(line?.line ?? '')) ? BigInt(line.line) : 0n,
    functionId: null
  }));
}

// 应用一轮真实 HTTP 交换结果，产出新的解释位置表。
// 服务只覆盖部分地址时其余位置保持 unresolved 并记录原因；
// 已 resolved 的位置原样保留，内联链顺序按服务返回，不重排、不打散。
export function applyResponses(plan, exchanges) {
  const locations = plan.locations.map(item => ({ ...item, lines: item.lines.map(line => ({ ...line })) }));
  for (const exchange of exchanges) {
    const members = new Set(exchange.request.members.map(id => id.toString()));
    if (exchange.error) {
      for (const item of locations) {
        if (members.has(item.id.toString()) && item.status !== 'resolved') {
          item.status = 'unresolved';
          item.reason = exchange.error;
        }
      }
      continue;
    }
    const body = exchange.body ?? {};
    if (body.buildId !== undefined && body.buildId !== exchange.request.buildId) {
      for (const item of locations) {
        if (members.has(item.id.toString()) && item.status !== 'resolved') item.reason = 'build_id_mismatch';
      }
      continue;
    }
    const answered = new Map();
    if (body.addresses && typeof body.addresses === 'object') {
      for (const [address, payload] of Object.entries(body.addresses)) {
        if (!/^\d+$/.test(address)) continue;
        const lines = normalizeLines(payload);
        if (lines) answered.set(BigInt(address), lines);
      }
    }
    const declaredMissing = new Set(
      Array.isArray(body.missing) ? body.missing.filter(value => /^\d+$/.test(String(value))).map(value => BigInt(value)) : []
    );
    for (const item of locations) {
      if (!members.has(item.id.toString()) || item.status === 'resolved') continue;
      if (answered.has(item.objectAddress)) {
        item.lines = answered.get(item.objectAddress).map(line => ({ ...line }));
        item.status = 'resolved';
        item.reason = null;
      } else if (declaredMissing.has(item.objectAddress)) {
        item.status = 'unresolved';
        item.reason = 'symbol_service_missing';
      } else {
        // 响应既未给地址也未列入 missing：部分覆盖，位置仍未解释并可追溯。
        item.status = 'unresolved';
        item.reason = 'symbol_service_not_covered';
      }
    }
  }
  return locations;
}

export function summarize(locations) {
  const summary = { resolved: 0, unresolved: 0, byReason: {} };
  for (const location of locations) {
    if (location.status === 'resolved') summary.resolved += 1;
    else {
      summary.unresolved += 1;
      const reason = location.reason ?? 'unknown';
      summary.byReason[reason] = (summary.byReason[reason] ?? 0) + 1;
    }
  }
  return summary;
}

// 完整一轮补领：catalog 解析路由 -> 分批请求 -> 合并答案。
// fetcher 负责实际 HTTP（transport 同源限制在调用处保证），这里只做领域决策。
export async function symbolizePass({ profile, catalog, previous, fetcher, now = new Date().toISOString() }) {
  const plan = planRequests(profile, previous?.locations ?? []);
  const routes = catalog?.symbolServices ?? {};
  const exchanges = [];
  for (const request of plan.requests) {
    const route = routes[request.buildId];
    if (!route) {
      exchanges.push({ request, error: 'symbol_route_not_configured' });
      continue;
    }
    try {
      const body = await fetcher(route, request.addresses);
      exchanges.push({ request, body });
    } catch (error) {
      exchanges.push({ request, error: error?.message ? String(error.message) : 'symbol_request_failed' });
    }
  }
  const locations = applyResponses(plan, exchanges);
  return {
    at: now,
    locations,
    requests: plan.requests.map(request => ({
      buildId: request.buildId,
      addresses: request.addresses.map(value => value.toString())
    })),
    exchanges: exchanges.map(exchange => ({
      buildId: exchange.request.buildId,
      addresses: exchange.request.addresses.map(value => value.toString()),
      error: exchange.error ?? null,
      answered: exchange.body?.addresses ? Object.keys(exchange.body.addresses) : [],
      missing: Array.isArray(exchange.body?.missing) ? exchange.body.missing.map(String) : []
    })),
    summary: summarize(locations)
  };
}
