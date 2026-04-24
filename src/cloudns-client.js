import { CloudnsApiError } from "./transport/ssh-cloudns.js";

const PAGE_SIZE = 100;
const DEFAULT_TTL = 3600;
const MAX_ZONE_PAGES = 200;

export class CloudnsClient {
  constructor(transport) {
    this.transport = transport;
  }

  async listZones() {
    return (await scanZones(this.transport)).zones;
  }

  async zoneExists(name) {
    return (await scanZones(this.transport, { stopWhen: (pageZones) => pageZones.some((zone) => zone.name === name) })).matched;
  }

  async addZone(name) {
    return await this.transport.request("/dns/register.json", {
      "domain-name": name,
      "zone-type": "master",
    });
  }

  async deleteZone(name) {
    return await this.transport.request("/dns/delete.json", {
      "domain-name": name,
    });
  }

  async listRecords(zone, filters = {}) {
    const records = [];
    for (let page = 1; ; page += 1) {
      const payload = await this.transport.request("/dns/records.json", {
        "domain-name": zone,
        page,
        "rows-per-page": PAGE_SIZE,
        ...compact({
          "record-type": filters.type,
          host: filters.name,
        }),
      });
      const pageRecords = normalizeCollection(payload).map(normalizeRecord);
      if (pageRecords.length === 0) {
        break;
      }
      records.push(...pageRecords);
      if (pageRecords.length < PAGE_SIZE) {
        break;
      }
    }
    return records;
  }

  async addRecord(zone, record) {
    return await this.transport.request("/dns/add-record.json", {
      "domain-name": zone,
      ...toCloudnsRecordParams(record),
    });
  }

  async deleteRecord(zone, recordId) {
    return await this.transport.request("/dns/delete-record.json", {
      "domain-name": zone,
      "record-id": recordId,
    });
  }

  async exportBind(zone) {
    return await this.transport.request(
      "/dns/records-export.json",
      { "domain-name": zone },
      { responseType: "raw" },
    );
  }
}

export function normalizeRecord(record) {
  return {
    id: String(record.id ?? record["record-id"] ?? ""),
    type: String(record.type ?? record["record-type"] ?? "").toUpperCase(),
    name: normalizeName(record.host ?? record.name ?? "@"),
    value: String(record.record ?? record.value ?? ""),
    ttl: Number(record.ttl ?? DEFAULT_TTL),
    priority: maybeNumber(record.priority),
    weight: maybeNumber(record.weight),
    port: maybeNumber(record.port),
    caaFlag: maybeNumber(record.caa_flag ?? record.caaFlag),
    caaType: record.caa_type ?? record.caaType,
  };
}

export function toCloudnsRecordParams(record) {
  const { type, name, value, ttl, priority, weight, port, caaFlag, caaType } = normalizeRecordLike(record);
  const params = {
    "record-type": type,
    host: name,
    record: value,
    ttl,
  };

  if (priority !== undefined) {
    params.priority = priority;
  }
  if (weight !== undefined) {
    params.weight = weight;
  }
  if (port !== undefined) {
    params.port = port;
  }
  if (type === "CAA") {
    params.caa_flag = caaFlag ?? 0;
    params.caa_type = caaType ?? "issue";
  }

  return params;
}

export function recordsEquivalent(left, right) {
  const a = normalizeRecordLike(left);
  const b = normalizeRecordLike(right);
  return (
    a.type === b.type &&
    a.name === b.name &&
    a.value === b.value &&
    a.ttl === b.ttl &&
    a.priority === b.priority &&
    a.weight === b.weight &&
    a.port === b.port &&
    a.caaFlag === b.caaFlag &&
    a.caaType === b.caaType
  );
}

export function normalizeRecordLike(record) {
  return {
    type: String(record.type ?? "").toUpperCase(),
    name: normalizeName(record.name ?? record.host ?? "@"),
    value: String(record.value ?? record.record ?? ""),
    ttl: Number(record.ttl ?? DEFAULT_TTL),
    priority: maybeNumber(record.priority),
    weight: maybeNumber(record.weight),
    port: maybeNumber(record.port),
    caaFlag: maybeNumber(record.caaFlag ?? record.caa_flag),
    caaType: record.caaType ?? record.caa_type,
  };
}

export function normalizeName(name) {
  return name === "" || name === undefined || name === null ? "@" : String(name);
}

export function normalizeCollection(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return [];
  }
  if (Array.isArray(payload.data)) {
    return payload.data;
  }
  if (payload.data && typeof payload.data === "object") {
    return Object.entries(payload.data).map(([id, value]) => ({ id, ...value }));
  }
  return Object.entries(payload)
    .filter(([key]) => key !== "status" && key !== "statusDescription")
    .map(([id, value]) => (value && typeof value === "object" ? { id, ...value } : value));
}

async function scanZones(transport, { stopWhen } = {}) {
  const zones = [];

  for (let page = 1; page <= MAX_ZONE_PAGES; page += 1) {
    const payload = await transport.request("/dns/list-zones.json", {
      page,
      "rows-per-page": PAGE_SIZE,
    });
    const pageZones = normalizeCollection(payload).map(normalizeZone).filter((zone) => zone.name);

    if (stopWhen?.(pageZones)) {
      return { zones, matched: true };
    }
    if (pageZones.length === 0) {
      return { zones, matched: false };
    }

    zones.push(...pageZones);
  }

  throw new CloudnsApiError("CloudNS zone pagination limit exceeded");
}

function normalizeZone(zone) {
  return {
    name: zone.name ?? zone.zone ?? zone.domain ?? zone["domain-name"] ?? zone.domainName,
  };
}

function compact(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function maybeNumber(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return Number(value);
}
