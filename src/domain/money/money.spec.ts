import { describe, expect, it } from 'bun:test';
import { Money, InvalidMoneyError, CurrencyMismatchError } from './money.js';

describe('Money', () => {
    describe('from', () => {
        it('creates money from a valid decimal string', () => {
            const money = Money.from({ amount: '25.00', currency: 'BRL' });

            expect(money.toString()).toBe('25.00');
            expect(money.currency).toBe('BRL');
        });

        it.each([
            '', 'abc', 'NaN', 'Infinity', '1e3',
            '25', '25.5', '25.000', '1.005',
            '-25.00', '+25.00', ' 25.00', '007.00',
        ])(
            'rejects invalid amount %p',
            (amount) => {
                expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
            },
        );

        it.each(['brl', 'BR', 'REAIS', ''])(
            'rejects invalid currency %p',
            (currency) => {
                expect(() => Money.from({ amount: '25.00', currency })).toThrow(InvalidMoneyError);
            },
        );

        it('keeps precision on large values', () => {
            const a = Money.from({ amount: '99999999999999999.99', currency: 'BRL' });
            const b = Money.from({ amount: '0.01', currency: 'BRL' });

            expect(a.add(b).toString()).toBe('100000000000000000.00');
        });
    });


    describe('subtract', () => {
        it('returns a new money with the sub', () => {
            const a = Money.from({ amount: '0.40', currency: 'BRL' });
            const b = Money.from({ amount: '0.30', currency: 'BRL' });

            const total = a.subtract(b)

            expect(total.toString()).toBe('0.10')
        })

        it('can produce a negative result', () => {
            const a = Money.from({ amount: '30.00', currency: 'BRL' });
            const b = Money.from({ amount: '40.00', currency: 'BRL' });

            const total = a.subtract(b)

            expect(total.isNegative()).toBe(true)
        })

        it('can sub numbers with fractional part', () => {
            const a = Money.from({ amount: '40.00', currency: 'BRL' });
            const b = Money.from({ amount: '40.50', currency: 'BRL' });

            const total = a.subtract(b)

            expect(total.toString()).toBe('-0.50')
        })

        it('keeps the sign when the integer part is not zero', () => {
            const a = Money.from({ amount: '20.00', currency: 'BRL' });
            const b = Money.from({ amount: '80.50', currency: 'BRL' });

            const total = a.subtract(b)

            expect(total.toString()).toBe('-60.50')
        })

        it('rejects subtracting different currencies', () => {
            const brl = Money.from({ amount: '10.00', currency: 'BRL' });
            const usd = Money.from({ amount: '10.00', currency: 'USD' });

            expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
        })
    })

    describe('add', () => {
        it('returns a new money with the sum', () => {
            const a = Money.from({ amount: '0.10', currency: 'BRL' });
            const b = Money.from({ amount: '0.30', currency: 'BRL' });

            const total = a.add(b)

            expect(total.toString()).toBe('0.40')

        })

        it('doest not change the original values', () => {
            const a = Money.from({ amount: '0.10', currency: 'BRL' });
            const b = Money.from({ amount: '0.30', currency: 'BRL' });

            a.add(b)

            expect(a.toString()).toBe('0.10')
            expect(b.toString()).toBe('0.30')

        })

        it('rejects adding different currencies', () => {
            const brl = Money.from({ amount: '10.00', currency: 'BRL' });
            const usd = Money.from({ amount: '10.00', currency: 'USD' });

            expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
        });
    })

    describe('zero', () => {
        it('returns a new money with 0 cents', () => {
            const zeroMoney = Money.zero('BRL');

            expect(zeroMoney.toString()).toBe('0.00')
            expect(zeroMoney.isZero()).toBe(true)
            expect(zeroMoney.currency).toBe('BRL')
        })

        it('rejects an invalid currency', () => {
            expect(() => Money.zero('banana')).toThrow(InvalidMoneyError)
        })
    })

    describe('isZero', () => {
        it('returns if new money is 0 cents', () => {
            const testMoney = Money.from({ amount: '0.00', currency: 'BRL' });

            expect(testMoney.isZero()).toBe(true)

        })

        it('returns if new money is not 0 cents', () => {
            const testMoney = Money.from({ amount: '10.00', currency: 'BRL' });

            expect(testMoney.isZero()).toBe(false)

        })
    })

    describe('isPositive', () => {
        it('returns if new money is positive', () => {
            const testMoney = Money.from({ amount: '10.00', currency: 'BRL' });

            expect(testMoney.isPositive()).toBe(true)
        })

        it('is false for a negative value', () => {
            const a = Money.from({ amount: '30.00', currency: 'BRL' });
            const b = Money.from({ amount: '40.00', currency: 'BRL' });

            const total = a.subtract(b)

            expect(total.isPositive()).toBe(false)
        })
    })

    describe('isNegative', () => {
        it('returns if new money is negative', () => {
            const a = Money.from({ amount: '30.00', currency: 'BRL' });
            const b = Money.from({ amount: '40.00', currency: 'BRL' });

            const total = a.subtract(b)

            expect(total.isNegative()).toBe(true)
        })

        it('should return false', () => {
            const money = Money.from({ amount: '30.00', currency: 'BRL' });


            expect(money.isNegative()).toBe(false)
        })
    })

    describe('negate', () => {
        it('should transform money cents to negative', () => {
            const positiveMoney = Money.from({ amount: '30.00', currency: 'BRL' });

            const negativeMoney = positiveMoney.negate()

            expect(negativeMoney.isNegative()).toBe(true)
            expect(negativeMoney.toString()).toBe('-30.00')
        })

        it('turns a negative value positive', () => {
            const negativeMoney = Money.from({ amount: '30.00', currency: 'BRL' }).negate();

            const positiveMoney = negativeMoney.negate()

            expect(positiveMoney.isPositive()).toBe(true)
            expect(positiveMoney.toString()).toBe('30.00')
        })

        it('keeps zero as 0.00, never -0.00', () => {
            const money = Money.zero('BRL').negate();

            expect(money.isNegative()).toBe(false)
            expect(money.toString()).toBe('0.00')
        })
    })

    describe('isLessThan', () => {
        it('should return if money is less than another money', () => {
            const a = Money.from({ amount: '30.00', currency: 'BRL' });
            const b = Money.from({ amount: '40.00', currency: 'BRL' });

            expect(a.isLessThan(b)).toBe(true)
        })

        it('is false when the value is greater', () => {
            const a = Money.from({ amount: '40.00', currency: 'BRL' });
            const b = Money.from({ amount: '30.00', currency: 'BRL' });

            expect(a.isLessThan(b)).toBe(false)
        })

        it('is false when the values are equal', () => {
            const a = Money.from({ amount: '30.00', currency: 'BRL' });
            const b = Money.from({ amount: '30.00', currency: 'BRL' });

            expect(a.isLessThan(b)).toBe(false)
        })

        it('should return error if money has differente currency', () => {
            const a = Money.from({ amount: '30.00', currency: 'BRL' });
            const b = Money.from({ amount: '40.00', currency: 'USD' });

            expect(() => a.isLessThan(b)).toThrow(CurrencyMismatchError);
        })

    })

    describe('equals', () => {
        it('is true for same value and currency', () => {
            const a = Money.from({ amount: '40.00', currency: 'BRL' });
            const b = Money.from({ amount: '40.00', currency: 'BRL' });

            expect(a.equals(b)).toBe(true)
        })

        it('is false when values differ', () => {
            const a = Money.from({ amount: '30.00', currency: 'BRL' });
            const b = Money.from({ amount: '40.00', currency: 'BRL' });

            expect(a.equals(b)).toBe(false)
        })

        it('is false when currencies differ, without throwing', () => {
            const a = Money.from({ amount: '40.00', currency: 'BRL' });
            const b = Money.from({ amount: '40.00', currency: 'USD' });

            expect(a.equals(b)).toBe(false)
        })
    })

    describe('toJSON', () => {
        it('should return money JSON ', () => {
            const money = Money.from({ amount: '40.00', currency: 'BRL' });

            const json = money.toJSON()

            expect(json).toEqual({ amount: '40.00', currency: 'BRL' })
        })
    })

});