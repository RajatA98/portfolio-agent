import { ReturnRatesResult } from '../agent.types';
import { PortfolioService } from '../services/portfolio.service';
import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

export class GetReturnRatesTool implements ToolExecutor {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'getReturnRates',
    description:
      'Retrieves brokerage-calculated rate of return percentages by timeframe (1M, 3M, 6M, 1Y, ALL) for linked accounts. Use this tool to answer questions about investment returns, annual performance, or time-weighted returns.',
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
  ): Promise<ReturnRatesResult> {
    return this.portfolioService.getReturnRates(
      context.userId,
      context.baseCurrency,
      context.supabaseUserId
    );
  }
}
