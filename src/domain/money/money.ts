import { DomainError } from "../shared/domain-error.js";

export class InvalidMoneyError extends DomainError { }
export class CurrencyMismatchError extends DomainError { }

export interface MoneyProps {
    amount: string;   // decimal string, ex.: "25.00"
    currency: string; // ISO-4217
}


const AMOUNT_PATTERN = /^(0|[1-9]\d*)\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
    private constructor(
        private readonly cents: bigint,
        public readonly currency: string,
    ) { }

    static from(props: MoneyProps): Money {
        if (!CURRENCY_PATTERN.test(props.currency)) {
            throw new InvalidMoneyError(`Invalid currency: ${props.currency}`)
        }

        if (!AMOUNT_PATTERN.test(props.amount)) {
            throw new InvalidMoneyError(`Invalid amount: ${props.amount}`)
        }

        const cents = BigInt(props.amount.replace('.', ''))

        return new Money(cents, props.currency)
    };

    static zero(currency: string): Money {
        // Passa pelo from para validar a moeda.
        return Money.from({ amount: '0.00', currency })
    };

    add(other: Money): Money {
        this.assertSameCurrency(other)
        return new Money(this.cents + other.cents, this.currency)
    };

    subtract(other: Money): Money {
        this.assertSameCurrency(other)
        const result = this.cents - other.cents
        return new Money(result, this.currency)
    };

    negate(): Money {
        // -0n === 0n, então zero continua "0.00".
        return new Money(-this.cents, this.currency)
    };

    isZero(): boolean {
        return this.cents === 0n
    };

    isPositive(): boolean {
        return this.cents > 0n
    };

    isNegative(): boolean {
        return this.cents < 0n
    };

    isLessThan(other: Money): boolean {
        this.assertSameCurrency(other)

        return this.cents < other.cents
    };

    equals(other: Money): boolean {
        return this.currency === other.currency && this.cents === other.cents
    };

    toJSON(): MoneyProps {
        return {
            amount: this.toString(),
            currency: this.currency
        }
    };

    toString(): string {
        const sign = this.cents < 0n ? '-' : ''
        const absolute = this.cents < 0n ? -this.cents : this.cents
        const integerPart = absolute / 100n
        const fractionalPart = absolute % 100n
        return `${sign}${integerPart}.${fractionalPart.toString().padStart(2, '0')}`
    };

    private assertSameCurrency(other: Money): void {
        if (other.currency !== this.currency) {
            throw new CurrencyMismatchError(`Currency mismatch: ${this.currency} vs ${other.currency}`)
        }
    };
}
