import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ============================================
// MCP SERVER DEFINITION
// ============================================
const server = new McpServer({
	name: "quotes",
	version: "1.0.0",
	capabilities: {
		resources: {},
		tools: {},
	},
});

// ============================================
// VALIDATION SCHEMES
// ============================================
const DollarSchema = z.object({
	USDBRL: z.object({
		bid: z.string(),
		ask: z.string(),
		code: z.string(),
		codein: z.string(),
	}),
});

const BitcoinSchema = z.object({
	bitcoin: z.object({
		brl: z.number(),
	}),
});

const IbovSchema = z.object({
	results: z.array(
		z.object({
			symbol: z.string(),
			regularMarketPrice: z.number(),
			currency: z.string(),
			regularMarketChange: z.number().optional(),
			regularMarketChangePercent: z.number().optional(),
		}),
	),
});

// ============================================
// FUNCTIONS HELPERS
// ============================================
// FORMAT CURRENCY BRL
const formatBRL = (value: number): string => {
	return new Intl.NumberFormat("pt-BR", {
		style: "currency",
		currency: "BRL",
	}).format(value);
};

// URL VALIDATION
function validateUrl(url: string): boolean {
	try {
		const parsedUrl = new URL(url);
		return ["https:", "http:"].includes(parsedUrl.protocol);
	} catch {
		return false;
	}
}

// DEBUG LOG HELPER
function debugLog(message: string, data?: any, forceLog = false) {
	const shouldLog = process.env.DEBUG === "true" || forceLog;

	if (!shouldLog) return;

	const timestamp = new Date().toISOString();
	const logMessage = data
		? `[${timestamp}] ${message} ${JSON.stringify(data, null, 2)}`
		: `[${timestamp}] ${message}`;

	console.error(logMessage);
}

// Helper to format duration in a readable format.
function formatDuration(seconds: number): string {
	if (seconds < 60) {
		return `${seconds}s`;
	} else if (seconds < 3600) {
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = seconds % 60;
		return remainingSeconds > 0
			? `${minutes}m ${remainingSeconds}s`
			: `${minutes}m`;
	} else {
		const hours = Math.floor(seconds / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	}
}

// ============================================
// DEBUG ERROR HANDLING HELPER
// ============================================
enum ApiErrorType {
	NETWORK_ERROR = "NETWORK_ERROR",
	TIMEOUT_ERROR = "TIMEOUT_ERROR",
	API_ERROR = "API_ERROR",
	VALDATION_ERROR = "VALIDATION_ERROR",
	RATE_LIMIT_ERROR = "RATE_LIMIT_ERROR",
}

class ApiError extends Error {
	constructor(
		public type: ApiErrorType,
		message: string,
		public originalError?: any,
	) {
		super(message);
		this.name = "ApiError";
	}
}

// ================================================================================
//  Cache Manager
// TTL (Time To Live): 15s is good for quotes (updates quickly but not excessively)
// LRU eviction: Removes older entries when it reaches the limit
// Periodic cleanup: Automatically removes expired entries
// Hits tracking: Allows analysis of which endpoints are most used
// ================================================================================

interface CacheConfig {
	defaultTtl: number;
	maxEntries: number;
	enableCache: boolean;
	cleanupInterval: number;
}

interface CacheEntry {
	createdAt: number; // Creation timestamp (for TTL)
	lastAccessTime: number; // Last access timestamp (for LRU)
	value: any;
	hits: number;
}

interface CacheStats {
	size: number;
	maxEntries: number;
	totalHits: number;
	totalMisses: number;
	hitRate: number;
	missRate: number;
	entries: Array<{
		key: string;
		ageMs: number;
		timeSinceLastAccessMs: number;
		hits: number;
	}>;
}

// ============================================
// CACHE MANAGER
// ============================================
class CacheManager {
	private cache = new Map<string, CacheEntry>();
	private cleanupTimer?: NodeJS.Timeout;
	private totalHits = 0;
	private totalMisses = 0;
	private isCleanupRunning = false;

	constructor(private config: CacheConfig) {
		if (config.enableCache) {
			this.startCleanupTimer();
			debugLog(
				`Cache initialized | TTL: ${config.defaultTtl}ms | Max entries: ${config.maxEntries} | Cleanup interval: ${config.cleanupInterval}ms`,
				null,
				true, // Define the cache log as critical and configure it to always be visible.
			);
		} else {
			debugLog("Cache disabled in configuration", null, true);
		}
	}

	get<T>(key: string, ttlMs?: number): T | null {
		if (!this.config.enableCache) {
			debugLog(`Cache disabled - returning null for: ${key}`);
			return null;
		}

		const entry = this.cache.get(key);
		const effectiveTtl = ttlMs ?? this.config.defaultTtl;
		const now = Date.now();

		if (!entry) {
			this.totalMisses++;
			debugLog(
				`Cache miss (no entry): ${key} | Total misses: ${this.totalMisses} | Cache size: ${this.cache.size}`,
			);
			return null;
		}

		const age = now - entry.createdAt;

		if (age >= effectiveTtl) {
			this.cache.delete(key);
			this.totalMisses++;
			debugLog(
				`Cache miss (expired): ${key} | Age: ${age}ms | TTL: ${effectiveTtl}ms | Expired by: ${age - effectiveTtl}ms`,
			);
			return null;
		}

		this.totalHits++;
		entry.hits++;

		// Atualiza lastAccessTime para LRU
		entry.lastAccessTime = now;

		debugLog(
			`Cache hit: ${key} | Age: ${age}ms | TTL: ${effectiveTtl}ms | Remaining: ${effectiveTtl - age}ms | Hits: ${entry.hits} | Total hits: ${this.totalHits}`,
		);

		return entry.value as T;
	}

	set(key: string, value: any): void {
		if (!this.config.enableCache) {
			debugLog(`Cache disabled - not storing: ${key}`);
			return;
		}

		while (this.cache.size >= this.config.maxEntries) {
			debugLog(
				`Cache at max entries (${this.config.maxEntries}) - evicting LRU`,
			);
			this.evictLRU();
		}

		const now = Date.now();

		this.cache.set(key, {
			createdAt: now,
			lastAccessTime: now,
			value,
			hits: 0,
		});

		debugLog(
			`Cache set: ${key} | Created at: ${now} | Cache size: ${this.cache.size}/${this.config.maxEntries} | TTL: ${this.config.defaultTtl}ms`,
		);
	}

	// ==========================================================
	// LRU (Least Recently Used) Eviction
	// Removes the entry that was accessed the longest time ago
	// ==========================================================
	private evictLRU(): void {
		let lruKey = "";
		let lruTime = Date.now();

		for (const [key, entry] of this.cache.entries()) {
			if (entry.lastAccessTime < lruTime) {
				lruTime = entry.lastAccessTime;
				lruKey = key;
			}
		}

		if (lruKey) {
			this.cache.delete(lruKey);
			debugLog(`LRU eviction: removido ${lruKey}`);
		}
	}

	// ==========================================================
	// Starts cleanup timer with error handling
	// ==========================================================
	private startCleanupTimer(): void {
		this.cleanupTimer = setInterval(async () => {
			try {
				await this.cleanup();
			} catch (error) {
				debugLog("❌ Erro durante cleanup do cache:", error);
			}
		}, this.config.cleanupInterval);
	}

	// ==========================================================
	// - Uses the same expiration logic as get() (age >= TTL)
	// - Prevents overlapping execution
	// - Removes only truly expired entries
	// ==========================================================
	private async cleanup(): Promise<void> {
		// Previne cleanup sobreposto
		if (this.isCleanupRunning) {
			debugLog("⏭️ Cleanup já em execução, pulando...");
			return;
		}

		this.isCleanupRunning = true;

		try {
			const now = Date.now();
			const expiredKeys: string[] = [];

			for (const [key, entry] of this.cache.entries()) {
				const age = now - entry.createdAt;

				// Uses >= and simple TTL (not 2x)
				// Same logic as get() for consistency
				if (age >= this.config.defaultTtl) {
					expiredKeys.push(key);
					debugLog(
						`Cleanup: marcando entrada para remoção: ${key} (age: ${age}ms, ttl: ${this.config.defaultTtl}ms)`,
					);
				}
			}

			expiredKeys.forEach((key) => {
				this.cache.delete(key);
				debugLog(`Cleanup: removida entrada ${key}`);
			});

			if (expiredKeys.length > 0) {
				debugLog(
					`Limpeza do cache: ${expiredKeys.length} entradas removidas (${expiredKeys.join(", ")})`,
				);
			}
		} finally {
			this.isCleanupRunning = false;
		}
	}

	// ==========================================================
	// - Only counts valid (non-expired) entries
	// - Provides accurate data
	// ==========================================================
	getStats(): CacheStats {
		const now = Date.now();
		let activeEntries = 0;
		const entries: Array<{
			key: string;
			ageMs: number;
			timeSinceLastAccessMs: number;
			hits: number;
		}> = [];

		for (const [key, entry] of this.cache.entries()) {
			const age = now - entry.createdAt;

			if (age < this.config.defaultTtl) {
				activeEntries++;
				entries.push({
					key,
					ageMs: age,
					timeSinceLastAccessMs: now - entry.lastAccessTime,
					hits: entry.hits,
				});
			}
		}

		const totalRequests = this.totalHits + this.totalMisses;

		return {
			size: activeEntries,
			maxEntries: this.config.maxEntries,
			totalHits: this.totalHits,
			totalMisses: this.totalMisses,
			hitRate: totalRequests > 0 ? (this.totalHits / totalRequests) * 100 : 0,
			missRate:
				totalRequests > 0 ? (this.totalMisses / totalRequests) * 100 : 0,
			entries: entries.sort((a, b) => b.hits - a.hits),
		};
	}

	// ==========================================================
	// Destroy Limpa timer before cleaning cachex
	// ==========================================================
	destroy(): void {
		debugLog("🧹 Destruindo cache...", null, true);

		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = undefined;
		}

		const entriesCount = this.cache.size;
		this.cache.clear();
		this.totalHits = 0;
		this.totalMisses = 0;

		debugLog(`Cache destruído: ${entriesCount} entradas removidas`, null, true);
	}
}

// Cache Configuration
// DEFAULT TTL: 60 SECONDS (60000ms)
const cacheConfig: CacheConfig = {
	defaultTtl: parseInt(process.env.CACHE_TTL || "60000", 10),
	maxEntries: parseInt(process.env.CACHE_MAX_ENTRIES || "100", 10),
	enableCache: process.env.ENABLE_CACHE !== "false",
	cleanupInterval: parseInt(process.env.CACHE_CLEANUP_INTERVAL || "60000", 10),
};

const cache = new CacheManager(cacheConfig);

// ============================================
// RATE LIMIIT
// ============================================
interface RateLimitConfig {
	maxRequests: number;
	windowMs: number;
}

class RateLimiter {
	private requests = new Map<string, number[]>();

	constructor(private config: RateLimitConfig) {}

	canMakeRequest(key: string): boolean {
		const now = Date.now();
		const request = this.requests.get(key) || [];

		const validRequests = request.filter(
			(time) => now - time < this.config.windowMs,
		);

		if (validRequests.length >= this.config.maxRequests) {
			debugLog(
				`Rate limit exceeded for key: ${key}: ${validRequests.length}/$this.config.maxRequests in window ${this.config.windowMs}ms`,
			);
			return false;
		}

		validRequests.push(now);
		this.requests.set(key, validRequests);

		return true;
	}

	cleanup(): void {
		const now = Date.now();
		for (const [key, requests] of this.requests.entries()) {
			const validRequests = requests.filter(
				(time) => now - time < this.config.windowMs,
			);

			if (validRequests.length === 0) {
				this.requests.delete(key);
			} else {
				this.requests.set(key, validRequests);
			}
		}
	}

	getStats() {
		return {
			activeKeys: this.requests.size,
			config: this.config,
			details: Array.from(this.requests.entries()).map(([key, requests]) => ({
				key,
				requests: requests.length,
			})),
		};
	}
}

// Configuração do Rate Limiter
const rateLimitConfig: RateLimitConfig = {
	maxRequests: 30,
	windowMs: 60000, // 1 minute
};

const rateLimiter = new RateLimiter(rateLimitConfig);

// ============================================
// HTTP REQUEST ABSTRACTION
// RETRY PATTERN
// WITH BACKOFF
// TIMEOUT HANDLING
// ============================================
interface RequestConfig {
	maxRetries: number;
	timeoutMs: number;
	backoffMs: number;
}

const requestConfig: RequestConfig = {
	maxRetries: 3,
	timeoutMs: 8000,
	backoffMs: 1000,
};

/** PUBLIC API URLs*/
const API_DOLLAR =
	process.env.API_DOLLAR_URL ||
	"https://economia.awesomeapi.com.br/json/last/USD-BRL";
const API_BITCOIN =
	process.env.API_BITCOIN_URL ||
	"https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=brl";
const API_IBOV =
	process.env.API_IBOV_URL || "https://brapi.dev/api/quote/^BVSP";
const API_KEY_IBOV = process.env.API_IBOV_KEY || "demo_key";

const urlsToValidate = { API_DOLLAR, API_BITCOIN, API_IBOV };
for (const [name, url] of Object.entries(urlsToValidate)) {
	if (!validateUrl(url)) {
		throw new Error(`URL inválida configurada para ${name}: ${url}`);
	}
}

const USER_AGENT = process.env.USER_AGENT || "quotes-app/0.1.0";

// --- Headers para requisições ---
const getHeaders = (token = ""): Record<string, string> => ({
	"User-Agent": USER_AGENT,
	Accept: "application/json",
	"Cache-Control": "no-cache",
	"X-Requested-With": "XMLHttpRequest",
	Authorization: `Bearer ${token}`,
	"Content-Type": "application/json",
});

// ============================================
//  MAKE REQUEST WITH RETRY
//  - Check cache
//  - Check rate limit
//  - Attempt request with retries and backoff
//  - Save to cache if successful
// ============================================
async function makeRequestWithRetry<T>(
	params: {
		url: string;
		token?: string;
	},
	config: RequestConfig = requestConfig,
	ttlMs = cacheConfig.defaultTtl,
): Promise<T> {
	const { url, token = "" } = params;
	const cached = cache.get<T>(url, ttlMs);

	if (cached) {
		debugLog(`♻️ Cache hit para: ${url}`);
		return cached;
	}

	let lastError: any;
	if (!rateLimiter.canMakeRequest(url)) {
		throw new ApiError(
			ApiErrorType.RATE_LIMIT_ERROR,
			`Rate limit excedido. Tente novamente em alguns momentos.`,
		);
	}

	for (let attemp = 1; attemp <= config.maxRetries; attemp++) {
		const controller = new AbortController();

		const timeout = setTimeout(() => {
			controller.abort();
		}, config.timeoutMs);

		try {
			const response = await fetch(url, {
				headers: getHeaders(token),
				signal: controller.signal,
			});

			clearTimeout(timeout);

			if (!response.ok) {
				throw new ApiError(
					ApiErrorType.API_ERROR,
					`HTTP ${response.status} - ${response.statusText}`,
				);
			}

			const data = (await response.json()) as T;
			debugLog(`Request successful on attempt ${attemp}`);

			cache.set(url, data);

			return data;
		} catch (error) {
			clearTimeout(timeout);
			lastError = error;

			if (error instanceof Error && error.name === "AbortError") {
				lastError = new ApiError(
					ApiErrorType.TIMEOUT_ERROR,
					`Request timed out after ${config.timeoutMs}ms`,
					error,
				);
			}

			debugLog(`Request failed on attempt ${attemp}`, lastError.message);

			//Exponential Backoff
			if (attemp < config.maxRetries) {
				const backoffTime = config.backoffMs * 2 ** (attemp - 1);
				debugLog(`⏳ Aguardando ${backoffTime}ms antes da próxima tentativa`);
				await new Promise((resolve) => setTimeout(resolve, backoffTime));
			}
		}
	}

	throw lastError;
}

/*
TOOLS
*/
// ============================================
// TOOL: cache_stats
// ============================================
server.tool(
	"cache_stats",
	"Obter estatísticas detalhadas do cache",
	{},
	async () => {
		try {
			const stats = cache.getStats();

			const report = `
        📊 Estatísticas do Cache
        📈 Resumo:
        - Entradas ativas: ${stats.size}/${stats.maxEntries}
        - Taxa de utilização: ${((stats.size / stats.maxEntries) * 100).toFixed(1)}%
        - Total de acessos: ${stats.totalHits + stats.totalMisses}
          • Hits: ${stats.totalHits} (${stats.hitRate.toFixed(1)}%)
          • Misses: ${stats.totalMisses} (${stats.missRate.toFixed(1)}%)

        ⏰ Entradas por popularidade (top 10):
        ${
					stats.entries.length > 0
						? stats.entries
								.sort((a, b) => b.hits - a.hits)
								.slice(0, 10)
								.map((entry, index) => {
									const keyName = entry.key.split("/").pop() || entry.key;
									const ageSeconds = Math.floor(entry.ageMs / 1000);
									const lastAccessSeconds = Math.floor(
										entry.timeSinceLastAccessMs / 1000,
									);

									return `
                  ${index + 1}. ${keyName}
                  • Criado há: ${formatDuration(ageSeconds)}
                  • Último acesso: ${formatDuration(lastAccessSeconds)}
                  • Hits: ${entry.hits}
                `;
								})
								.join("\n\n")
						: "Nenhuma entrada no cache"
				}

        ⚙️ Configuração:
        - TTL padrão: ${formatDuration(Math.floor(cacheConfig.defaultTtl / 1000))}
        - Limpeza automática: a cada ${formatDuration(Math.floor(cacheConfig.cleanupInterval / 1000))}
        - Max entradas: ${cacheConfig.maxEntries}
        - Status: ${cacheConfig.enableCache ? "✅ Ativo" : "❌ Desabilitado"}

        💡 Dica: Itens com "último acesso" recente são protegidos pela estratégia LRU
      `;

			return { content: [{ type: "text", text: report }] };
		} catch (error) {
			debugLog("❌ Erro ao obter stats do cache:", error);
			return {
				content: [
					{
						type: "text",
						text: "❌ Erro ao obter estatísticas do cache",
					},
				],
			};
		}
	},
);

// ============================================
// TOOL: rate_limit_stats
// ============================================
server.tool(
	"rate_limits_stats",
	"Obter estatísticas do rate limiter",
	{},
	async () => {
		try {
			const stats = rateLimiter.getStats();

			const report = `🚦 Estatísticas do Rate Limiter

  📊 Configuração:
  - Máximo de requisições: ${stats.config.maxRequests}
  - Janela de tempo: ${stats.config.windowMs}ms (${stats.config.windowMs / 1000}s)

  📈 Estado Atual:
  - Chaves ativas: ${stats.activeKeys}

  ${
		stats.details.length > 0
			? `📋 Detalhes por endpoint:
  ${stats.details.map((d) => `- ${d.key.split("/").pop()}: ${d.requests} requisições`).join("\n")}`
			: "✅ Nenhuma requisição recente"
	}`;

			return { content: [{ type: "text", text: report }] };
		} catch (error) {
			debugLog("❌ Erro ao obter stats do rate limiter:", error);
			return {
				content: [
					{
						type: "text",
						text: "❌ Erro ao obter estatísticas do rate limiter",
					},
				],
			};
		}
	},
);

server.tool("get_dollar", "Obter cotação atual do Dólar", {}, async () => {
	try {
		debugLog("Fetching Dólar quotation...");

		const raw = await makeRequestWithRetry<unknown>({
			url: API_DOLLAR,
		});

		const parsed = DollarSchema.safeParse(raw);

		if (!parsed.success) {
			debugLog("Validation error", parsed.error);
			throw new ApiError(
				ApiErrorType.VALDATION_ERROR,
				"Formato inesperado da resposta",
				parsed.error,
			);
		}

		const dollar = parsed.data.USDBRL;
		const bid = parseFloat(dollar.bid);
		const ask = parseFloat(dollar.ask);

		const result = `
      Dólar (${dollar.code}/${dollar.codein})
      Compra: ${formatBRL(bid)} | Venda: ${formatBRL(ask)}
    `;

		return {
			content: [
				{
					type: "text",
					text: result,
				},
			],
		};
	} catch (error) {
		const errorMsg =
			error instanceof ApiError && error.type === ApiErrorType.VALDATION_ERROR
				? `A resposta da API de cotação não veio no formato esperado. Detalhes: ${error.originalError.message}`
				: error instanceof ApiError
					? error.message
					: "Erro inesperado ao buscar cotação do dólar";

		debugLog("❌ Error fetching Dólar quotation", error);

		return {
			content: [
				{
					type: "text",
					text: errorMsg,
				},
			],
		};
	}
});

// ============================================
// TOOL: get_bitcoin
// ============================================
server.tool("get_bitcoin", "Obter cotação atual do Bitcoin", {}, async () => {
	try {
		debugLog("💰 Executando ferramenta: get_bitcoin");

		const raw = await makeRequestWithRetry<unknown>({ url: API_BITCOIN });

		const parsed = BitcoinSchema.safeParse(raw);

		if (!parsed.success) {
			debugLog("Erro de validação", parsed.error);
			throw new ApiError(
				ApiErrorType.VALDATION_ERROR,
				"Resposta da API não veio no formato esperado",
			);
		}

		const btc = parsed.data.bitcoin.brl;
		const result = `Bitcoin (BTC/BRL) ${formatBRL(btc)}`;

		return {
			content: [
				{
					type: "text",
					text: result,
				},
			],
		};
	} catch (error) {
		const errorMsg =
			error instanceof ApiError
				? `❌ ${error.message}`
				: "❌ Erro inesperado ao buscar cotação do Bitcoin";

		return {
			content: [
				{
					type: "text",
					text: errorMsg,
				},
			],
		};
	}
});

// ============================================
// TOOL: get_ibov
// ============================================
server.tool("get_ibov", "Obter cotação atual do Ibovespa", {}, async () => {
	try {
		debugLog("💰 Executando ferramenta: get_ibov:: ", API_KEY_IBOV);

		const raw = await makeRequestWithRetry<unknown>({
			url: API_IBOV,
			token: API_KEY_IBOV,
		});

		const parsed = IbovSchema.safeParse(raw);

		if (!parsed.success) {
			debugLog("Erro de validação", parsed.error);
			throw new ApiError(
				ApiErrorType.VALDATION_ERROR,
				"Resposta da API não veio no formato esperado",
			);
		}

		const ibov = parsed.data.results[0];

		if (
			typeof ibov.regularMarketPrice !== "number" ||
			!Number.isFinite(ibov.regularMarketPrice)
		) {
			throw new ApiError(
				ApiErrorType.VALDATION_ERROR,
				"Preço de mercado inválido na resposta da API",
			);
		}

		const result = `Ibovespa (${ibov.symbol}): ${ibov.regularMarketPrice.toLocaleString("pt-BR")} ${ibov.currency}`;

		return {
			content: [
				{
					type: "text",
					text: result,
				},
			],
		};
	} catch (error) {
		const errorMsg =
			error instanceof ApiError
				? `❌ ${error.message}`
				: "❌ Erro inesperado ao buscar cotação do Ibovespa";

		debugLog("Erro na ferramenta get_ibov:", error);

		return {
			content: [
				{
					type: "text",
					text: errorMsg,
				},
			],
		};
	}
});

// ============================================
// TOOL: healt_check
// ============================================
server.tool("health_check", "Verificar saúde das APIs", {}, async () => {
	try {
		debugLog("Executando health check");

		const apis = [
			{ name: "DÓLAR", url: API_DOLLAR },
			{ name: "BITCOIN", url: API_BITCOIN },
			{ name: "IBOV", url: API_IBOV },
		];

		const checks = await Promise.allSettled(
			apis.map(async (api) => {
				const start = Date.now();
				try {
					await makeRequestWithRetry(
						{ url: api.url },
						{ ...requestConfig, maxRetries: 1 },
						5000,
					);
					return {
						name: api.name,
						status: "✅ OK",
						responseTime: `${Date.now() - start}ms`,
					};
				} catch (error) {
					return {
						name: api.name,
						status: "❌ ERRO",
						error:
							error instanceof ApiError ? error.message : "Erro desconhecido",
					};
				}
			}),
		);

		const results = checks.map((check) =>
			check.status === "fulfilled"
				? check.value
				: {
						name: "UNKNOWN",
						status: "❌ FALHA",
						responseTime: "N/A",
						error: "Erro ao executar verificação",
					},
		);

		const healthReport = `🏥 Health Check - ${new Date().toLocaleString("pt-BR")}
      📡 APIs: ${results.map((r) => `${r.status} ${r.name} (${r.responseTime || "N/A"})`).join("\n")}
      ⚙️ Configurações:
      - Timeout: ${requestConfig.timeoutMs}ms
      - Max Retries: ${requestConfig.maxRetries}
      - Rate Limit: ${rateLimitConfig.maxRequests} req/${rateLimitConfig.windowMs}ms
      - Cache TTL: ${cacheConfig.defaultTtl}ms
    `;

		return { content: [{ type: "text", text: healthReport }] };
	} catch (error) {
		debugLog("❌ Erro no health check:", error);
		return {
			content: [
				{
					type: "text",
					text: "❌ Erro ao executar health check",
				},
			],
		};
	}
});

// ============================================
// HANDLE SHUTDOWN
// ============================================
// ✅ DRY (Don't Repeat Yourself)
async function gracefulShutdown(signal: string) {
	debugLog(`🛑 Recebido ${signal}, finalizando...`);

	// Cleanup em ordem
	rateLimiter.cleanup(); // Limpeza final
	cache.destroy(); // Limpa o timer interno do cache

	debugLog("✅ Shutdown completo");
	process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// Limpeza periódica do rate limiter
setInterval(() => {
	rateLimiter.cleanup();
}, 60000);

// ============================================
// MAIN
// ============================================
async function main() {
	try {
		debugLog("🚀 Iniciando Quotes MCP Server Enhanced v2.1.0");
		debugLog("⚙️ Configurações:", {
			cache: cacheConfig,
			requests: requestConfig,
			apis: { API_DOLLAR, API_BITCOIN, API_IBOV },
		});

		const transport = new StdioServerTransport();
		await server.connect(transport);

		debugLog("✅ Quotes MCP Server Enhanced rodando no stdio");
		debugLog(
			"🎯 Ferramentas disponíveis: get_dollar, get_bitcoin, get_ibov, health_check, cache_stats, rate_limit_stats",
		);
	} catch (error) {
		debugLog("💥 Erro fatal na inicialização:", error);
		cache.destroy();
		process.exit(1);
	}
}

main().catch((error) => {
	debugLog("💥 Erro fatal no main():", error);
	cache.destroy();
	process.exit(1);
});
