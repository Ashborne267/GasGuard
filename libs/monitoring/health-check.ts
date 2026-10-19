import axios from "axios";
import {
  HealthProbeRegistry,
  HealthProbeThresholds,
  ProbeEvaluation,
  sanitizeProbeTarget,
} from "./health-probe";

export interface EndpointHealth {
  url: string;
  isAlive: boolean;
  latency: number;
  lastChecked: Date;
  status?: string;
  evaluation?: ProbeEvaluation;
}

export class HealthCheckService {
  private readonly registry: HealthProbeRegistry;
  private readonly defaultThresholds?: Partial<HealthProbeThresholds>;

  constructor(defaultThresholds?: Partial<HealthProbeThresholds>) {
    this.registry = new HealthProbeRegistry();
    this.defaultThresholds = defaultThresholds;
  }

  getRegistry(): HealthProbeRegistry {
    return this.registry;
  }

  async checkEndpoint(
    url: string,
    overrides?: Partial<HealthProbeThresholds>,
  ): Promise<EndpointHealth> {
    const start = Date.now();
    const probe = this.registry.getOrCreateProbe(
      url,
      overrides || this.defaultThresholds,
    );
    const timeout = probe.getThresholds().timeoutMs;

    try {
      // Basic health check: try to get a simple response or just a TCP connection check
      // For RPCs, we might want to call a simple method like eth_blockNumber
      await axios.post(
        url,
        {
          jsonrpc: "2.0",
          method: "eth_blockNumber", // Default to EVM, but can be customized
          params: [],
          id: 1,
        },
        { timeout },
      );

      const latency = Date.now() - start;
      const evaluation = probe.recordSample({
        isAlive: true,
        latencyMs: latency,
        timestamp: Date.now(),
      });

      return {
        url: sanitizeProbeTarget(url),
        isAlive: true,
        latency,
        lastChecked: new Date(),
        status: evaluation.status,
        evaluation,
      };
    } catch (error) {
      const latency = Date.now() - start;
      const errMsg = error instanceof Error ? error.message : "check failed";
      const evaluation = probe.recordSample({
        isAlive: false,
        latencyMs: latency,
        errorMessage: errMsg,
        timestamp: Date.now(),
      });

      return {
        url: sanitizeProbeTarget(url),
        isAlive: false,
        latency: -1,
        lastChecked: new Date(),
        status: evaluation.status,
        evaluation,
      };
    }
  }

  async evaluateEndpoint(
    url: string,
    overrides?: Partial<HealthProbeThresholds>,
  ): Promise<ProbeEvaluation> {
    const res = await this.checkEndpoint(url, overrides);
    return (
      res.evaluation ??
      this.registry
        .getOrCreateProbe(url, overrides || this.defaultThresholds)
        .evaluate()
    );
  }
}
