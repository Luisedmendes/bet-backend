// D12: ids gerados no domínio, em UUID v7 (ordenados pelo horário).
export function newId(): string {
  return Bun.randomUUIDv7();
}
