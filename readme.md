# Plano de Live Coding - Servidor MCP de Cotações do Zero

## 📋 Visão Geral

**Duração Estimada:** 3-4 horas  
**Nível:** Intermediário a Avançado  
**Objetivo:** Construir um servidor MCP robusto e production-ready do zero, implementando patterns e best practices essenciais seguindo documentação Anthropic.

### 📋 Sequência de Branchs
- genesis
- feat/tool-hello
- feat/tool-getDolar
- feat/advanced-error-handling
- feat/pattern-retry
- feat/cache-lru-eviction 
- feat/rate-limit
- feat/tool-getBitcoin
- feat/tool-getIbov
- feat/tool-health-check
- refactor/get-headers
- refactor/graceful-shutdown
- feat/validate-url
- refactor/main
- refactor/dry-gracefull-shutdown
- malaquias
---

## 🎯 Estrutura do Live Code

### **SESSÃO 1: Fundamentos e Setup Inicial**

#### 1.1 Introdução e Contexto
- **O que é MCP (Model Context Protocol)**
> O Model Context Protocol (MCP) é um protocolo aberto desenvolvido pela Anthropic que padroniza a comunicação entre Modelos de Linguagem (LLMs) e ferramentas externas, como bancos de dados, APIs ou sistemas internos. Ele define uma interface clara e segura para que modelos possam descobrir, invocar e interagir com recursos de forma estruturada, permitindo integrar capacidades contextuais e operacionais em tempo real. Na prática, o MCP facilita a criação de servidores interoperáveis e escaláveis, onde a LLM atua como um cliente inteligente que compreende e manipula o ambiente ao seu redor com previsibilidade e governança.

- **Casos de uso do servidor de cotações**
>Sem o MCP, o modelo LLM só tem conhecimento histórico e estático (treinado até certo ponto).
>Com o MCP, ele passa a ter:
> - acesso em tempo real a dados externos,
> - contexto factual para suas respostas,
> - e base empírica para raciocínio analítico e preditivo.

Isso transforma o modelo de um “gerador de texto” em um agente analítico contextualizado, apto a interpretar eventos de mercado e explicar implicações econômicas.
> **Note:** “O servidor MCP não é apenas uma *“fonte de dados”*, mas uma camada de inteligência conectada, que transforma o modelo em um agente contextualizado — capaz de raciocinar, correlacionar e produzir análises úteis com base em dados atualizados”.
- **Arquitetura final que vamos construir**
🧱 Arquitetura Final do Servidor MCP
```
┌─────────────────────────────────────────┐
│        MCP Server (stdio transport)     │
│   @modelcontextprotocol/sdk             │
├─────────────────────────────────────────┤
│  Tools Layer                            │
│    • hello                              │
│    • get_dolar                          │
│    • get_bitcoin                        │
│    • get_ibov                           │
│    • health_check                       │
│    • cache_stats                        │
│    • rate_limit_stats                   │
├─────────────────────────────────────────┤
│  Core Services Layer                    │
│    • makeRequestWithRetry()             │
│       ├─ Cache Check (LRU + TTL)        │
│       ├─ Rate Limit Check               │
│       ├─ Retry Logic (Exponential Backoff)
│       ├─ Timeout & AbortController       │
│       └─ Error Handling Typed (ApiError) │
├─────────────────────────────────────────┤
│  Infrastructure Layer                   │
│    • CacheManager (TTL + LRU + Cleanup) │
│    • RateLimiter (Sliding Window)       │
│    • Graceful Shutdown (SIGINT/SIGTERM) │
│    • EnvConfig (.env → process.env)     │
│    • Logging via stderr (debugLog)      │
├─────────────────────────────────────────┤
│  Validation & Security Layer            │
│    • Zod Schemas                        │
│    • URL validation (safe API endpoints)│
│    • getHeaders() para headers seguros  │
└─────────────────────────────────────────┘
```
>O servidor MCP final atua como uma camada inteligente de integração entre LLMs e APIs financeiras, aplicando patterns de arquitetura de sistemas distribuídos — caching, retries, rate limiting e shutdown controlado — dentro de um ambiente padronizado pelo protocolo MCP, garantindo interoperabilidade, previsibilidade e segurança em produção.



| Padrão / Mecanismo                      | Função na Arquitetura                                                      |
| --------------------------------------- | -------------------------------------------------------------------------- |
| **Retry Pattern (Exponential Backoff)** | Reexecuta requisições com espera progressiva em falhas temporárias.        |
| **Cache com TTL + LRU**                 | Garante performance e estabilidade evitando chamadas redundantes a APIs.   |
| **Rate Limiter (Sliding Window)**       | Controla número de requisições por janela de tempo, prevenindo abuso.      |
| **Error Handling Tipado**               | Usa `ApiError` e enums para diferenciar e tratar falhas previsíveis.       |
| **Validation Layer (Zod)**              | Garante integridade dos dados recebidos das APIs externas.                 |
| **Graceful Shutdown**                   | Encerra o servidor com segurança, limpando timers e recursos.              |
| **Health Check e Diagnóstico**          | Tools internas permitem auditar integridade de APIs, cache e rate limiter. |


**Overview das tecnologias: TypeScript, Zod, MCP SDK...**
- NodeJs 22 Runtime principal do servidor MCP. 
- Typescript Linguagem principal de desenvolvimento.
- rimraf / ts-node → Build e execução em ambiente dev/production-ready
- @modelcontextprotocol/sdk → SDK oficial do MCP para criar o servidor e registrar tools
- Zod Valida e tipa os dados retornados pelas APIs.
- Anthropic Define o padrão de comunicação entre LLMs e servidores externos.
- Claude Consome o servidor MCP para executar ferramentas e acessar dados em tempo real.
- MCP Protocolo que conecta o LLM às ferramentas do servidor (como consultas de cotações) de forma padronizada. 
- Cursor Ambiente de desenvolvimento com integração nativa para LLMs e suporte ao protocolo MCP. 
- Git Sistema de controle de versão do histórico de alterações no código. 
- Github Armazenamento do repositório Git, permitindo versionamento, revisão e publicação do projeto.

#### 1.2 Setup do Projeto

**🎓 BREAKPOINT - Conceitos:**

**Por que `server.tool()` e não `server.registerTool()`?**
- `server.tool()` é a API moderna e fluente do SDK
- Integração automática com TypeScript para type safety
- Validação de schema integrada com Zod
- Menos boilerplate, código mais limpo e expressivo

**Por que logs vão para `stderr`?**
- MCP usa `stdio` para comunicação JSON
- `stdout` é reservado para mensagens do protocolo
- `stderr` é para logs de debug sem interferir na comunicação

**💻 LIVE CODE:**
```bash
# Criar projeto
mkdir quotes-mcp-server
cd quotes-mcp-server
npm init -y

# Instalar dependências
npm install @modelcontextprotocol/sdk rimraf zod
npm install -D typescript @types/node ts-node @types/node

# Configurar TypeScript
npx tsc --init
```

**Configurar `tsconfig.json`:**
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src"]
}

```

**Criar Arquivo `.env`:**
```env
MCP_SERVER_NAME="LIVE-MCP-SERVER"
```

**Criar Arquivo `src/index.ts`:**
```typescript
// Usa stderr para não interferir na comunicação JSON
console.error("Hello, world!");

console.error(
	"MCP SERVER NAME:: ",
	process.env.MCP_SERVER_NAME || "Default Server",
);
process.exit(0);
// Fim do arquivo

```

**Atualizar `package.json`:**
```json
{
  "type": "module",
  "scripts": {
    "clean": "rimraf dist",
    "dev": "node -r ts-node/register --env-file=.env  src/index.ts",
    "build": "npm run clean && tsc -p tsconfig.json",
    "start": "node --env-file .env dist/index.js"
  }
}
```

**Instalar Biblioteca `EditorConfig` e criar arquivo `.editorconfig`:**
```
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = false
insert_final_newline = true

```
**Inicializar versionamento do projeto e criar `.gitignore`:**
```
.env
dist
node_modules
.DS_Store
```

```bash
git init
git add .
git commit "chore: initiate project"
git checkout -B genesis
git branch -D master
git che checkout -B develop
```

#### 1.3 Servidor MCP Básico

**💻 LIVE CODE - `src/index.ts`:**
```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({
  name: 'quotes',
  version: '1.0.0',
  capabilities: {
    resources: {},
    tools: {}
  }
})

// Tool simples de teste
server.tool(
  'hello',
  'Ferramenta de teste',
  { 
    name: z.string().describe('Seu nome'),
  },
  async (args) => {
    return { 
      content: [{ 
        type: 'text', 
        text: `Olá, ${args.name}!` 
      }] 
    }
  }
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('✅ Servidor MCP rodando!')
}

main()
```

**🧪 Teste:**
```json
npm run dev
# Testar manualmente ou configurar cliente MCP
```

```json
"scripts": {
  "get:test": "printf '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"hello\",\"arguments\":{\"name\":\"Elisandro Mello\"}}}\\n' | node dist/index.js"
},
```

```bash
npm run get:test
# Testar manualmente ou configurar cliente MCP
```

**💻 Inclusão de parâmetros adicionais:**

```typescript
// Tool simples de teste
server.tool(
  'hello',
  'Ferramenta de teste',
  { 
    name: z.string().describe("Seu nome"),
    age: z.number().describe("Sua idade")
  },
  async (args) => {
    return { 
      content: [{ 
        type: 'text', 
        text: `Olá, ${args.name}! Você tem ${args.age} anos.`,
      }] 
    }
  }
)
```

**🧪 Teste:**
```json
"scripts": {
  "get:test2": "printf '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"hello\",\"arguments\":{\"name\":\"Elisandro Mello\", \"age\": 30}}}\\n' | node dist/index.js"
},
```

```bash
npm run get:test2
# Testar manualmente ou configurar cliente MCP
```
---

### **SESSÃO 2: Primeira Tool Real - Dólar**
#### 2.1 Implementação Schema Dolar
```typescript
// Schemas Zod
const DolarSchema = z.object({
  USDBRL: z.object({
    bid: z.string(),
    ask: z.string(),
    code: z.string(),
    codein: z.string()
  })
})
```
#### 2.2 Implementação Helper Formatação Currency
> O objeto Intl em JavaScript (abreviação de Internacionalização) é um namespace embutido que fornece recursos sensíveis ao idioma, permitindo a formatação nativa de datas, horas, números e moedas de acordo com as regras e convenções de diferentes países e regiões (locales). 

**Essa API é extremamente útil para criar aplicações que atendem a um público global, sem a necessidade de bibliotecas de terceiros.**

```typescript
// Função helper para formatação
const formatBRL = (value: number): string => {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(value)
}
```

#### 2.3 Implementação Básica da Tool de Dólar
**🎓 BREAKPOINT - Validação com Zod:**
**Por que validar com Zod?**
- APIs externas podem mudar sem aviso
- Previne erros em runtime com dados malformados
- Type safety automático - TypeScript infere tipos do schema
- Mensagens de erro claras e descritivas
- Documentação viva - o schema é a spec

**💻 LIVE CODE:**
```typescript
// Tool get_dolar
server.tool(
  'get_dolar',
  'Obter cotação atual do Dólar',
  {},
  async () => {
    const response = await fetch(
      'https://economia.awesomeapi.com.br/json/last/USD-BRL'
    )
    
    const raw = await response.json()
    const parsed = DolarSchema.parse(raw)
    
    const dolar = parsed.USDBRL
    const bid = parseFloat(dolar.bid)
    const ask = parseFloat(dolar.ask)
    
    const result = `💱 Dólar (${dolar.code}/${dolar.codein})
Compra: ${formatBRL(bid)} | Venda: ${formatBRL(ask)}`
    
    return { content: [{ type: 'text', text: result }] }
  }
)
```

**🧪 Teste:**
```json
"scripts": {
  "get:dolar": "printf '{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"get_dolar\",\"arguments\":{}}}\\n' | node dist/index.js",
  "get:dolar-dev": "printf '{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"get_dolar\",\"arguments\":{}}}\\n' | node -r ts-node/register --env-file=.env  src/index.ts"
},
```

```bash
npm run get:dolar
# Testar manualmente ou configurar cliente MCP
```
---

### **SESSÃO 3: Tratamento Robusto de Erros**

#### 3.1 Sistema de Erros Customizados
**🎓 BREAKPOINT - Centralização de Erros:**

**Por que criar classes de erro customizadas?**
- Tipagem forte - sabemos exatamente qual erro ocorreu
- Contexto rico - podemos adicionar metadata específica
- Logging estruturado - facilita debugging e monitoramento
- Tratamento diferenciado - podemos reagir diferente por tipo
- Rastreabilidade - mantemos o erro original encapsulado

**💻 LIVE CODE:**
```typescript
enum ApiErrorType {
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
  API_ERROR = 'API_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  RATE_LIMIT_ERROR = 'RATE_LIMIT_ERROR'
}

class ApiError extends Error {
  constructor(
    public type: ApiErrorType,
    message: string,
    public originalError?: any
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// Função de logging
function debugLog(message: string, data?: any) {
  if (process.env.DEBUG !== 'true') return
  
  const timestamp = new Date().toISOString()
  const logMessage = data
    ? `[${timestamp}] ${message} ${JSON.stringify(data, null, 2)}`
    : `[${timestamp}] ${message}`
  console.error(logMessage)
}
```

#### 3.2 Refatorar Tool com Tratamento de Erros

**💻 LIVE CODE:**
```typescript
server.tool(
  'get_dolar',
  'Obter cotação atual do Dólar',
  {},
  async () => {
    try {
      debugLog('💰 Executando ferramenta: get_dolar')
      
      const response = await fetch(
        'https://economia.awesomeapi.com.br/json/last/USD-BRL'
      )
      
      if (!response.ok) {
        throw new ApiError(
          ApiErrorType.API_ERROR,
          `HTTP ${response.status}: ${response.statusText}`
        )
      }
      
      const raw = await response.json()
      const parsed = DolarSchema.safeParse(raw)
      
      if (!parsed.success) {
        debugLog('❌ Erro de validação:', parsed.error)
        throw new ApiError(
          ApiErrorType.VALIDATION_ERROR,
          'Formato inesperado da resposta'
        )
      }
      
      const dolar = parsed.data.USDBRL
      const bid = parseFloat(dolar.bid)
      const ask = parseFloat(dolar.ask)
      
      const result = `💱 Dólar (${dolar.code}/${dolar.codein})
Compra: ${formatBRL(bid)} | Venda: ${formatBRL(ask)}`
      
      return { content: [{ type: 'text', text: result }] }
      
    } catch (error) {
      const errorMsg = error instanceof ApiError
        ? `❌ ${error.message}`
        : '❌ Erro inesperado ao buscar cotação do Dólar'
      
      debugLog('❌ Erro na ferramenta get_dolar:', error)
      return { content: [{ type: 'text', text: errorMsg }] }
    }
  }
)
```
---

### **SESSÃO 4: Retry Pattern com Exponential Backoff**

#### 4.1 Implementação do Sistema de Retry
**🎓 BREAKPOINT - Retry Pattern:**
**Por que implementar retry com exponential backoff?**
- **Resiliência:** APIs externas podem ter falhas temporárias
- **Exponential backoff:** Evita sobrecarregar servidor com retries agressivos
- **Timeout:** Previne requests pendurados indefinidamente
- **User experience:** Aumenta taxa de sucesso sem intervenção manual

#### AbortController ####

> O AbortController no Node.js é uma API nativa (inspirada no navegador) usada para cancelar operações assíncronas — como fetch, streams, timers, requisições HTTP, etc.

Ele funciona em conjunto com um objeto chamado AbortSignal. O fluxo é assim:

- Você cria um AbortController.
- Esse controller expõe uma propriedade .signal (o AbortSignal).
- Você passa esse signal para a operação assíncrona que suporta cancelamento
- Quando quiser abortar, chama .abort() no controller.
- Todas as operações que usam esse signal serão notificadas e devem encerrar.

O **AbortController** é um mecanismo de cancelamento. Ele não força o término imediato de uma função — mas fornece um sinal padronizado para que as operações saibam quando devem encerrar.

>O clearTimeout(timeout) cancela a contagem regressiva do temporizador criado anteriormente.
Ou seja:
- Se a requisição terminar antes do tempo limite, chamamos clearTimeout(timeout) para impedir que o timer ainda dispare depois.
- Se não chamássemos isso, o setTimeout continuaria ativo, podendo abortar uma requisição já finalizada com sucesso.

**💻 LIVE CODE:**
```typescript
interface RequestConfig {
  maxRetries: number
  timeoutMs: number
  backoffMs: number
}

const requestConfig: RequestConfig = {
  maxRetries: 3,
  timeoutMs: 8000,
  backoffMs: 1000
}

/* ============================================
  MAKE REQUEST WITH RETRY
  - Verifica cache
  - Verifica rate limit
  - Tenta requisição com retries e backoff
  - Salva no cache se sucesso
============================================ */
async function makeRequestWithRetry<T>(
  url: string,
  config = requestConfig
): Promise<T> {
  let lastError: any
  
  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
  
// ======================================================
// ... Restante do código será desenvolvido no Live Code
// ======================================================
}
```

>O await new Promise((resolve) => setTimeout(resolve, backoffTime)); pausa a execução da função por um tempo determinado, simulando um atraso (backoff) antes de uma nova tentativa de requisição.
- setTimeout(resolve, backoffTime) cria um temporizador que executará a função resolve() após backoffTime milissegundos.
- Essa função é passada para um novo Promise(...).
- Como há um await antes da Promise, a execução da função makeRequestWithRetry pausa até que o tempo definido passe.

#### 4.2 Refatorar Tool para Usar Retry

**💻 LIVE CODE:**
```typescript
// ============================================
// TOOL: get_Dolar
// ============================================
server.tool(
  'get_dolar',
  'Obter cotação atual do Dólar',
  {},
  async () => {
// ======================================================
// ... Restante do código será desenvolvido no Live Code
// ======================================================
  }
)
```

---

### **SESSÃO 5: Sistema de Cache**
**🎓 BREAKPOINT - Sistema de Cache:**

**Por que implementar cache?**
- **Performance:** Reduz latência de 500ms+ para <1ms
- **Confiabilidade:** Continua funcionando se API cair temporariamente
- **Custo:** Reduz número de requisições (algumas APIs cobram por uso)
- **Rate limiting:** Evita bater nos limites das APIs públicas

**Design Decisions:**
- **TTL (Time To Live):** 15s é bom para cotações (atualiza rápido mas não excessivo)
- **LRU eviction:** Remove entradas mais antigas quando atinge limite
- **Cleanup periódico:** Remove entradas expiradas automaticamente
- **Hits tracking:** Permite análise de quais endpoints são mais usados

**🧪 Demonstrar:**
- Primeira chamada (cache miss)
- Segunda chamada imediata (cache hit)
- Chamada após TTL expirar (cache miss)

### 🧩 Conceito: LRU Cache ###

O LRU (Least Recently Used) é uma estratégia de gerenciamento de cache que remove o item menos recentemente acessado quando o cache atinge sua capacidade máxima.

**A ideia é:**
>“Se um item não foi usado há muito tempo, é menos provável que seja usado de novo — então pode ser removido.”

#### 5.1 Implementação do Cache Manager
#### Refatorar o Debuglog ####

```typescript
function debugLog(message: string, data?: any, forceLog = false) {
	const shouldLog = process.env.DEBUG === "true" || forceLog;

	if (!shouldLog) return;

	const timestamp = new Date().toISOString();
	const logMessage = data
		? `[${timestamp}] ${message} ${JSON.stringify(data, null, 2)}`
		: `[${timestamp}] ${message}`;

	console.error(logMessage);
}
```

**💻 LIVE CODE:**
```typescript
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
	
// ======================================================
// ... Restante do código será desenvolvido no Live Code
// ======================================================

```

#### 5.3 Integrar Cache no Retry

**💻 LIVE CODE:**
```typescript
async function makeRequestWithRetry<T>(
  url: string,
  config = requestConfig,
  ttlMs = cacheConfig.defaultTtl
): Promise<T> {
// ======================================================
// ... Restante do código será desenvolvido no Live Code
// ======================================================
}
```

#### 5.4 ⌛  Tool  Cache Stats
```typescript
// ============================================
// TOOL: cache_stats
// ============================================
server.tool(
	"cache_stats",
	"Obter estatísticas detalhadas do cache",
	{},
	async () => {
	// ======================================================
    // ... Restante do código será desenvolvido no Live Code
    // ======================================================
	},
);
```

**🧪 Teste:**
```json
"scripts": {
  "// VERIFICAR ESTADO DO CACHE": "",
  "cache-stats": "printf '{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"cache_stats\",\"arguments\":{}}}\\n' | node --env-file .env dist/index.js",
},
````

### **SESSÃO 6: Rate Limiter**
**🎓 BREAKPOINT - Rate Limiting:**

**Por que implementar rate limiter?**
- **Proteção:** Evita banimento por abuso de APIs públicas
- **Fair usage:** Distribui recursos de forma justa entre usuários
- **Estabilidade:** Previne sobrecarregar o próprio servidor
- **Custo:** Algumas APIs cobram por requisição

**Sliding Window:** Mais justo que fixed window (não reseta abruptamente)

**🧪 Demonstrar:**
- Fazer 30 requisições rápidas
- Mostrar rate limit sendo atingido
- Aguardar window passar e tentar novamente

#### 6.1 Implementação do Rate Limiter

**💻 LIVE CODE:**
```typescript
interface RateLimitConfig {
  maxRequests: number
  windowMs: number
}

class RateLimiter {
  private requests = new Map<string, number[]>()
  
  constructor(private config: RateLimitConfig) {}
  
  canMakeRequest(key: string): boolean {
 	// ======================================================
    // ... Restante do código será desenvolvido no Live Code
    // ====================================================== 
  }
}

const rateLimitConfig: RateLimitConfig = {
  maxRequests: 30,
  windowMs: 60000 // 1 minuto
}

const rateLimiter = new RateLimiter(rateLimitConfig)
```

#### 6.2 Integrar no Retry

**💻 LIVE CODE:**
```typescript
async function makeRequestWithRetry<T>(
  url: string,
  config = requestConfig,
  ttlMs = cacheConfig.defaultTtl
): Promise<T> {
  const cached = cache.get<T>(url, ttlMs)
  if (cached) {
    debugLog(`♻️ Cache hit para: ${url}`)
    return cached
  }
  
  // Verificar rate limit
  if (!rateLimiter.canMakeRequest(url)) {
    throw new ApiError(
      ApiErrorType.RATE_LIMIT_ERROR,
      `Rate limit excedido. Tente novamente em alguns momentos.`
    )
  }
  
  // ... resto do código
}
```
#### 6.3 💀 Rate Limiter
```typescript
// ============================================
// TOOL: rate_limit_stats
// ============================================
server.tool(
  "rate_limit_stats",
  "Obter estatísticas do rate limiter",
  {},
  async () => {
	// ======================================================
    // ... Restante do código será desenvolvido no Live Code
    // ======================================================
  },
);
```

**🧪 Teste:**
```json
"scripts": {
  "rate-limit-stats": "printf '{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"rate_limit_stats\",\"arguments\":{}}}\\n' | node --env-file .env dist/index.js"
},
```


---

### **SESSÃO 7: Adicionando Mais Tools** ###

#### 7.1 Schemas e Contstantes URLs

**💻 LIVE CODE:**
```typescript
// ============================================
// SCHEMAS DE VALIDAÇÃO
// ============================================
const BitcoinSchema = z.object({
  bitcoin: z.object({
    brl: z.number()
  })
})

const IbovSchema = z.object({
  results: z.array(
    z.object({
      symbol: z.string(),
      regularMarketPrice: z.number(),
      currency: z.string(),
      regularMarketChange: z.number().optional(),
      regularMarketChangePercent: z.number().optional()
    })
  )
})

#### Criar Constantes para URLs ####
APIs públicas de exemplo
const API_DOLAR = process.env.API_DOLAR_URL || 'https://economia.awesomeapi.com.br/json/last/USD-BRL'</br>
const API_BITCOIN = process.env.API_DOLAR_URL || 'https://economia.awesomeapi.com.br/json/last/USD-BRL'</br>
const API_IBOV = process.env.API_IBOV_URL || 'https://brapi.dev/api/quote/^BVSP'
</br>
```

#### 7.2 Bitcoin - 💰 GetBitcoin

```typescript
// ============================================
// TOOL: get_bitcoin
// ============================================
server.tool("get_bitcoin", "Obter cotação atual do Bitcoin", {}, async () => {
	// ======================================================
    // ... Restante do código será desenvolvido no Live Code
    // ======================================================
}
});
```

**🧪 Teste:**
```json
"scripts": {
  "// HEALTH CHECK": "",
  "health": "printf '{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"health_check\",\"arguments\":{}}}\\n' | node --env-file .env dist/index.js"
},
````

#### 7.3 Ibov - 💸 GetIbov
```typescript
// ============================================
// TOOL: get_ibov
// ============================================
server.tool("get_ibov", "Obter cotação atual do Ibov", {}, async () => {
	// ======================================================
    // ... Restante do código será desenvolvido no Live Code
    // ======================================================
}
});
````

**🧪 Teste:**
```json
"scripts": {
  "// GET BITCOIN": "",
		"get:bitcoin": "printf '{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"get_bitcoin\",\"arguments\":{}}}\\n' | node --env-file .env dist/index.js",
},
```

### **SESSÃO 8: Adicionando Tools de Diagnóstico** ###
#### 8.1 🏥 Healt Check
**Promise.allSettled(...)**

>Papel central do allSettled:
>Ele aguarda todas essas Promises terminarem, 
>sem interromper o fluxo se uma delas falhar.

- Mesmo que uma ou várias APIs estejam fora do ar, o await Promise.allSettled(...) só resolve quando todas as requisições terminaram (com sucesso ou erro).
- Isso é essencial, pois você quer ter um relatório completo de todas as APIs, não apenas das que responderam.

> **Note: Promise.allSettled vs Promise.all:** Se qualquer requisição desse erro não tratado, o `Promise.all` lançaria exceção imediatamente, e perderíamos os resultados das demais APIs.

A variável checks vai conter um array com a forma:
```typescript
[
  { status: "fulfilled", value: { name: "DÓLAR", status: "✅ OK", responseTime: "120ms" } },
  { status: "fulfilled", value: { name: "BITCOIN", status: "✅ OK", responseTime: "120ms" } },
  { status: "fulfilled", value: { name: "IBOV", status: "❌ ERRO", error: "Timeout" } }
]
```

```typescript
// ============================================
// TOOL: health_check
// ============================================
server.tool("health_check", "Verificar saúde das APIs", {}, async () => {
	// ======================================================
    // ... Restante do código será desenvolvido no Live Code
    // ======================================================
});
```

**🧪 Teste:**
```json
"scripts": {
  "// HEALTH CHECK": "",
  "health-check": "printf '{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"health_check\",\"arguments\":{}}}\\n' | node --env-file .env dist/index.js"
},
````
---

### **SESSÃO 9: Refinamentos Finais**
#### 9.1 Implementar método getHeaders()

```typescript
const USER_AGENT = process.env.USER_AGENT || "quotes-app/2.1.0";

// --- Headers para requisições ---
const getHeaders = (): Record<string, string> => ({
  'User-Agent': USER_AGENT,
  Accept: 'application/json',
  'Cache-Control': 'no-cache',
  'X-Requested-With': 'XMLHttpRequest'
})

// alterar makeRequestWithRetry
async function makeRequestWithRetry<T>(
  url: string,
  config = requestConfig,
  ttlMs = cacheConfig.defaultTtl
): Promise<T> {
   ... 

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    ...

    try {

      ...

      const response = await fetch(url, {
        headers: getHeaders(),
        signal: controller.signal
      })

      ...

    } catch (error) {
      ...
    }
  }
  throw lastError
}
```

**Editar Arquivo `.env`:**
```env
USER_AGENT="2.1.0"
```

#### 9.2 Graceful Shutdown
**🎯 Explicação Detalhada: Graceful Shutdown e Sinais do Sistema Operacional**

>📡 **O que são Sinais (Signals)?**
Sinais são mensagens que o Sistema Operacional envia para processos em execução. Pense neles como "toques no ombro" que o OS dá no seu programa para comunicar eventos importantes.

#### 🔴 SIGINT (Signal Interrupt) ####
**O que é?**

- **SIGINT =** *"Signal Interrupt"*
- É o sinal enviado quando você pressiona Ctrl+C no terminal
- Número do sinal: 2

**Quando acontece?**
```bash
# Seu servidor está rodando...
npm run dev
✅ Servidor MCP rodando!

# Você pressiona Ctrl+C
^C
🛑 Recebido SIGINT, finalizando...
````

**Propósito:**

- Interrupção intencional pelo usuário
- É uma forma "educada" de pedir ao programa para parar
- O programa pode capturar e decidir como reagir

**Analogia:**
Imagine que SIGINT é como você dizendo educadamente:

>"Ei, programa, preciso que você pare. Por favor, finalize o que está fazendo de forma organizada."

<br>

#### 🔵 SIGTERM (Signal Terminate) ####
**O que é?**

- SIGTERM = "Signal Terminate"
- É o sinal de terminação padrão enviado pelo sistema
- Número do sinal: 15

**Quando acontece?**
```bash
# Em outro terminal, você envia o sinal manualmente:
kill 12345  # PID do processo

# Ou em ambientes de produção:
systemctl stop meu-servidor
docker stop meu-container
kubernetes pod shutdown
````

**Propósito:**

- Terminação controlada por sistemas externos
- Usado por gerenciadores de processos (systemd, docker, k8s)
- Também permite que o programa faça cleanup
- Previne a ocorrência de memory leaks
> Um `memory leak` (vazamento de memória) ocorre quando um programa deixa de liberar áreas de memória que não são mais necessárias, fazendo com que o consumo de RAM cresça continuamente ao longo do tempo. Em sistemas de longa execução, como servidores Node.js, isso acontece, por exemplo, quando timers, conexões, listeners ou caches permanecem ativos mesmo após o encerramento de suas tarefas. O Graceful Shutdown previne esse problema ao garantir que todos os recursos alocados sejam limpos corretamente (timers cancelados, caches destruídos, conexões fechadas) antes do processo encerrar, evitando o acúmulo de objetos órfãos e mantendo o sistema estável e eficiente.

**Analogia:**
SIGTERM é como o gerente dizendo:

>"O turno acabou, finalize seu trabalho e vá para casa de forma organizada."


**💻 LIVE CODE:**
```typescript
// ============================================
// HANDLE SHUTDOWN
// ============================================
process.on('SIGINT', () => {
  debugLog('🛑 Recebido SIGINT, finalizando...')
  cache.destroy()
  process.exit(0)
})

process.on('SIGTERM', () => {
  debugLog('🛑 Recebido SIGTERM, finalizando...')
  cache.destroy()
  process.exit(0)
})

// Limpeza periódica do rate limiter
setInterval(() => {
  rateLimiter.cleanup()
}, 60000)
```

### 🚨 Por que isso é CRÍTICO? ###
#### Sem Graceful Shutdown: ####
```typescript
javascript// ❌ SEM tratamento de sinais
npm run dev
^C  # Ctrl+C

// O que acontece:
- ❌ Timer do cache continua rodando (memory leak!)
- ❌ Conexões podem ficar abertas
- ❌ Dados em cache podem não ser persistidos
- ❌ Logs não são fechados corretamente
```

#### Com Graceful Shutdown: ####
```typescript
javascript// ✅ COM tratamento de sinais
npm run dev
^C  # Ctrl+C

[2025-10-31T10:30:00.000Z] 🛑 Recebido SIGINT, finalizando...
[2025-10-31T10:30:00.050Z] 🧹 Cache destruído: 42 entradas limpas
✅ Processo finalizado com sucesso

// O que acontece:
- ✅ Timers são cancelados
- ✅ Recursos são liberados
- ✅ Logs indicam shutdown limpo
- ✅ Exit code 0 (sucesso)
```


#### 9.3 Validação de URLs e Segurança

**💻 LIVE CODE:**
```typescript
function validateUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url)
    return ['https:', 'http:'].includes(parsedUrl.protocol)
  } catch {
    return false
  }
}

// Validar na inicialização
const urlsToValidate = { API_DOLAR, API_BITCOIN, API_IBOV }
for (const [name, url] of Object.entries(urlsToValidate)) {
  if (!validateUrl(url)) {
    throw new Error(`URL inválida configurada para ${name}: ${url}`)
  }
}
```

#### 9.4 Refactor Main

**💻 LIVE CODE:**
```typescript
async function main() {
  try {
    debugLog("🚀 Iniciando Quotes MCP Server Enhanced v2.1.0");
    debugLog("⚙️ Configurações:", {
      cache: cacheConfig,
      requests: requestConfig,
      apis: { API_DOLAR, API_BITCOIN, API_IBOV },
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);

    debugLog("✅ Quotes MCP Server Enhanced rodando no stdio");
    debugLog(
      "🎯 Ferramentas disponíveis: get_dolar, get_bitcoin, get_ibov, health_check, cache_stats, rate_limit_stats",
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
```

#### 9.4 Refactor DRY Gracefull Shutdown

**💻 LIVE CODE:**
```typescript
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
```
---

## 🎯 Recapitulação Final

### Arquitetura Final
```
┌─────────────────────────────────────────┐
│         MCP Server (stdio)              │
├─────────────────────────────────────────┤
│  Tools: get_dolar, get_bitcoin, etc     │
├─────────────────────────────────────────┤
│  makeRequestWithRetry                   │
│    ├─ Cache Check                       │
│    ├─ Rate Limit Check                  │
│    ├─ Retry Logic (3x)                  │
│    ├─ Exponential Backoff               │
│    └─ Timeout Control                   │
├─────────────────────────────────────────┤
│  CacheManager                           │
│    ├─ TTL Management                    │
│    ├─ LRU Eviction                      │
│    └─ Auto Cleanup                      │
├─────────────────────────────────────────┤
│  RateLimiter                            │
│    └─ Sliding Window                    │
├─────────────────────────────────────────┤
│  Error Handling                         │
│    └─ ApiError (typed errors)           │
├─────────────────────────────────────────┤
│  Validation Layer (Zod)                 │
└─────────────────────────────────────────┘
```

### Patterns Implementados

1. **Retry Pattern com Exponential Backoff**
   - Resiliência contra falhas temporárias
   - Não sobrecarrega servidor

2. **Cache com TTL e LRU**
   - Performance e confiabilidade
   - Uso eficiente de memória

3. **Rate Limiting (Sliding Window)**
   - Proteção contra abuso
   - Fair usage

4. **Validação com Zod**
   - Type safety em runtime
   - Previne erros de dados malformados

5. **Error Handling Centralizado**
   - Erros tipados e rastreáveis
   - Logging estruturado

6. **Graceful Shutdown**
   - Cleanup adequado de recursos
   - Previne memory leaks

---

## 📚 Materiais Complementares

### Recursos:
- Repositório final no GitHub
- Diagrama de arquitetura
- Lista de APIs públicas para testar
- Exercícios de extensão (adicionar mais tools)
- Checklist de production-readiness

### Exercícios Propostos:
1. Adicionar tool para cotação do Euro
2. Implementar circuit breaker pattern
3. Adicionar métricas com Prometheus
4. Implementar persistência de cache em Redis
5. Adicionar autenticação para APIs privadas

---

