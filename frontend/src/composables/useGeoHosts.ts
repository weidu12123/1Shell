import { ref, type Ref } from 'vue';
import { useApiClient } from '@/composables/useApiClient';
import { DEFAULT_PAGE_STATE_TTL_MS, getCachedPageState, isPageStateFresh, readStorageState, setCachedPageState, writeStorageState } from '@/composables/usePageState';

export interface GeoHost {
  id: string;
  name: string;
  host: string;
  ip: string;
  country: string | null;
  countryCode: string | null;
  region: string | null;
  regionName: string | null;
  city: string | null;
  lat: number;
  lng: number;
  source?: 'remote-api' | 'manual' | string;
  online?: boolean | null;
  stale?: boolean;
  probeSource?: 'ssh' | 'agent' | 'relay_agent' | string;
  probeCheckedAt?: string | number | null;
  probeLastSuccessAt?: string | number | null;
  probeAgentOnline?: boolean | null;
  probeSshOnline?: boolean | null;
  probeError?: string | null;
}

export type UnresolvedReason =
  | 'local-or-no-ip'
  | 'dns-failed'
  | 'private-ip'
  | 'no-data'
  | 'timeout';

export interface UnresolvedHost {
  id: string;
  name: string;
  reason: UnresolvedReason;
  online?: boolean | null;
  stale?: boolean;
  probeSource?: 'ssh' | 'agent' | 'relay_agent' | string;
  probeCheckedAt?: string | number | null;
  probeLastSuccessAt?: string | number | null;
  probeAgentOnline?: boolean | null;
  probeSshOnline?: boolean | null;
  probeError?: string | null;
}

export interface GeoHostsState {
  hosts: Ref<GeoHost[]>;
  unresolved: Ref<UnresolvedHost[]>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  refresh: (force?: boolean) => Promise<void>;
}

interface GeoHostsCache {
  hosts: GeoHost[];
  unresolved: UnresolvedHost[];
}

const GEO_CACHE_KEY = 'home.geo-hosts.v1';
const GEO_STORAGE_KEY = '1shell.home.geo-hosts.v1';

export function useGeoHosts(): GeoHostsState {
  const { requestJson } = useApiClient();
  const cached = getCachedPageState<GeoHostsCache>(GEO_CACHE_KEY)?.value
    ?? readStorageState<GeoHostsCache>(GEO_STORAGE_KEY, { hosts: [], unresolved: [] });
  const hosts = ref<GeoHost[]>(cached.hosts);
  const unresolved = ref<UnresolvedHost[]>(cached.unresolved);
  const loading = ref(false);
  const error = ref<string | null>(null);

  function saveCache(): void {
    const value = { hosts: hosts.value, unresolved: unresolved.value };
    setCachedPageState(GEO_CACHE_KEY, value);
    writeStorageState(GEO_STORAGE_KEY, value);
  }

  async function refresh(force = false): Promise<void> {
    if (!force && hosts.value.length > 0 && isPageStateFresh(GEO_CACHE_KEY, DEFAULT_PAGE_STATE_TTL_MS)) return;
    loading.value = true;
    error.value = null;
    try {
      const data = await requestJson<{
        hosts: GeoHost[];
        unresolved: UnresolvedHost[];
      }>('/api/geo/hosts');
      hosts.value = data.hosts || [];
      unresolved.value = data.unresolved || [];
      saveCache();
    } catch (err) {
      error.value = (err as Error).message || '加载地理信息失败';
    } finally {
      loading.value = false;
    }
  }

  return { hosts, unresolved, loading, error, refresh };
}
