#!/bin/bash
# Roda quando o LocalStack fica pronto. Idempotente.
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
MAX_RECEIVE_COUNT="${WAGER_MAX_RECEIVE_COUNT:-5}"

queue_url() { awslocal sqs get-queue-url --region "$REGION" --queue-name "$1" --query QueueUrl --output text; }

awslocal sqs create-queue --region "$REGION" --queue-name wager-transactions-dlq.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false","MessageRetentionPeriod":"1209600"}' >/dev/null

DLQ_ARN=$(awslocal sqs get-queue-attributes --region "$REGION" --queue-url "$(queue_url wager-transactions-dlq.fifo)" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

awslocal sqs create-queue --region "$REGION" --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"${MAX_RECEIVE_COUNT}\\\"}\"}" >/dev/null

# Destino da outbox (eventos de integração).
awslocal sqs create-queue --region "$REGION" --queue-name wagering-events.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' >/dev/null

touch /tmp/queues-ready
echo "SQS queues ready"
