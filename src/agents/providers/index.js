'use strict';

const { getAllManifests } = require('../cli-manifest');
const {
  AGENT_DEFAULT_PROVIDER,
} = require('../../config/env');

function createAgentProviders({ cliSandbox } = {}) {
  function createProviderFromManifest(manifest) {
    return {
      id: manifest.id,
      label: manifest.name,
      command: manifest.binary,
      args({ useLocalEnv } = {}) {
        if (cliSandbox && !useLocalEnv) {
          return cliSandbox.buildLaunchArgs(manifest.id, {
            useLocalEnv: false,
            cwd: process.cwd(),
          });
        }
        return [...(manifest.launchArgs || [])];
      },
      env({ host, hostId, useLocalEnv } = {}) {
        const base = {
          FORCE_COLOR: '1',
          TERM: 'xterm-256color',
        };

        if (cliSandbox && !useLocalEnv) {
          const sandboxEnv = cliSandbox.buildLaunchEnv(manifest.id, {
            useLocalEnv: false,
            cwd: process.cwd(),
          });
          Object.assign(base, sandboxEnv);
        }

        return base;
      },
    };
  }

  const providers = getAllManifests().map(createProviderFromManifest);
  const providerMap = new Map(providers.map(p => [p.id, p]));

  function listProviders() {
    return providers.map(p => {
      let configured = false;
      let activeProviderName = '';
      let upstreamProtocol = '';
      let model = '';
      if (cliSandbox) {
        const status = cliSandbox.getSandboxStatus(p.id);
        configured = status.sandboxed;
      }
      return {
        id: p.id,
        label: p.label,
        isDefault: p.id === AGENT_DEFAULT_PROVIDER,
        configured,
        activeProviderName,
        upstreamProtocol,
        model,
      };
    });
  }

  function getProvider(providerId = AGENT_DEFAULT_PROVIDER) {
    return providerMap.get(providerId)
      || providerMap.get(AGENT_DEFAULT_PROVIDER)
      || providers[0]
      || null;
  }

  return { getProvider, listProviders };
}

module.exports = { createAgentProviders };