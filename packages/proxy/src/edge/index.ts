import { DEFAULT_BRAINTRUST_APP_URL } from "@/constants";
import { flushMetrics } from "@/metrics";
import { proxyV1 } from "@/proxy";
import { isEmpty } from "@/util";
import { MeterProvider } from "@opentelemetry/sdk-metrics";

import { APISecret, getModelEndpointTypes, isFireworksModel, isAnthropicModel, isBedrockModel, isGroqModel, isOpenAIModel, isGoogleModel, isXAIModel, isMistralModel, isPerplexityModel } from "@/schema";
import { verifyTempCredentials, isTempCredential } from "@/utils/tempCredentials";
import {
  decryptMessage,
  EncryptedMessage,
  encryptMessage,
} from "@/utils/encrypt";

export { FlushingExporter } from "./exporter";

export interface EdgeContext {
  waitUntil(promise: Promise<any>): void;
}

export interface CacheSetOptions {
  ttl?: number;
}
export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, options?: { ttl?: number }): Promise<void>;
}

export interface ProxyOpts {
  getRelativeURL(request: Request): string;
  cors?: boolean;
  credentialsCache?: Cache;
  completionsCache?: Cache;
  authConfig?: {
    type: "cloudflare";
    /**
     * The API key to use for proxy authentication
     */
    apiKey: string;
    /**
     * A function that returns the API secret for a given model
     */
    getSecret: (model: string) => Promise<APISecret> | APISecret;
  } | {
    type: "braintrust";
    braintrustApiUrl?: string;
  }
  meterProvider?: MeterProvider;
  whitelist?: (string | RegExp)[];
}

const defaultWhitelist: (string | RegExp)[] = [
  "https://www.braintrustdata.com",
  "https://www.braintrust.dev",
  new RegExp("https://.*-braintrustdata.vercel.app"),
  new RegExp("https://.*.preview.braintrust.dev"),
];

const baseCorsHeaders = {
  "access-control-allow-credentials": "true",
  "access-control-allow-methods": "GET,OPTIONS,POST",
};

export function getCorsHeaders(
  request: Request,
  whitelist: (string | RegExp)[] | undefined,
) {
  whitelist = whitelist || defaultWhitelist;

  // If the host is not in the whitelist, return a 403.
  const origin = request.headers.get("Origin");
  if (
    origin &&
    !whitelist.some(
      (w) => w === origin || (w instanceof RegExp && w.test(origin)),
    )
  ) {
    throw new Error("Forbidden");
  }

  return origin
    ? {
      "access-control-allow-origin": origin,
      ...baseCorsHeaders,
    }
    : {};
}

// https://developers.cloudflare.com/workers/examples/cors-header-proxy/
async function handleOptions(
  request: Request,
  corsHeaders: Record<string, string>,
) {
  if (
    request.headers.get("Origin") !== null &&
    request.headers.get("Access-Control-Request-Method") !== null &&
    request.headers.get("Access-Control-Request-Headers") !== null
  ) {
    // Handle CORS preflight requests.
    return new Response(null, {
      headers: {
        ...corsHeaders,
        "access-control-allow-headers": request.headers.get(
          "Access-Control-Request-Headers",
        )!,
      },
    });
  } else {
    // Handle standard OPTIONS request.
    return new Response(null, {
      headers: {
        Allow: "GET, HEAD, POST, OPTIONS",
      },
    });
  }
}

export async function digestMessage(message: string) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

export function makeFetchApiSecrets({
  ctx,
  opts,
}: {
  ctx: EdgeContext;
  opts: ProxyOpts;
}) {
  return async (
    useCache: boolean,
    authToken: string,
    model: string | null,
    org_name?: string,
  ): Promise<APISecret[]> => {
    if (opts.authConfig?.type === "cloudflare") {
      if (authToken !== opts.authConfig.apiKey) {
        throw new Error("Forbidden");
      }

      if (!model) {
        throw new Error("no model provided");
      }

      const secret = await opts.authConfig.getSecret(model);
      return [secret];
    }

    // First try to decode & verify as JWT. We gate this on Braintrust JWT
    // format, not just any JWT, in case a future model provider uses JWT as
    // the auth token.
    if (opts.credentialsCache && isTempCredential(authToken)) {
      try {
        const { jwtPayload, credentialCacheValue } =
          await verifyTempCredentials({
            jwt: authToken,
            cacheGet: opts.credentialsCache.get,
          });

        // Overwrite parameters with those from JWT.
        authToken = credentialCacheValue.authToken;
        model = jwtPayload.bt.model || null;
        org_name = jwtPayload.bt.org_name || undefined;
        // Fall through to normal secrets lookup.
      } catch (error) {
        // Re-throw to filter out everything except `message`.
        console.error(error);
        throw new Error(error instanceof Error ? error.message : undefined);
      }
    }

    const cacheKey = await digestMessage(
      `${model}/${org_name ? org_name + ":" : ""}${authToken}`,
    );

    const response =
      useCache &&
      opts.credentialsCache &&
      (await encryptedGet(opts.credentialsCache, cacheKey, cacheKey));
    if (response) {
      console.log("API KEY CACHE HIT");
      return JSON.parse(response);
    } else {
      console.log("API KEY CACHE MISS");
    }

    let secrets: APISecret[] = [];
    let lookupFailed = false;
    // Only cache API keys for 60 seconds. This reduces the load on the database but ensures
    // that changes roll out quickly enough too.
    let ttl = 60;
    try {
      const response = await fetch(
        `${opts.authConfig?.braintrustApiUrl || DEFAULT_BRAINTRUST_APP_URL}/api/secret`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            org_name,
            mode: "full",
          }),
        },
      );
      if (response.ok) {
        secrets = await response.json();
      } else {
        lookupFailed = true;
        console.warn("Failed to lookup api key", await response.text());
      }
    } catch (e) {
      lookupFailed = true;
      console.warn("Failed to lookup api key. Falling back to provided key", e);
    }

    if (lookupFailed) {
      const endpointTypes = !isEmpty(model) ? getModelEndpointTypes(model) : [];
      secrets.push({
        secret: authToken,
        type: endpointTypes[0] ?? "openai",
      });
    }

    if (opts.credentialsCache) {
      ctx.waitUntil(
        encryptedPut(
          opts.credentialsCache,
          cacheKey,
          cacheKey,
          JSON.stringify(secrets),
          {
            ttl,
          },
        ),
      );
    }

    return secrets;
  };
}

export function EdgeProxyV1(opts: ProxyOpts) {
  const meterProvider = opts.meterProvider;
  return async (request: Request, ctx: EdgeContext) => {
    let corsHeaders = {};
    try {
      if (opts.cors) {
        corsHeaders = getCorsHeaders(request, opts.whitelist);
      }
    } catch (e) {
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method === "OPTIONS" && opts.cors) {
      return handleOptions(request, corsHeaders);
    }
    if (request.method !== "GET" && request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const relativeURL = opts.getRelativeURL(request);

    // Create an identity TransformStream (a.k.a. a pipe).
    // The readable side will become our new response body.
    let { readable, writable } = new TransformStream();

    let status = 200;

    let headers: Record<string, string> = opts.cors ? corsHeaders : {};

    const setStatus = (code: number) => {
      status = code;
    };
    const setHeader = (name: string, value: string) => {
      headers[name] = value;
    };

    const proxyHeaders: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      proxyHeaders[name] = value;
    });

    const cacheGet = async (encryptionKey: string, key: string) => {
      if (opts.completionsCache) {
        return (
          (await encryptedGet(opts.completionsCache, encryptionKey, key)) ??
          null
        );
      } else {
        return null;
      }
    };

    const fetchApiSecrets = makeFetchApiSecrets({ ctx, opts });

    const cachePut = async (
      encryptionKey: string,
      key: string,
      value: string,
      ttl_seconds?: number,
    ): Promise<void> => {
      if (opts.completionsCache) {
        const ret = encryptedPut(
          opts.completionsCache,
          encryptionKey,
          key,
          value,
          {
            // 1 week if not specified
            ttl: ttl_seconds ?? 60 * 60 * 24 * 7,
          },
        );
        ctx.waitUntil(ret);
        return ret;
      }
    };

    try {
      await proxyV1({
        method: request.method,
        url: relativeURL,
        proxyHeaders,
        body: await request.text(),
        setHeader,
        setStatusCode: setStatus,
        res: writable,
        getApiSecrets: fetchApiSecrets,
        cacheGet,
        cachePut,
        digest: digestMessage,
        meterProvider,
      });
    } catch (e) {
      return new Response(`${e}`, {
        status: 400,
        headers: { "Content-Type": "text/plain" },
      });
    } finally {
      if (meterProvider) {
        ctx.waitUntil(flushMetrics(meterProvider));
      }
    }

    return new Response(readable, {
      status,
      headers,
    });
  };
}

export interface Secrets {
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  PERPLEXITY_API_KEY: string;
  REPLICATE_API_KEY: string;
  FIREWORKS_API_KEY: string;
  GOOGLE_API_KEY: string;
  XAI_API_KEY: string;

  TOGETHER_API_KEY: string;
  LEPTON_API_KEY: string;
  MISTRAL_API_KEY: string;
  OLLAMA_API_KEY: string;
  GROQ_API_KEY: string;
  CEREBRAS_API_KEY: string;

  BEDROCK_SECRET_KEY: string;
  BEDROCK_ACCESS_KEY: string;
  BEDROCK_REGION: string;
}

export function getApiSecret(model: string, secrets: Secrets): APISecret {
  if (isOpenAIModel(model)) {
    return {
      secret: secrets.OPENAI_API_KEY,
      type: "openai",
    };
  } else if (isAnthropicModel(model)) {
    return {
      secret: secrets.ANTHROPIC_API_KEY,
      type: "anthropic",
    };
  } else if (isBedrockModel(model)) {
    return {
      secret: secrets.BEDROCK_SECRET_KEY,
      type: "bedrock",
      metadata: {
        "region": secrets.BEDROCK_REGION,
        "access_key": secrets.BEDROCK_ACCESS_KEY,
        supportsStreaming: true,
      },
    };
  } else if (isGroqModel(model)) {
    return {
      secret: secrets.GROQ_API_KEY,
      type: "groq",
    };
  } else if (isFireworksModel(model)) {
    return {
      secret: secrets.FIREWORKS_API_KEY,
      type: "fireworks",
    };
  } else if (isGoogleModel(model)) {
    return {
      secret: secrets.GOOGLE_API_KEY,
      type: "google",
    };
  } else if (isXAIModel(model)) {
    return {
      secret: secrets.XAI_API_KEY,
      type: "xAI",
    };
  } else if (isMistralModel(model)) {
    return {
      secret: secrets.MISTRAL_API_KEY,
      type: "mistral",
    };
  } else if (isPerplexityModel(model)) {
    return {
      secret: secrets.PERPLEXITY_API_KEY,
      type: "perplexity",
    };
  }

  throw new Error(`could not find secret for model ${model}`);
}

// We rely on the fact that Upstash will automatically serialize and deserialize things for us
export async function encryptedGet(
  cache: Cache,
  encryptionKey: string,
  key: string,
) {
  const message = await cache.get<EncryptedMessage>(key);
  if (isEmpty(message)) {
    return null;
  }

  return await decryptMessage(encryptionKey, message.iv, message.data);
}

async function encryptedPut(
  cache: Cache,
  encryptionKey: string,
  key: string,
  value: string,
  options?: { ttl?: number },
) {
  options = options || {};

  const encryptedValue = await encryptMessage(encryptionKey, value);
  await cache.set(key, encryptedValue, options);
}
