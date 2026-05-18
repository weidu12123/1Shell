'use strict';

// Match IPv4 literal a.b.c.d (each 0-255). Doesn't validate ranges strictly
// but is good enough to differentiate "203.0.113.42" from "vps.example.com".
function isIpAddress(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

// RFC1918 + loopback + link-local — anything we shouldn't bother
// querying GeoIP for.
function isPrivateIp(ip) {
  if (!isIpAddress(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

module.exports = { isIpAddress, isPrivateIp };
