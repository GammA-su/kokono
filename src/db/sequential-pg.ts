import { PrismaPg } from "@prisma/adapter-pg";

type Adapter = Awaited<ReturnType<PrismaPg["connect"]>>;
type Transaction = Awaited<ReturnType<Adapter["startTransaction"]>>;

function sequentialTransaction(transaction: Transaction): Transaction {
  let pending: Promise<unknown> = Promise.resolve();
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    // A failed statement must not prevent rollback or connection release.
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    provider: transaction.provider,
    adapterName: transaction.adapterName,
    options: transaction.options,
    queryRaw: (query) => enqueue(() => transaction.queryRaw(query)),
    executeRaw: (query) => enqueue(() => transaction.executeRaw(query)),
    commit: () => enqueue(() => transaction.commit()),
    rollback: () => enqueue(() => transaction.rollback()),
    ...(transaction.createSavepoint && {
      createSavepoint: (name: string) => enqueue(() => transaction.createSavepoint!(name)),
    }),
    ...(transaction.rollbackToSavepoint && {
      rollbackToSavepoint: (name: string) => enqueue(() => transaction.rollbackToSavepoint!(name)),
    }),
    ...(transaction.releaseSavepoint && {
      releaseSavepoint: (name: string) => enqueue(() => transaction.releaseSavepoint!(name)),
    }),
  };
}

// Prisma can fan out relation reads inside one transaction. pg 8.20+ deprecates
// overlapping queries on that single connection (prisma/prisma#29407).
// Queue at the adapter boundary, including transaction cleanup. Pool queries
// and separate transactions remain concurrent. Revisit after the upstream fix.
export class SequentialPrismaPg extends PrismaPg {
  override async connect() {
    const adapter = await super.connect();
    const startTransaction = adapter.startTransaction.bind(adapter);
    adapter.startTransaction = async (isolationLevel) =>
      sequentialTransaction(await startTransaction(isolationLevel));
    return adapter;
  }
}
