import type { AppLogger } from '../../application/ports/observability.js';

/**
 * Executa `tick` repetidamente. Se o tick fez trabalho (> 0), roda de novo
 * em seguida; senão espera `intervalMs`. `stop()` espera o tick atual terminar.
 */
export class PeriodicWorker {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<number>,
    private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let didWork = 0;
      try {
        didWork = await this.tick();
      } catch (error) {
        this.logger.error(`${this.name} tick failed`, { error: (error as Error).message });
      }
      if (!this.running) break;
      if (didWork === 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.intervalMs);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    }
  }
}
