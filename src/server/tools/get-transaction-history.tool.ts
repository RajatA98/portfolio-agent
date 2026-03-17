import { TransactionHistoryResult } from '../agent.types';
import { PortfolioService } from '../services/portfolio.service';
import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

export class GetTransactionHistoryTool implements ToolExecutor {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'getTransactionHistory',
    description:
      'Retrieves historical transactions (buys, sells, dividends, fees) from linked brokerage accounts. Use this tool to answer questions about past trades, dividend income, transaction history, or account activity.',
    input_schema: {
      type: 'object' as const,
      properties: {
        startDate: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format. Defaults to 90 days ago if not specified.'
        },
        endDate: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format. Defaults to today if not specified.'
        },
        type: {
          type: 'string',
          description: 'Filter by transaction type. Comma-separated values: BUY, SELL, DIVIDEND, FEE, INTEREST, TRANSFER, etc.'
        },
        symbol: {
          type: 'string',
          description: 'Filter by ticker symbol (e.g., AAPL, BTC).'
        }
      },
      required: []
    }
  };

  constructor(private readonly portfolioService: PortfolioService) {}

  public async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<TransactionHistoryResult> {
    return this.portfolioService.getTransactionHistory(
      context.userId,
      context.baseCurrency,
      context.supabaseUserId,
      {
        startDate: input.startDate as string | undefined,
        endDate: input.endDate as string | undefined,
        type: input.type as string | undefined,
        symbol: input.symbol as string | undefined
      }
    );
  }
}
