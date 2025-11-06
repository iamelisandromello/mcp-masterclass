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

server.tool(
	"hello",
	"Ferramenta de Teste",
	{
		name: z.string().optional().describe("Seu Nome"),
		age: z.number().optional().describe("Sua Idade"),
	},
	async (args) => {
		return {
			content: [
				{
					type: "text",
					text: `Hello, ${args.name || "world"}! ! Você tem ${args.age} anos.`,
				},
			],
		};
	},
);

async function main() {
	const trasport = new StdioServerTransport();
	await server.connect(trasport);
	console.error("Quotes MCP Server is running...");
}

main();
