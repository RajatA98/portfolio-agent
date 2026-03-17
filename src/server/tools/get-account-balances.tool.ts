import { AccountBalancesResult } from '../agent.types';
import { PortfolioService } from '../services/portfolio.service';
import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

export class GetAccountBalancesTool implements ToolExecutor {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'getAccountBalances',
    description:
      'Retrieves cash balances and buying power across all linked brokerage accounts. Use this tool to answer questions about available cash, uninvested funds, buying power, or account balances.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: []
    }
  };

  constructor(private readonly portfolioService: PortfolioService) {}

  public async execute(
    _input: Record<string, unknown>,
    context: ToolContext
  ): Promise<AccountBalancesResult> {
    return this.portfolioService.getAccountBalances(
      context.userId,
      context.baseCurrency,
      context.supabaseUserId
    );
  }
}
