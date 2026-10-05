import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { AppEnv } from '../config/env.js';

export function createSqsClient(env: AppEnv): SQSClient {
  return new SQSClient({
    region: env.sqs.region,
    endpoint: env.sqs.endpoint,
    // Sem retry interno do SDK além do padrão: quem decide retry é o consumidor/outbox.
    maxAttempts: 3,
  });
}

/** Resolve e memoriza a URL de cada fila pelo nome. */
export class QueueUrls {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(private readonly client: SQSClient) {}

  get(queueName: string): Promise<string> {
    let url = this.cache.get(queueName);
    if (!url) {
      url = this.client
        .send(new GetQueueUrlCommand({ QueueName: queueName }))
        .then((out) => {
          if (!out.QueueUrl) throw new Error(`Queue ${queueName} not found`);
          return out.QueueUrl;
        })
        .catch((error: unknown) => {
          this.cache.delete(queueName);
          throw error;
        });
      this.cache.set(queueName, url);
    }
    return url;
  }
}
