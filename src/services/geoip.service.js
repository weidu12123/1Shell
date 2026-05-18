'use strict';

const dns = require('dns');
const { LOCAL_HOST_ID } = require('../config/env');
const { isIpAddress, isPrivateIp } = require('../utils/ip');

const DNS_TIMEOUT_MS = 5000;
const REMOTE_TIMEOUT_MS = 5000;
const REMOTE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REMOTE_API_BASE = 'http://ip-api.com/json/';
const REMOTE_API_FIELDS = 'status,message,country,countryCode,region,regionName,city,lat,lon,query';

function dnsLookupWithTimeout(hostname) {
  return Promise.race([
    dns.promises.lookup(hostname),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('dns timeout')), DNS_TIMEOUT_MS)
    ),
  ]);
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function createGeoIpService() {
  const remoteCache = new Map();

  async function resolveByRemoteApi(ip) {
    const cached = remoteCache.get(ip);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    let data;
    try {
      data = await fetchJsonWithTimeout(
        `${REMOTE_API_BASE}${encodeURIComponent(ip)}?fields=${REMOTE_API_FIELDS}`,
        REMOTE_TIMEOUT_MS
      );
    } catch {
      return { ok: false, reason: 'timeout' };
    }

    if (!data || data.status !== 'success') {
      return { ok: false, reason: data?.message === 'private range' ? 'private-ip' : 'no-data' };
    }

    if (typeof data.lat !== 'number' || typeof data.lon !== 'number') {
      return { ok: false, reason: 'no-data' };
    }

    const result = {
      ok: true,
      ip: data.query || ip,
      country: data.country || null,
      countryCode: data.countryCode || null,
      region: data.region || null,
      regionName: data.regionName || null,
      city: data.city || null,
      lat: data.lat,
      lng: data.lon,
      source: 'remote-api',
    };

    remoteCache.set(ip, { data: result, expiresAt: Date.now() + REMOTE_CACHE_TTL_MS });
    return result;
  }

  async function resolveHost(hostRecord) {
    // 手动定位优先：用户在前端选好了就直接用，跳过 DNS / IP-API
    if (hostRecord.manualLocation) {
      const m = hostRecord.manualLocation;
      return {
        ok: true,
        ip: hostRecord.host || '',
        country: m.country || null,
        countryCode: m.countryCode || null,
        region: null,
        regionName: null,
        city: m.city || null,
        lat: m.lat,
        lng: m.lng,
        source: 'manual',
      };
    }

    if (hostRecord.id === LOCAL_HOST_ID || hostRecord.type === 'local') {
      return { ok: false, reason: 'local-or-no-ip' };
    }
    const rawHost = hostRecord.host;
    if (!rawHost) return { ok: false, reason: 'local-or-no-ip' };

    let ip = rawHost;
    if (!isIpAddress(ip)) {
      try {
        ip = (await dnsLookupWithTimeout(ip)).address;
      } catch {
        return { ok: false, reason: 'dns-failed' };
      }
    }
    if (isPrivateIp(ip)) return { ok: false, reason: 'private-ip' };

    return resolveByRemoteApi(ip);
  }

  return {
    resolveHost,
    provider: () => 'remote-api',
  };
}

module.exports = { createGeoIpService };
