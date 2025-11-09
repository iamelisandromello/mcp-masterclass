import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
	name: "quotes",
	version: "1.0.0",
	capabilities: {
		resources: {},
		tools: {},
	},
});

// ============================================
// SCHEMAS DE VALIDAÇÃO
// ============================================
const DolarSchema = z.object({
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

// formatação do valor
const formatBRL = (value: number): string => {
	return new Intl.NumberFormat("pt-BR", {
		style: "currency",
		currency: "BRL",
	}).format(value);
};

/* 
Personalização de Erros e debug 
*/
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

// ============================================
// DEBUG LOG HELPER
// ============================================
function debugLog(message: string, data?: any, forceLog = false) {
	const shouldLog = process.env.DEBUG === "true" || forceLog;

	if (!shouldLog) return;

	const timestamp = new Date().toISOString();
	const logMessage = data
		? `[${timestamp}] ${message} ${JSON.stringify(data, null, 2)}`
		: `[${timestamp}] ${message}`;

	console.error(logMessage);
}

/* 
  Cache Manager
  TTL (Time To Live): 15s é bom para cotações (atualiza rápido mas não excessivo)
  LRU eviction: Remove entradas mais antigas quando atinge limite
  Cleanup periódico: Remove entradas expiradas automaticamente
  Hits tracking: Permite análise de quais endpoints são mais usados 
*/

interface CacheConfig {
	defaultTtl: number;
	maxEntries: number;
	enableCache: boolean;
	cleanupInterval: number;
}

interface CacheEntry {
	createdAt: number; // Timestamp de criação (para TTL)
	lastAccessTime: number; // Timestamp de último acesso (para LRU)
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
	private isCleanupRunning = false; // Previne cleanup sobreposto

	constructor(private config: CacheConfig) {
		if (config.enableCache) {
			this.startCleanupTimer();
			debugLog(
				`Cache initialized | TTL: ${config.defaultTtl}ms | Max entries: ${config.maxEntries} | Cleanup interval: ${config.cleanupInterval}ms`,
				null,
				true, // Log crítico sempre visível
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

		// Incrementa miss - entrada não existe
		if (!entry) {
			this.totalMisses++;
			debugLog(
				`Cache miss (no entry): ${key} | Total misses: ${this.totalMisses} | Cache size: ${this.cache.size}`,
			);
			return null;
		}

		const age = now - entry.createdAt;

		// Usa >= para consistência (expirou no momento exato do TTL)
		if (age >= effectiveTtl) {
			this.cache.delete(key);
			this.totalMisses++;
			debugLog(
				`Cache miss (expired): ${key} | Age: ${age}ms | TTL: ${effectiveTtl}ms | Expired by: ${age - effectiveTtl}ms`,
			);
			return null;
		}

		// Incrementa hit
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

		// Loop while para garantir que não ultrapasse maxEntries
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

	/**
	 * LRU (Least Recently Used) Eviction
	 * Remove a entrada que foi acessada há mais tempo
	 */
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

	/**
	 * Inicia timer de cleanup com tratamento de erro
	 */
	private startCleanupTimer(): void {
		this.cleanupTimer = setInterval(async () => {
			try {
				await this.cleanup();
			} catch (error) {
				debugLog("❌ Erro durante cleanup do cache:", error);
			}
		}, this.config.cleanupInterval);
	}

	/**
	 * - Usa mesma lógica de expiração do get() (age >= TTL)
	 * - Previne execução sobreposta
	 * - Remove apenas entradas realmente expiradas
	 */
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

				// Usa >= e TTL simples (não 2x)
				// Mesma lógica do get() para consistência
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

	/**
	 * - Conta apenas entradas válidas (não expiradas)
	 * - Fornece dados precisos
	 */
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

			// Só conta entradas que ainda não expiraram
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
			size: activeEntries, // Apenas entradas válidas
			maxEntries: this.config.maxEntries,
			totalHits: this.totalHits,
			totalMisses: this.totalMisses,
			hitRate: totalRequests > 0 ? (this.totalHits / totalRequests) * 100 : 0,
			missRate:
				totalRequests > 0 ? (this.totalMisses / totalRequests) * 100 : 0,
			entries: entries.sort((a, b) => b.hits - a.hits), // Ordena por popularidade
		};
	}

	/**
	 * Destroy Limpa timer antes de limpar cache
	 */
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

// ============================================
// HELPER: Formatar duração em formato legível
// ============================================
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

// Configuração do Cache
// TTL padrão: 60 segundos (60000ms) - ajustado para permitir testes confiáveis
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
	windowMs: 60000, // 1 minuto
};

const rateLimiter = new RateLimiter(rateLimitConfig);

/*
  Abstração de Requisção HTTP 
  Pattern Retry
  with Backoff
 */

interface RequestConfig {
	maxRetries: number;
	timeoutMs: number;
	backoffMs: number;
}

const resquestConfig: RequestConfig = {
	maxRetries: 3,
	timeoutMs: 8000,
	backoffMs: 1000,
};

/** URLs APIs Públicas */
const API_DOLAR =
	process.env.API_DOLAR_URL ||
	"https://economia.awesomeapi.com.br/json/last/USD-BRL";
const API_BITCOIN =
	process.env.API_BITCOIN_URL ||
	"https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=brl";
const API_IBOV =
	process.env.API_IBOV_URL || "https://brapi.dev/api/quote/^BVSP";

/* ============================================
  MAKE REQUEST WITH RETRY
  - Verifica cache
  - Verifica rate limit
  - Tenta requisição com retries e backoff
  - Salva no cache se sucesso
============================================ */
async function makeRequestWithRetry<T>(
	url: string,
	config: RequestConfig = resquestConfig,
	ttlMs = cacheConfig.defaultTtl,
): Promise<T> {
	// Verificar cache primeiro
	const cached = cache.get<T>(url, ttlMs);

	if (cached) {
		debugLog(`♻️ Cache hit para: ${url}`);
		return cached;
	}

	let lastError: any;
	// Verificar rate limit
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
				headers: {
					"USER-AGENT": "quotes-app/1.0.0",
					ACCEPT: "application/json",
				},
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

			// Salvar no cache
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
				const backoffTime = config.backoffMs * attemp;
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

server.tool("get_dolar", "Obter cotação atual do Dólar", {}, async () => {
	try {
		debugLog("Fetching Dólar quotation...");

		const raw = await makeRequestWithRetry<unknown>(
			"https://economia.awesomeapi.com.br/json/last/USD-BRL",
		);

		const parsed = DolarSchema.safeParse(raw);

		if (!parsed.success) {
			debugLog("Validation error", parsed.error);
			throw new ApiError(
				ApiErrorType.VALDATION_ERROR,
				"Formato inesperado da resposta",
				parsed.error,
			);
		}

		const dolar = parsed.data.USDBRL;
		const bid = parseFloat(dolar.bid);
		const ask = parseFloat(dolar.ask);

		const result = `
      Dólar (${dolar.code}/${dolar.codein})
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

		const raw = await makeRequestWithRetry<unknown>(API_BITCOIN);

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
		debugLog("💰 Executando ferramenta: get_ibov");

		const raw = await makeRequestWithRetry<unknown>(API_IBOV);

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

		debugLog("❌ Erro na ferramenta get_ibov:", error);

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

async function main() {
	const trasport = new StdioServerTransport();
	await server.connect(trasport);
	console.error("Quotes MCP Server is running...");
}

main();
