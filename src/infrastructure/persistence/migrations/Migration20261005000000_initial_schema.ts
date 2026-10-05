import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As garantias de unicidade, imutabilidade e não-negatividade
 * ficam no banco (README §5, restrição 9), não só no código:
 *
 * - CHECKs de formato, sinal e coerência de status;
 * - UNIQUE para idempotência, wallet por player+moeda e reversão única;
 * - triggers que bloqueiam UPDATE/DELETE no ledger, mudanças em transações
 *   terminais e saltos de version;
 * - constraint triggers DEFERRED que, no COMMIT, exigem
 *   wallet.balance == último balance_after do ledger.
 */
export class Migration20261005000000_initial_schema extends Migration {
  override name = 'Migration20261005000000_initial_schema';

  override up(): void {
    // ---------------------------------------------------------------- wallets
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid PRIMARY KEY,
        player_id   uuid NOT NULL,
        currency    char(3) NOT NULL CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        balance     numeric(19, 2) NOT NULL
                    CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0 AND balance <> 'NaN'::numeric),
        version     integer NOT NULL CONSTRAINT wallets_version_positive CHECK (version >= 1),
        created_at  timestamptz NOT NULL,
        updated_at  timestamptz NOT NULL,
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency)
      )`);

    // ------------------------------------------------------ wager_transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid PRIMARY KEY,
        provider_id                       text NOT NULL,
        external_transaction_id           text NOT NULL,
        idempotency_key                   text NOT NULL,
        payload_hash                      char(64) NOT NULL
                                          CONSTRAINT wager_transactions_payload_hash_format CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id                         uuid NOT NULL
                                          REFERENCES wallets (id) DEFERRABLE INITIALLY DEFERRED,
        player_id                         uuid NOT NULL,
        round_id                          text NOT NULL,
        game_id                           text NOT NULL,
        kind                              text NOT NULL
                                          CONSTRAINT wager_transactions_kind CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount                            numeric(19, 2) NOT NULL
                                          CONSTRAINT wager_transactions_amount_non_negative CHECK (amount >= 0 AND amount <> 'NaN'::numeric),
        currency                          char(3) NOT NULL
                                          CONSTRAINT wager_transactions_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id text,
        reference_transaction_id          uuid
                                          REFERENCES wager_transactions (id) DEFERRABLE INITIALLY DEFERRED,
        status                            text NOT NULL
                                          CONSTRAINT wager_transactions_status CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code                      text,
        result_balance                    numeric(19, 2)
                                          CONSTRAINT wager_transactions_result_balance_non_negative CHECK (result_balance >= 0),
        reference_attempts                integer NOT NULL DEFAULT 0
                                          CONSTRAINT wager_transactions_reference_attempts CHECK (reference_attempts >= 0),
        next_reference_attempt_at         timestamptz,
        created_at                        timestamptz NOT NULL,
        updated_at                        timestamptz NOT NULL,
        processed_at                      timestamptz,

        CONSTRAINT wager_transactions_idempotency_key_unique UNIQUE (idempotency_key),
        CONSTRAINT wager_transactions_provider_external_unique UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_transactions_reference_required
          CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_transactions_not_self_reference
          CHECK (reference_transaction_id IS NULL OR reference_transaction_id <> id),
        CONSTRAINT wager_transactions_opening_is_internal
          CHECK ((kind = 'OPENING') = (provider_id = 'internal')),
        CONSTRAINT wager_transactions_failure_code_iff_failed
          CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_transactions_processed_at_iff_terminal
          CHECK ((status IN ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at IS NOT NULL)),
        CONSTRAINT wager_transactions_schedule_iff_pending_reference
          CHECK ((status = 'PENDING_REFERENCE') = (next_reference_attempt_at IS NOT NULL)),
        CONSTRAINT wager_transactions_result_balance_when_decided
          CHECK (status IN ('PENDING', 'FAILED') OR result_balance IS NOT NULL),
        CONSTRAINT wager_transactions_processed_movement_positive
          CHECK (status <> 'PROCESSED' OR kind = 'LOSS' OR amount > 0)
      )`);

    // Uma transação só pode ser revertida uma vez (README §7, regra 4 — ver D16).
    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_single_reversal
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'`);
    // Worker de PENDING_REFERENCE: só indexa o que está esperando.
    this.addSql(`
      CREATE INDEX wager_transactions_pending_reference_due
        ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`
      CREATE INDEX wager_transactions_waiting_for_reference
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`CREATE INDEX wager_transactions_wallet ON wager_transactions (wallet_id, created_at)`);

    // ------------------------------------------------- wallet_ledger_entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        seq            bigint GENERATED ALWAYS AS IDENTITY
                       CONSTRAINT wallet_ledger_entries_seq_unique UNIQUE,
        id             uuid PRIMARY KEY,
        wallet_id      uuid NOT NULL REFERENCES wallets (id) DEFERRABLE INITIALLY DEFERRED,
        transaction_id uuid NOT NULL REFERENCES wager_transactions (id) DEFERRABLE INITIALLY DEFERRED,
        direction      text NOT NULL CONSTRAINT wallet_ledger_entries_direction CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount         numeric(19, 2) NOT NULL
                       CONSTRAINT wallet_ledger_entries_amount_positive CHECK (amount > 0 AND amount <> 'NaN'::numeric),
        currency       char(3) NOT NULL CONSTRAINT wallet_ledger_entries_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        balance_before numeric(19, 2) NOT NULL
                       CONSTRAINT wallet_ledger_entries_before_non_negative CHECK (balance_before >= 0 AND balance_before <> 'NaN'::numeric),
        balance_after  numeric(19, 2) NOT NULL
                       CONSTRAINT wallet_ledger_entries_after_non_negative CHECK (balance_after >= 0 AND balance_after <> 'NaN'::numeric),
        created_at     timestamptz NOT NULL,

        -- No máximo um lançamento por transação por wallet (README §6.4).
        CONSTRAINT wallet_ledger_entries_one_per_transaction UNIQUE (wallet_id, transaction_id),
        CONSTRAINT wallet_ledger_entries_balanced CHECK (
          (direction = 'DEBIT'  AND balance_after = balance_before - amount) OR
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
        )
      )`);
    this.addSql(`CREATE INDEX wallet_ledger_entries_wallet_seq ON wallet_ledger_entries (wallet_id, seq)`);

    // ---------------------------------------------------------- inbox / outbox
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL,
        message_id    text NOT NULL,
        payload_hash  char(64) NOT NULL,
        received_at   timestamptz NOT NULL,
        processed_at  timestamptz,
        CONSTRAINT inbox_messages_pkey PRIMARY KEY (consumer_name, message_id)
      )`);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid PRIMARY KEY,
        aggregate_id    text NOT NULL,
        event_type      text NOT NULL,
        payload         jsonb NOT NULL,
        occurred_at     timestamptz NOT NULL,
        attempts        integer NOT NULL DEFAULT 0 CONSTRAINT outbox_messages_attempts CHECK (attempts >= 0),
        next_attempt_at timestamptz,
        published_at    timestamptz,
        CONSTRAINT outbox_messages_schedule_iff_pending CHECK ((published_at IS NULL) = (next_attempt_at IS NOT NULL))
      )`);
    this.addSql(`
      CREATE INDEX outbox_messages_due ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL`);

    // ---------------------------------------------------------------- triggers
    // Ledger: append-only. Sem UPDATE, DELETE ou TRUNCATE.
    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_append_only() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% blocked)', TG_OP
          USING ERRCODE = 'restrict_violation';
      END $$`);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_update_delete
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_append_only()`);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wallet_ledger_entries_append_only()`);

    // Ledger encadeado: balance_before do novo lançamento = balance_after do anterior.
    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_chain() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        previous_after numeric;
      BEGIN
        SELECT balance_after INTO previous_after
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id
         ORDER BY seq DESC
         LIMIT 1;
        IF NOT FOUND THEN
          IF NEW.balance_before <> 0 THEN
            RAISE EXCEPTION 'first ledger entry of wallet % must start from 0, got %', NEW.wallet_id, NEW.balance_before
              USING ERRCODE = 'check_violation';
          END IF;
        ELSIF previous_after <> NEW.balance_before THEN
          RAISE EXCEPTION 'ledger chain broken for wallet %: previous balance_after % <> balance_before %',
            NEW.wallet_id, previous_after, NEW.balance_before
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_chain
        BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_chain()`);

    // Wallets: campos de identidade imutáveis, version 1 na criação e +1 só quando o saldo muda.
    this.addSql(`
      CREATE FUNCTION wallets_guard() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wallets cannot be deleted' USING ERRCODE = 'restrict_violation';
        END IF;
        IF TG_OP = 'INSERT' THEN
          IF NEW.version <> 1 THEN
            RAISE EXCEPTION 'a new wallet starts at version 1' USING ERRCODE = 'check_violation';
          END IF;
          RETURN NEW;
        END IF;
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
           IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'wallet identity fields are immutable' USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'wallet % version must increase by 1 when the balance changes', NEW.id
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'wallet % version can only change with the balance', NEW.id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER wallets_guard
        BEFORE INSERT OR UPDATE OR DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wallets_guard()`);

    // Transações: terminais não mudam; campos de negócio nunca mudam; nada é apagado.
    this.addSql(`
      CREATE FUNCTION wager_transactions_guard() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions cannot be deleted' USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'transaction % is terminal (%) and cannot change', OLD.id, OLD.status
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'business fields of transaction % are immutable', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard
        BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard()`);

    // Outbox: o evento em si é imutável; publicado não volta a pendente.
    this.addSql(`
      CREATE FUNCTION outbox_messages_guard() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id, NEW.aggregate_id, NEW.event_type, NEW.payload, NEW.occurred_at)
           IS DISTINCT FROM (OLD.id, OLD.aggregate_id, OLD.event_type, OLD.payload, OLD.occurred_at) THEN
          RAISE EXCEPTION 'outbox event % is immutable', OLD.id USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
          RAISE EXCEPTION 'outbox event % was already published', OLD.id USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER outbox_messages_guard
        BEFORE UPDATE ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION outbox_messages_guard()`);

    // No COMMIT: saldo materializado == último balance_after do ledger, na moeda da wallet.
    // Garante "toda alteração de saldo tem lançamento, e vice-versa" no próprio banco.
    this.addSql(`
      CREATE FUNCTION wallet_matches_ledger() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        target_wallet uuid;
        wallet_balance numeric;
        wallet_currency char(3);
        last_after numeric;
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN
          target_wallet := NEW.id;
        ELSE
          target_wallet := NEW.wallet_id;
        END IF;

        SELECT balance, currency INTO wallet_balance, wallet_currency FROM wallets WHERE id = target_wallet;
        IF NOT FOUND THEN
          RETURN NULL; -- a FK deferred acusa o problema
        END IF;

        IF TG_TABLE_NAME = 'wallet_ledger_entries' AND NEW.currency <> wallet_currency THEN
          RAISE EXCEPTION 'ledger entry % currency % differs from wallet %', NEW.id, NEW.currency, wallet_currency
            USING ERRCODE = 'check_violation';
        END IF;

        SELECT balance_after INTO last_after
          FROM wallet_ledger_entries
         WHERE wallet_id = target_wallet
         ORDER BY seq DESC
         LIMIT 1;
        IF NOT FOUND THEN
          last_after := 0;
        END IF;

        IF last_after <> wallet_balance THEN
          RAISE EXCEPTION 'wallet % balance % does not match ledger balance %', target_wallet, wallet_balance, last_after
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_match_ledger
        AFTER INSERT OR UPDATE OF balance ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_matches_ledger()`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_ledger_entries_match_wallet
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_matches_ledger()`);
  }

  override down(): void {
    this.addSql('DROP TABLE IF EXISTS outbox_messages');
    this.addSql('DROP TABLE IF EXISTS inbox_messages');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries');
    this.addSql('DROP TABLE IF EXISTS wager_transactions');
    this.addSql('DROP TABLE IF EXISTS wallets');
    this.addSql('DROP FUNCTION IF EXISTS wallet_matches_ledger()');
    this.addSql('DROP FUNCTION IF EXISTS outbox_messages_guard()');
    this.addSql('DROP FUNCTION IF EXISTS wager_transactions_guard()');
    this.addSql('DROP FUNCTION IF EXISTS wallets_guard()');
    this.addSql('DROP FUNCTION IF EXISTS wallet_ledger_entries_chain()');
    this.addSql('DROP FUNCTION IF EXISTS wallet_ledger_entries_append_only()');
  }
}
