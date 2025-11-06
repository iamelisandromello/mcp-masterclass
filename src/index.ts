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

server.tool("get_dolar", "Obter cotação atual do Dólar", {}, async () => {
	const response = await fetch(
		"https://economia.awesomeapi.com.br/json/last/USD-BRL",
	);
	console.error("Fetching Dolar quotation...", response.body);

	const raw = await response.json();
	console.error("Raw Dolar data:", raw);
	const parsed = DolarSchema.parse(raw);
	console.error("Parsed Dolar data:", parsed);

	const dolar = parsed.USDBRL;
	console.error("Dolar quotation:", dolar);
	const bid = parseFloat(dolar.bid);
	console.error("Dolar bid:", bid);
	const ask = parseFloat(dolar.ask);
	console.error("Dolar ask:", ask);

	const result = `Dólar (${dolar.code}/${dolar.codein})
Compra: ${formatBRL(bid)} | Venda: ${formatBRL(ask)}`;

	console.error("Result Dolar quotation:", result);

	return {
		content: [
			{
				type: "text",
				text: result,
			},
		],
	};
});

async function main() {
	const trasport = new StdioServerTransport();
	await server.connect(trasport);
	console.error("Quotes MCP Server is running...");
}

main();
