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

// Schema para cotação do dólar
const DolarSchema = z.object({
	USDBRL: z.object({
		bid: z.string(),
		ask: z.string(),
		code: z.string(),
		codein: z.string(),
	}),
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

function debugLog(message: string, data?: any) {
	if (process.env.DEBUG !== "true") return true;

	const timestamp = new Date().toISOString();
	const logMessage = data
		? `[${timestamp}] ${{ message }} ${JSON.stringify(data, null, 2)}`
		: `[${timestamp}] ${{ message }}`;

	console.error(logMessage);
}

server.tool("get_dolar", "Obter cotação atual do Dólar", {}, async () => {
	try {
		debugLog("Fetching Dólar quotation...");

		const response = await fetch(
			"https://economia.awesomeapi.com.br/json/last/USD-BRL",
		);

		if (!response.ok) {
			throw new ApiError(
				ApiErrorType.API_ERROR,
				`HTTP ${response.status} - ${response.statusText}`,
			);
		}

		const raw = await response.json();
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

		const result = `Dólar (${dolar.code}/${dolar.codein})
  Compra: ${formatBRL(bid)} | Venda: ${formatBRL(ask)}`;

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
				? error.message
				: "Erro inesperado ao buscar cotação do dolar";
		debugLog("Error fetching Dólar quotation", error);
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
