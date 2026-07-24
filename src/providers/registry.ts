/**
 * Built-in OpenAI-compatible provider registry.
 */

/** Built-in LLM inference provider ids. */
export type ProviderId =
  | 'ollama'
  | 'gemini'
  | 'groq'
  | 'cerebras'
  | 'mistral'
  | 'nvidia'
  | 'github'
  | 'zai'
  | 'puter'
  | 'opencode'
  | 'huggingface'
  | 'openrouter'
  | 'cohere'
  | 'openai'
  | 'openai_compatible';

/** Soft default rate-limit hints (overridden by live headers when available). */
export interface RateLimitHint {
  rpm?: number;
  tpm?: number;
  rpd?: number;
  tpd?: number;
  notes?: string;
}

/** Static metadata for a built-in provider. */
export interface ProviderMeta {
  id: ProviderId;
  /** Human-readable label. */
  label: string;
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  supportsModelList: boolean;
  supportsStreaming: boolean;
  /** Lower = preferred in auto / cheapest routing. */
  autoPriority: number;
  /** Treated as free-tier friendly unless marked paid in config. */
  defaultFree: boolean;
  isLocal?: boolean;
  fixedTemperature?: number;
  freeTierHints?: RateLimitHint;
  docsUrl?: string;
  apiKeyUrl?: string;
  suggestedModels?: string[];
}

/**
 * Built-in provider registry (endpoints and soft free-tier hints).
 * Verified against public docs around mid-2026; re-check limits in production.
 */
export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    requiresApiKey: false,
    supportsModelList: true,
    supportsStreaming: true,
    autoPriority: 1,
    defaultFree: true,
    isLocal: true,
    docsUrl: 'https://docs.ollama.com/api/openai-compatibility',
    freeTierHints: { notes: 'Local hardware only; no cloud quota.' },
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresApiKey: true,
    supportsModelList: true,
    supportsStreaming: true,
    autoPriority: 2,
    defaultFree: true,
    docsUrl: 'https://ai.google.dev/gemini-api/docs/rate-limits',
    apiKeyUrl: 'https://aistudio.google.com/api-keys',
    suggestedModels: ['gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-3-flash-preview'],
    freeTierHints: {
      rpm: 10,
      tpm: 250000,
      rpd: 1500,
      notes:
        'Per Google Cloud project; live limits in AI Studio. Flash models preferred on free tier.',
    },
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    requiresApiKey: true,
    supportsModelList: true,
    supportsStreaming: true,
    autoPriority: 3,
    defaultFree: true,
    docsUrl: 'https://console.groq.com/docs/rate-limits',
    apiKeyUrl: 'https://console.groq.com/keys',
    suggestedModels: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'qwen/qwen3-32b'],
    freeTierHints: {
      rpm: 30,
      tpm: 6000,
      rpd: 14400,
      notes: 'Per-org; model-specific RPD/TPM — check console limits page.',
    },
  },
  cerebras: {
    id: 'cerebras',
    label: 'Cerebras',
    defaultBaseUrl: 'https://api.cerebras.ai/v1',
    requiresApiKey: true,
    supportsModelList: true,
    supportsStreaming: true,
    autoPriority: 4,
    defaultFree: true,
    docsUrl: 'https://inference-docs.cerebras.ai/',
    apiKeyUrl: 'https://cloud.cerebras.ai/',
    suggestedModels: ['llama-3.3-70b', 'qwen-3-32b'],
    freeTierHints: {
      rpm: 30,
      tpd: 1000000,
      notes: 'Generous daily token free tier; confirm live limits in console.',
    },
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral AI',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    requiresApiKey: true,
    supportsModelList: true,
    supportsStreaming: true,
    autoPriority: 5,
    defaultFree: true,
    docsUrl: 'https://docs.mistral.ai/admin/user-management-finops/tier',
    apiKeyUrl: 'https://console.mistral.ai/api-keys',
    suggestedModels: ['mistral-small-latest', 'open-mistral-nemo'],
    freeTierHints: {
      rpm: 60,
      notes: 'Free evaluation mode; check org Limits panel for live values.',
    },
  },
  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
    requiresApiKey: true,
    supportsModelList: true,
    supportsStreaming: true,
    autoPriority: 6,
    defaultFree: true,
    docsUrl: 'https://build.nvidia.com/',
    apiKeyUrl: 'https://build.nvidia.com/settings/api-keys',
    suggestedModels: ['meta/llama-3.1-8b-instruct', 'nvidia/llama-3.1-nemotron-70b-instruct'],
    freeTierHints: {
      rpm: 40,
      notes: 'NVIDIA Developer Program free trial / credits; ~40 RPM typical.',
    },
  },
  github: {
    id: 'github',
    label: 'GitHub Models',
    defaultBaseUrl: 'https://models.github.ai/inference',
    requiresApiKey: true,
    supportsModelList: true,
    supportsStreaming: true,
    autoPriority: 7,
    defaultFree: true,
    docsUrl: 'https://docs.github.com/en/github-models/prototyping-with-ai-models',
    apiKeyUrl: 'https://github.com/settings/tokens',
    suggestedModels: ['openai/gpt-4.1-mini', 'openai/gpt-4o-mini'],
    freeTierHints: {
      rpm: 15,
      rpd: 150,
      notes: 'Free tier depends on Copilot plan; see GitHub Models rate table.',
    },
  },
  zai: {
    id: 'zai',
    label: 'Zhipu AI / Z.ai',
    defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
    requiresApiKey: true,
    supportsModelList: true,
    supportsStreaming: true,
    autoPriority: 8,
    defaultFree: false,
    docsUrl: 'https://docs.z.ai/guides/develop/openai/python',
    apiKeyUrl: 'https://z.ai/manage-apikey',
    suggestedModels: ['glm-4.5-flash', 'glm-4-flash'],
    freeTierHints: {
      notes: 'Flash models may have free quotas; confirm on Z.AI console.',
    },
  },
  puter: {
    id: 'puter',
    label: 'Puter AI Gateway',
    defaultBaseUrl: 'https://api.puter.com/puterai/openai/v1',
    requiresApiKey: true,
    supportsModelList: true,
    supportsStreaming: true,
    autoPriority: 9,
    defaultFree: true,
    fixedTemperature: 1,
    docsUrl: 'https://developer.puter.com/',
    apiKeyUrl: 'https://puter.com/dashboard#account',
    suggestedModels: [
      'gpt-5-nano',
      'gemini-2.5-flash-lite',
      'glm-4.7-flash',
      'qwen-flash',
      'minimax-m2.5',
    ],
    freeTierHints: {
      notes:
        'User-Pays: usage draws from your Puter account credits. Prefer nano/flash/lite models under free-only.',
    },
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode Zen',
    defaultBaseUrl: 'https://opencode.ai/zen/v1',
    requiresApiKey: true,
    supportsModelList: true,
    supportsStreaming: true,
    autoPriority: 10,
    defaultFree: false,
    docsUrl: 'https://opencode.ai/docs/zen/',
    apiKeyUrl: 'https://opencode.ai/auth',
    suggestedModels: [
      'deepseek-v4-flash-free',
      'mimo-v2.5-free',
      'nemotron-3-ultra-free',
      'big-pickle',
    ],
    freeTierHints: {
      notes: 'Only *-free / listed free models are free; rest is pay-as-you-go.',
    },
  },
  huggingface: {
    id: 'huggingface',
    label: 'Hugging Face',
    defaultBaseUrl: 'https://router.huggingface.co/v1',
    requiresApiKey: true,
    supportsModelList: true,
    supportsStreaming: true,
    autoPriority: 11,
    defaultFree: true,
    docsUrl: 'https://huggingface.co/docs/inference-providers',
    apiKeyUrl: 'https://huggingface.co/settings/tokens',
    suggestedModels: ['meta-llama/Llama-3.1-8B-Instruct'],
    freeTierHints: {
      notes: 'Free credits / rate limits vary by HF account tier.',
    },
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    supportsModelList: true,
    supportsStreaming: true,
    autoPriority: 12,
    defaultFree: false,
    docsUrl: 'https://openrouter.ai/docs/guides/routing/model-selection',
    apiKeyUrl: 'https://openrouter.ai/keys',
    suggestedModels: ['openrouter/free'],
    freeTierHints: {
      notes: 'Free models are limited; prefer as fallback only.',
    },
  },
  cohere: {
    id: 'cohere',
    label: 'Cohere',
    defaultBaseUrl: 'https://api.cohere.com/compatibility/v1',
    requiresApiKey: true,
    supportsModelList: true,
    supportsStreaming: true,
    autoPriority: 13,
    defaultFree: true,
    docsUrl: 'https://docs.cohere.com/docs/rate-limits',
    apiKeyUrl: 'https://dashboard.cohere.com/api-keys',
    suggestedModels: ['command-a-03-2025', 'command-a-plus-05-2026'],
    freeTierHints: {
      notes: 'Trial / free credits; check Cohere dashboard.',
    },
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    supportsModelList: true,
    supportsStreaming: true,
    autoPriority: 50,
    defaultFree: false,
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    suggestedModels: ['gpt-4.1-mini', 'gpt-4o-mini', 'o4-mini'],
    freeTierHints: {
      notes: 'Pay-as-you-go Platform API; skipped in free-only / cheapest mode.',
    },
  },
  openai_compatible: {
    id: 'openai_compatible',
    label: 'Custom OpenAI-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    supportsModelList: true,
    supportsStreaming: true,
    autoPriority: 100,
    defaultFree: false,
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    freeTierHints: {
      notes: 'Custom endpoint — set baseUrl and mark isPaid appropriately.',
    },
  },
};

/** Provider ids sorted by ascending autoPriority. */
export const PROVIDER_AUTO_ORDER: ProviderId[] = (Object.values(PROVIDERS) as ProviderMeta[])
  .slice()
  .sort((a, b) => a.autoPriority - b.autoPriority)
  .map((p) => p.id);

/** Type guard for known provider ids. */
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}

/** Fixed temperature required by a provider, if any. */
export function getFixedTemperature(provider: ProviderId): number | undefined {
  const value = PROVIDERS[provider].fixedTemperature;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Heuristic: whether a model id looks free on a given provider.
 * Used by the `cheapest` routing strategy.
 */
export function isLikelyFreeModel(provider: ProviderId, model: string): boolean {
  const m = model.trim().toLowerCase();
  if (!m) {
    return PROVIDERS[provider].defaultFree;
  }

  if (provider === 'ollama') {
    return true;
  }
  if (provider === 'opencode') {
    return m.includes('free') || m === 'big-pickle';
  }
  if (provider === 'puter') {
    return (
      m.includes('nano') ||
      m.includes('flash') ||
      m.includes('lite') ||
      m.includes('mini') ||
      m.includes('small') ||
      m.includes('instant')
    );
  }
  if (provider === 'openrouter') {
    return m.includes(':free') || m.endsWith('/free') || m.includes('free');
  }
  if (provider === 'zai') {
    return m.includes('flash');
  }
  if (provider === 'gemini') {
    if (/\bpro\b/.test(m) && !m.includes('flash')) {
      return false;
    }
    return true;
  }
  if (provider === 'openai') {
    return false;
  }
  if (provider === 'openai_compatible') {
    return false;
  }

  return PROVIDERS[provider].defaultFree;
}

/** Resolve effective base URL (no trailing slash). */
export function resolveBaseUrl(provider: ProviderId, baseUrl?: string): string {
  const raw = (baseUrl || PROVIDERS[provider].defaultBaseUrl).trim();
  return raw.replace(/\/+$/, '');
}
